from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings
from app.core.ratelimit import RateLimitMiddleware, SlidingWindowCounter
from app.routers import admin, auth, billing, recharge, telemetry, translate, usage

app = FastAPI(title="Immersive Translate Backend")

# IP 级滑动窗口限流（高阈值 DDoS 闸）。用纯 ASGI 中间件而非 @app.middleware("http")：
# 后者的 BaseHTTPMiddleware 会把并发长流式响应里的一条 cancel 掉（区域并发翻译两条 SSE 必中），
# 详见 RateLimitMiddleware 文档。
_limiter = SlidingWindowCounter()
app.add_middleware(RateLimitMiddleware, limiter=_limiter)

# CORS：管理台是独立 origin 的浏览器应用（dev :3001），跨端口调 /admin/* 的 fetch 触发预检 OPTIONS，
# 无此中间件则预检无 Access-Control-Allow-Origin → 浏览器拦截（"Failed to fetch"，管理台登录/取数全挂）。
# 放在限流之后 add → CORS 处于更外层、先处理预检，预检不计入限流。允许 origin 由 cors_origins 配置（env 可覆盖）。
# 扩展走 service worker（host_permissions）不受 CORS 限制，无需为其开放。
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_methods=["*"],
    allow_headers=["*"],
)


app.include_router(translate.router)
app.include_router(usage.router)
app.include_router(auth.router)
app.include_router(telemetry.router)
app.include_router(admin.router)
app.include_router(billing.router)
app.include_router(recharge.router)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
