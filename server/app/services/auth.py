from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.security import (
    create_access_token,
    hash_password,
    hash_refresh_token,
    new_refresh_token,
    verify_password,
)
from app.db.models import Session, User


class AuthError(Exception):
    pass


@dataclass
class AuthResult:
    user_id: int
    email: str
    access: str
    refresh: str


@dataclass
class RefreshResult:
    user_id: int
    access: str


class AuthService:
    def __init__(self, session: AsyncSession) -> None:
        self._s = session

    async def _issue_session(self, user_id: int) -> str:
        raw = new_refresh_token()
        self._s.add(
            Session(
                user_id=user_id,
                refresh_token_hash=hash_refresh_token(raw),
                expires_at=datetime.now(timezone.utc) + timedelta(days=settings.refresh_ttl_days),
            )
        )
        await self._s.commit()
        return raw

    async def register(self, email: str, password: str) -> AuthResult:
        email = email.strip().lower()
        if not email or len(password) < 6:
            raise AuthError("邮箱或密码不合法（密码至少 6 位）")
        user = User(email=email, password_hash=hash_password(password))
        self._s.add(user)
        try:
            await self._s.commit()
        except IntegrityError:
            await self._s.rollback()
            raise AuthError("该邮箱已注册")
        await self._s.refresh(user)
        raw = await self._issue_session(user.id)
        return AuthResult(user.id, user.email, create_access_token(user.id), raw)

    async def login(self, email: str, password: str) -> AuthResult:
        email = email.strip().lower()
        user = await self._s.scalar(select(User).where(User.email == email))
        if user is None or not verify_password(password, user.password_hash):
            raise AuthError("邮箱或密码错误")
        raw = await self._issue_session(user.id)
        return AuthResult(user.id, user.email, create_access_token(user.id), raw)

    async def refresh(self, raw_refresh: str) -> RefreshResult:
        h = hash_refresh_token(raw_refresh)
        sess = await self._s.scalar(select(Session).where(Session.refresh_token_hash == h))
        if sess is None:
            raise AuthError("refresh token 无效")
        exp = sess.expires_at
        if exp.tzinfo is None:
            exp = exp.replace(tzinfo=timezone.utc)
        if exp < datetime.now(timezone.utc):
            raise AuthError("refresh token 已过期")
        return RefreshResult(sess.user_id, create_access_token(sess.user_id))

    async def logout(self, raw_refresh: str) -> None:
        h = hash_refresh_token(raw_refresh)
        sess = await self._s.scalar(select(Session).where(Session.refresh_token_hash == h))
        if sess is not None:
            await self._s.delete(sess)
            await self._s.commit()
