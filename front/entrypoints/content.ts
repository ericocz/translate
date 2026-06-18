// content script：抽取、原文先垫、流式回填、Ctrl+点击、整页翻面、白名单关闭→还原。
//
// 状态：
// - blocks: 已抽取的块（id → 原始 HTML 字符串 + styleMap + 根节点）
// - mode: 'en' | 'zh'（整页当前显示语言）
// - perBlockMode: id → 'en' | 'zh'，Ctrl+点击产生的局部覆盖
// - failedIds: 翻译失败 / 校验失败的块 id

import { extractBlocks } from '@/lib/extractor';
import { classifyTier, type Tier } from '@/lib/regions';
import { validateMarkers, restoreSoleWrapper, stripMarkers } from '@/lib/markers';
import { rebuild } from '@/lib/rebuilder';
import { isDomainEnabled, onSettingsChanged } from '@/lib/storage';
import type { FailureKind } from '@/lib/types';
import {
  PORT_NAME,
  type BgToContent,
  type ContentToBg,
  type TabMessage,
  type StatusReply,
} from '@/lib/messages';

const STYLE_ID = 'immersive-translate-style';
const FADE_CLASS = 'imt-fade-in';
const RETRY_LABEL = '重试翻译';
const RETRY_BUSY = '重试中…';
const RETRY_CONTEXT = 2; // 重试时连带的上下文段数（目标段前后各 RETRY_CONTEXT 段一起发模型）

