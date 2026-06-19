from fastapi import FastAPI

from app.core.ratelimit import RateLimitMiddleware, SlidingWindowCounter
from app.routers import admin, auth, billing, recharge, telemetry, translate, usage

app = FastAPI(title="Immersive Translate Backend")

# IP 级滑动窗口限流（高阈值 DDoS 闸）。用纯 ASGI 中间件而非 @app.middleware("http")：
# 后者的 BaseHTTPMiddleware 会把并发长流式响应里的一条 cancel 掉（区域并发翻译两条 SSE 必中），
# 详见 RateLimitMiddleware 文档。
_limiter = SlidingWindowCounter()
app.add_middleware(RateLimitMiddleware, limiter=_limiter)


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
