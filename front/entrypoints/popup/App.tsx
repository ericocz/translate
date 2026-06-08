import { useCallback, useEffect, useState } from 'react';
import { isDomainEnabled, setDomainEnabled } from '@/lib/storage';
import { BACKEND_URL } from '@/lib/config';
import { getDeviceId, localDateString } from '@/lib/device';
import { getAccessToken, getEmail, login, logout, register } from '@/lib/auth';
import type { PopupQuery, StatusReply } from '@/lib/messages';

interface PopupState {
  domain: string;
  favicon: string;
  enabled: boolean;
  status: StatusReply | null;
  loading: boolean;
  /** 当日免费用量；登录则 loggedIn=true（无限）；后端不可达时为 null。 */
  usage: {
    loggedIn: boolean;
    used?: number;
    limit?: number | null;
    remaining?: number | null;
    tokensToday?: number;
    cap?: number | null;
    notice?: string | null;
  } | null;
  /** 已登录邮箱；未登录为 null。 */
  email: string | null;
}

export function Popup() {
  const [s, setS] = useState<PopupState>({
    domain: '',
    favicon: '',
    enabled: false,
    status: null,
    loading: true,
    usage: null,
    email: null,
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

  const fetchUsage = useCallback(async () => {
    try {
      const deviceId = await getDeviceId();
      const accessToken = await getAccessToken();
      const r = await fetch(`${BACKEND_URL}/v1/usage?localDate=${localDateString()}`, {
        headers: {
          'X-Device-Id': deviceId,
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
      });
      if (r.ok) {
        return (await r.json()) as {
          loggedIn: boolean;
          used?: number;
          limit?: number | null;
          remaining?: number | null;
          tokensToday?: number;
          cap?: number | null;
          notice?: string | null;
        };
      }
    } catch {
      // 后端不可达时不显示用量，不报错。
    }
    return null;
  }, []);

  const refresh = useCallback(async () => {
    const tab = await getActiveTab();
    if (!tab?.url) {
      setS({ domain: '', favicon: '', enabled: false, status: null, loading: false, usage: null, email: await getEmail() });
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
    const usage = await fetchUsage();
    const email = await getEmail();
    setS({ domain, favicon: tab.favIconUrl ?? '', enabled, status, loading: false, usage, email });
  }, [fetchUsage]);

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

      <AccountSection email={s.email} onChanged={() => void refresh()} />

      {s.usage?.notice && (
        <div className="status">
          <span className="dot dot--off" />
          <span>{s.usage.notice}</span>
        </div>
      )}

      <div className="domain">
        {s.favicon ? (
          <img className="fav" src={s.favicon} alt="" />
        ) : (
          <span className="fav fav--ph" />
        )}
        <span className="domain-name">{s.domain}</span>
      </div>

      {/* 状态行（一行极轻文字，不是进度条横幅） */}
      {err && st?.errorKind === 'quota' ? (
        <div className="status">
          <span className="dot dot--off" />
          <span>{err}</span>
        </div>
      ) : err ? (
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
          {s.usage
            ? s.usage.loggedIn
              ? `已登录 · 今日 ${s.usage.tokensToday ?? 0}/${s.usage.cap ?? '∞'} token`
              : `免费 ${s.usage.used}/${s.usage.limit} 页 · 登录后无限`
            : s.enabled
              ? (err ? '关掉再开可整页重译' : '自动翻译已开启')
              : '开启即整页翻译'}
        </span>
        <button className="link" onClick={openSettings}>设置 ›</button>
      </div>
    </div>
  );
}

/** 账号区：已登录显示邮箱 + 登出；未登录折叠为一行 CTA，点开展为登录/注册表单。 */
function AccountSection({ email, onChanged }: { email: string | null; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [emailInput, setEmailInput] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onLogout = useCallback(async () => {
    await logout();
    onChanged();
  }, [onChanged]);

  const onSubmit = useCallback(async () => {
    setErr(null);
    setBusy(true);
    try {
      if (mode === 'register') await register(emailInput.trim(), pw);
      else await login(emailInput.trim(), pw);
      setPw('');
      setOpen(false);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }, [mode, emailInput, pw, onChanged]);

  if (email) {
    return (
      <div className="acct">
        <span className="acct-email">{email}</span>
        <button className="link" onClick={() => void onLogout()}>登出</button>
      </div>
    );
  }

  if (!open) {
    return (
      <div className="acct">
        <span className="acct-email">未登录 · 免费 3 页/天</span>
        <button className="link" onClick={() => setOpen(true)}>登录 / 注册</button>
      </div>
    );
  }

  return (
    <div className="authbox">
      <input
        type="email"
        placeholder="邮箱"
        value={emailInput}
        onChange={(e) => setEmailInput(e.target.value)}
        autoComplete="username"
      />
      <input
        type="password"
        placeholder="密码（至少 6 位）"
        value={pw}
        onChange={(e) => setPw(e.target.value)}
        autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void onSubmit();
        }}
      />
      {err && <span className="auth-err">{err}</span>}
      <button className="action action--on" onClick={() => void onSubmit()} disabled={busy}>
        <span>{busy ? '请稍候…' : mode === 'register' ? '注册并登录' : '登录'}</span>
      </button>
      <div className="auth-row">
        <button
          className="link"
          onClick={() => {
            setErr(null);
            setMode(mode === 'login' ? 'register' : 'login');
          }}
        >
          {mode === 'login' ? '没有账号？注册' : '已有账号？登录'}
        </button>
        <button className="link" onClick={() => setOpen(false)}>收起</button>
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
