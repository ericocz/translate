from fastapi import FastAPI

from app.routers import translate

app = FastAPI(title="Immersive Translate Backend")
app.include_router(translate.router)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
