import { useCallback, useEffect, useRef, useState } from 'react';
import { getEmail } from '@/lib/auth';
import { createRecharge, fetchBalance, type RechargeOrder } from '@/lib/recharge';

const TIERS = ['10', '30', '68'];

/** 充值卡（options）：充值须登录。登录后选档位 → 微信扫码二维码 → 轮询余额到账。 */
export function RechargeCard() {
  const [email, setEmail] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [order, setOrder] = useState<RechargeOrder | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [paid, setPaid] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPoll = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  useEffect(() => {
    void (async () => {
      setEmail(await getEmail());
      setBalance(await fetchBalance());
    })();
    return stopPoll;
  }, []);

  const onPick = useCallback(
    async (tier: string) => {
      setErr(null);
      setPaid(false);
      setBusy(true);
      const res = await createRecharge(tier);
      setBusy(false);
      if (!res.ok) {
        setErr(
          res.error === 'unconfigured'
            ? '充值暂未开通'
            : res.error === 'login_required'
              ? '请先在弹窗登录'
              : '下单失败，请重试'
        );
        return;
      }
      setOrder(res);
      // 轮询余额：到账（变大）即提示并停。
      const before = balance ?? 0;
      stopPoll();
      pollRef.current = setInterval(async () => {
        const b = await fetchBalance();
        if (b !== null) {
          setBalance(b);
          if (b > before) {
            setPaid(true);
            setOrder(null);
            stopPoll();
          }
        }
      }, 3000);
    },
    [balance]
  );

  return (
    <section className="card">
      <div className="card-h">
        <h2>充值额度</h2>
        {balance !== null && (
          <span className="muted">余额 ¥{balance.toFixed(2)}</span>
        )}
      </div>

      {!email ? (
        <p className="muted">充值需登录（余额跨设备 / 找回）。请在扩展弹窗登录后再来此页充值。</p>
      ) : (
        <>
          <p className="muted">微信扫码支付，支付后额度自动到账（¥1 = ¥1 翻译额度）。</p>
          <div style={{ display: 'flex', gap: 8 }}>
            {TIERS.map((t) => (
              <button key={t} className="ghost" disabled={busy} onClick={() => void onPick(t)}>
                ¥{t}
              </button>
            ))}
          </div>
          {err && <div className="byok-score byok-score--poor">{err}</div>}
          {paid && <div className="byok-score byok-score--good">充值成功，额度已到账。</div>}
          {order?.qr && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 6,
                marginTop: 10,
              }}
            >
              <img src={order.qr} alt="微信支付二维码" width={180} height={180} />
              <span className="muted">微信扫码支付 ¥{order.yuan} · 支付后自动到账</span>
            </div>
          )}
        </>
      )}
    </section>
  );
}
