import json
from dataclasses import dataclass
from typing import AsyncIterator

import httpx

from app.core.hashing import MODEL
from app.core.prompt import SYSTEM_PROMPT

DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions"

# DeepSeek V4 Flash 输出上限：显式设定使「超长被截断」行为确定，并与 translator.OUTPUT_TOKEN_BUDGET
# 配合（后者 < 此值、留安全余量）。⚠️ 上线前以 DeepSeek 官方 max_tokens 实际上限校准本值。
MAX_OUTPUT_TOKENS = 384000


@dataclass
class Usage:
    input_tokens: int
    output_tokens: int


# 流里既有内容增量（str），也可能有最后一块的真实用量（Usage）。
StreamItem = str | Usage


class DeepSeekError(Exception):
    def __init__(self, kind: str, message: str) -> None:
        self.kind = kind  # network | api | auth
        self.message = message
        super().__init__(message)


def build_request_body(blocks: list[tuple[str, str]]) -> dict:
    """稳定系统提示词前缀 + 关思考；变化的块列表放 user 消息。对应客户端铁律 1/4：
    - system 逐字节稳定 → 命中 DeepSeek 前缀缓存；
    - thinking:disabled → V4 Flash 默认开思考，关掉后首 token 快约 3.5×、不产生 reasoning_tokens。"""
    user = "\n".join(f"[[{bid}]] {src}" for bid, src in blocks)
    return {
        "model": MODEL,
        "stream": True,
        "stream_options": {"include_usage": True},
        "thinking": {"type": "disabled"},
        "temperature": 0.2,
        "max_tokens": MAX_OUTPUT_TOKENS,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user},
        ],
    }


async def stream_content_deltas(
    client: httpx.AsyncClient, api_key: str, blocks: list[tuple[str, str]]
) -> AsyncIterator[StreamItem]:
    """调 DeepSeek 流式接口，逐个 yield delta.content 文本。错误按 network/api/auth 分类抛出。

    失败分类（对齐 lib/deepseek.ts）：
    - 401/403 → auth；其余 4xx/5xx → api；fetch/连接层异常 → network（多半是代理未连通）。
    """
    body = build_request_body(blocks)
    headers = {
        "Authorization": f"Bearer {api_key}",  # 绝不写日志
        "Content-Type": "application/json",
    }
    try:
        async with client.stream("POST", DEEPSEEK_URL, json=body, headers=headers) as resp:
            if resp.status_code in (401, 403):
                raise DeepSeekError("auth", "DeepSeek API Key 无效或已过期")
            if resp.status_code >= 400:
                text = (await resp.aread()).decode("utf-8", "replace")
                summary = " ".join(text[:200].split())
                raise DeepSeekError("api", f"DeepSeek 接口报错 {resp.status_code}：{summary}")
            async for line in resp.aiter_lines():
                if not line or line.startswith(":"):
                    continue
                if not line.startswith("data:"):
                    continue
                data = line[5:].lstrip()
                if data == "[DONE]":
                    return
                try:
                    obj = json.loads(data)
                except json.JSONDecodeError:
                    continue  # 单事件解析失败不致命
                usage = obj.get("usage")
                if usage:
                    yield Usage(
                        int(usage.get("prompt_tokens", 0)),
                        int(usage.get("completion_tokens", 0)),
                    )
                try:
                    delta = obj["choices"][0]["delta"].get("content")
                except (KeyError, IndexError):
                    delta = None
                if isinstance(delta, str) and delta:
                    yield delta
    except DeepSeekError:
        raise
    except httpx.HTTPError as e:
        raise DeepSeekError("network", f"无法连通 DeepSeek：{e}") from e


async def stream_with_default_client(
    api_key: str, blocks: list[tuple[str, str]]
) -> AsyncIterator[StreamItem]:
    """生产用便捷包装：每次开一个 httpx client 调上游。
    签名 (api_key, blocks) 对齐 translator 期望的 DeepSeekStream。

    trust_env=False：后端直连 api.deepseek.com（DeepSeek 是中国服务、无需代理），
    避免误用开发机环境里的个人 SOCKS 代理（也省去 socksio 依赖）。"""
    async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=10.0), trust_env=False) as client:
        async for item in stream_content_deltas(client, api_key, blocks):
            yield item
