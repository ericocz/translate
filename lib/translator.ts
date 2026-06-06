// 翻译编排：把一批块从「源」变成「译文回调」，串起缓存 / 去重 / 分批 / 并发四个阶段。
//
// 设计原则：
// - 不依赖任何扩展 API（chrome.*）。只接收「取 apiKey 的回调」「块列表」「结果回调」，
//   因此可在 node 里直接单测，也让 background.ts 退化成薄薄的 port 适配层。
// - 流式：每块译好即回调 onBlock（缓存命中是同步的、模型译出是流式的），不攒批返回。
// - 失败隔离：单批失败不打断其余批次；只有「一块都没成功」才算整体 onError。
// - 可整体 abort：取消 / 断连时中止全部在途请求。

import { streamTranslate, type DeepSeekClient } from './deepseek';
import { cacheGetMany, cacheSetMany } from './cache';
import { validateMarkers, allowedIdsFromSource } from './markers';
import type { FailureInfo } from './types';

// 单请求块数上限：过多会超出模型输出 max_tokens 被截断，导致尾部块永远译不出。
// 实测整页 ~400 块单请求只译出 ~240，故分批 + 有限并发，既避免截断又够快。
const BATCH_SIZE = 40;
const CONCURRENCY = 4;

export interface SourceBlock {
  id: string;
  source: string;
}

export interface JobCallbacks {
  /** 一块译好（缓存命中或模型译出）：把译文回送给该 id。 */
  onBlock: (id: string, translated: string) => void;
  /** 全部结束（可能有零散块未成功，但不算整体失败）。 */
  onDone: () => void;
  /** 整体失败：所有批次都没出货。 */
  onError: (failure: FailureInfo) => void;
}

export interface TranslationJob {
  /** 中止全部在途请求。中止后不再触发任何回调。 */
  abort: () => void;
}

/**
 * 翻译一批块。立即返回可 abort 的 job；结果通过 cb 异步流式回送。
 */
export function translateBlocks(
  getApiKey: () => Promise<string>,
  blocks: SourceBlock[],
  cb: JobCallbacks
): TranslationJob {
  let aborted = false;
  const activeClients = new Set<DeepSeekClient>();
  const job: TranslationJob = {
    abort: () => {
      aborted = true;
      for (const c of activeClients) c.abort();
      activeClients.clear();
    },
  };

  void (async () => {
    if (blocks.length === 0) {
      cb.onDone();
      return;
    }

    // 1) 缓存优先：命中直接回送（0 token、毫秒级），未命中收集起来。
    const misses = await emitCachedAndCollectMisses(blocks, cb);
    if (aborted) return;
    if (misses.length === 0) {
      cb.onDone(); // 整页全命中——连 API Key 都不需要
      return;
    }

    // 走到这里才需要 API Key。
    const apiKey = await getApiKey();
    if (aborted) return;
    if (!apiKey) {
      cb.onError({ kind: 'auth', message: '尚未配置 DeepSeek API Key：请在项目 .env 填入 WXT_DEEPSEEK_API_KEY 后重新构建。' });
      return;
    }

    // 2) 按 source 去重：同页重复内容（相同按钮 / 文件名）只翻一次，译文广播给所有共享块。
    const groups = dedupeBySource(misses);

    // 3) 分批 + 有限并发翻译，校验通过即排入缓存。
    const toCache: { source: string; translated: string }[] = [];
    let successBlocks = 0;
    let lastFailure: FailureInfo | null = null;

    await runBatches(apiKey, groups.modelBlocks, {
      isAborted: () => aborted,
      register: (c) => activeClients.add(c),
      unregister: (c) => activeClients.delete(c),
      onRepBlock: (repId, translated) => {
        const grp = groups.byRepId.get(repId);
        if (!grp) return; // 模型乱编 id：忽略
        for (const id of grp.ids) cb.onBlock(id, translated);
        // 用 source 反推 allowedIds 做与 content 端等价的校验，只缓存合法译文。
        if (validateMarkers(translated, allowedIdsFromSource(grp.source)).ok) {
          successBlocks++;
          // 不缓存「原样回显」：模型偶发把短标签 / 多标记块整段照抄英文返回，
          // 这种空翻译一旦入缓存就会永久命中英文（缓存污染）。只应用不缓存，
          // 下次加载即有机会重译出中文，实现自愈。
          if (!isVerbatimEcho(grp.source, translated)) {
            toCache.push({ source: grp.source, translated });
          }
        }
      },
      onBatchError: (f) => {
        lastFailure = f; // 单批失败不打断其余；其块留待下次刷新按缓存未命中重试
      },
    });
    if (aborted) return;

    await cacheSetMany(toCache);
    // 全失败才报错；部分成功照常结束（未成功的块留待「重试未完成」或下次刷新）。
    if (successBlocks === 0 && lastFailure) cb.onError(lastFailure);
    else cb.onDone();
  })();

  return job;
}

