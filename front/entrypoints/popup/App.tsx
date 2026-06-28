import { useCallback, useEffect, useState } from 'react';
import { isDomainEnabled, setDomainEnabled } from '@/lib/storage';
import { BACKEND_URL } from '@/lib/config';
import { getDeviceId, localDateString } from '@/lib/device';
import { getAccessToken, getEmail, login, logout, register } from '@/lib/auth';
import { getTargetLang, setTargetLang, getBilingual, setBilingual } from '@/lib/storage';
import { targetLanguages, type LangOption } from '@/lib/languages';
import { useT } from '@/lib/i18n-react';
import type { Messages, UiLocale } from '@/lib/i18n';
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
function balanceParts(u: UsageInfo, giftWord: string): string[] {
  const parts: string[] = [];
  if ((u.giftCny ?? 0) > 0) parts.push(`${giftWord} ¥` + u.giftCny!.toFixed(2));
  if ((u.cny ?? 0) > 0) parts.push('¥' + u.cny!.toFixed(2));
  if ((u.usd ?? 0) > 0) parts.push('$' + u.usd!.toFixed(2));
  return parts;
}

interface PopupState {
  domain: string;
  enabled: boolean;
  status: StatusReply | null;
  loading: boolean;
  usage: UsageInfo | null;
  /** 已登录邮箱；未登录为 null。 */
  email: string | null;
}

export function Popup() {
  const { m, locale } = useT();
  const [s, setS] = useState<PopupState>({
    domain: '',
    enabled: false,
    status: null,
    loading: true,
    usage: null,
    email: null,
  });
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
      setS({ domain: '', enabled: false, status: null, loading: false, usage: null, email: await getEmail() });
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
    setS({ domain, enabled, status, loading: false, usage, email });
  }, [fetchUsage]);

  useEffect(() => {
    void refresh();
    // 翻译进行时轮询拿进度（一行极轻文字 + 进度条）。
    const t = setInterval(() => void refresh(), 1200);
    return () => clearInterval(t);
  }, [refresh]);

  // 文档语言随界面语言（影响字体渲染 / 无障碍）。
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

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
    return <div className="pop pop--msg">{m.popup.loading}</div>;
  }

  // 非普通页面（chrome:// / 扩展页 / 新标签页等）。
  if (!s.domain) {
    return (
      <div className="pop">
        <Brand brand={m.brand} />
        <div className="msg">
          <p className="msg-title">{m.popup.notTranslatableTitle}</p>
          <p className="msg-sub">{m.popup.notTranslatableSub}</p>
        </div>
        <div className="foot">
          <span className="foot-hint" />
          <button className="link" onClick={openSettings}>{m.popup.settings}</button>
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
      <Brand brand={m.brand} />

      <AccountSection email={s.email} onChanged={() => void refresh()} m={m} />

      <GiftBar usage={s.usage} email={s.email} onChanged={() => void refresh()} m={m} />

      {s.usage?.notice && (
        <div className="status">
          <span className="dot dot--off" />
          <span>{s.usage.notice}</span>
        </div>
      )}

      <TargetLangRow enabled={s.enabled} m={m} locale={locale} />

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
      ) : !s.enabled ? null : running ? (
        <>
          <div className="status">
            <span className="dot dot--on pulse" />
            <span>
              {m.popup.translatingThisPage}
              {total > 0 ? <>{' · '}{m.popup.segDoneOfTotal(done, total)}</> : '…'}
            </span>
          </div>
          <div className="prog">
            <i style={{ width: total > 0 ? `${pct}%` : '35%' }} />
          </div>
        </>
      ) : (
        <div className="status">
          <span className="dot dot--on" />
          <span>{total > 0 ? m.popup.transReady : m.popup.autoOn}</span>
        </div>
      )}

      {/* 一键翻译按钮 + 左侧双语对照切换（替换↔双语） */}
      <div className="action-row">
        <BilingualToggle m={m} />
        <button
          className={'action ' + (s.enabled ? 'action--quiet' : 'action--primary')}
          onClick={onToggle}
        >
          <span>
            {s.enabled ? m.popup.cancelTranslate : m.popup.translate}
            <em className="action-key"> (Ctrl+X)</em>
          </span>
        </button>
      </div>

      <div className="foot foot--end">
        <button className="link" onClick={openSettings}>{m.popup.settings}</button>
      </div>
    </div>
  );
}

