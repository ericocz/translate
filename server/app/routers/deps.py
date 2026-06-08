from fastapi import Request

from app.core.security import decode_access_token


def current_user_optional(request: Request) -> int | None:
    """读 Authorization: Bearer <access>；合法返回 user_id，否则 None（匿名）。"""
    auth = request.headers.get("authorization", "")
    if not auth.lower().startswith("bearer "):
        return None
    return decode_access_token(auth[7:].strip())
