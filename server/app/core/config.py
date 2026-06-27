from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    deepseek_api_key: str = ""
    # 跨 provider failover：火山方舟（Ark，OpenAI 兼容）作官方 DeepSeek 的备线。
    # 三者都配齐才启用 failover，否则仅官方单线（纯加性休眠）。
    volcengine_api_key: str = ""  # 火山方舟 Ark API Key；空＝failover 关闭、仅官方
    volcengine_model: str = ""    # 火山方舟上 DeepSeek 模型/接入点 id（如 ep-xxx 或 deepseek-v3-xxx）
    volcengine_base_url: str = "https://ark.cn-beijing.volces.com/api/v3"  # Ark OpenAI 兼容端点
    database_url: str = "postgresql+asyncpg://imt:imt@localhost:5433/imt"
    jwt_secret: str = "dev-insecure-change-me"
    access_ttl_min: int = 30
    refresh_ttl_days: int = 30
    session_private_key: str = ""  # D-13 应用层加密静态私钥 base64(原始标量)；空＝明文路径（dev）
    creem_webhook_secret: str = ""  # Creem webhook 验签密钥（Developers→Webhook 页）；空＝拒收所有 webhook
    creem_recharge_product_id: str = ""  # 充值商品 id（$9.9 美元额度）；空＝不校验商品（仅联调）
    yungouos_mch_id: str = ""  # 大陆充值（YunGouOS 微信支付）商户号；空＝充值不可用
    yungouos_pay_key: str = ""  # YunGouOS 支付密钥（签名 / 回调验签）
    public_base_url: str = ""  # 公网后端地址（YunGouOS notify 回调用），如 https://api.yourdomain；空＝充值不可用
    # 管理台是独立 origin 的浏览器应用（dev :3001），跨端口调 /admin/* 必过 CORS。
    # 逗号分隔的允许 origin 白名单；生产部署把管理台公网 origin 加进来（env 覆盖）。
    # 扩展走 service worker（有 host_permissions）不受 CORS 限制，故只为管理台开。
    cors_origins: str = "http://localhost:3001,http://localhost:3000"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()