/** 账号区：已登录显示邮箱 + 登出；未登录折叠为一行 CTA，点开展为登录/注册表单。 */
function AccountSection({ email, onChanged, m }: { email: string | null; onChanged: () => void; m: Messages }) {
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
      setErr(e instanceof Error ? e.message : m.popup.opFailed);
    } finally {
      setBusy(false);
    }
  }, [mode, emailInput, pw, onChanged, m]);

  if (email) {
    return (
      <div className="acct">
        <span className="acct-email">{email}</span>
        <button className="link" onClick={() => void onLogout()}>{m.popup.logout}</button>
      </div>
    );
  }

  if (!open) {
    return (
      <div className="acct">
        <span className="acct-email">{m.popup.notLoggedIn}</span>
        <span className="acct-actions">
          <button className="link" onClick={() => { setErr(null); setMode('login'); setOpen(true); }}>{m.popup.login}</button>
          <button className="link" onClick={() => { setErr(null); setMode('register'); setOpen(true); }}>{m.popup.register}</button>
        </span>
      </div>
    );
  }

  return (
    <div className="authbox">
      <input
        type="email"
        placeholder={m.popup.emailPlaceholder}
        value={emailInput}
        onChange={(e) => setEmailInput(e.target.value)}
        autoComplete="username"
      />
      <input
        type="password"
        placeholder={m.popup.pwPlaceholder}
        value={pw}
        onChange={(e) => setPw(e.target.value)}
        autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void onSubmit();
        }}
      />
      {err && <span className="auth-err">{err}</span>}
      <button className="action action--primary" onClick={() => void onSubmit()} disabled={busy}>
        <span>{busy ? m.popup.pleaseWait : mode === 'register' ? m.popup.registerAndLogin : m.popup.login}</span>
      </button>
      <div className="auth-row">
        <button
          className="link"
          onClick={() => {
            setErr(null);
            setMode(mode === 'login' ? 'register' : 'login');
          }}
        >
          {mode === 'login' ? m.popup.noAccountRegister : m.popup.haveAccountLogin}
        </button>
        <button className="link" onClick={() => setOpen(false)}>{m.popup.collapse}</button>
      </div>
    </div>
  );
}

/** 额度条：登录用户显分桶余额 + 充值入口；未登录没领过则「领取 ¥2」，领过则显余额。
 *  领取**不需要登录**——故未登录用户必须始终有领取入口，包括后端暂时连不上（usage 取不到）时
 *  也给入口（领取后端幂等、连上即到账）。已登录但 usage 取不到则只给「重试」（不误导其重复领取）。 */
