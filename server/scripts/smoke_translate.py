"""真实调一次后端 + DeepSeek：起服务后运行，核对流式译文 + 缓存命中。

用法：
    uv run uvicorn app.main:app --port 8000   # 另开一个终端起服务
    uv run python scripts/smoke_translate.py   # 第一次：调模型
    uv run python scripts/smoke_translate.py   # 第二次：应全部缓存命中（秒回）
"""
import asyncio
import json

import httpx

PAYLOAD = {
    "blocks": [
        {"id": "b1", "source": "You must call <g0>fetch()</g0> before rendering."},
        {"id": "b2", "source": "Submit"},
    ]
}


async def run() -> None:
    # trust_env=False：只连本机 8000，绕过环境里的 SOCKS 代理（否则 httpx 需 socksio）。
    async with httpx.AsyncClient(timeout=60, trust_env=False) as c:
        async with c.stream("POST", "http://localhost:8000/v1/translate", json=PAYLOAD) as r:
            print("status", r.status_code)
            async for line in r.aiter_lines():
                if line.strip():
                    print(line)


asyncio.run(run())
