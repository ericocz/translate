from datetime import date
from typing import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import create_admin_token, decode_admin_token, verify_password
from app.db.base import async_session
from app.db.models import (
    Admin,
    CreditAccount,
    DailyUsage,
    ErrorLog,
    Event,
    UpstreamKey,
    User,
)

router = APIRouter(prefix="/admin")


async def get_session() -> AsyncIterator[AsyncSession]:
    async with async_session() as s:
        yield s


def admin_required(request: Request) -> int:
    auth = request.headers.get("authorization", "")
    admin_id = decode_admin_token(auth[7:].strip()) if auth.lower().startswith("bearer ") else None
    if admin_id is None:
        raise HTTPException(status_code=401, detail="需要管理员登录")
    return admin_id


class LoginIn(BaseModel):
    email: str
    password: str


@router.post("/login")
async def admin_login(body: LoginIn, session: AsyncSession = Depends(get_session)):
    admin = await session.scalar(select(Admin).where(Admin.email == body.email.strip().lower()))
    if admin is None or not verify_password(body.password, admin.password_hash):
        raise HTTPException(status_code=401, detail="邮箱或密码错误")
    return {"token": create_admin_token(admin.id), "email": admin.email}


@router.get("/stats")
async def stats(session: AsyncSession = Depends(get_session), _: int = Depends(admin_required)):
    users = await session.scalar(select(func.count()).select_from(User)) or 0
    translations = (
        await session.scalar(
            select(func.count()).select_from(Event).where(Event.type == "translate_done")
        )
        or 0
    )
    errors = await session.scalar(select(func.count()).select_from(ErrorLog)) or 0
    tokens = (
        await session.scalar(
            select(func.coalesce(func.sum(DailyUsage.input_tokens + DailyUsage.output_tokens), 0))
        )
        or 0
    )
    top_rows = (
        await session.execute(
            select(Event.host, func.count().label("n"))
            .where(Event.host.is_not(None))
            .group_by(Event.host)
            .order_by(func.count().desc())
            .limit(10)
        )
    ).all()
    return {
        "users": int(users),
        "translations": int(translations),
        "errors": int(errors),
        "tokens": int(tokens),
        "topHosts": [{"host": h, "count": int(n)} for h, n in top_rows],
    }


@router.get("/users")
async def users(session: AsyncSession = Depends(get_session), _: int = Depends(admin_required)):
    today = date.today().isoformat()
    rows = (await session.execute(select(User).order_by(User.id.desc()).limit(200))).scalars().all()
    ids = [u.id for u in rows]
    # 批量取当日用量与额度余额（按 user_id 归集），避免逐用户 N+1 查询。
    usage_by_user: dict[int, DailyUsage] = {}
    balance_by_user: dict[int, int] = {}
    if ids:
        usage_rows = (
            await session.execute(
                select(DailyUsage).where(
                    DailyUsage.user_id.in_(ids), DailyUsage.local_date == today
                )
            )
        ).scalars()
        usage_by_user = {du.user_id: du for du in usage_rows}
        owner_to_id = {f"u:{i}": i for i in ids}
        bal_rows = (
            await session.execute(
                select(CreditAccount).where(CreditAccount.owner.in_(list(owner_to_id)))
            )
        ).scalars()
        balance_by_user = {owner_to_id[ca.owner]: int(ca.balance_micro) for ca in bal_rows}
    out = []
    for u in rows:
        du = usage_by_user.get(u.id)
        out.append({
            "id": u.id,
            "email": u.email,
            "tokensToday": int((du.input_tokens + du.output_tokens) if du else 0),
            "balanceMicro": balance_by_user.get(u.id, 0),
            "createdAt": u.created_at.isoformat() if u.created_at else None,
        })
    return out


@router.get("/errors")
async def errors(session: AsyncSession = Depends(get_session), _: int = Depends(admin_required)):
    rows = (
        await session.execute(select(ErrorLog).order_by(ErrorLog.id.desc()).limit(200))
    ).scalars().all()
    return [
        {
            "id": r.id,
            "ts": r.ts.isoformat(),
            "kind": r.kind,
            "message": r.message,
            "context": r.context,
            "userId": r.user_id,
        }
        for r in rows
    ]


@router.get("/events")
async def events(session: AsyncSession = Depends(get_session), _: int = Depends(admin_required)):
    rows = (
        await session.execute(select(Event).order_by(Event.id.desc()).limit(200))
    ).scalars().all()
    return [
        {"id": r.id, "ts": r.ts.isoformat(), "type": r.type, "host": r.host, "props": r.props}
        for r in rows
    ]


# ---- 上游 Key 管理（脱敏：绝不回完整 Key）----
def _mask(v: str) -> str:
    return ("•" * max(0, len(v) - 4)) + v[-4:] if v else ""


def _key_out(k: UpstreamKey) -> dict:
    return {
        "id": k.id,
        "label": k.label,
        "masked": _mask(k.key_value),
        "status": k.status,
        "usedTokens": k.used_tokens,
        "balanceNote": k.balance_note,
    }


class KeyIn(BaseModel):
    label: str
    key: str


class KeyPatch(BaseModel):
    status: str


@router.get("/keys")
async def list_keys(session: AsyncSession = Depends(get_session), _: int = Depends(admin_required)):
    rows = (await session.execute(select(UpstreamKey).order_by(UpstreamKey.id))).scalars().all()
    return [_key_out(k) for k in rows]


@router.post("/keys")
async def add_key(
    body: KeyIn, session: AsyncSession = Depends(get_session), _: int = Depends(admin_required)
):
    k = UpstreamKey(label=body.label, key_value=body.key)
    session.add(k)
    await session.commit()
    await session.refresh(k)
    return _key_out(k)


@router.patch("/keys/{key_id}")
async def patch_key(
    key_id: int,
    body: KeyPatch,
    session: AsyncSession = Depends(get_session),
    _: int = Depends(admin_required),
):
    k = await session.get(UpstreamKey, key_id)
    if k is None:
        raise HTTPException(status_code=404, detail="not found")
    k.status = body.status
    await session.commit()
    return _key_out(k)
