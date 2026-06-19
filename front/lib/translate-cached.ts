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
import type { FailureInfo } from './types';

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
  // 只覆盖关心的依赖（如仅换 server 客户端），其余取默认实现。
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

/**
 * 按结构区域并发翻译：正文(content) 与外框(chrome) 各起一条独立 job，正文优先。
 * **传输分流**：正文走 SSE（流式逐块淡入、首屏「秒懂」），外框走普通 HTTP（量小、不在视线焦点，
 * 不值一条长连接）——由 makeJob 的 stream 参数表达（content=true / chrome=false），具体 server 客户端
 * 由 background 注入（SSE / HTTP）。
 * 上层（background→content）只见「一个 job、一个 done/error」，finalizeJob/重试/SPA 均无需改动。
 *
 * 优先级：正文 job 立即起；chrome 由「正文首段已回填」**或正文 settle**（onDone/onError）放行
 * 后再起 → 用户在读的正文先出，导航/页脚慢半拍没人在意（对得起「秒懂」）。
 * chromeDelayMs 不是抢跑闸而是**防卡死兜底**：仅当正文 job 迟迟既不吐块也不结束（极少：网络挂起）
 * 才到点放行 chrome，故取较大值。实测教训：早期取 700ms 会让短小的导航块抢在长段落正文前先上色，
 * 把「正文优先」翻转——务必 > 正文首段的现实到达时间。
 *
 * 终态聚合（两路皆 settle 后只发一个）：
 *  · 任一路系统性错误(quota/auth：账号级、两路必同时触发) → 报该错（popup 引导登录/充值）；
 *  · 否则正文路出错(network/api/unknown，即正文整组全失败) → 报该错（popup 说人话）；
 *  · 否则外框路出错(整组全失败) → 同样报该错（与正文对齐，popup 弹红+引导，不再静默吞掉）；
 *  · 否则 → done。两路各自没译成的**部分**块，由上层 finalizeJob 统一挂「重试翻译」按钮（不分区）。
 *
 * makeJob：起一条 job 的工厂（注入 translateWithCache + pageKey/deps/bypassCache）。各路自带缓存层。
 * 第三参 stream 标识该路是否走 SSE（正文 true / 外框 false），由 background 据此选平台 server 客户端。
 */
export function translateByRegion(
  content: ApiBlock[],
  chrome: ApiBlock[],
  handlers: ApiHandlers,
  makeJob: (blocks: ApiBlock[], h: ApiHandlers, stream: boolean) => ApiClient,
  chromeDelayMs = 8000
): ApiClient {
  let aborted = false;
  let finished = false;
  let contentJob: ApiClient | null = null;
  let chromeJob: ApiClient | null = null;
  let chromeTimer: ReturnType<typeof setTimeout> | null = null;
  let chromeStarted = false;

  let contentSettled = content.length === 0;
  let chromeSettled = chrome.length === 0;
  // 外框默认走非流式 HTTP（量小、不在焦点）；但**整页只有外框**（无正文）时它就是用户唯一在看的内容，
  // 降级成走 SSE 拿回逐块淡入「秒懂」体感（content 为空 = 纯导航/着陆页/仪表盘）。
  const chromeStream = content.length === 0;
  let contentError: FailureInfo | null = null;
  let chromeError: FailureInfo | null = null;

  const systemic = (e: FailureInfo | null): e is FailureInfo =>
    !!e && (e.kind === 'quota' || e.kind === 'auth');

  const finalize = () => {
    if (finished || aborted || !contentSettled || !chromeSettled) return;
    finished = true;
    if (systemic(contentError)) handlers.onError(contentError);
    else if (systemic(chromeError)) handlers.onError(chromeError);
    else if (contentError) handlers.onError(contentError);
    else if (chromeError) handlers.onError(chromeError);
    else handlers.onDone();
  };

  const startChrome = () => {
    if (chromeStarted || aborted || chrome.length === 0) return;
    chromeStarted = true;
    if (chromeTimer) {
      clearTimeout(chromeTimer);
      chromeTimer = null;
    }
    chromeJob = makeJob(chrome, {
      // 外框默认非流式 HTTP（stream=false）；纯外框页（无正文）升级为 SSE（chromeStream）。
      onBlock: handlers.onBlock,
      onDone: () => {
        chromeSettled = true;
        finalize();
      },
      onError: (f) => {
        chromeError = f;
        chromeSettled = true;
        finalize();
      },
    }, chromeStream);
  };

  if (content.length > 0) {
    let firstSeen = false;
    contentJob = makeJob(content, {
      // 正文走 SSE（stream=true）：逐块流式淡入、首屏「秒懂」。
      onBlock: (id, t) => {
        handlers.onBlock(id, t);
        if (!firstSeen) {
          firstSeen = true;
          startChrome(); // 正文首段已出，放行 chrome
        }
      },
      onDone: () => {
        contentSettled = true;
        startChrome();
        finalize();
      },
      onError: (f) => {
        contentError = f;
        contentSettled = true;
        startChrome();
        finalize();
      },
    }, true);
    // 防卡死兜底（非抢跑）：正文 job 病态挂起（既不吐块也不 settle）时才到点放行 chrome。
    // 正常路径由上面 onBlock 首段 / onDone / onError 先放行，远早于此。
    if (chrome.length > 0) chromeTimer = setTimeout(startChrome, chromeDelayMs);
  } else {
    startChrome();
  }

  if (content.length === 0 && chrome.length === 0) handlers.onDone();

  return {
    abort: () => {
      aborted = true;
      if (chromeTimer) {
        clearTimeout(chromeTimer);
        chromeTimer = null;
      }
      contentJob?.abort();
      chromeJob?.abort();
    },
  };
}
