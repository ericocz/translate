from typing import Any, AsyncIterator

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.base import async_session
from app.db.models import ErrorLog, Event
from app.routers.deps import current_user_optional

router = APIRouter()


async def get_session() -> AsyncIterator[AsyncSession]:
    async with async_session() as s:
        yield s


class EventIn(BaseModel):
    type: str
    host: str | None = None
    props: dict[str, Any] = {}


class ErrorIn(BaseModel):
    kind: str
    message: str
    context: dict[str, Any] = {}


class EventsBody(BaseModel):
    events: list[EventIn] = []


class ErrorsBody(BaseModel):
    errors: list[ErrorIn] = []


@router.post("/v1/events")
async def post_events(
    body: EventsBody,
    request: Request,
    session: AsyncSession = Depends(get_session),
    user_id: int | None = Depends(current_user_optional),
):
    device_id = request.headers.get("x-device-id") or None
    for e in body.events:
        session.add(
            Event(user_id=user_id, device_id=device_id, type=e.type, host=e.host, props=e.props)
        )
    await session.commit()
    return {"stored": len(body.events)}


@router.post("/v1/errors")
async def post_errors(
    body: ErrorsBody,
    request: Request,
    session: AsyncSession = Depends(get_session),
    user_id: int | None = Depends(current_user_optional),
):
    device_id = request.headers.get("x-device-id") or None
    for e in body.errors:
        session.add(
            ErrorLog(
                user_id=user_id, device_id=device_id, kind=e.kind, message=e.message, context=e.context
            )
        )
    await session.commit()
    return {"stored": len(body.errors)}
