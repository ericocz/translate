// background service worker：
//  ① 翻译 port（薄适配层）——内容脚本把待译块发来，委托 translateBlocks 编排，逐块回送；
//  ② 工具栏图标三态——按 tab 维护 未开启/已开启/翻译中/出错，让你在工具栏一眼看出某站点状态；
//  ③ 工具栏快捷键——翻译 / 取消翻译当前网站。
// 不含任何翻译业务逻辑（都在 lib/translator.ts）。

import { translateBlocks, type TranslationJob } from '@/lib/translator';
import { DEEPSEEK_API_KEY } from '@/lib/config';
import { isDomainEnabled, setDomainEnabled, onSettingsChanged } from '@/lib/storage';
import { PORT_NAME, type BgToContent, type ContentToBg } from '@/lib/messages';
import { setTabIcon, hostOf } from '@/lib/icon';

export default defineBackground(() => {
  // 「翻译中 / 出错」是按 tab 的临时叠加态；基线 on/off 永远由白名单决定。
  const overlay = new Map<number, 'translating' | 'error'>();

  /** 刷新某 tab 的图标：有叠加态优先显示，否则按域名是否在白名单显示 on/off。 */
  async function refreshTabIcon(tabId: number, domain?: string): Promise<void> {
    const ov = overlay.get(tabId);
    if (ov) {
      await setTabIcon(tabId, ov);
      return;
    }
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

  // ---- ① 翻译 port，顺带驱动 翻译中/出错/完成 的图标叠加态 ----
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PORT_NAME) return;
    const tabId = port.sender?.tab?.id;
    const domain = hostOf(port.sender?.url);
    let job: TranslationJob | null = null;

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
        if (tabId !== undefined) {
          overlay.delete(tabId);
          void refreshTabIcon(tabId, domain);
        }
        return;
      }
      if (msg.kind !== 'start') return;

      job?.abort(); // 新请求到来：先中止上一轮
      if (tabId !== undefined) {
        overlay.set(tabId, 'translating');
        void setTabIcon(tabId, 'translating');
      }
      const thisJob: TranslationJob = translateBlocks(
        async () => DEEPSEEK_API_KEY,
        msg.blocks,
        {
          onBlock: (id, translated) => send({ kind: 'block', id, translated }),
          onDone: () => {
            if (job === thisJob) job = null;
            if (tabId !== undefined) {
              overlay.delete(tabId);
              void refreshTabIcon(tabId, domain);
            }
            send({ kind: 'done' });
          },
          onError: (failure) => {
            if (job === thisJob) job = null;
            if (tabId !== undefined) {
              overlay.set(tabId, 'error');
              void setTabIcon(tabId, 'error');
            }
            send({ kind: 'error', failure });
          },
        }
      );
      job = thisJob;
    });

    port.onDisconnect.addListener(() => {
      job?.abort();
      job = null;
      // 页面卸载 / 导航：清掉叠加态，重新加载后按白名单显示基线。
      if (tabId !== undefined) overlay.delete(tabId);
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
    // 开始导航：旧的翻译叠加态作废。
    if (changeInfo.status === 'loading' && changeInfo.url) overlay.delete(tabId);
    if (changeInfo.status === 'complete' || changeInfo.url) {
      void refreshTabIcon(tabId, hostOf(tab.url));
    }
  });

  chrome.runtime.onInstalled.addListener(() => void refreshAllTabs());
  chrome.runtime.onStartup.addListener(() => void refreshAllTabs());
});
