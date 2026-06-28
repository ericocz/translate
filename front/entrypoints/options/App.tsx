import { useCallback, useEffect, useRef, useState } from 'react';
import { getCacheEnabled, setCacheEnabled } from '@/lib/storage';
import { cacheStats, clearCache } from '@/lib/local-cache';
import { useT } from '@/lib/i18n-react';
import { UI_LOCALES, UI_LOCALE_NAMES, detectUiLocale, type Messages, type UiLocale } from '@/lib/i18n';
import { RechargeCard } from './Recharge';

export function Options() {
  const { m, locale, stored, setLocale } = useT();
  const [shortcut, setShortcut] = useState(suggestedShortcut);
  // Chrome 是否真的绑定了快捷键：getAll() 返回非空才算（reload/更新后常返空，见经验）。
  const [bound, setBound] = useState(false);
  const [cacheOn, setCacheOn] = useState(true);
  const [stats, setStats] = useState({ count: 0, bytes: 0 });
  const cacheRef = useRef<HTMLElement>(null);

  useEffect(() => {
    // 显示实际快捷键（用户可能在 chrome://extensions/shortcuts 改过）；为空则保留建议键。
    void chrome.commands.getAll().then((cmds) => {
      const real = cmds.find((c) => c.name === 'toggle-site')?.shortcut;
      if (real) {
        setShortcut(real);
        setBound(true);
      }
    });
    void getCacheEnabled().then(setCacheOn);
    void cacheStats().then(setStats);
    // 来自 popup 直达链接 options.html#cache：滚动到缓存卡片。
    if (location.hash === '#cache') {
      setTimeout(() => cacheRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    }
  }, []);

  // 标签页标题 + 文档语言随界面语言。
  useEffect(() => {
    document.title = m.options.docTitle;
    document.documentElement.lang = locale;
  }, [m.options.docTitle, locale]);

  // 「修改快捷键」：MV3 不允许扩展用 API 改快捷键，只能打开 Chrome 原生改键页引导用户。
  const openShortcuts = useCallback(() => {
    void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  }, []);

  const toggleCache = useCallback(async () => {
    const next = !cacheOn;
    await setCacheEnabled(next);
    setCacheOn(next);
  }, [cacheOn]);

  const onClearCache = useCallback(async () => {
    await clearCache();
    setStats({ count: 0, bytes: 0 });
  }, []);

  const keys = parseShortcut(shortcut);

  return (
    <div className="wrap">
      <header className="head">
        <Mark />
        <div className="head-t">
          <h1>
            {m.brand}<span className="head-sub">{m.options.titleSuffix}</span>
          </h1>
          <p className="lead">{m.options.lead}</p>
        </div>
      </header>

      <UiLangCard m={m} stored={stored} setLocale={setLocale} />

      <section className="card">
        <div className="card-h">
          <h2>{m.options.shortcut}</h2>
          <div className="keys">
            {keys.length > 0 ? (
              keys.map((k, i) => (
                <kbd className="keycap" key={i}>
                  {k}
                </kbd>
              ))
            ) : (
              <span className="muted">{m.options.notSet}</span>
            )}
          </div>
        </div>
        <div className="line">
          <span className="muted">
            {bound ? m.options.shortcutBound : m.options.shortcutUnbound}
          </span>
          <button className="ghost" onClick={openShortcuts}>
            {m.options.modify}
          </button>
        </div>
      </section>

      <section className="card" id="cache" ref={cacheRef}>
        <div className="card-h">
          <h2>{m.options.cacheTitle}</h2>
          <button
            type="button"
            className={'switch' + (cacheOn ? ' switch--on' : '')}
            role="switch"
            aria-checked={cacheOn}
            aria-label={m.options.cacheAria}
            onClick={() => void toggleCache()}
          >
            <i />
          </button>
        </div>
        <p className="muted">{m.options.cacheDesc}</p>
        <div className="line">
          <span className="muted">
            {cacheOn ? m.options.cacheStored(stats.count, formatBytes(stats.bytes)) : m.options.cacheOff}
          </span>
          <button className="ghost" onClick={() => void onClearCache()} disabled={stats.count === 0}>
            {m.options.clear}
          </button>
        </div>
      </section>

      <RechargeCard />
    </div>
  );
}

/** 界面语言卡：「跟随浏览器」+ 四种语言显式选择。stored=null 即跟随浏览器（首项）。 */
function UiLangCard({
  m,
  stored,
  setLocale,
}: {
  m: Messages;
  stored: UiLocale | null;
  setLocale: (l: UiLocale | null) => Promise<void>;
}) {
  const autoName = UI_LOCALE_NAMES[detectUiLocale()];
  return (
    <section className="card">
      <div className="card-h">
        <h2>{m.options.uiLangTitle}</h2>
        <select
          className="lang-select"
          value={stored ?? ''}
          onChange={(e) => void setLocale(e.target.value ? (e.target.value as UiLocale) : null)}
        >
          <option value="">{m.options.uiLangAuto(autoName)}</option>
          {UI_LOCALES.map((l) => (
            <option key={l} value={l}>
              {UI_LOCALE_NAMES[l]}
            </option>
          ))}
        </select>
      </div>
      <p className="muted">{m.options.uiLangDesc}</p>
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

/** 素方案双线标记（开启色：下线青绿），用于设置页页眉。 */
function Mark() {
  return (
    <svg viewBox="0 0 32 32" width="30" height="30" aria-hidden>
      <rect x="2.5" y="2.5" width="27" height="27" rx="8" fill="#e8f7f7" stroke="#bfe7e9" strokeWidth="1.2" />
      <rect x="8" y="11" width="16" height="3.2" rx="1.6" fill="none" stroke="#26242a" strokeWidth="1.6" />
      <rect x="8" y="18.2" width="13" height="3.2" rx="1.6" fill="#038f93" />
    </svg>
  );
}

function suggestedShortcut(): string {
  const isMac = /mac/i.test(navigator.platform || navigator.userAgent);
  return isMac ? '⌘⇧A' : 'Alt+Shift+A';
}

/**
 * 把 chrome.commands 的快捷键字符串拆成单个键，用于渲染独立键帽。
 * 兼容两种格式：非 Mac 用 '+' 分隔（Alt+Shift+A）；Mac 是符号连写（⌘⇧A），
 * 其中 ⌘⌥⇧⌃ 各算一个修饰键、其余连续字符（可能是 F5 这类多字符主键）合为一键。
 */
function parseShortcut(s: string): string[] {
  if (!s) return [];
  if (s.includes('+')) {
    return s
      .split('+')
      .map((x) => x.trim())
      .filter(Boolean);
  }
  const mods = new Set(['⌘', '⌥', '⇧', '⌃']);
  const keys: string[] = [];
  let main = '';
  for (const ch of s) {
    if (mods.has(ch)) keys.push(ch);
    else main += ch;
  }
  if (main) keys.push(main);
  return keys;
}
