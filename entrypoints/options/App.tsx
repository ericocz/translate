import { useCallback, useEffect, useState } from 'react';
import { getSettings, setApiKey, setWhitelist } from '@/lib/storage';

export function Options() {
  const [apiKey, setKeyState] = useState('');
  const [keySaved, setKeySaved] = useState(false);
  const [list, setList] = useState<string[]>([]);
  const [newDomain, setNewDomain] = useState('');
  const [shortcut, setShortcut] = useState('Ctrl+A');

  useEffect(() => {
    void (async () => {
      const s = await getSettings();
      setKeyState(s.apiKey);
      setList(s.whitelist);
      setShortcut(s.shortcutLabel);
    })();
  }, []);

  const saveKey = useCallback(async () => {
    await setApiKey(apiKey.trim());
    setKeySaved(true);
    setTimeout(() => setKeySaved(false), 1500);
  }, [apiKey]);

  const addDomain = useCallback(async () => {
    const d = normalizeDomain(newDomain);
    if (!d) return;
    const next = Array.from(new Set([...list, d]));
    await setWhitelist(next);
    setList(next.sort());
    setNewDomain('');
  }, [newDomain, list]);

  const removeDomain = useCallback(async (d: string) => {
    const next = list.filter((x) => x !== d);
    await setWhitelist(next);
    setList(next);
  }, [list]);

  const openShortcuts = useCallback(() => {
    // Chrome 不允许扩展直接改 commands；只能跳到 chrome://extensions/shortcuts。
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  }, []);

  return (
    <div className="wrap">
      <h1>沉浸式翻译 · 设置</h1>

      <section className="card">
        <h2>DeepSeek API Key</h2>
        <label htmlFor="ak">用于调用 DeepSeek V4 Flash。仅存在 chrome.storage.local 中，不上传任何地方。</label>
        <input
          id="ak"
          type="password"
          autoComplete="off"
          placeholder="sk-..."
          value={apiKey}
          onChange={(e) => setKeyState(e.target.value)}
        />
        <div className="row">
          <button className="primary" onClick={saveKey} disabled={apiKey.trim().length === 0}>
            保存
          </button>
          {keySaved && <span className="saved">已保存</span>}
        </div>
      </section>

      <section className="card">
        <h2>站点白名单</h2>
        <div className="row">
          <input
            type="text"
            placeholder="example.com"
            value={newDomain}
            onChange={(e) => setNewDomain(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void addDomain(); }}
            style={{ flex: 1 }}
          />
          <button onClick={addDomain} disabled={normalizeDomain(newDomain) === ''}>添加</button>
        </div>
        {list.length === 0 ? (
          <div className="muted">还没有白名单。也可以在站点页面点扩展图标开启。</div>
        ) : (
          <ul className="whitelist">
            {list.map((d) => (
              <li key={d}>
                <span>{d}</span>
                <button onClick={() => void removeDomain(d)}>移除</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>整页翻面快捷键</h2>
        <div className="muted">
          当前：<code>{shortcut}</code>。注意此组合与浏览器"全选"冲突，网页通常会先吞掉事件；如失效请到 Chrome 快捷键页改为 Alt+A 或 Ctrl+Shift+A。
        </div>
        <div className="row">
          <button onClick={openShortcuts}>打开 chrome://extensions/shortcuts</button>
        </div>
      </section>
    </div>
  );
}

function normalizeDomain(input: string): string {
  const s = input.trim().toLowerCase();
  if (!s) return '';
  // 容忍粘贴整个 URL：取 hostname。
  try {
    if (s.startsWith('http://') || s.startsWith('https://')) {
      return new URL(s).hostname;
    }
  } catch { /* ignore */ }
  // 简单校验：至少一个点、不能含空格 / 路径。
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(s)) return '';
  return s;
}
