"""轻量 IP 级速率限流（in-memory 滑动窗口计数器）。

定位：**高阈值 DDoS / 脚本狂刷闸**，不做细粒度业务限流——
- translate 的滥用成本已被额度系统挡住（零额度发 quota、有额度按 credits 扣费）；
- 撞库交给 auth 的「按邮箱失败锁定」；领赠送防薅交给 deviceId 幂等 + 服务端指纹。
故阈值放得很高，避免误伤 CGNAT / 网吧 / 公司 NAT 等共享出口 IP 的正常用户。

算法：滑动窗口计数器——每 key 存 (上一窗口计数, 当前窗口计数, 当前窗口起点)，
按当前窗口已过比例给上一窗口线性加权，近似消除固定窗口的「边界 2×limit 突刺」，
内存与固定窗口相当（只多一个计数器）。单机够用；多 worker 各自独立计数（粗粒度可接受）。
"""
import time
from dataclasses import dataclass

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send


@dataclass(frozen=True)
class Rule:
    limit: int       # 窗口内最大请求数（近似）
    window_sec: int  # 窗口秒数


# 高阈值 DDoS 闸：只挡明显的脚本狂刷，不误伤共享出口 IP。
_RULES: list[tuple[str, Rule]] = [
    ("/v1/auth/", Rule(120, 60)),   # 撞库的 IP 兜底；细粒度靠 auth 邮箱失败锁定
]
_DEFAULT = Rule(600, 60)           # translate / grant / usage 等：额度 / deviceId / 指纹管细粒度
# webhook 由支付商服务器回调（IP 不可控）、admin 自带 JWT 鉴权、health 探活 —— 都不限流。
_NO_LIMIT_PREFIXES = ("/health", "/v1/billing/", "/admin/")


def classify(path: str) -> Rule | None:
    """返回该路径适用的限流规则；None = 不限流。"""
    for p in _NO_LIMIT_PREFIXES:
        if path.startswith(p):
            return None
    for prefix, rule in _RULES:
        if path.startswith(prefix):
            return rule
    return _DEFAULT


def client_ip(forwarded: str | None, peer: str | None) -> str:
    """真实 IP：优先 X-Forwarded-For 首段（反代 / CDN 后），否则连接 peer。"""
    if forwarded:
        return forwarded.split(",")[0].strip()
    return peer or "unknown"


class SlidingWindowCounter:
    """滑动窗口计数器。key 通常是 f"{ip}:{path}"。`now`（秒）可注入便于测试。

    估算 = 上一窗口计数 × (上一窗口在滑动窗口内的剩余比例) + 当前窗口计数。
    刚跨入新窗口时剩余比例≈1（上窗口几乎全额计入）→ 挡住边界突刺；
    随当前窗口推进比例线性降到 0 → 上窗口影响平滑消退。
    """

    def __init__(self) -> None:
        self._buckets: dict[str, tuple[int, int, float]] = {}  # (prev, cur, window_start)

    def allow(self, key: str, rule: Rule, now: float | None = None) -> bool:
        now = time.monotonic() if now is None else now
        if len(self._buckets) > 5000:
            self._gc(now)
        w = rule.window_sec
        cur_start = (now // w) * w  # 对齐的当前窗口起点
        prev, cur, stored_start = self._buckets.get(key, (0, 0, cur_start))
        if stored_start == cur_start:
            pass                       # 同一窗口
        elif stored_start == cur_start - w:
            prev, cur = cur, 0         # 相邻窗口：当前→上一
        else:
            prev, cur = 0, 0           # 隔了 ≥2 窗口：旧数据全失效
        weight = 1.0 - (now - cur_start) / w   # 上一窗口剩余权重 ∈ (0, 1]
        estimate = prev * weight + cur
        if estimate >= rule.limit:
            return False
        self._buckets[key] = (prev, cur + 1, cur_start)
        return True

    def _gc(self, now: float) -> None:
        """惰性清理 2h 未动的 key，防内存无限增长。"""
        dead = [k for k, (_, _, s) in self._buckets.items() if now - s >= 7200]
        for k in dead:
            del self._buckets[k]


class RateLimitMiddleware:
    """IP 级限流中间件——**纯 ASGI**（非 BaseHTTPMiddleware）。

    为什么不用 `@app.middleware("http")`：那是 Starlette 的 BaseHTTPMiddleware，会用 anyio
    task group + 内存流把响应包一层。对**长流式响应**有已知缺陷：一条 SSE 与其他请求并发在途时，
    会把这条流式响应 cancel 成 CancelledError → 客户端收 500。**区域并发翻译正好踩中**——同一页面
    正文走 SSE(/v1/translate) 与外框走非流式(/v1/translate/batch) 并发同发，那条 SSE 必被打成 500
    （单发恒正常；历史上外框也曾走 SSE，两条 SSE 更必中）。纯 ASGI 中间件只在放行前查限流、之后原样
    透传 scope/receive/send、绝不碰响应体，故流式与并发都安全。
    """

    def __init__(self, app: ASGIApp, limiter: SlidingWindowCounter) -> None:
        self.app = app
        self.limiter = limiter

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        path: str = scope["path"]
        rule = classify(path)
        client = scope.get("client")
        # 测试经 ASGITransport 无 client → 跳过限流（不影响用例），与旧中间件行为一致。
        if rule is not None and client is not None:
            xff: str | None = None
            for k, v in scope.get("headers", []):
                if k == b"x-forwarded-for":
                    xff = v.decode("latin-1")
                    break
            ip = client_ip(xff, client[0])
            if not self.limiter.allow(f"{ip}:{path}", rule):
                resp = JSONResponse(status_code=429, content={"error": "请求过于频繁，请稍后再试"})
                await resp(scope, receive, send)
                return
        await self.app(scope, receive, send)
