"""建管理员：uv run python scripts/create_admin.py <email> <password>"""
import asyncio
import os
import sys

# 让脚本无论从哪运行都能 import app（把 server 根加入 sys.path）。
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.core.security import hash_password
from app.db.base import async_session
from app.db.models import Admin


async def main(email: str, password: str) -> None:
    async with async_session() as s:
        s.add(Admin(email=email.strip().lower(), password_hash=hash_password(password)))
        await s.commit()
    print("created admin", email)


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1], sys.argv[2]))
