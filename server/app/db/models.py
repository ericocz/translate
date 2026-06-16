from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    tz: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class DailyUsage(Base):
    """登录用户每日 Token 记账（含缓存命中归因）。pages = 当日翻译请求计数。"""

    __tablename__ = "daily_usage"

    user_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    local_date: Mapped[str] = mapped_column(String(10), primary_key=True)
    input_tokens: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    output_tokens: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    pages: Mapped[int] = mapped_column(Integer, default=0, nullable=False)


class Event(Base):
    """运营打点：只存 host（不存完整 URL/正文）。props 放计数/耗时等非敏感字段。"""

    __tablename__ = "events"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    ts: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    user_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True, index=True)
    device_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    type: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    host: Mapped[str | None] = mapped_column(String(255), nullable=True)
    props: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)


class ErrorLog(Base):
    """客户端/服务端错误上报。context 仅放脱敏字段（host、失败类等）。"""

    __tablename__ = "error_logs"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    ts: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    user_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True, index=True)
    device_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    kind: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    context: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)


class Admin(Base):
    """管理台管理员（与终端用户隔离）。"""

    __tablename__ = "admins"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[str] = mapped_column(String(32), default="admin", nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class UpstreamKey(Base):
    """上游 DeepSeek Key 池（MVP：明文存库，响应脱敏只回末 4 位；加密存储留后续硬化）。"""

    __tablename__ = "upstream_keys"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    label: Mapped[str] = mapped_column(String(64), nullable=False)
    key_value: Mapped[str] = mapped_column(String(255), nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="active", nullable=False)  # active|disabled
    used_tokens: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    balance_note: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class Session(Base):
    """登录会话：refresh token 只存 sha256 哈希；access 是短时 JWT 无需存。"""

    __tablename__ = "sessions"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(BigInteger, index=True, nullable=False)
    refresh_token_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class CreditAccount(Base):
    """预付额度余额。owner = "u:{user_id}"（注册用户）或 "d:{device_id}"（未注册设备，领赠送用）。
    整数 micro-¥（1e-6 元）记账，不用浮点。"""

    __tablename__ = "credit_accounts"

    owner: Mapped[str] = mapped_column(String(80), primary_key=True)
    balance_micro: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


# 买断产品策略默认（D-06，非部署开关）——单一来源，model 列默认与 RedeemCodeRepo.issue 共用，避免漂移。
BUYOUT_PRODUCT = "buyout"
BUYOUT_MAX_DEVICES = 5


class RedeemCode(Base):
    """买断注册码：一张码 = 一次买断（BYOK 终身，激活时绑 ≤max_devices 台，绑定逻辑在激活端点/另计划）。
    source_ref 唯一 → 同一支付订单 webhook 重投只签发一张（幂等）。"""

    __tablename__ = "redeem_codes"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    code: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)
    email: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    product: Mapped[str] = mapped_column(String(32), default=BUYOUT_PRODUCT, nullable=False)
    source: Mapped[str] = mapped_column(String(16), nullable=False)  # creem|yungouos
    source_ref: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)  # 订单 id，幂等键
    max_devices: Mapped[int] = mapped_column(Integer, default=BUYOUT_MAX_DEVICES, nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="active", nullable=False)  # active|revoked
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class CreditTxn(Base):
    """额度流水：发放(grant/gift) / 扣减(deduct) / 退款(refund)。
    idempotency_key 唯一 → webhook 重投/并发只入账一次（DB 约束兜底）。"""

    __tablename__ = "credit_txns"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    owner: Mapped[str] = mapped_column(String(80), nullable=False, index=True)
    delta_micro: Mapped[int] = mapped_column(BigInteger, nullable=False)  # +发放 / -扣减
    kind: Mapped[str] = mapped_column(String(16), nullable=False)  # grant|gift|deduct|refund
    balance_after: Mapped[int] = mapped_column(BigInteger, nullable=False)
    idempotency_key: Mapped[str | None] = mapped_column(String(128), unique=True, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
