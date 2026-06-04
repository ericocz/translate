// background service worker：内容脚本通过 chrome.runtime.connect 建立 port，
// 把待译块发过来；这里调用 DeepSeek、把流块按 [[id]] 拼齐后逐块回送。

import { streamTranslate, type DeepSeekClient } from '@/lib/deepseek';
import { getSettings } from '@/lib/storage';
import { PORT_NAME, type BgToContent, type ContentToBg } from '@/lib/messages';
import { cacheGetMany, cacheSetMany } from '@/lib/cache';
import { validateMarkers, allowedIdsFromSource } from '@/lib/markers';
import type { FailureInfo } from '@/lib/types';

export default defineBackground(() => {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PORT_NAME) return;
    let client: DeepSeekClient | null = null;
    let totalBlocks = 0;
    let doneBlocks = 0;

    const send = (msg: BgToContent) => {
      try {
        port.postMessage(msg);
      } catch {
        // port 已断开：直接丢弃即可。
      }
    };

    port.onMessage.addListener(async (msg: ContentToBg) => {
      if (msg.kind === 'cancel') {
        client?.abort();
        client = null;
        return;
      }
      if (msg.kind !== 'start') return;
      if (client) {
        client.abort();
        client = null;
      }
      if (msg.blocks.length === 0) {
        send({ kind: 'done' });
        return;
      }

      totalBlocks = msg.blocks.length;
      doneBlocks = 0;

      // 1) 先查缓存：命中的块直接回传（0 token、毫秒级），只把未命中的交给模型。
      const hitMap = await cacheGetMany(msg.blocks.map((b) => b.source));
      const misses: { id: string; source: string }[] = [];
      for (const b of msg.blocks) {
        const cached = hitMap.get(b.source);
        if (cached !== undefined) {
          doneBlocks++;
          send({ kind: 'block', id: b.id, translated: cached });
        } else {
          misses.push(b);
        }
      }
      send({ kind: 'progress', done: doneBlocks, total: totalBlocks });
      if (misses.length === 0) {
        // 整页全部命中——连 API Key 都不需要。
        send({ kind: 'done' });
        return;
      }

      // 走到这里才需要 API Key。
      const { apiKey } = await getSettings();
      if (!apiKey) {
        send({
          kind: 'error',
          failure: { kind: 'auth', message: '尚未配置 DeepSeek API Key，请到设置页填写。' },
        });
        return;
      }

      // 2) 未命中按 source 去重：同页重复内容（如多处相同按钮 / 文件名）只翻一次。
      const byRepId = new Map<string, { ids: string[]; source: string }>();
      const bySource = new Map<string, { ids: string[]; source: string }>();
      const modelBlocks: { id: string; source: string }[] = [];
      for (const b of misses) {
        const g = bySource.get(b.source);
        if (g) {
          g.ids.push(b.id);
        } else {
          const grp = { ids: [b.id], source: b.source };
          bySource.set(b.source, grp);
          byRepId.set(b.id, grp); // 该组用首个 id 作为发给模型的代表 id
          modelBlocks.push({ id: b.id, source: b.source });
        }
      }

      // 3) 把未命中块分批翻译：单请求块数过多会超出模型输出上限被截断，导致尾部块永远
      //    译不出 / 进不了缓存（实测整页 ~400 块单请求只译出 ~240）。分批（每批 BATCH_SIZE）
      //    + 有限并发，既避免截断又够快；译完批量写缓存，下次刷新即可整页命中、零请求。
      const BATCH_SIZE = 40;
      const CONCURRENCY = 4;
      const batches: { id: string; source: string }[][] = [];
      for (let i = 0; i < modelBlocks.length; i += BATCH_SIZE) {
        batches.push(modelBlocks.slice(i, i + BATCH_SIZE));
      }

      const toCache: { source: string; translated: string }[] = [];
      const activeClients = new Set<DeepSeekClient>();
      let aborted = false;
      let successBlocks = 0;
      let lastFailure: FailureInfo | null = null;

      // 把整批集合包成一个可整体 abort 的 client，挂到外层 client（供 cancel / 断连时中止）。
      const thisRun: DeepSeekClient = {
        abort: () => {
          aborted = true;
          for (const c of activeClients) c.abort();
          activeClients.clear();
        },
      };
      client = thisRun;

      const runBatch = (batch: { id: string; source: string }[]) =>
        new Promise<void>((resolve) => {
          if (aborted) {
            resolve();
            return;
          }
          const c = streamTranslate(apiKey, batch, {
            onBlock: (repId, translated) => {
              const grp = byRepId.get(repId);
              if (!grp) return; // 未知 id（模型乱编）：忽略
              // 把该 source 的译文回传给共享它的所有原始块。
              for (const id of grp.ids) {
                doneBlocks++;
                send({ kind: 'block', id, translated });
              }
              send({ kind: 'progress', done: doneBlocks, total: totalBlocks });
              if (validateMarkers(translated, allowedIdsFromSource(grp.source)).ok) {
                successBlocks++;
                toCache.push({ source: grp.source, translated });
              }
            },
            onDone: () => {
              activeClients.delete(c);
              resolve();
            },
            onError: (failure) => {
              activeClients.delete(c);
              lastFailure = failure; // 单批失败不打断其余批次；其块留待下次刷新按缓存未命中重试
              resolve();
            },
          });
          activeClients.add(c);
        });

      void (async () => {
        let idx = 0;
        const worker = async () => {
          while (idx < batches.length && !aborted) {
            await runBatch(batches[idx++]!);
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(CONCURRENCY, batches.length) }, () => worker())
        );
        if (!aborted) {
          await cacheSetMany(toCache);
          // 全失败才报错；部分成功照常结束（未成功的块留待"重试未完成"或下次刷新）。
          if (successBlocks === 0 && lastFailure) {
            send({ kind: 'error', failure: lastFailure });
          } else {
            send({ kind: 'done' });
          }
        }
        if (client === thisRun) client = null;
      })();
    });

    port.onDisconnect.addListener(() => {
      client?.abort();
      client = null;
    });
  });

  // 工具栏快捷键：整页翻面。
  chrome.commands.onCommand.addListener(async (command) => {
    if (command !== 'toggle-flip') return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    try {
      await chrome.tabs.sendMessage(tab.id, { kind: 'flip-page' });
    } catch {
      // tab 上没有 content script（如 chrome://）—— 忽略。
    }
  });
});
