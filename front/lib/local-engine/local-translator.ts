// BYOK 本地翻译编排（对应后端 server/app/services/translator.py，但跑在扩展 SW、TS 实现）。
//
// 角色对等：BYOK 下 SW 接管「后端的角色」——与后端一样只处理带 <gN> 标记的文本、不碰 styleMap。
// 复用 content 侧的 extractor/markers/rebuilder 不变；新增的只是这套「本地翻译引擎」。
//
// 产出与 lib/api.ts 的 translateViaBackend 同形的 ApiClient（{abort} + ApiHandlers 回调），
// 故可直接当作 translate-cached.ts 的 deps.server 塞进去——本地缓存层对 BYOK 译文同样生效。

import type { ApiBlock, ApiClient, ApiHandlers } from '../api';
import type { FailureInfo, FailureKind } from '../types';
import { allowedIdsFromSource, validateMarkers } from '../markers';
import { createSseParser } from '../sse';
import { BlockSplitter } from './block-splitter';
import { estimateTokens } from './estimate-tokens';
import { systemPrompt } from './prompt';
import { adapterFor } from './providers';
import type { ProviderConfig } from './types';

/** 按估算输出 token 把块顺序装箱，每箱累计 estimateTokens(source) ≤ budget（对应后端 batch_by_token_budget）。
 *  单块自身超 budget 时独占一箱（块是原子的，拆块会破坏 <gN> 标记）。 */
export function batchByTokenBudget(blocks: ApiBlock[], budget: number): ApiBlock[][] {
  const batches: ApiBlock[][] = [];
  let current: ApiBlock[] = [];
  let currentTokens = 0;
  for (const b of blocks) {
    const t = estimateTokens(b.source);
    if (current.length > 0 && currentTokens + t > budget) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(b);
    currentTokens += t;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** 本次翻译的降级统计：success/total 供 §7.4 降级率反馈用。 */
export interface LocalStats {
  total: number;
  success: number;
}

/** BYOK 直连翻译一批块；返回可 abort 的 client，结果经 handlers 流式回调。
 *  onStats（可选）在结束前回传降级统计。 */
export function translateLocal(
  blocks: ApiBlock[],
  cfg: ProviderConfig,
  handlers: ApiHandlers,
  onStats?: (s: LocalStats) => void
): ApiClient {
  const controller = new AbortController();

  void (async () => {
    if (blocks.length === 0) {
      handlers.onDone();
      return;
    }

    // 1) 按 source 去重：代表块发模型，译文广播给共享同 source 的所有 id。
    const bySource = new Map<string, string[]>();
    const repSource = new Map<string, string>(); // repId -> source
    const modelBlocks: ApiBlock[] = [];
    for (const b of blocks) {
      const ids = bySource.get(b.source);
      if (ids) {
        ids.push(b.id);
        continue;
      }
      bySource.set(b.source, [b.id]);
      repSource.set(b.id, b.source);
      modelBlocks.push(b);
    }

    // 2) 装箱 + 有限并发。
    const batches = batchByTokenBudget(modelBlocks, cfg.batchBudget);
    const adapter = adapterFor(cfg.format);
    const sys = systemPrompt(cfg.promptLang);

    let success = 0;
    let total = 0;
    let lastError: FailureInfo | null = null;

    const runBatch = async (batch: ApiBlock[]): Promise<void> => {
      let resp: Response;
      try {
        resp = await fetch(cfg.endpoint, {
          method: 'POST',
          headers: adapter.headers(cfg),
          body: JSON.stringify(adapter.buildBody(cfg, sys, batch)),
          signal: controller.signal,
        });
      } catch (e) {
        if (controller.signal.aborted) return;
        lastError = classifyNetwork(e, cfg);
        return;
      }
      if (resp.status === 401 || resp.status === 403) {
        lastError = { kind: 'auth', message: `${cfg.label}：API Key 无效或无权限（${resp.status}）` };
        return;
      }
      if (!resp.ok) {
        lastError = { kind: 'api', message: `${cfg.label} 接口报错 ${resp.status}` };
        return;
      }
      if (!resp.body) {
        lastError = { kind: 'api', message: `${cfg.label} 无响应体` };
        return;
      }

      // 切块：splitter 回调里就地校验 + 广播给同 source 的所有 id。
      const splitter = new BlockSplitter((repId, translated) => {
        const source = repSource.get(repId);
        if (source === undefined) return; // 模型乱编 id：忽略
        for (const bid of bySource.get(source)!) handlers.onBlock(bid, translated);
        total += 1;
        if (validateMarkers(translated, allowedIdsFromSource(source)).ok) success += 1;
      });

      const parser = createSseParser((ev) => {
        const parsed = adapter.parseEvent(ev.data);
        if (parsed?.delta) splitter.feed(parsed.delta);
        // usage 本路径不计费（BYOK 平台零成本），仅可作统计；此处不必累计。
      });

      try {
        const reader = resp.body.getReader();
        const decoder = new TextDecoder('utf-8');
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parser.feed(decoder.decode(value, { stream: true }));
        }
        parser.flush();
        splitter.flush();
      } catch (e) {
        if (controller.signal.aborted) return;
        lastError = classifyNetwork(e, cfg); // 流中断
      }
    };

    // 有限并发池：本地模型 cfg.concurrency=1 即串行。
    await runWithConcurrency(batches, Math.max(1, cfg.concurrency), runBatch);

    if (controller.signal.aborted) return;
    onStats?.({ total, success });

    // 全失败才报错；部分成功照常结束（未成功的块留待下次刷新重试）。
    if (success === 0 && lastError !== null) handlers.onError(lastError);
    else handlers.onDone();
  })();

  return { abort: () => controller.abort() };
}

/** 把 translateLocal 包成与 translateViaBackend 同形的 server 函数（pageKey 对 BYOK 无意义、忽略）。 */
export function makeLocalServer(
  cfg: ProviderConfig,
  onStats?: (s: LocalStats) => void
): (blocks: ApiBlock[], pageKey: string, handlers: ApiHandlers) => ApiClient {
  return (blocks, _pageKey, handlers) => translateLocal(blocks, cfg, handlers, onStats);
}

/** 有限并发执行：同时最多 limit 个 worker 从队列取任务。单任务自行吞错（失败隔离）。 */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  const run = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

function classifyNetwork(e: unknown, cfg: ProviderConfig): FailureInfo {
  const msg = e instanceof Error ? e.message : String(e);
  const kind: FailureKind = 'network';
  // 本地 endpoint 连不上：多半本地服务（如 ollama）未启动。
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)/.test(cfg.endpoint);
  const hint = isLocal ? `（本地服务未启动？${cfg.endpoint}）` : `（${cfg.label}）`;
  return { kind, message: `无法连通模型${hint}：${msg}` };
}
