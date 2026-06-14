import asyncio
from dataclasses import dataclass
from typing import AsyncIterator, Callable

from app.core.tokens import estimate_tokens
from app.services.block_splitter import BlockSplitter
from app.services.deepseek import MAX_OUTPUT_TOKENS, Usage
from app.services.markers import allowed_ids_from_source, validate_markers

# 单请求「估算输出 token」预算：装箱上限。校准为 = deepseek.MAX_OUTPUT_TOKENS（384000，V4 Flash 输出上限），
# 即对任何现实网页都装一箱、全文单次请求（D-12）；仅当整页估算输出超模型上限才分片（≈25 万词，网页不可达）。
OUTPUT_TOKEN_BUDGET = MAX_OUTPUT_TOKENS
CONCURRENCY = 4


def batch_by_token_budget(
    blocks: list[tuple[str, str]], budget: int
) -> list[list[tuple[str, str]]]:
    """按估算输出 token 把 (id, source) 块顺序装箱，每箱累计 estimate_tokens(source) ≤ budget。

    - 译文与原文 token 量级相当，故用 estimate_tokens(source) 代理输出量；budget 已留安全余量。
    - 单块自身超 budget：独占一箱（块是原子的，拆块会破坏 <gN> 标记）。
    - 空输入 → []。
    """
    batches: list[list[tuple[str, str]]] = []
    current: list[tuple[str, str]] = []
    current_tokens = 0
    for bid, src in blocks:
        t = estimate_tokens(src)
        if current and current_tokens + t > budget:
            batches.append(current)
            current = []
            current_tokens = 0
        current.append((bid, src))
        current_tokens += t
    if current:
        batches.append(current)
    return batches


@dataclass(frozen=True)
class SourceBlock:
    id: str
    source: str


@dataclass(frozen=True)
class BlockEvent:
    id: str
    translated: str


@dataclass(frozen=True)
class DoneEvent:
    pass


@dataclass(frozen=True)
class ErrorEvent:
    kind: str
    message: str


@dataclass(frozen=True)
class UsageEvent:
    """本次请求应计入用户当日用量的 token（接口真实 usage 优先，缺失时本地估算兜底）。"""

    input_tokens: int
    output_tokens: int


Event = BlockEvent | DoneEvent | ErrorEvent | UsageEvent

# deepseek_stream(api_key, blocks) -> 逐个 yield content delta 文本
DeepSeekStream = Callable[[str, list[tuple[str, str]]], AsyncIterator[str]]


async def translate(
    blocks: list[SourceBlock],
    *,
    deepseek_stream: DeepSeekStream,
    api_key: str,
) -> AsyncIterator[Event]:
    """去重 → token 预算装箱 + 有限并发 → 切块 → 标记校验 → 逐块 yield 事件。

    D-11：服务端不再持有缓存（隐私=不留存用户内容）；客户端 IndexedDB 命中的块根本不发到这里。
    服务端只翻译收到的块、只对实际翻译的用量记账（接口 usage 优先，缺失时本地估算兜底）。
    - 流式：每块译好即 yield（经 queue 合流）。
    - 失败隔离：单批失败不打断其余；只有「一块都没成功」才整体 ErrorEvent。
    - 原样回显 / 校验不过的块：仍回送（客户端再校验）。
    """
    if not blocks:
        yield DoneEvent()
        return

    # 1) 按 source 去重：代表块发模型，译文广播给共享同 source 的所有 id
    by_source: dict[str, list[str]] = {}
    rep_source: dict[str, str] = {}  # rep_id -> source
    model_blocks: list[tuple[str, str]] = []
    for b in blocks:
        if b.source in by_source:
            by_source[b.source].append(b.id)
            continue
        by_source[b.source] = [b.id]
        rep_source[b.id] = b.source
        model_blocks.append((b.id, b.source))

    # 2) 按 token 预算装箱 + 有限并发，结果经 queue 合流回送
    batches = batch_by_token_budget(model_blocks, OUTPUT_TOKEN_BUDGET)
    queue: asyncio.Queue = asyncio.Queue()
    sem = asyncio.Semaphore(CONCURRENCY)
    success = 0
    last_error: ErrorEvent | None = None
    used_in = 0
    used_out = 0

    async def run_batch(batch: list[tuple[str, str]]) -> None:
        nonlocal success, last_error, used_in, used_out
        async with sem:
            collected: list[tuple[str, str]] = []
            splitter = BlockSplitter(lambda i, t: collected.append((i, t)))
            batch_usage: Usage | None = None
            try:
                async for item in deepseek_stream(api_key, batch):
                    if isinstance(item, Usage):
                        batch_usage = item  # 最后一块的真实用量
                    else:
                        splitter.feed(item)
                splitter.flush()
            except Exception as e:  # DeepSeekError 等：单批失败不打断其余
                last_error = ErrorEvent(getattr(e, "kind", "unknown"), getattr(e, "message", str(e)))
                return
            est_in = 0
            est_out = 0
            for rep_id, translated in collected:
                source = rep_source.get(rep_id)
                if source is None:
                    continue  # 模型乱编 id：忽略
                for bid in by_source[source]:
                    await queue.put(BlockEvent(bid, translated))
                if validate_markers(translated, allowed_ids_from_source(source)).ok:
                    success += 1
                est_in += estimate_tokens(source)
                est_out += estimate_tokens(translated)
            # 记账：优先真实 usage；接口没给时回退本地估算之和。
            if batch_usage is not None:
                used_in += batch_usage.input_tokens
                used_out += batch_usage.output_tokens
            else:
                used_in += est_in
                used_out += est_out

    async def producer() -> None:
        await asyncio.gather(*(run_batch(b) for b in batches))
        await queue.put(None)  # 哨兵：通知消费端结束

    task = asyncio.create_task(producer())
    while True:
        item = await queue.get()
        if item is None:
            break
        yield item
    await task

    yield UsageEvent(used_in, used_out)
    # 全失败才报错；部分成功照常结束（未成功的块留待下次刷新重试）。
    if success == 0 and last_error is not None:
        yield last_error
    else:
        yield DoneEvent()
