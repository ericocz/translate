from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    deepseek_api_key: str = ""
    database_url: str = "postgresql+asyncpg://imt:imt@localhost:5433/imt"


settings = Settings()
