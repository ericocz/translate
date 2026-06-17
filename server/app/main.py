from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.core.ratelimit import SlidingWindowCounter, classify, client_ip
from app.routers import admin, auth, billing, recharge, redeem, telemetry, translate, usage

app = FastAPI(title="Immersive Translate Backend")

_limiter = SlidingWindowCounter()


@app.middleware("http")
async def rate_limit(request: Request, call_next):
    """IP 级滑动窗口限流（高阈值 DDoS 闸）。测试经 ASGITransport 无 client → 跳过、不影响用例。"""
    if request.client is not None:
        rule = classify(request.url.path)
        if rule is not None:
            ip = client_ip(request.headers.get("x-forwarded-for"), request.client.host)
            if not _limiter.allow(f"{ip}:{request.url.path}", rule):
                return JSONResponse(status_code=429, content={"error": "请求过于频繁，请稍后再试"})
    return await call_next(request)


app.include_router(translate.router)
app.include_router(usage.router)
app.include_router(auth.router)
app.include_router(telemetry.router)
app.include_router(admin.router)
app.include_router(billing.router)
app.include_router(redeem.router)
app.include_router(recharge.router)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
