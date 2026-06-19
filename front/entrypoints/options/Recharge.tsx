import { useCallback, useEffect, useRef, useState } from 'react';
import { getEmail } from '@/lib/auth';
import { createRecharge, fetchBalances, type Balances, type RechargeOrder } from '@/lib/recharge';
import { CREEM_RECHARGE_URL } from '@/lib/config';

const TIERS = ['10', '30', '68'];

/** 余额各桶 >0 才展示：如「赠送 ¥1.80 · ¥10.00 · $9.90」。 */
function balanceText(b: Balances): string {
  const parts: string[] = [];
  if (b.giftCny > 0) parts.push('赠送 ¥' + b.giftCny.toFixed(2));
  if (b.cny > 0) parts.push('¥' + b.cny.toFixed(2));
  if (b.usd > 0) parts.push('$' + b.usd.toFixed(2));
  return parts.length ? '余额 ' + parts.join(' · ') : '余额 0';
}

/** 充值卡（options）：充值须登录。大陆走微信扫码（人民币桶）、海外走 Creem（美元桶 $9.9）。 */
export function RechargeCard() {
  const [email, setEmail] = useState<string | null>(null);
  const [bal, setBal] = useState<Balances | null>(null);
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
      setBal(await fetchBalances());
    })();
    return stopPoll;
  }, []);

  /** 轮询余额：任一桶变大（到账）即提示并停。 */
  const pollUntilPaid = useCallback((before: Balances) => {
    stopPoll();
    pollRef.current = setInterval(async () => {
      const b = await fetchBalances();
      if (b) {
        setBal(b);
        if (b.giftCny > before.giftCny || b.cny > before.cny || b.usd > before.usd) {
          setPaid(true);
          setOrder(null);
          stopPoll();
        }
      }
    }, 3000);
  }, []);

  const onPickCny = useCallback(
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
      pollUntilPaid(bal ?? { giftCny: 0, cny: 0, usd: 0 });
    },
    [bal, pollUntilPaid]
  );

  const onPayUsd = useCallback(() => {
    setErr(null);
    setPaid(false);
    // Creem 静态 payment link 外开新页支付；回到此页后轮询美元桶到账（须用注册邮箱付款）。
    window.open(CREEM_RECHARGE_URL, '_blank', 'noopener');
    pollUntilPaid(bal ?? { giftCny: 0, cny: 0, usd: 0 });
  }, [bal, pollUntilPaid]);

  return (
    <section className="card">
      <div className="card-h">
        <h2>充值额度</h2>
        {bal && <span className="muted">{balanceText(bal)}</span>}
      </div>

      {!email ? (
        <p className="muted">充值需登录（余额跨设备 / 找回）。请在扩展弹窗登录后再来此页充值。</p>
      ) : (
        <>
          <p className="muted">微信扫码支付（人民币），支付后额度自动到账（¥1 = ¥1 翻译额度）。</p>
          <div style={{ display: 'flex', gap: 8 }}>
            {TIERS.map((t) => (
              <button key={t} className="ghost" disabled={busy} onClick={() => void onPickCny(t)}>
                ¥{t}
              </button>
            ))}
          </div>

          {CREEM_RECHARGE_URL && (
            <>
              <p className="muted" style={{ marginTop: 14 }}>
                海外信用卡支付（美元）：充值 $9.9 美元额度。<b>请用注册邮箱（{email}）付款</b>，否则无法自动到账。
              </p>
              <button className="ghost" onClick={onPayUsd}>
                充值 $9.9 ›
              </button>
            </>
          )}

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
