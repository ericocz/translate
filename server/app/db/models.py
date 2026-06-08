from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Integer, String, Text, func
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