/** 批量查缓存，命中即回送，返回未命中的块。 */
async function emitCachedAndCollectMisses(
  blocks: SourceBlock[],
  cb: JobCallbacks
): Promise<SourceBlock[]> {
  const hitMap = await cacheGetMany(blocks.map((b) => b.source));
  const misses: SourceBlock[] = [];
  for (const b of blocks) {
    const cached = hitMap.get(b.source);
    if (cached !== undefined) cb.onBlock(b.id, cached);
    else misses.push(b);
  }
  return misses;
}

/** 译文是否只是把 source 原样照抄回来（空翻译）：归一化空白后逐字相同即判定。 */
function isVerbatimEcho(source: string, translated: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  return norm(source) === norm(translated);
}

interface SourceGroup {
  ids: string[];
  source: string;
}

/** 按 source 去重：返回发给模型的代表块，与「代表 id → 共享该 source 的所有 id」映射。 */
function dedupeBySource(blocks: SourceBlock[]): {
  modelBlocks: SourceBlock[];
  byRepId: Map<string, SourceGroup>;
} {
  const bySource = new Map<string, SourceGroup>();
  const byRepId = new Map<string, SourceGroup>();
  const modelBlocks: SourceBlock[] = [];
  for (const b of blocks) {
    const g = bySource.get(b.source);
    if (g) {
      g.ids.push(b.id);
      continue;
    }
    const grp: SourceGroup = { ids: [b.id], source: b.source };
    bySource.set(b.source, grp);
    byRepId.set(b.id, grp); // 该组用首个 id 作代表发给模型
    modelBlocks.push({ id: b.id, source: b.source });
  }
  return { modelBlocks, byRepId };
}

interface BatchHooks {
  isAborted: () => boolean;
  register: (c: DeepSeekClient) => void;
  unregister: (c: DeepSeekClient) => void;
  onRepBlock: (repId: string, translated: string) => void;
  onBatchError: (f: FailureInfo) => void;
}

/** 把块切成批，用固定大小的并发池跑完。 */
async function runBatches(
  apiKey: string,
  modelBlocks: SourceBlock[],
  hooks: BatchHooks
): Promise<void> {
  const batches: SourceBlock[][] = [];
  for (let i = 0; i < modelBlocks.length; i += BATCH_SIZE) {
    batches.push(modelBlocks.slice(i, i + BATCH_SIZE));
  }
  let idx = 0;
  const worker = async () => {
    while (idx < batches.length && !hooks.isAborted()) {
      await runOneBatch(apiKey, batches[idx++]!, hooks);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, batches.length) }, () => worker())
  );
}

/** 跑单批：把流块回调出去，批结束 / 失败时 resolve。 */
function runOneBatch(apiKey: string, batch: SourceBlock[], hooks: BatchHooks): Promise<void> {
  return new Promise<void>((resolve) => {
    if (hooks.isAborted()) {
      resolve();
      return;
    }
    const c = streamTranslate(apiKey, batch, {
      onBlock: hooks.onRepBlock,
      onDone: () => {
        hooks.unregister(c);
        resolve();
      },
      onError: (failure) => {
        hooks.unregister(c);
        hooks.onBatchError(failure);
        resolve();
      },
    });
    hooks.register(c);
  });
}
