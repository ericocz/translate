from fastapi import FastAPI

from app.routers import admin, auth, telemetry, translate, usage

app = FastAPI(title="Immersive Translate Backend")
app.include_router(translate.router)
app.include_router(usage.router)
app.include_router(auth.router)
app.include_router(telemetry.router)
app.include_router(admin.router)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
