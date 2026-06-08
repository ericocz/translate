from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class TranslationCache(Base):
    """全局共享内容寻址翻译缓存。

    键 = `{version}:{sha256(source)[:16]}`，version 由模型名 + 系统提示词派生（见 core.hashing）。
    token 列用于缓存命中记账（P4）：命中时直接累加这两列到用户当日用量。
    """

    __tablename__ = "translation_cache"

    key: Mapped[str] = mapped_column(String(80), primary_key=True)
    translated: Mapped[str] = mapped_column(Text, nullable=False)
    input_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    hits: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    last_access: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class AnonUsage(Base):
    """匿名「每页一次」去重计数：一行 = 某设备某本地日翻译过的一个页面（page_key 为客户端算好的哈希）。
    唯一约束保证同设备同日同页只占一行；当日不同 page_key 行数即「已用页数」。"""

    __tablename__ = "anon_usage"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    device_id: Mapped[str] = mapped_column(String(64), nullable=False)
    local_date: Mapped[str] = mapped_column(String(10), nullable=False)  # YYYY-MM-DD（用户时区）
    page_key: Mapped[str] = mapped_column(String(32), nullable=False)
    ip: Mapped[str | None] = mapped_column(String(64), nullable=True)  # 软兜底，仅记录不硬卡
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        UniqueConstraint("device_id", "local_date", "page_key", name="uq_anon_device_date_page"),
    )


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


class QuotaTier(Base):
    """登录用户梯度限流状态机：tier 决定日 Token 上限；strikes/clean_days 累计跨日表现；
    notice 暂存升降档提醒，供 /v1/usage 取走。"""

    __tablename__ = "quota_tier"

    user_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    tier: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    strikes: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    clean_days: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    last_day: Mapped[str | None] = mapped_column(String(10), nullable=True)
    notice: Mapped[str | None] = mapped_column(String(255), nullable=True)


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
