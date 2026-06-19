import { useCallback, useEffect, useState } from 'react';
import { isDomainEnabled, setDomainEnabled } from '@/lib/storage';
import { BACKEND_URL } from '@/lib/config';
import { getDeviceId, localDateString } from '@/lib/device';
import { getAccessToken, getEmail, login, logout, register } from '@/lib/auth';
import type { PopupQuery, StatusReply } from '@/lib/messages';
import { claimGift } from '@/lib/grant';

/** 额度信息（后端 /v1/usage）：三桶余额（giftCny/cny 单位元、usd 单位美元）+ hasAccount。 */
interface UsageInfo {
  loggedIn: boolean;
  giftCny?: number; // 赠送·人民币（元）
  cny?: number;     // 充值·人民币（元）
  usd?: number;     // 充值·美元（$）
  hasAccount?: boolean;
  tokensToday?: number;
  notice?: string | null;
}

/** 各桶 >0 才展示：赠送余额优先、人民币、美元分开列。返回如 ["赠送 ¥1.80", "$9.90"]。 */
function balanceParts(u: UsageInfo): string[] {
  const parts: string[] = [];
  if ((u.giftCny ?? 0) > 0) parts.push('赠送 ¥' + u.giftCny!.toFixed(2));
  if ((u.cny ?? 0) > 0) parts.push('¥' + u.cny!.toFixed(2));
  if ((u.usd ?? 0) > 0) parts.push('$' + u.usd!.toFixed(2));
  return parts;
}

interface PopupState {
  domain: string;
  favicon: string;
  enabled: boolean;
  status: StatusReply | null;
  loading: boolean;
  usage: UsageInfo | null;
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
        return (await r.json()) as UsageInfo;
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
  const openCacheSettings = useCallback(
    () => void chrome.tabs.create({ url: chrome.runtime.getURL('options.html#cache') }),
    []
  );

  if (s.loading) {
    return <div className="pop pop--msg">读取中…</div>;
  }

  // 非普通页面（chrome:// / 扩展页 / 新标签页等）。
  if (!s.domain) {
    return (
      <div className="pop">
        <Brand />
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
      <Brand />

      <AccountSection email={s.email} onChanged={() => void refresh()} />

      <GiftBar usage={s.usage} onChanged={() => void refresh()} />

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
            ? balanceParts(s.usage).length > 0
              ? `${s.usage.loggedIn ? '已登录 · ' : ''}余额 ${balanceParts(s.usage).join(' · ')}`
              : s.usage.hasAccount
                ? '额度已用完，去充值'
                : '装好即领 ¥2 赠送额度'
            : s.enabled
              ? (err ? '关掉再开可整页重译' : '自动翻译已开启')
              : '开启即整页翻译'}
        </span>
        <span>
          <button className="link" style={{ marginRight: 12 }} onClick={openCacheSettings}>缓存</button>
          <button className="link" onClick={openSettings}>设置 ›</button>
        </span>
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
        <span className="acct-email">未登录</span>
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

/** 额度条：登录用户显分桶余额 + 充值入口；未登录没领过则「领取 ¥2」，领过则显余额。 */
function GiftBar({ usage, onChanged }: { usage: UsageInfo | null; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!usage) return null;
  const parts = balanceParts(usage);

  if (usage.loggedIn) {
    return (
      <div className="byokbar">
        <span className="byokbar-t">{parts.length > 0 ? `余额 ${parts.join(' · ')}` : '额度已用完'}</span>
        <button className="link" onClick={() => chrome.runtime.openOptionsPage()}>
          充值 ›
        </button>
      </div>
    );
  }

  if (usage.hasAccount) {
    return (
      <div className="byokbar">
        <span className="byokbar-t">{parts.length > 0 ? `余额 ${parts.join(' · ')}` : '额度已用完'}</span>
        {parts.length === 0 && (
          <button className="link" onClick={() => chrome.runtime.openOptionsPage()}>
            充值 ›
          </button>
        )}
      </div>
    );
  }

  const onClaim = async () => {
    setErr(null);
    setBusy(true);
    const res = await claimGift();
    setBusy(false);
    if (res.ok) onChanged();
    else setErr('领取失败，请重试');
  };

  return (
    <div className="byokbar">
      <span className="byokbar-t">新用户赠送 ¥2 翻译额度</span>
      <button className="link" onClick={() => void onClaim()} disabled={busy}>
        {busy ? '领取中…' : '领取 ¥2'}
      </button>
      {err && <span className="auth-err">{err}</span>}
    </div>
  );
}

/** 品牌行：仅扩展名称——工具栏已有图标，popup 内不再重复小 logo。 */
function Brand() {
  return (
    <div className="brand">
      <span className="brand-name">秒懂翻译</span>
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
