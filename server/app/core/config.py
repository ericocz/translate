from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    deepseek_api_key: str = ""
    database_url: str = "postgresql+asyncpg://imt:imt@localhost:5433/imt"
    jwt_secret: str = "dev-insecure-change-me"
    access_ttl_min: int = 30
    refresh_ttl_days: int = 30
    session_private_key: str = ""  # D-13 应用层加密静态私钥 base64(原始标量)；空＝明文路径（dev）
    creem_webhook_secret: str = ""  # D-18 Creem webhook 验签密钥（Developers→Webhook 页）；空＝拒收所有 webhook
    creem_buyout_product_id: str = ""  # D-18 买断商品 id；空＝不校验商品（仅联调）
    resend_api_key: str = ""  # 买断码邮件发信（Resend Dashboard→API Keys）；空＝退化为日志占位、不丢单
    email_from: str = ""  # 发信地址，如 "秒懂翻译 <noreply@yourdomain>"；域名须在 Resend 验证过


settings = Settings()
