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
      /** 一次"整页翻译（含沉降补抽）"是否进行中，防重入。 */
      translating: boolean;
      lastError?: string;
    } = {
      records: new Map(),
      mode: 'en',
      perBlockMode: new Map(),
      running: false,
      translating: false,
    };

    injectStyle();

    let port: chrome.runtime.Port | null = null;

    const enabled = await isDomainEnabled(domain);
    if (enabled) {
      // 等 hydration 完成再开译，避免在 React hydrate 期间改 DOM 触发 #418；
      // 也让抽取发生在页面完全渲染后，块集更稳定（缓存命中更一致）。
      await waitForHydration();
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
    chrome.runtime.onMessage.addListener((msg: PopupQuery, _sender, sendResponse) => {
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
      const reply: StatusReply = { running: state.running };
      if (state.lastError) reply.error = state.lastError;
      // 极轻进度：已译完段数 / 总段数（供 popup 显示 "12 / 40 段" 与进度条）。
      const total = state.records.size;
      if (total > 0) {
        let done = 0;
        for (const r of state.records.values()) if (r.status === 'done') done++;
        reply.done = done;
        reply.total = total;
      }
      return reply;
    }

    /**
     * 把当前 DOM 里「尚未认领」的块抽取并入 state.records，返回这批新块。
     * extractBlocks 的 acceptNode 会跳过 [data-trans-id] 子树，所以重跑只会拿到新出现的块。
     * 坑：extractBlocks 内部每次都从 b1 重新编号，重抽会与上轮 id 撞——故第 ≥1 轮按轮次加前缀
     *     重写为唯一 id（同时改写元素的 data-trans-id），保证 records 唯一、Ctrl+点击查找正确。
     */
    function extractInto(round: number): { id: string; source: string }[] {
      const { blocks, rootById } = extractBlocks(document.body);
      const fresh: { id: string; source: string }[] = [];
      for (const b of blocks) {
        const root = rootById.get(b.id)!;
        const uid = round === 0 ? b.id : `r${round}.${b.id}`;
        if (uid !== b.id) root.dataset['transId'] = uid;
        state.records.set(uid, {
          id: uid,
          root,
          source: b.source,
          styleMap: b.styleMap,
          originalHTML: root.innerHTML,
          translatedFrag: null,
          status: 'pending',
        });
        fresh.push({ id: uid, source: b.source });
      }
      return fresh;
    }

    async function runTranslation() {
      if (state.translating) return;
      state.translating = true;
      try {
        state.records.clear();
        state.lastError = undefined;
        state.mode = 'zh';
        // 1) 初次抽取——原文已经在页面上"垫"着了，因为这是 document_idle 才跑的。
        const initial = extractInto(0);
        if (initial.length > 0) {
          state.running = true;
          openPortAndStart(initial);
        }
        // 2) 沉降补抽：晚渲染 SPA（如 MongoDB 文档）首屏正文晚于抽取时机，初抽可能为空或不全。
        //    有界重抽把后到的块补译；正常站第 1 轮就 0 新块、立即结束。
        await settleAndReextract();
      } finally {
        state.translating = false;
      }
    }

    /**
     * 有界「沉降-补抽」：最多 MAX_ROUNDS 轮、每轮间隔后重抽，累积晚到的新块；某轮 0 新块即判定
     * 页面已稳、停止。把累积的晚到块在初译 job 结束后用一个 port job 串行补译（避免并发 port
     * 互相 disconnect 取消在途任务）。硬上限防长轮询/动态站跑飞（呼应"不上 MutationObserver"）。
     */
    async function settleAndReextract() {
      const MAX_ROUNDS = 5;
      const INTERVAL = 1200;
      const late: { id: string; source: string }[] = [];
      for (let round = 1; round <= MAX_ROUNDS; round++) {
        await sleep(INTERVAL);
        if (state.mode !== 'zh') return; // 期间被关站/切回英文
        const fresh = extractInto(round);
        if (fresh.length === 0) break; // 已稳
        late.push(...fresh);
      }
      if (late.length === 0 || state.mode !== 'zh') return;
      await waitForIdle(); // 等初译 job 完成，串行补译
      if (state.mode !== 'zh') return;
      state.running = true;
      openPortAndStart(late);
    }

    /** 等当前流式 job 结束（state.running 落回 false），带绝对上限防卡死。 */
    function waitForIdle(): Promise<void> {
      return new Promise((resolve) => {
        if (!state.running) return resolve();
        let waited = 0;
        const tick = () => {
          if (!state.running || waited >= 20000) return resolve();
          waited += 150;
          setTimeout(tick, 150);
        };
        setTimeout(tick, 150);
      });
    }

    function openPortAndStart(payload: { id: string; source: string }[]) {
      port?.disconnect();
      // 用局部 p 捕获本次 port：沉降补抽会串行起多个 job，旧 port 的回调若在新 job 启动后才触发，
      // 必须用 `port === p` 守卫，避免它把当前 port / running 清掉（否则补译 job 会被误判结束）。
      const p = chrome.runtime.connect({ name: PORT_NAME });
      port = p;
      p.onMessage.addListener((msg: BgToContent) => {
        if (msg.kind === 'block') {
          applyBlock(msg.id, msg.translated); // 块回填始终生效（属于 records，与是否当前 port 无关）
        } else if (msg.kind === 'done') {
          if (port === p) state.running = false;
        } else if (msg.kind === 'error') {
          if (port === p) {
            state.running = false;
            state.lastError = msg.failure.message;
          }
          // 失败的视觉表现：失败块就保持英文，无须特别处理。
        }
      });
      p.onDisconnect.addListener(() => {
        if (port === p) {
          state.running = false;
          port = null;
        }
      });
      const startMsg: ContentToBg = { kind: 'start', blocks: payload };
      p.postMessage(startMsg);
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
      // aria-hidden 的「阴影副本」（与可见正文同字、绝对定位叠在背后）用译文镜像：
      // 它在 extractor 里按 <xN/> 原样保留（不送翻，避免模型把重复内容去重后丢掉可见正文），
      // 但保留的是英文，会与可见译文重叠成中英混排——这里用译文把它刷成中文。
      syncAriaHiddenShadows(frag, rec.source);
      rec.translatedFrag = frag;
      rec.status = 'done';
      // 若整页处于"看英文"模式或该块被局部锁为英文，则不刷 DOM。
      if (state.mode !== 'zh') return;
      if (state.perBlockMode.get(id) === 'en') return;
      replaceWithFadeIn(rec.root, frag.cloneNode(true) as DocumentFragment);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 等 dom-compat（MAIN world）发出的 hydration 就绪信号后再开译，消除 React #418。
 * 优先级：已就绪属性 → 'imt-ready' 事件 → load 后兜底 → 绝对超时兜底（防永久等待 /
 * dom-compat 未注入的情况）。
 */
function waitForHydration(): Promise<void> {
  if (document.documentElement.getAttribute('data-imt-ready') === '1') {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    document.addEventListener('imt-ready', done, { once: true });
    // dom-compat 缺席时的兜底：load 之后稍等也开译（多半已过 hydration）。
    if (document.readyState === 'complete') setTimeout(done, 1500);
    else window.addEventListener('load', () => setTimeout(done, 1500), { once: true });
    // 绝对兜底，避免永久等待。
    setTimeout(done, 8000);
  });
}

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

/**
 * 把块内「aria-hidden 阴影副本」刷成译文。
 *
 * 模式：标题等常用「一份可见正文 + 一份 aria-hidden 的同字绝对定位副本」做描边/阴影。
 * extractor 把 aria-hidden 子树按 <xN/> 原样保留（不送翻），重建出的副本仍是英文，
 * 会和可见译文叠在一起成中英混排。这里在重建后的 fragment 顶层找这种副本，用译文镜像它。
 *
 * 安全前提：只镜像「英文文字 == 原文可见文字」的副本（据 source 反推可见原文）。
 * 这样既能命中真正的阴影副本，又不会误伤「aria-hidden 才是唯一可见文字」等其它用法
 * （那种情形也会被镜像成译文，仍是正确结果）。
 */
function syncAriaHiddenShadows(frag: DocumentFragment, source: string): void {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  // 原文可见文字 = source 去掉占位标记（aria-hidden 已是 <xN/>，不含其文字）。
  const visibleText = norm(source.replace(/<\/?[gx]\d+\/?>/g, ''));
  if (!visibleText) return;

  const top = Array.from(frag.childNodes);
  const isAH = (n: Node): n is Element =>
    n.nodeType === Node.ELEMENT_NODE && (n as Element).getAttribute('aria-hidden') === 'true';
  // 可见节点（非 aria-hidden）= 已是译文，作为镜像源。
  const visibleNodes = top.filter((n) => !isAH(n));
  if (visibleNodes.length === 0) return;

  for (const n of top) {
    if (isAH(n) && norm(n.textContent ?? '') === visibleText) {
      n.replaceChildren(...visibleNodes.map((v) => v.cloneNode(true)));
    }
  }
}
