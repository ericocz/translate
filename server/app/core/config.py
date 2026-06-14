from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    deepseek_api_key: str = ""
    database_url: str = "postgresql+asyncpg://imt:imt@localhost:5433/imt"
    jwt_secret: str = "dev-insecure-change-me"
    access_ttl_min: int = 30
    refresh_ttl_days: int = 30
    session_private_key: str = ""  # D-13 应用层加密静态私钥 base64(原始标量)；空＝明文路径（dev）


settings = Settings()
