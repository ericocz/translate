import { useCallback, useEffect, useState } from 'react';
import { isDomainEnabled, setDomainEnabled } from '@/lib/storage';
import type { PopupQuery, StatusReply } from '@/lib/messages';

interface PopupState {
  domain: string;
  enabled: boolean;
  status: StatusReply | null;
  loading: boolean;
}

export function Popup() {
  const [s, setS] = useState<PopupState>({
    domain: '',
    enabled: false,
    status: null,
    loading: true,
  });

  const refresh = useCallback(async () => {
    const tab = await getActiveTab();
    if (!tab?.url) {
      setS({ domain: '', enabled: false, status: null, loading: false });
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
    setS({ domain, enabled, status, loading: false });
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 1500);
    return () => clearInterval(t);
  }, [refresh]);

  const onToggle = useCallback(async () => {
    if (!s.domain) return;
    const next = !s.enabled;
    await setDomainEnabled(s.domain, next);
    const tab = await getActiveTab();
    if (tab?.id) {
      await querySafe(tab.id, { kind: 'toggle-site', enabled: next });
    }
    await refresh();
  }, [s.domain, s.enabled, refresh]);

  const onRetry = useCallback(async () => {
    const tab = await getActiveTab();
    if (!tab?.id) return;
    await querySafe(tab.id, { kind: 'retry-failed' });
    await refresh();
  }, [refresh]);

  const onFlip = useCallback(async () => {
    const tab = await getActiveTab();
    if (!tab?.id) return;
    await querySafe(tab.id, { kind: 'flip-page' });
    await refresh();
  }, [refresh]);

  const openSettings = useCallback(() => {
    // WXT 生成的 options 页：用 chrome 原生入口最稳。
    chrome.runtime.openOptionsPage();
  }, []);

  if (s.loading) {
    return <div className="pop">读取中…</div>;
  }

  if (!s.domain) {
    return (
      <div className="pop">
        <h1>当前页面不可翻译</h1>
        <div className="domain">仅在普通 http/https 页面生效。</div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="link" onClick={openSettings}>打开设置</button>
        </div>
      </div>
    );
  }

  const status = s.status;
  const progressText = status && status.total > 0
    ? status.running
      ? `已翻译 ${status.done} / ${status.total} 段`
      : status.failed > 0
        ? `完成 ${status.done} / ${status.total}，${status.failed} 段未译`
        : `已译完 ${status.total} 段`
    : null;

  return (
    <div className="pop">
      <h1>沉浸式翻译</h1>
      <div className="domain">{s.domain}</div>

      <div className="row">
        <span>在此站点自动翻译</span>
        <label className="switch">
          <input type="checkbox" checked={s.enabled} onChange={onToggle} />
          <span className="slider" />
        </label>
      </div>

      {progressText && <div className="progress">{progressText}</div>}

      {status?.error && <div className="error">{status.error}</div>}

      <div className="row">
        <button onClick={onRetry} disabled={!status || status.running || (status.failed === 0 && status.done === status.total)}>
          重试未完成
        </button>
        <button onClick={onFlip} disabled={!status || status.total === 0}>
          整页翻面
        </button>
      </div>

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="link" onClick={openSettings}>打开设置</button>
      </div>
    </div>
  );
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
