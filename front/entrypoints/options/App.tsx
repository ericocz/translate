import { useCallback, useEffect, useRef, useState } from 'react';
import { getWhitelist, setWhitelist, getCacheEnabled, setCacheEnabled } from '@/lib/storage';
import { cacheStats, clearCache } from '@/lib/local-cache';
import { ByokCard } from './Byok';

export function Options() {
  const [list, setList] = useState<string[]>([]);
  const [newDomain, setNewDomain] = useState('');
  const [shortcut, setShortcut] = useState(suggestedShortcut);
  // Chrome 是否真的绑定了快捷键：getAll() 返回非空才算（reload/更新后常返空，见经验）。
  const [bound, setBound] = useState(false);
  const [cacheOn, setCacheOn] = useState(true);
  const [stats, setStats] = useState({ count: 0, bytes: 0 });
  const cacheRef = useRef<HTMLElement>(null);

  useEffect(() => {
    void (async () => setList(await getWhitelist()))();
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

  const addDomain = useCallback(async () => {
    const d = normalizeDomain(newDomain);
    if (!d) return;
    const next = Array.from(new Set([...list, d])).sort();
    await setWhitelist(next);
    setList(next);
    setNewDomain('');
  }, [newDomain, list]);

  const removeDomain = useCallback(
    async (d: string) => {
      const next = list.filter((x) => x !== d);
      await setWhitelist(next);
      setList(next);
    },
    [list]
  );

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

  const valid = normalizeDomain(newDomain) !== '';
  const keys = parseShortcut(shortcut);

  return (
    <div className="wrap">
      <header className="head">
        <Mark />
        <div className="head-t">
          <h1>秒懂翻译</h1>
          <span className="head-sub">设置</span>
        </div>
      </header>

      <section className="card">
        <div className="card-h">
          <h2>自动翻译的网站</h2>
          {list.length > 0 && <span className="count">{list.length}</span>}
        </div>
        <p className="muted">
          列表里的网站，打开即自动整页翻成中文。也可以在任意页面点扩展图标，直接开关当前站点。
        </p>

        <div className="row">
          <input
            type="text"
            placeholder="example.com"
            value={newDomain}
            onChange={(e) => setNewDomain(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void addDomain();
            }}
          />
          <button className="add" onClick={() => void addDomain()} disabled={!valid}>
            添加
          </button>
        </div>

        {list.length === 0 ? (
          <div className="empty">还没有添加任何网站。在上面输入域名，或在站点页面点扩展图标开启。</div>
        ) : (
          <ul className="wl">
            {list.map((d) => (
              <li key={d}>
                <span className="wl-d">
                  <span className="wl-dot" />
                  {d}
                </span>
                <button className="rm" onClick={() => void removeDomain(d)}>
                  移除
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <div className="card-h">
          <h2>快捷键</h2>
        </div>
        <p className="muted">翻译 / 取消翻译当前网站。</p>

        <div className="kbd-row">
          <div className="keys">
            {keys.length > 0 ? (
              keys.map((k, i) => (
                <kbd className="keycap" key={i}>
                  {k}
                </kbd>
              ))
            ) : (
              <span className="muted">未设置</span>
            )}
          </div>
          <button className="ghost" onClick={openShortcuts}>
            修改快捷键 ›
          </button>
        </div>

        <p className="muted">
          {bound
            ? '快捷键由 Chrome 管理。点「修改快捷键」会打开浏览器的扩展快捷键页，在那里改成顺手的组合。'
            : 'Chrome 还没绑定这个快捷键（扩展更新或重载后常见）。点「修改快捷键」去绑定。'}
        </p>
      </section>

      <section className="card" id="cache" ref={cacheRef}>
        <div className="card-h">
          <h2>翻译缓存</h2>
        </div>
        <p className="muted">
          译文只存在你这台设备的浏览器里（IndexedDB），同一页面重访时秒出、且不再消耗额度。
          我们的服务器不保存你的译文。
        </p>
        <div className="kbd-row">
          <span className="muted">
            {cacheOn ? `已开启 · ${stats.count} 条 · ${formatBytes(stats.bytes)}` : '已关闭'}
          </span>
          <button className="ghost" onClick={() => void toggleCache()}>
            {cacheOn ? '关闭缓存' : '开启缓存'}
          </button>
        </div>
        <div className="kbd-row">
          <span className="muted">清空后下次翻译会重新请求。</span>
          <button className="ghost" onClick={() => void onClearCache()} disabled={stats.count === 0}>
            清空缓存
          </button>
        </div>
      </section>

      <ByokCard />
    </div>
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

function normalizeDomain(input: string): string {
  const s = input.trim().toLowerCase();
  if (!s) return '';
  // 容忍粘贴整个 URL：取 hostname。
  try {
    if (s.startsWith('http://') || s.startsWith('https://')) {
      return new URL(s).hostname;
    }
  } catch {
    /* ignore */
  }
  // 简单校验：至少一个点、不含空格 / 路径。
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(s)) return '';
  return s;
}
