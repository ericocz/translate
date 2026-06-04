// content script：抽取、原文先垫、流式回填、Ctrl+点击、整页翻面、白名单关闭→还原。
//
// 状态：
// - blocks: 已抽取的块（id → 原始 HTML 字符串 + styleMap + 根节点）
// - mode: 'en' | 'zh'（整页当前显示语言）
// - perBlockMode: id → 'en' | 'zh'，Ctrl+点击产生的局部覆盖
// - failedIds: 翻译失败 / 校验失败的块 id

import { extractBlocks } from '@/lib/extractor';
import { validateMarkers } from '@/lib/markers';
import { rebuild } from '@/lib/rebuilder';
import { isDomainEnabled, onSettingsChanged } from '@/lib/storage';
import {
  PORT_NAME,
  type BgToContent,
  type ContentToBg,
  type PopupQuery,
  type StatusReply,
} from '@/lib/messages';

const STYLE_ID = 'immersive-translate-style';
const FADE_CLASS = 'imt-fade-in';

interface BlockRecord {
  id: string;
  root: HTMLElement;
  source: string;
  styleMap: Map<number, Element>;
  originalHTML: string;
  translatedFrag: DocumentFragment | null;
  status: 'pending' | 'done' | 'failed';
}

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  async main() {
    // 防止在扩展自身页面 / 数据 URL 跑。
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
    const domain = location.hostname;

    const state: {
      records: Map<string, BlockRecord>;
      mode: 'en' | 'zh';
      perBlockMode: Map<string, 'en' | 'zh'>;
      running: boolean;
      lastError?: string;
    } = {
      records: new Map(),
      mode: 'en',
      perBlockMode: new Map(),
      running: false,
    };

    injectStyle();

    let port: chrome.runtime.Port | null = null;

    const enabled = await isDomainEnabled(domain);
    if (enabled) {
      await runTranslation();
    }

    // 监听白名单变化：关掉则立即还原英文。
    onSettingsChanged(async () => {
      const nowEnabled = await isDomainEnabled(domain);
      if (!nowEnabled) {
        cancelStream();
        restoreAllEnglish();
        state.mode = 'en';
      } else if (state.records.size === 0) {
        await runTranslation();
      }
    });

    // popup 消息。
    chrome.runtime.onMessage.addListener((msg: PopupQuery | { kind: 'flip-page' }, _sender, sendResponse) => {
      (async () => {
        if (msg.kind === 'query-status') {
          sendResponse(buildStatusReply());
          return;
        }
        if (msg.kind === 'toggle-site') {
          if (!msg.enabled) {
            cancelStream();
            restoreAllEnglish();
            state.mode = 'en';
          } else if (state.records.size === 0) {
            await runTranslation();
          }
          sendResponse(buildStatusReply());
          return;
        }
        if (msg.kind === 'retry-failed') {
          await retryFailed();
          sendResponse(buildStatusReply());
          return;
        }
        if (msg.kind === 'flip-page') {
          flipPage();
          sendResponse(buildStatusReply());
          return;
        }
      })();
      return true; // 异步响应
    });

    // Ctrl+点击：单块切换。
    document.addEventListener(
      'click',
      (ev) => {
        if (!ev.ctrlKey && !ev.metaKey) return;
        const target = ev.target as HTMLElement | null;
        if (!target) return;
        const root = target.closest<HTMLElement>('[data-trans-id]');
        if (!root) return;
        const id = root.dataset['transId']!;
        const rec = state.records.get(id);
        if (!rec) return;
        ev.preventDefault();
        ev.stopPropagation();
        toggleSingle(rec);
      },
      true
    );

    function buildStatusReply(): StatusReply {
      let done = 0;
      let failed = 0;
      for (const r of state.records.values()) {
        if (r.status === 'done') done++;
        else if (r.status === 'failed') failed++;
      }
      const total = state.records.size;
      const reply: StatusReply = {
        enabled: state.records.size > 0 || state.running,
        done,
        total,
        failed,
        running: state.running,
      };
      if (state.lastError) reply.error = state.lastError;
      return reply;
    }

    async function runTranslation() {
      if (state.running) return;
      // 1) 抽取——原文已经在页面上"垫"着了，因为这是 document_idle 才跑的。
      const { blocks, rootById } = extractBlocks(document.body);
      if (blocks.length === 0) return;
      state.records.clear();
      state.lastError = undefined;
      for (const b of blocks) {
        const root = rootById.get(b.id)!;
        state.records.set(b.id, {
          id: b.id,
          root,
          source: b.source,
          styleMap: b.styleMap,
          originalHTML: root.innerHTML,
          translatedFrag: null,
          status: 'pending',
        });
      }
      // 2) 建立 port，开始流式翻译。
      state.running = true;
      state.mode = 'zh';
      openPortAndStart(blocks.map((b) => ({ id: b.id, source: b.source })));
    }

    function openPortAndStart(payload: { id: string; source: string }[]) {
      port?.disconnect();
      port = chrome.runtime.connect({ name: PORT_NAME });
      port.onMessage.addListener((msg: BgToContent) => {
        if (msg.kind === 'block') {
          applyBlock(msg.id, msg.translated);
        } else if (msg.kind === 'done') {
          state.running = false;
        } else if (msg.kind === 'error') {
          state.running = false;
          state.lastError = msg.failure.message;
          // 失败的视觉表现：失败块就保持英文，无须特别处理。
        }
      });
      port.onDisconnect.addListener(() => {
        state.running = false;
        port = null;
      });
      const startMsg: ContentToBg = { kind: 'start', blocks: payload };
      port.postMessage(startMsg);
    }

    function cancelStream() {
      if (port) {
        try {
          const cancel: ContentToBg = { kind: 'cancel' };
          port.postMessage(cancel);
          port.disconnect();
        } catch {
          // 忽略
        }
        port = null;
      }
      state.running = false;
    }

    function applyBlock(id: string, translated: string) {
      const rec = state.records.get(id);
      if (!rec) return;
      // 校验标记。
      const allowedIds = new Set<number>([...rec.styleMap.keys()]);
      const check = validateMarkers(translated, allowedIds);
      if (!check.ok) {
        rec.status = 'failed';
        return;
      }
      const frag = rebuild(translated, rec.styleMap);
      rec.translatedFrag = frag;
      rec.status = 'done';
      // 若整页处于"看英文"模式或该块被局部锁为英文，则不刷 DOM。
      if (state.mode !== 'zh') return;
      if (state.perBlockMode.get(id) === 'en') return;
      replaceWithFadeIn(rec.root, frag.cloneNode(true) as DocumentFragment);
    }

    async function retryFailed() {
      const failed: { id: string; source: string }[] = [];
      for (const rec of state.records.values()) {
        if (rec.status !== 'done') {
          rec.status = 'pending';
          failed.push({ id: rec.id, source: rec.source });
        }
      }
      if (failed.length === 0) return;
      state.lastError = undefined;
      state.running = true;
      openPortAndStart(failed);
    }

    function flipPage() {
      // 整页翻面：两个方向都把局部 Ctrl+点击覆盖清掉，避免之后再点回来时残留。
      state.perBlockMode.clear();
      if (state.mode === 'zh') {
        state.mode = 'en';
        for (const rec of state.records.values()) {
          replaceRaw(rec.root, rec.originalHTML);
        }
      } else {
        state.mode = 'zh';
        for (const rec of state.records.values()) {
          if (rec.translatedFrag) {
            replaceWithFadeIn(rec.root, rec.translatedFrag.cloneNode(true) as DocumentFragment);
          }
          // 翻译失败的块：rec.translatedFrag 为 null，保持英文，符合设计。
        }
      }
    }

    function toggleSingle(rec: BlockRecord) {
      const cur = state.perBlockMode.get(rec.id) ?? state.mode;
      const next = cur === 'zh' ? 'en' : 'zh';
      state.perBlockMode.set(rec.id, next);
      if (next === 'en') {
        replaceRaw(rec.root, rec.originalHTML);
      } else if (rec.translatedFrag) {
        replaceWithFadeIn(rec.root, rec.translatedFrag.cloneNode(true) as DocumentFragment);
      }
    }

    function restoreAllEnglish() {
      for (const rec of state.records.values()) {
        replaceRaw(rec.root, rec.originalHTML);
        delete rec.root.dataset['transId'];
      }
      state.records.clear();
      state.perBlockMode.clear();
    }
  },
});

// ---------------- 工具 ----------------

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  // 极短的淡入：130ms，符合"安静、不刺眼"。
  s.textContent = `
    .${FADE_CLASS} { animation: imt-fade 130ms ease-in; }
    @keyframes imt-fade { from { opacity: 0.35; } to { opacity: 1; } }
  `;
  document.documentElement.appendChild(s);
}

function replaceWithFadeIn(target: HTMLElement, frag: DocumentFragment) {
  target.replaceChildren(frag);
  // 触发动画：先移除类、强制 reflow、再加。
  target.classList.remove(FADE_CLASS);
  void target.offsetWidth;
  target.classList.add(FADE_CLASS);
}

function replaceRaw(target: HTMLElement, html: string) {
  target.innerHTML = html;
}
