from fastapi import FastAPI

from app.routers import auth, translate, usage

app = FastAPI(title="Immersive Translate Backend")
app.include_router(translate.router)
app.include_router(usage.router)
app.include_router(auth.router)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
