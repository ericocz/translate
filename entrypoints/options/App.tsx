import { useCallback, useEffect, useState } from 'react';
import { getWhitelist, setWhitelist } from '@/lib/storage';

export function Options() {
  const [list, setList] = useState<string[]>([]);
  const [newDomain, setNewDomain] = useState('');
  const [shortcut, setShortcut] = useState(suggestedShortcut);

  useEffect(() => {
    void (async () => setList(await getWhitelist()))();
    // 显示实际快捷键（用户可能在 chrome://extensions/shortcuts 改过）；为空则保留建议键。
    void chrome.commands.getAll().then((cmds) => {
      const real = cmds.find((c) => c.name === 'toggle-site')?.shortcut;
      if (real) setShortcut(real);
    });
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

  const valid = normalizeDomain(newDomain) !== '';

  return (
    <div className="wrap">
      <header className="head">
        <Mark />
        <div className="head-t">
          <h1>沉浸式翻译</h1>
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

      <p className="kbd-note">
        <span>翻译 / 取消翻译当前网站</span>
        <kbd>{shortcut}</kbd>
        <span className="kbd-sub">在 chrome://extensions/shortcuts 可改</span>
      </p>
    </div>
  );
}

/** 素方案双线标记（开启色：下线桃红），用于设置页页眉。 */
function Mark() {
  return (
    <svg viewBox="0 0 32 32" width="30" height="30" aria-hidden>
      <rect x="2.5" y="2.5" width="27" height="27" rx="8" fill="#fbf2f5" stroke="#f0d8e0" strokeWidth="1.2" />
      <rect x="8" y="11" width="16" height="3.2" rx="1.6" fill="none" stroke="#26242a" strokeWidth="1.6" />
      <rect x="8" y="18.2" width="13" height="3.2" rx="1.6" fill="#d94a73" />
    </svg>
  );
}

function suggestedShortcut(): string {
  const isMac = /mac/i.test(navigator.platform || navigator.userAgent);
  return isMac ? '⌘⇧A' : 'Alt+Shift+A';
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
