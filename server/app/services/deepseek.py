import json
import logging
from dataclasses import dataclass
from typing import AsyncIterator

import httpx

from app.core.config import settings
from app.core.hashing import MODEL
from app.core.prompt import SYSTEM_PROMPT

log = logging.getLogger("deepseek")

DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions"

# DeepSeek V4 Flash 输出上限：显式设定使「超长被截断」行为确定，并与 translator.OUTPUT_TOKEN_BUDGET
# 配合（后者 < 此值、留安全余量）。⚠️ 上线前以 DeepSeek 官方 max_tokens 实际上限校准本值。
MAX_OUTPUT_TOKENS = 384000


@dataclass
class Usage:
    """DeepSeek 真实用量。输入按前缀缓存命中拆两档计价（命中价≈未命中 1/50）：
    prompt_tokens = cache_hit + cache_miss。输出永不缓存。"""

    input_miss_tokens: int   # 输入·未命中（¥1/M）
    input_hit_tokens: int    # 输入·命中（¥0.02/M）
    output_tokens: int       # 输出（¥2/M）

    @property
    def input_tokens(self) -> int:
        return self.input_miss_tokens + self.input_hit_tokens


# 流里既有内容增量（str），也可能有最后一块的真实用量（Usage）。
StreamItem = str | Usage


class DeepSeekError(Exception):
    def __init__(self, kind: str, message: str) -> None:
        self.kind = kind  # network | api | auth
        self.message = message
        super().__init__(message)


@dataclass(frozen=True)
class Provider:
    """一路上游（OpenAI 兼容流式）。failover 时按列表顺序尝试。"""

    name: str       # 日志用（不含 key）
    url: str        # chat/completions 完整地址
    api_key: str
    model: str


def build_request_body(blocks: list[tuple[str, str]], model: str = MODEL) -> dict:
    """稳定系统提示词前缀 + 关思考；变化的块列表放 user 消息。对应客户端铁律 1/4：
    - system 逐字节稳定 → 命中 DeepSeek 前缀缓存；
    - thinking:disabled → V4 Flash 默认开思考，关掉后首 token 快约 3.5×、不产生 reasoning_tokens。
    `thinking` 是 DeepSeek 顶层参数；**已真机联调火山方舟**（model `deepseek-v4-flash-260425`、
    OpenAI 兼容 /chat/completions）确认接受同一顶层 `thinking` 参数、不报 400、标记格式无损。"""
    user = "\n".join(f"[[{bid}]] {src}" for bid, src in blocks)
    return {
        "model": model,
        "stream": True,
        "stream_options": {"include_usage": True},
        "thinking": {"type": "disabled"},
        "temperature": 0.2,
        "max_tokens": MAX_OUTPUT_TOKENS,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user},
        ],
    }


async def stream_content_deltas(
    client: httpx.AsyncClient,
    api_key: str,
    blocks: list[tuple[str, str]],
    *,
    url: str = DEEPSEEK_URL,
    model: str = MODEL,
) -> AsyncIterator[StreamItem]:
    """调上游流式接口（OpenAI 兼容），逐个 yield delta.content 文本。错误按 network/api/auth 分类抛出。
    url/model 默认官方 DeepSeek；failover 时由 `stream_with_failover` 传入火山方舟。

    失败分类（对齐 lib/deepseek.ts）：
    - 401/403 → auth；其余 4xx/5xx → api；fetch/连接层异常 → network（多半是代理未连通）。
    """
    body = build_request_body(blocks, model=model)
    headers = {
        "Authorization": f"Bearer {api_key}",  # 绝不写日志
        "Content-Type": "application/json",
    }
    try:
        async with client.stream("POST", url, json=body, headers=headers) as resp:
            if resp.status_code in (401, 403):
                raise DeepSeekError("auth", "上游 API Key 无效或已过期")
            if resp.status_code >= 400:
                text = (await resp.aread()).decode("utf-8", "replace")
                summary = " ".join(text[:200].split())
                raise DeepSeekError("api", f"上游接口报错 {resp.status_code}：{summary}")
            async for line in resp.aiter_lines():
                if not line or line.startswith(":"):
                    continue
                if not line.startswith("data:"):
                    continue
                data = line[5:].lstrip()
                if data == "[DONE]":
                    return
                try:
                    obj = json.loads(data)
                except json.JSONDecodeError:
                    continue  # 单事件解析失败不致命
                usage = obj.get("usage")
                if usage:
                    hit = int(usage.get("prompt_cache_hit_tokens", 0))
                    miss = int(usage.get("prompt_cache_miss_tokens", 0))
                    # 缺命中拆分字段（老接口/异常）时全算未命中，宁可少算缓存折扣不少收成本。
                    if hit == 0 and miss == 0:
                        miss = int(usage.get("prompt_tokens", 0))
                    yield Usage(
                        input_miss_tokens=miss,
                        input_hit_tokens=hit,
                        output_tokens=int(usage.get("completion_tokens", 0)),
                    )
                try:
                    delta = obj["choices"][0]["delta"].get("content")
                except (KeyError, IndexError):
                    delta = None
                if isinstance(delta, str) and delta:
                    yield delta
    except DeepSeekError:
        raise
    except httpx.HTTPError as e:
        raise DeepSeekError("network", f"无法连通上游：{e}") from e


def _providers(primary_api_key: str) -> list[Provider]:
    """failover 优先级列表：官方 DeepSeek 主，火山方舟备（配齐 key+model 才加入）。"""
    providers = [Provider("deepseek", DEEPSEEK_URL, primary_api_key, MODEL)]
    if settings.volcengine_api_key and settings.volcengine_model:
        providers.append(
            Provider(
                "volcengine",
                f"{settings.volcengine_base_url.rstrip('/')}/chat/completions",
                settings.volcengine_api_key,
                settings.volcengine_model,
            )
        )
    return providers


async def stream_with_failover(
    api_key: str, blocks: list[tuple[str, str]]
) -> AsyncIterator[StreamItem]:
    """生产用上游调用：官方 DeepSeek 主线，失败且**尚未吐出任何内容**时切火山方舟备线。
    签名 (api_key, blocks) 对齐 translator 期望的 DeepSeekStream。

    切换规则：仅在某 provider 首 token 之前失败（连接 / 非 200 / 早期异常）才换下一路；
    一旦已 yield 过内容再失败就直接抛（不能半句换源重来，交由单批失败隔离 + 漏块下次重试）。

    trust_env=False：后端直连各上游（均中国服务、无需代理），避免误用开发机个人 SOCKS 代理。"""
    providers = _providers(api_key)
    last_error: DeepSeekError | None = None
    for i, p in enumerate(providers):
        yielded = False
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(60.0, connect=10.0), trust_env=False
            ) as client:
                async for item in stream_content_deltas(
                    client, p.api_key, blocks, url=p.url, model=p.model
                ):
                    yielded = True
                    yield item
            return  # 该路正常跑完
        except DeepSeekError as e:
            last_error = e
            if yielded:
                raise  # 已吐内容，不能换源重来
            if i + 1 < len(providers):
                log.warning("上游 %s 失败(%s)，切换备线", p.name, e.kind)
                continue
    if last_error is not None:
        raise last_error


# 兼容旧名（smoke 脚本等单线直连用）。
stream_with_default_client = stream_with_failover
