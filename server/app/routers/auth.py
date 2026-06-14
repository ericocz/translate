import json
from typing import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from app.core import crypto
from app.core.config import settings
from app.db.base import async_session
from app.services.auth import AuthError, AuthService

router = APIRouter()

# D-13 应用层加密：静态私钥启动时载一次；空＝明文路径（dev / 现有测试）。
_server_priv = crypto.load_private_key(settings.session_private_key) if settings.session_private_key else None


async def get_auth() -> AsyncIterator[AuthService]:
    async with async_session() as s:
        yield AuthService(s)


class RegisterIn(BaseModel):
    email: str | None = None      # 明文路径
    password: str | None = None
    ct: str | None = None         # 加密路径：decrypt 出 {"email","password"} JSON，AAD="auth"


class LoginIn(BaseModel):
    email: str | None = None
    password: str | None = None
    ct: str | None = None


class RefreshIn(BaseModel):
    refresh: str


def _creds(body: RegisterIn | LoginIn, request: Request) -> tuple[str, str]:
    """带 X-Eph-Pub 头且服务端有私钥 → 解密 ct 取邮箱/密码；否则用明文字段。"""
    eph = request.headers.get("x-eph-pub", "")
    if eph and _server_priv and body.ct:
        key = crypto.derive_key(_server_priv, eph)
        data = json.loads(crypto.decrypt(key, body.ct, "auth"))
        return str(data.get("email", "")), str(data.get("password", ""))
    return body.email or "", body.password or ""


@router.post("/v1/auth/register")
async def register(body: RegisterIn, request: Request, auth=Depends(get_auth)):
    email, password = _creds(body, request)
    try:
        r = await auth.register(email, password)
    except AuthError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return {"userId": r.user_id, "email": r.email, "access": r.access, "refresh": r.refresh}


@router.post("/v1/auth/login")
async def login(body: LoginIn, request: Request, auth=Depends(get_auth)):
    email, password = _creds(body, request)
    try:
        r = await auth.login(email, password)
    except AuthError as e:
        raise HTTPException(status_code=401, detail=str(e))
    return {"userId": r.user_id, "email": r.email, "access": r.access, "refresh": r.refresh}


@router.post("/v1/auth/refresh")
async def refresh(body: RefreshIn, auth=Depends(get_auth)):
    try:
        r = await auth.refresh(body.refresh)
    except AuthError as e:
        raise HTTPException(status_code=401, detail=str(e))
    return {"userId": r.user_id, "access": r.access}


@router.post("/v1/auth/logout")
async def logout(body: RefreshIn, auth=Depends(get_auth)):
    await auth.logout(body.refresh)
    return {"ok": True}
