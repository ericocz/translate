import { useCallback, useEffect, useState } from 'react';
import { isDomainEnabled, setDomainEnabled } from '@/lib/storage';
import type { PopupQuery, StatusReply } from '@/lib/messages';

interface PopupState {
  domain: string;
  favicon: string;
  enabled: boolean;
  status: StatusReply | null;
  loading: boolean;
}

export function Popup() {
  const [s, setS] = useState<PopupState>({
    domain: '',
    favicon: '',
    enabled: false,
    status: null,
    loading: true,
  });
  // 「翻译 / 取消翻译此网站」的快捷键，显示在按钮里。先给本平台建议键兜底，
  // 随后 chrome.commands.getAll() 有实际绑定再覆盖（见历史：更新安装时 getAll 可能为空）。
  const [shortcut, setShortcut] = useState(suggestedShortcut);

  useEffect(() => {
    void chrome.commands.getAll().then((cmds) => {
      const real = cmds.find((c) => c.name === 'toggle-site')?.shortcut;
      if (real) setShortcut(real);
    });
  }, []);

  const refresh = useCallback(async () => {
    const tab = await getActiveTab();
    if (!tab?.url) {
      setS({ domain: '', favicon: '', enabled: false, status: null, loading: false });
      return;
    }
    let domain = '';
    try {
      domain = new URL(tab.url).hostname;
    } catch {
      // chrome:// 等
    }
    const enabled = domain ? await isDomainEnabled(domain) : false;
    const status = tab.id ? await querySafe(tab.id, { kind: 'query-status' }) : null;
    setS({ domain, favicon: tab.favIconUrl ?? '', enabled, status, loading: false });
  }, []);

  useEffect(() => {
    void refresh();
    // 翻译进行时轮询拿进度（一行极轻文字 + 进度条）。
    const t = setInterval(() => void refresh(), 1200);
    return () => clearInterval(t);
  }, [refresh]);

  // 主按钮：在「翻译此网站」「取消翻译此网站」间切换 = 加入/移出自动翻译列表 + 立即整页翻译/还原。
  const onToggle = useCallback(async () => {
    if (!s.domain) return;
    const next = !s.enabled;
    await setDomainEnabled(s.domain, next);
    const tab = await getActiveTab();
    if (tab?.id) await querySafe(tab.id, { kind: 'toggle-site', enabled: next });
    await refresh();
  }, [s.domain, s.enabled, refresh]);

  const openSettings = useCallback(() => chrome.runtime.openOptionsPage(), []);

  if (s.loading) {
    return <div className="pop pop--msg">读取中…</div>;
  }

  // 非普通页面（chrome:// / 扩展页 / 新标签页等）。
  if (!s.domain) {
    return (
      <div className="pop">
        <Brand enabled={false} />
        <div className="msg">
          <p className="msg-title">当前页面不可翻译</p>
          <p className="msg-sub">仅在普通 http / https 页面生效。</p>
        </div>
        <div className="foot">
          <span className="foot-hint" />
          <button className="link" onClick={openSettings}>设置 ›</button>
        </div>
      </div>
    );
  }

  const st = s.status;
  const running = !!st?.running;
  const err = st?.error;
  const total = st?.total ?? 0;
  const done = st?.done ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

  return (
    <div className="pop">
      <Brand enabled={s.enabled} />

      <div className="domain">
        {s.favicon ? (
          <img className="fav" src={s.favicon} alt="" />
        ) : (
          <span className="fav fav--ph" />
        )}
        <span className="domain-name">{s.domain}</span>
      </div>

      {/* 状态行（一行极轻文字，不是进度条横幅） */}
      {err ? (
        <div className="status status--err">
          <span className="dot dot--err" />
          <span>{err}</span>
        </div>
      ) : !s.enabled ? (
        <div className="status">
          <span className="dot dot--off" />
          <span>此站点保持英文原样</span>
        </div>
      ) : running ? (
        <>
          <div className="status">
            <span className="dot dot--on pulse" />
            <span>
              正在翻译此页
              {total > 0 ? (
                <>
                  {' · '}
                  <b>{done}</b> / {total} 段
                </>
              ) : (
                '…'
              )}
            </span>
          </div>
          <div className="prog">
            <i style={{ width: total > 0 ? `${pct}%` : '35%' }} />
          </div>
        </>
      ) : (
        <div className="status">
          <span className="dot dot--on" />
          <span>{total > 0 ? '译文已就位' : '自动翻译已开启'}</span>
        </div>
      )}

      <button
        className={'action ' + (s.enabled ? 'action--on' : 'action--off')}
        onClick={onToggle}
      >
        <span>{s.enabled ? '取消翻译此网站' : '翻译此网站'}</span>
        {shortcut && <kbd>{shortcut}</kbd>}
      </button>

      <div className="foot">
        <span className="foot-hint">
          {s.enabled ? (err ? '关掉再开可整页重译' : '自动翻译已开启') : '开启即整页翻译'}
        </span>
        <button className="link" onClick={openSettings}>设置 ›</button>
      </div>
    </div>
  );
}

/** 品牌行：素方案的「英→中」双线标记（开启时下线灌桃红） + 名称。 */
function Brand({ enabled }: { enabled: boolean }) {
  return (
    <div className="brand">
      <svg className="brand-mark" viewBox="0 0 32 32" width="22" height="22" aria-hidden>
        <rect
          x="2.5" y="2.5" width="27" height="27" rx="8"
          fill={enabled ? '#FBF2F5' : '#F4F4F3'}
          stroke={enabled ? '#F0D8E0' : '#E6E6E3'}
          strokeWidth="1.2"
        />
        <rect x="8" y="11" width="16" height="3.2" rx="1.6" fill="none" stroke="#26242A" strokeWidth="1.6" />
        <rect x="8" y="18.2" width="13" height="3.2" rx="1.6" fill={enabled ? '#D94A73' : '#B7B6B2'} />
      </svg>
      <span className="brand-name">沉浸式翻译</span>
    </div>
  );
}

/**
 * 当前平台「翻译 / 取消翻译此网站」的建议快捷键，用作 getAll() 返回空时的兜底显示。
 * 字形与 Chrome 在各平台 getAll() 返回一致：Mac 用 ⌘⇧A，其余用 Alt+Shift+A。
 */
function suggestedShortcut(): string {
  const isMac = /mac/i.test(navigator.platform || navigator.userAgent);
  return isMac ? '⌘⇧A' : 'Alt+Shift+A';
}

async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function querySafe(tabId: number, msg: PopupQuery): Promise<StatusReply | null> {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    // content script 没注入：chrome://、devtools、扩展页等。
    return null;
  }
}