interface BlockRecord {
  id: string;
  root: HTMLElement;
  source: string;
  /** 结构层：正文(content) / 外框(chrome)，供 background 按区域并发提交、正文优先。 */
  tier: Tier;
  styleMap: Map<number, Element>;
  originalHTML: string;
  translatedFrag: DocumentFragment | null;
  status: 'pending' | 'done' | 'failed';
  /** 失败段内追加的「重试翻译」文字按钮（仅失败块有）。 */
  retryBtn?: HTMLElement | null;
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
      /** 翻译轮次代号：每次 runTranslation 自增；在途的旧沉降循环据此自我作废（SPA 连续跳转时）。 */
      epoch: number;
      /** 全局单调抽取批次号：保证跨路由、跨沉降轮次的 data-trans-id 唯一（batch 0 用裸 id，≥1 加 r 前缀）。 */
      seq: number;
      lastError?: string;
      lastErrorKind?: FailureKind;
    } = {
      records: new Map(),
      mode: 'en',
      perBlockMode: new Map(),
      running: false,
      epoch: 0,
      seq: 0,
    };

    injectStyle();

    let port: chrome.runtime.Port | null = null;
    // SPA 路由去重：同一 path+search 不重复重译（Next.js 等会对同地址发 replaceState / 滚动恢复）。
    let lastRouteKey = location.pathname + location.search;

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
    chrome.runtime.onMessage.addListener((msg: TabMessage, _sender, sendResponse) => {
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
        if (msg.kind === 'spa-navigated') {
          // SPA 同文档导航（History API）：content script 不会重新注入，需主动对新路由重译。
          // 同 path+search 不重复触发（框架对同地址发 replaceState / 滚动恢复也会上报）。
          const key = location.pathname + location.search;
          if (key !== lastRouteKey) {
            lastRouteKey = key;
            void handleSpaNavigation();
          }
          sendResponse({ ok: true });
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
      if (state.lastErrorKind) reply.errorKind = state.lastErrorKind;
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
     * 坑：extractBlocks 内部每次都从 b1 重新编号，多次抽取（沉降补抽 / SPA 新路由）会撞 id——
     *     故用全局单调批次号 state.seq 加前缀：batch 0 用裸 id（首屏），≥1 用 r{batch}. 前缀，
     *     保证跨轮次、跨路由唯一（同时改写元素的 data-trans-id），records 唯一、Ctrl+点击查找正确。
     */
    function extractInto(): { id: string; source: string; tier: Tier }[] {
      const batch = state.seq++;
      const { blocks, rootById } = extractBlocks(document.body);
      const fresh: { id: string; source: string; tier: Tier }[] = [];
      for (const b of blocks) {
        const root = rootById.get(b.id)!;
        const uid = batch === 0 ? b.id : `r${batch}.${b.id}`;
        if (uid !== b.id) root.dataset['transId'] = uid;
        const tier = classifyTier(root); // 正文(main/article) vs 外框(nav/header/footer/aside)
        state.records.set(uid, {
          id: uid,
          root,
          source: b.source,
          tier,
          styleMap: b.styleMap,
          originalHTML: root.innerHTML,
          translatedFrag: null,
          status: 'pending',
        });
        fresh.push({ id: uid, source: b.source, tier });
      }
      return fresh;
    }

    async function runTranslation() {
      // 每次翻译启一个新 epoch：在途的旧沉降循环（上一路由 / 上一次调用）据此自我作废，
      // 支持 SPA 连续快速跳转时新译覆盖旧译、互不串扰。
      const myEpoch = ++state.epoch;
      state.lastError = undefined;
      state.lastErrorKind = undefined;
      state.mode = 'zh';
      // 1) 初次抽取——首页加载时原文已"垫"着（document_idle）；SPA 新路由则可能尚未渲染，
      //    抽到 0 也无妨，下面的沉降补抽会把晚到的新路由内容补上。
      //    注意：不再 records.clear()——SPA 跳转要保留仍挂载的共享 layout 已译块（见 handleSpaNavigation）；
      //    首页 / 重新开站场景 records 本就为空（restoreAllEnglish 已清并把 seq 归零）。
      const initial = extractInto();
      if (initial.length > 0) {
        state.running = true;
        openPortAndStart(initial);
      }
      // 2) 沉降补抽：晚渲染 SPA（如 MongoDB 文档）首屏正文晚于抽取时机，初抽可能为空或不全。
      //    有界重抽把后到的块补译；正常站第 1 轮就 0 新块、立即结束。
      await settleAndReextract(myEpoch);
    }

    /**
     * 有界「沉降-补抽」：最多 MAX_ROUNDS 轮、每轮间隔后重抽，累积晚到的新块；某轮 0 新块即判定
     * 页面已稳、停止。把累积的晚到块在初译 job 结束后用一个 port job 串行补译（避免并发 port
     * 互相 disconnect 取消在途任务）。硬上限防长轮询/动态站跑飞（呼应"不上 MutationObserver"）。
     * epoch：本轮翻译代号；若期间发生新导航 / 关站（epoch 变了或切回英文）则立即作废退出。
     */
    async function settleAndReextract(epoch: number) {
      const MAX_ROUNDS = 5;
      const INTERVAL = 1200;
      const stale = () => state.epoch !== epoch || state.mode !== 'zh';
      const late: { id: string; source: string }[] = [];
      for (let round = 1; round <= MAX_ROUNDS; round++) {
        await sleep(INTERVAL);
        if (stale()) return; // 期间被新导航作废 / 关站切回英文
        pruneStaleRecords(); // SPA 跳转后旧路由节点会陆续脱离 DOM，顺手清掉其记录（正常站为 no-op）
        const fresh = extractInto();
        if (fresh.length === 0) break; // 已稳
        late.push(...fresh);
      }
      if (late.length === 0 || stale()) return;
      await waitForIdle(); // 等初译 job 完成，串行补译
      if (stale()) return;
      state.running = true;
      openPortAndStart(late);
    }

    /**
     * SPA 同域路由切换（History API，content script 不会重新注入）后对新路由重译。
     * 旧路由的页面节点会被框架换掉、其记录悬空；共享 layout（导航/侧栏/页脚）通常保持挂载、
     * 已是中文，无需重译。故：取消旧路由在途流 → 删除已脱离 DOM 的旧块记录（保留 layout）
     * → 对新出现的内容重抽 + 沉降补抽。seq 不归零，保证新块 id 不与保留的 layout 块相撞。
     */
    async function handleSpaNavigation(): Promise<void> {
      if (!(await isDomainEnabled(location.hostname))) return; // 防御：导航途中被关站
      cancelStream();
      pruneStaleRecords();
      await runTranslation();
    }

    /** 删除 root 已脱离文档的记录（SPA 跳转后的旧路由块）；保留仍挂载的块（如共享 layout）。 */
    function pruneStaleRecords(): void {
      for (const [id, rec] of state.records) {
        if (!rec.root.isConnected) {
          state.records.delete(id);
          state.perBlockMode.delete(id);
        }
      }
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

    function openPortAndStart(
      payload: { id: string; source: string; tier?: Tier }[],
      opts?: { bypassCache?: boolean }
    ) {
      port?.disconnect();
      // 用局部 p 捕获本次 port：沉降补抽会串行起多个 job，旧 port 的回调若在新 job 启动后才触发，
      // 必须用 `port === p` 守卫，避免它把当前 port / running 清掉（否则补译 job 会被误判结束）。
      const p = chrome.runtime.connect({ name: PORT_NAME });
      port = p;
      const ids = payload.map((b) => b.id);
      p.onMessage.addListener((msg: BgToContent) => {
        if (msg.kind === 'block') {
          applyBlock(msg.id, msg.translated); // 块回填始终生效（属于 records，与是否当前 port 无关）
        } else if (msg.kind === 'done') {
          if (port === p) state.running = false;
          finalizeJob(ids); // 本批里没译成的块 → 标失败 + 段内「重试翻译」按钮
        } else if (msg.kind === 'error') {
          if (port === p) {
            state.running = false;
            state.lastError = msg.failure.message;
            state.lastErrorKind = msg.failure.kind;
          }
          // quota/auth 是系统性引导（popup 已提示登录/充值），不给段落挂按钮——只复位「重试中…」态；
          // 其余（network/api/unknown）可能只是部分失败，给失败块挂「重试翻译」按钮。
          if (msg.failure.kind === 'quota' || msg.failure.kind === 'auth') unstickBusyButtons(ids);
          else finalizeJob(ids);
        }
      });
      p.onDisconnect.addListener(() => {
        if (port === p) {
          state.running = false;
          port = null;
        }
        // 被新 job / 取消 superseded 时，复位卡在「重试中…」的按钮（不改状态、不新增按钮）。
        unstickBusyButtons(ids);
      });
      const startMsg: ContentToBg = { kind: 'start', blocks: payload, bypassCache: opts?.bypassCache };
      p.postMessage(startMsg);
    }

    /** 一批翻译结束后收尾：没译成的块标失败 + 挂「重试翻译」按钮；已译成的清掉残留按钮。 */
    function finalizeJob(ids: string[]) {
      for (const id of ids) {
        const rec = state.records.get(id);
        if (!rec) continue;
        if (rec.status === 'done') {
          removeRetryButton(rec);
          continue;
        }
        rec.status = 'failed';
        if (rec.root.isConnected) ensureRetryButton(rec);
      }
    }

    /** 在失败段内追加 / 复位「重试翻译」文字按钮（幂等：已存在则复位到可点状态）。 */
    function ensureRetryButton(rec: BlockRecord) {
      const existing = rec.retryBtn;
      if (existing && existing.isConnected) {
        existing.textContent = RETRY_LABEL;
        existing.removeAttribute('disabled');
        return;
      }
      const btn = document.createElement('button');
      btn.className = 'imt-retry-btn';
      btn.type = 'button';
      btn.textContent = RETRY_LABEL;
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (btn.hasAttribute('disabled')) return;
        btn.textContent = RETRY_BUSY;
        btn.setAttribute('disabled', '');
        retryBlock(rec);
      });
      // 追加进失败块自身：其 data-trans-id 让抽取器整树跳过这个按钮，绝不送翻；
      // 关站/还原走 originalHTML 重置 innerHTML 时按钮也随之消失，无需额外清理。
      rec.root.appendChild(btn);
      rec.retryBtn = btn;
    }

    function removeRetryButton(rec: BlockRecord) {
      rec.retryBtn?.remove();
      rec.retryBtn = null;
    }

    /** 把这些块里卡在「重试中…」（disabled）的按钮复位到可点状态——用于 job 被取消/系统性失败时，避免按钮永久卡死。 */
    function unstickBusyButtons(ids: string[]) {
      for (const id of ids) {
        const b = state.records.get(id)?.retryBtn;
        if (b && b.isConnected && b.hasAttribute('disabled')) {
          b.textContent = RETRY_LABEL;
          b.removeAttribute('disabled');
        }
      }
    }

    /**
     * 重试单个失败段：连带前后各 RETRY_CONTEXT 段一起发模型，让模型有上下文译好这段。
     * 关键走 bypassCache——否则上下文段命中本地缓存被直接回填、只有失败段被单独发服务端，又失去上下文。
     * 上下文里已译完的块 applyBlock 会早退（不重复重建）；本次仍没译成的块由 finalizeJob 复位按钮。
     */
    function retryBlock(rec: BlockRecord) {
      const ordered = Array.from(state.records.values()).filter((r) => r.root.isConnected);
      const idx = ordered.findIndex((r) => r.id === rec.id);
      if (idx < 0) return; // 记录已被 SPA 清掉
      const from = Math.max(0, idx - RETRY_CONTEXT);
      const to = Math.min(ordered.length, idx + RETRY_CONTEXT + 1);
      const payload = ordered.slice(from, to).map((r) => ({ id: r.id, source: r.source, tier: r.tier }));
      state.running = true;
      openPortAndStart(payload, { bypassCache: true });
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
      // 已译完的块不重复处理：retry 把上下文段一起发回时会重复回填，跳过避免无谓重建/淡入。
      if (rec.status === 'done') return;
      // 补回模型整对省略的「最外层唯一内联包装」（最典型：超链接 <a> 裹住整块文字）。
      // 否则 rebuild 拿不到 open token、不重建这层壳，文字直接落进父元素——链接失效，且在
      // white-space:nowrap 的容器里（如热门问题侧栏 li）中文不换行、整行溢出。见经验库。
      const repaired = restoreSoleWrapper(translated, rec.source);
      // 校验标记。
      const allowedIds = new Set<number>([...rec.styleMap.keys()]);
      const check = validateMarkers(repaired, allowedIds);
      if (!check.ok) {
        rec.status = 'failed';
        return;
      }
      const frag = rebuild(repaired, rec.styleMap);
      // aria-hidden 的「阴影副本」（与可见正文同字、绝对定位叠在背后）用译文镜像：
      // 它在 extractor 里按 <xN/> 原样保留（不送翻，避免模型把重复内容去重后丢掉可见正文），
      // 但保留的是英文，会与可见译文重叠成中英混排——这里用译文把它刷成中文。
      syncAriaHiddenShadows(frag, rec.source);
      rec.translatedFrag = frag;
      rec.status = 'done';
      removeRetryButton(rec); // 这段译好了，去掉它的重试按钮（若有）
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
      state.seq = 0; // 全清后下次翻译从裸 id（batch 0）重新开始
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
    .imt-retry-btn {
      display: inline-block; margin-left: 6px; padding: 0; border: 0; background: none;
      color: #038f93; font: inherit; font-size: 0.82em; line-height: inherit;
      cursor: pointer; opacity: 0.9; vertical-align: baseline;
    }
    .imt-retry-btn:hover { text-decoration: underline; opacity: 1; }
    .imt-retry-btn[disabled] { cursor: default; opacity: 0.5; text-decoration: none; }
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
  const visibleText = norm(stripMarkers(source));
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
