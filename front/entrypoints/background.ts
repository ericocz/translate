// background service worker：
//  ① 翻译 port（薄适配层）——内容脚本把待译块发来，委托 translateBlocks 编排，逐块回送；
//  ② 工具栏图标两态——按 tab 显示 未开启 / 已开启翻译（只反映白名单，不随翻译进度变化）；
//  ③ 工具栏快捷键——翻译 / 取消翻译当前网站。
// 不含任何翻译业务逻辑（都在后端 /v1/translate）。

import { type ApiClient } from '@/lib/api';
import { translateWithCache } from '@/lib/translate-cached';
import { pageKeyFromUrl } from '@/lib/device';
import { track, reportError } from '@/lib/telemetry';
import { isDomainEnabled, setDomainEnabled, onSettingsChanged } from '@/lib/storage';
import {
  PORT_NAME,
  type BgToContent,
  type ContentToBg,
  type SpaNavigatedMsg,
} from '@/lib/messages';
import { setTabIcon, hostOf } from '@/lib/icon';

export default defineBackground(() => {
  /** 刷新某 tab 的图标：按域名是否在白名单显示 on/off（只有这两态）。 */
  async function refreshTabIcon(tabId: number, domain?: string): Promise<void> {
    let host = domain;
    if (host === undefined) {
      try {
        host = hostOf((await chrome.tabs.get(tabId)).url);
      } catch {
        return; // tab 已不存在
      }
    }
    const enabled = host ? await isDomainEnabled(host) : false;
    await setTabIcon(tabId, enabled ? 'on' : 'off');
  }

  /** 给所有 tab 刷新基线图标（白名单变化、SW 启动时用）。 */
  async function refreshAllTabs(): Promise<void> {
    let tabs: chrome.tabs.Tab[];
    try {
      tabs = await chrome.tabs.query({});
    } catch {
      return;
    }
    for (const t of tabs) {
      if (t.id !== undefined) await refreshTabIcon(t.id, hostOf(t.url));
    }
  }

  // ---- ① 翻译 port：内容脚本发来待译块，委托 translateWithCache 编排、逐块回送 ----
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PORT_NAME) return;
    const domain = hostOf(port.sender?.url);
    let job: ApiClient | null = null;

    const send = (msg: BgToContent) => {
      try {
        port.postMessage(msg);
      } catch {
        // port 已断开：直接丢弃即可。
      }
    };

    port.onMessage.addListener((msg: ContentToBg) => {
      if (msg.kind === 'cancel') {
        job?.abort();
        job = null;
        return;
      }
      if (msg.kind !== 'start') return;

      job?.abort(); // 新请求到来：先中止上一轮
      const startedAt = Date.now();
      track('translate_start', domain ?? null, { blocks: msg.blocks.length });
      const thisJob: ApiClient = translateWithCache(
        msg.blocks,
        pageKeyFromUrl(port.sender?.url),
        {
          onBlock: (id, translated) => send({ kind: 'block', id, translated }),
          onDone: () => {
            if (job === thisJob) job = null;
            track('translate_done', domain ?? null, {
              blocks: msg.blocks.length,
              ms: Date.now() - startedAt,
            });
            send({ kind: 'done' });
          },
          onError: (failure) => {
            if (job === thisJob) job = null;
            track('translate_error', domain ?? null, { kind: failure.kind });
            reportError(failure.kind, failure.message, { host: domain ?? null });
            send({ kind: 'error', failure });
          },
        },
        undefined,
        msg.bypassCache
      );
      job = thisJob;
    });

    port.onDisconnect.addListener(() => {
      job?.abort();
      job = null;
    });
  });

  // ---- ② 工具栏快捷键：翻译 / 取消翻译当前网站（与 popup 主按钮同一路径） ----
  chrome.commands.onCommand.addListener(async (command) => {
    if (command !== 'toggle-site') return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) return;
    const domain = hostOf(tab.url);
    if (!domain) return; // chrome:// / data: 等非普通页面
    const next = !(await isDomainEnabled(domain));
    await setDomainEnabled(domain, next);
    try {
      await chrome.tabs.sendMessage(tab.id, { kind: 'toggle-site', enabled: next });
    } catch {
      // 该 tab 无 content script（如 chrome://）—— 白名单已写入，忽略即可。
    }
    // 图标基线随白名单变化由下面的 onSettingsChanged 统一刷新。
  });

  // ---- ③ 图标基线刷新：白名单变化 / 切 tab / tab 加载完成 / SW 启动 ----
  onSettingsChanged(() => void refreshAllTabs());

  chrome.tabs.onActivated.addListener(({ tabId }) => void refreshTabIcon(tabId));

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' || changeInfo.url) {
      void refreshTabIcon(tabId, hostOf(tab.url));
    }
  });

  chrome.runtime.onInstalled.addListener(() => void refreshAllTabs());
  chrome.runtime.onStartup.addListener(() => void refreshAllTabs());

  // ---- ④ SPA 同文档导航（pushState/replaceState）：通知 content 对新路由重译 ----
  // content script 只在文档加载时注入一次；Next.js 等 App Router 点链接走 History API、
  // 不重载文档，故内容脚本侧没有触发器。这里监听同文档导航，仅主框架 + 白名单站点才下发。
  chrome.webNavigation.onHistoryStateUpdated.addListener(async ({ tabId, frameId, url }) => {
    if (frameId !== 0) return; // 仅主框架，忽略 iframe
    const domain = hostOf(url);
    if (!domain || !(await isDomainEnabled(domain))) return; // 仅白名单站点
    try {
      await chrome.tabs.sendMessage(tabId, { kind: 'spa-navigated', url } satisfies SpaNavigatedMsg);
    } catch {
      // 该 tab 没有 content script（或尚未就绪）—— 忽略。
    }
  });
});
