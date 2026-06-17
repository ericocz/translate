// 本地缓存优先的翻译编排（D-11b）：
//  ① 读设置：缓存关 → 直接走服务端（旧行为，零差异）。
//  ② 缓存开 → 批量查本地：命中块立即 onBlock（不发服务端、不计费）；未命中块发服务端；
//     服务端回的块（标记校验通过者）done/error 时批量写回本地。
//  ③ 全命中 → 根本不发服务端，直接 onDone。
// 只替换 background 的调用入口；DOM 抽取/校验/重建/淡入仍在 content，铁律不变。

import { translateViaBackend, type ApiBlock, type ApiClient, type ApiHandlers } from './api';
import { cacheGetMany, cachePutMany } from './local-cache';
import { getCacheEnabled } from './storage';
import { allowedIdsFromSource, validateMarkers } from './markers';

/** 仅缓存通过标记校验的译文：坏标记若被缓存，下次「命中」会让该块永远停在英文。 */
function cacheable(source: string, translated: string): boolean {
  return validateMarkers(translated, allowedIdsFromSource(source)).ok;
}

/** 按本地缓存命中拆分 blocks（纯函数，便于单测）。 */
export function partitionByCache(
  blocks: ApiBlock[],
  hits: Map<string, string>
): { hitBlocks: { id: string; translated: string }[]; misses: ApiBlock[] } {
  const hitBlocks: { id: string; translated: string }[] = [];
  const misses: ApiBlock[] = [];
  for (const b of blocks) {
    const t = hits.get(b.source);
    if (t !== undefined) hitBlocks.push({ id: b.id, translated: t });
    else misses.push(b);
  }
  return { hitBlocks, misses };
}

/** 可注入依赖（生产用默认实现；单测可替身）。 */
export interface CacheDeps {
  getEnabled: () => Promise<boolean>;
  getMany: (sources: string[]) => Promise<Map<string, string>>;
  putMany: (items: { source: string; translated: string }[]) => Promise<void>;
  server: typeof translateViaBackend;
}

const defaultDeps: CacheDeps = {
  getEnabled: getCacheEnabled,
  getMany: cacheGetMany,
  putMany: cachePutMany,
  server: translateViaBackend,
};

/** 与 translateViaBackend 同形（返回 {abort}）：可直接替换 background 的调用。
 *  bypassCache=true 时跳过本地缓存查询、整批直接发服务端（重试带上下文用）；成功译文照常写回缓存。 */
export function translateWithCache(
  blocks: ApiBlock[],
  pageKey: string,
  handlers: ApiHandlers,
  deps: Partial<CacheDeps> = {},
  bypassCache = false
): ApiClient {
  // 只覆盖关心的依赖（如 BYOK 仅换 server），其余取默认实现。
  const d: CacheDeps = { ...defaultDeps, ...deps };
  let inner: ApiClient | null = null;
  let aborted = false;

  void (async () => {
    let enabled = true;
    try {
      enabled = await d.getEnabled();
    } catch {
      enabled = true;
    }
    if (aborted) return;
    if (!enabled) {
      inner = d.server(blocks, pageKey, handlers);
      return;
    }

    let hits = new Map<string, string>();
    if (!bypassCache) {
      try {
        hits = await d.getMany(blocks.map((b) => b.source));
      } catch {
        hits = new Map();
      }
    }
    if (aborted) return;

    const { hitBlocks, misses } = partitionByCache(blocks, hits);
    for (const h of hitBlocks) handlers.onBlock(h.id, h.translated);

    if (misses.length === 0) {
      handlers.onDone();
      return;
    }

    const srcById = new Map(misses.map((b) => [b.id, b.source]));
    const writeback: { source: string; translated: string }[] = [];

    inner = d.server(misses, pageKey, {
      onBlock: (id, translated) => {
        handlers.onBlock(id, translated);
        const source = srcById.get(id);
        if (source !== undefined && cacheable(source, translated)) {
          writeback.push({ source, translated });
        }
      },
      onDone: () => {
        if (writeback.length) void d.putMany(writeback);
        handlers.onDone();
      },
      onError: (failure) => {
        // 部分成功也写回，不浪费已译好的块。
        if (writeback.length) void d.putMany(writeback);
        handlers.onError(failure);
      },
    });
  })();

  return {
    abort: () => {
      aborted = true;
      inner?.abort();
    },
  };
}
