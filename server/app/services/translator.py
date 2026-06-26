import asyncio
from dataclasses import dataclass
from typing import AsyncIterator, Callable

from app.core.tokens import estimate_tokens
from app.services.block_splitter import BlockSplitter
from app.services.deepseek import Usage
from app.services.markers import allowed_ids_from_source, validate_markers

# 单请求「估算输出 token」装箱软上限：整页按此切多箱、有限并发跑（见下 CONCURRENCY）。
# 刻意 << deepseek.MAX_OUTPUT_TOKENS（384000）——后者是单请求截断硬顶（防爆），这里是「为响应速度切多批」的软上限。
# 为什么不再「全文单请求」（原 D-12 已反转）：一个巨请求 = 巨 prompt 预填 + 整页输出串行生成 →
#   首屏要干等数秒、墙钟≈全页输出 token 顺序生成。切成多个 ~BUDGET 小批并发后：
#   · 首批（页面顶部）秒级回 → 体感「秒懂」；· 墙钟≈全页 ÷ 并发数（长页约 4× 提速）；
#   · 短生成比一次性生成两万 token 更不易漏块/截断（可靠性反升）。
# 取值权衡：太小→请求数多 + 跨块上下文碎（一致性略降）；太大→退化回串行慢。1500≈数段，留足局部上下文；
# 跨段术语一致性靠逐字节稳定的系统提示词钉死，受切批影响很小。
# 成本几乎不变：每批重发的系统提示词走前缀缓存命中价（1/50），原文每块仍只发一次，输出 token 总量不变。
# 小页（整页估算 < BUDGET）仍只装一箱（本就快，无需切）。
OUTPUT_TOKEN_BUDGET = 1500
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
    """本次请求应计入的 token（接口真实 usage 优先，缺失时本地估算兜底）。
    输入按前缀缓存命中拆两档（计价不同）；本地估算兜底时全算未命中（不少收成本）。"""

    input_miss_tokens: int
    input_hit_tokens: int
    output_tokens: int

    @property
    def input_tokens(self) -> int:
        """daily_usage 统计用的输入总量（命中+未命中）。"""
        return self.input_miss_tokens + self.input_hit_tokens


Event = BlockEvent | DoneEvent | ErrorEvent | UsageEvent

# deepseek_stream(api_key, blocks, *, target="zh") -> 逐个 yield content delta 文本
# （target 为关键字参，Callable 类型无法表达 kw-only，此处仅标位置参签名。）
DeepSeekStream = Callable[[str, list[tuple[str, str]]], AsyncIterator[str]]


async def translate(
    blocks: list[SourceBlock],
    *,
    deepseek_stream: DeepSeekStream,
    api_key: str,
    target: str = "zh",
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
    used_miss = 0
    used_hit = 0
    used_out = 0

    async def run_batch(batch: list[tuple[str, str]]) -> None:
        nonlocal success, last_error, used_miss, used_hit, used_out
        async with sem:
            collected: list[tuple[str, str]] = []

            # 切出一块即刻入队广播——这是「逐块流式」的关键：BlockSplitter 在流中识别出完整块
            # 就回调，这里立即 put_nowait 到合流队列、客户端随即收到该块。
            # ⚠️ 绝不能改回「回调只 append、整批流完再统一入队」：那会让整批译文在批末一次性涌出
            #（实测回归：12 块全挤在 6.4s 末尾 2ms 内到达，体感「一下子全部翻译完」）。queue 无界，put_nowait 不阻塞。
            def on_block(rep_id: str, translated: str) -> None:
                collected.append((rep_id, translated))
                source = rep_source.get(rep_id)
                if source is None:
                    return  # 模型乱编 id：忽略
                for bid in by_source[source]:
                    queue.put_nowait(BlockEvent(bid, translated))

            splitter = BlockSplitter(on_block)
            batch_usage: Usage | None = None
            try:
                async for item in deepseek_stream(api_key, batch, target=target):
                    if isinstance(item, Usage):
                        batch_usage = item  # 最后一块的真实用量
                    else:
                        splitter.feed(item)
                splitter.flush()
            except Exception as e:  # DeepSeekError 等：单批失败不打断其余
                last_error = ErrorEvent(getattr(e, "kind", "unknown"), getattr(e, "message", str(e)))
                return
            # 批末统计：成功块计数 + 本地估算兜底用量（入队广播已在 on_block 即时完成）。
            est_in = 0
            est_out = 0
            for rep_id, translated in collected:
                source = rep_source.get(rep_id)
                if source is None:
                    continue  # 模型乱编 id：忽略
                if validate_markers(translated, allowed_ids_from_source(source)).ok:
                    success += 1
                est_in += estimate_tokens(source)
                est_out += estimate_tokens(translated)
            # 记账：优先真实 usage（含命中/未命中拆分）；接口没给时回退本地估算（全算未命中）。
            if batch_usage is not None:
                used_miss += batch_usage.input_miss_tokens
                used_hit += batch_usage.input_hit_tokens
                used_out += batch_usage.output_tokens
            else:
                used_miss += est_in
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

    yield UsageEvent(used_miss, used_hit, used_out)
    # 全失败才报错；部分成功照常结束（未成功的块留待下次刷新重试）。
    if success == 0 and last_error is not None:
        yield last_error
    else:
        yield DoneEvent()
