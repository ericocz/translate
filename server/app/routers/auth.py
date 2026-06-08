from typing import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.db.base import async_session
from app.services.auth import AuthError, AuthService

router = APIRouter()


async def get_auth() -> AsyncIterator[AuthService]:
    async with async_session() as s:
        yield AuthService(s)


class RegisterIn(BaseModel):
    email: str
    password: str


class LoginIn(BaseModel):
    email: str
    password: str


class RefreshIn(BaseModel):
    refresh: str


@router.post("/v1/auth/register")
async def register(body: RegisterIn, auth=Depends(get_auth)):
    try:
        r = await auth.register(body.email, body.password)
    except AuthError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return {"userId": r.user_id, "email": r.email, "access": r.access, "refresh": r.refresh}


@router.post("/v1/auth/login")
async def login(body: LoginIn, auth=Depends(get_auth)):
    try:
        r = await auth.login(body.email, body.password)
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