function GiftBar({ usage, email, onChanged, m }: { usage: UsageInfo | null; email: string | null; onChanged: () => void; m: Messages }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onClaim = async () => {
    setErr(null);
    setBusy(true);
    const res = await claimGift();
    setBusy(false);
    if (res.ok) onChanged();
    else setErr(res.error === 'server' ? m.popup.serverBusy : m.popup.netRetry);
  };

  // 后端不可达（usage 没取到）：登录用户给「重试」；未登录直接给「领取 ¥2」入口。
  if (!usage) {
    if (email) {
      return (
        <div className="balancebar">
          <span className="balancebar-t">{m.popup.cantReachServer}</span>
          <button className="link" onClick={onChanged}>{m.retry}</button>
        </div>
      );
    }
    return (
      <div className="balancebar">
        <span className="balancebar-t">{m.popup.giftNewUser}</span>
        <button className="link" onClick={() => void onClaim()} disabled={busy}>
          {busy ? m.popup.claiming : m.popup.claim2}
        </button>
        {err && <span className="auth-err">{err}</span>}
      </div>
    );
  }

  const parts = balanceParts(usage, m.popup.giftWord);

  if (usage.loggedIn) {
    return (
      <div className="balancebar">
        <span className="balancebar-t">{parts.length > 0 ? m.popup.balance(parts.join(' · ')) : m.popup.balanceEmpty}</span>
        <button className="link" onClick={() => chrome.runtime.openOptionsPage()}>
          {m.popup.recharge}
        </button>
      </div>
    );
  }

  if (usage.hasAccount) {
    return (
      <div className="balancebar">
        <span className="balancebar-t">{parts.length > 0 ? m.popup.balance(parts.join(' · ')) : m.popup.balanceEmpty}</span>
        {parts.length === 0 && (
          <button className="link" onClick={() => chrome.runtime.openOptionsPage()}>
            {m.popup.recharge}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="balancebar">
      <span className="balancebar-t">{m.popup.giftNewUser}</span>
      <button className="link" onClick={() => void onClaim()} disabled={busy}>
        {busy ? m.popup.claiming : m.popup.claim2}
      </button>
      {err && <span className="auth-err">{err}</span>}
    </div>
  );
}

/**
 * 目标语言选择行：清单按界面语言取（中文界面中文清单/中文名、英文界面英文清单/英文名）。
 * 选中即持久化到设置；若当前站点已开启翻译，则就地重译生效（先还原再翻译，不动白名单）。
 */
function TargetLangRow({ enabled, m, locale }: { enabled: boolean; m: Messages; locale: UiLocale }) {
  const [opts, setOpts] = useState<LangOption[]>(() => targetLanguages(locale));
  const [code, setCode] = useState<string | null>(null);

  // 界面语言变化时刷新清单（显示名 / 排序随之变）。
  useEffect(() => {
    setOpts(targetLanguages(locale));
  }, [locale]);

  useEffect(() => {
    void getTargetLang().then(setCode);
  }, []);

  const onChange = useCallback(
    async (next: string) => {
      setCode(next);
      await setTargetLang(next);
      // 已开站：先取消翻译（还原原文、清 records）再重新翻译，让新目标语言立即生效。
      if (enabled) {
        const tab = await getActiveTab();
        if (tab?.id) {
          await querySafe(tab.id, { kind: 'toggle-site', enabled: false });
          await querySafe(tab.id, { kind: 'toggle-site', enabled: true });
        }
      }
    },
    [enabled]
  );

  return (
    <label className="lang">
      <span className="lang-label">{m.popup.targetLang}</span>
      <select
        className="lang-select"
        value={code ?? ''}
        onChange={(e) => void onChange(e.target.value)}
      >
        {code === null && <option value="">…</option>}
        {opts.map((o) => (
          <option key={o.code} value={o.code}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * 双语对照切换（放在翻译按钮左侧，纯图标按钮）：开启＝译文追加在原文下方（双语对照），关闭＝译文替换原文（隐形）。
 * 两态靠**图标本身**区分（不靠颜色）：双语态 = 上下堆叠的对照图标；替换态 = 互换箭头图标。
 * 仅写设置；已开站 / 悬停译过的页面的 content script 监听 storage 变化会就地重排，无需重译、无需重开站。
 */
function BilingualToggle({ m }: { m: Messages }) {
  const [on, setOn] = useState<boolean | null>(null);

  useEffect(() => {
    void getBilingual().then(setOn);
  }, []);

  const toggle = useCallback(async () => {
    const next = !on;
    setOn(next);
    await setBilingual(next);
  }, [on]);

  return (
    <button
      type="button"
      className="bi-toggle"
      role="switch"
      aria-checked={!!on}
      aria-label={m.popup.bilingualAria}
      title={on ? m.popup.bilingualTitleOn : m.popup.bilingualTitleOff}
      onClick={() => void toggle()}
    >
      {/* 图标（CSS mask + currentColor，两态恒同色、随 hover/主题变色）：双语态=「文A」两语并存，替换态=「A」单一 */}
      <span className="bi-glyph" data-mode={on ? 'bilingual' : 'replace'} />
    </button>
  );
}

/** 品牌行：仅扩展名称（单色、字距舒展）；工具栏已有图标，popup 内不再重复小 logo。 */
function Brand({ brand }: { brand: string }) {
  return (
    <div className="brand">
      <span className="brand-name">{brand}</span>
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
