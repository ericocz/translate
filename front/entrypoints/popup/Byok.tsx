import { useCallback, useEffect, useState } from 'react';
import { getBuyout, resolveTranslateRoute, type TranslateRoute } from '@/lib/storage';
import { unlock } from '@/lib/local-engine/key-vault';
import { redeemVerify, reasonText } from '@/lib/redeem';
import { BUYOUT_URL } from '@/lib/config';
import { readLastStats, downgradeRate, DOWNGRADE_NOTICE_THRESHOLD } from '@/lib/local-engine/stats';

/** popup 的 BYOK 区：未买断→激活码；已买断→模式角标 +（加密则）PIN 解锁 + 降级柔提示。 */
export function ByokSection({ onChanged }: { onChanged?: () => void }) {
  const [active, setActive] = useState(false);
  const [route, setRoute] = useState<TranslateRoute | null>(null);
  const [downgrade, setDowngrade] = useState(false);

  // 激活码
  const [codeOpen, setCodeOpen] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // 解锁
  const [pin, setPin] = useState('');
  const [pinErr, setPinErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const buyout = await getBuyout();
    setActive(buyout.active);
    if (buyout.active) {
      const r = await resolveTranslateRoute();
      setRoute(r);
      if (r.mode === 'byok') {
        const stats = await readLastStats();
        setDowngrade(!!stats && downgradeRate(stats) > DOWNGRADE_NOTICE_THRESHOLD);
      } else {
        setDowngrade(false);
      }
    } else {
      setRoute(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onActivate = useCallback(async () => {
    setErr(null);
    setBusy(true);
    try {
      const res = await redeemVerify(code);
      if (res.ok) {
        setCode('');
        setCodeOpen(false);
        await refresh();
        onChanged?.();
      } else {
        setErr(reasonText(res.reason));
      }
    } finally {
      setBusy(false);
    }
  }, [code, refresh, onChanged]);

  const onUnlock = useCallback(async () => {
    setPinErr(null);
    const ok = await unlock(pin);
    if (ok) {
      setPin('');
      await refresh();
      onChanged?.();
    } else {
      setPinErr('PIN 不正确');
    }
  }, [pin, refresh, onChanged]);

  // —— 未买断：折叠的激活入口 ——
  if (!active) {
    if (!codeOpen) {
      return (
        <div className="byokbar">
          <span className="byokbar-t">买断解锁自带模型</span>
          {BUYOUT_URL && (
            <a className="link" href={BUYOUT_URL} target="_blank" rel="noopener noreferrer">
              买断 $9.99 ›
            </a>
          )}
          <button className="link" onClick={() => setCodeOpen(true)}>
            已有激活码
          </button>
        </div>
      );
    }
    return (
      <div className="authbox">
        <input
          type="text"
          placeholder="激活码 IMT-XXXX-XXXX-XXXX"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void onActivate();
          }}
        />
        {err && <span className="auth-err">{err}</span>}
        <button className="action action--on" onClick={() => void onActivate()} disabled={busy}>
          <span>{busy ? '激活中…' : '激活'}</span>
        </button>
        <div className="auth-row">
          <span className="muted">激活后到「设置」配置自带模型</span>
          <button className="link" onClick={() => setCodeOpen(false)}>
            收起
          </button>
        </div>
      </div>
    );
  }

  // —— 已买断：模式角标 ——
  const badge =
    route?.mode === 'byok'
      ? { cls: 'byokbar-tag--on', text: `自带模型 · ${route.cfg.label}` }
      : route?.mode === 'locked'
        ? { cls: 'byokbar-tag--lock', text: '自带模型 · 已加密' }
        : { cls: 'byokbar-tag--platform', text: '平台额度' };

  return (
    <div className="byok">
      <div className="byokbar">
        <span className="byokbar-t">
          翻译模式
          <span className={'byokbar-tag ' + badge.cls}>{badge.text}</span>
        </span>
        <button className="link" onClick={() => chrome.runtime.openOptionsPage()}>
          配置 ›
        </button>
      </div>

      {route?.mode === 'locked' && (
        <div className="authbox">
          <input
            type="password"
            placeholder="输入 PIN 解锁自带模型"
            value={pin}
            autoComplete="off"
            onChange={(e) => setPin(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void onUnlock();
            }}
          />
          {pinErr && <span className="auth-err">{pinErr}</span>}
          <button className="action action--on" onClick={() => void onUnlock()} disabled={!pin}>
            <span>解锁</span>
          </button>
        </div>
      )}

      {downgrade && (
        <div className="status">
          <span className="dot dot--off" />
          <span>当前模型对占位符支持不佳，部分段落可能丢格式，建议在设置里换模型或测试兼容性。</span>
        </div>
      )}
    </div>
  );
}
