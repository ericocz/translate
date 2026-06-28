import { useCallback, useEffect, useRef, useState } from 'react';
import { getEmail } from '@/lib/auth';
import { createRecharge, fetchBalances, type Balances, type RechargeOrder } from '@/lib/recharge';
import { CREEM_RECHARGE_URL } from '@/lib/config';
import { useT } from '@/lib/i18n-react';
import type { Messages } from '@/lib/i18n';

const TIERS = ['1', '5', '10', '50'];

/** 余额各桶 >0 才展示：如「赠送 ¥1.80 · ¥10.00 · $9.90」。 */
function balanceText(b: Balances, m: Messages): string {
  const parts: string[] = [];
  if (b.giftCny > 0) parts.push(`${m.popup.giftWord} ¥` + b.giftCny.toFixed(2));
  if (b.cny > 0) parts.push('¥' + b.cny.toFixed(2));
  if (b.usd > 0) parts.push('$' + b.usd.toFixed(2));
  return parts.length ? m.popup.balance(parts.join(' · ')) : m.recharge.balanceZero;
}

/** 充值卡（options）：充值须登录。大陆走微信扫码（人民币桶）、海外走 Creem（美元桶 $9.9）。 */
export function RechargeCard() {
  const { m } = useT();
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
            ? m.recharge.unconfigured
            : res.error === 'login_required'
              ? m.recharge.loginFirst
              : m.recharge.orderFailed
        );
        return;
      }
      setOrder(res);
      pollUntilPaid(bal ?? { giftCny: 0, cny: 0, usd: 0 });
    },
    [bal, pollUntilPaid, m]
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
        <h2>{m.recharge.title}</h2>
        {bal && <span className="muted">{balanceText(bal, m)}</span>}
      </div>

      {!email ? (
        <p className="muted">{m.recharge.loginRequired}</p>
      ) : (
        <>
          <p className="muted">{m.recharge.wechatDesc}</p>
          <div className="tiers">
            {TIERS.map((t) => (
              <button key={t} className="ghost" disabled={busy} onClick={() => void onPickCny(t)}>
                ¥{t}
              </button>
            ))}
          </div>

          {CREEM_RECHARGE_URL && (
            <div className="line" style={{ marginTop: 6 }}>
              <span className="muted">{m.recharge.usdLine(email)}</span>
              <button className="ghost" onClick={onPayUsd}>
                {m.recharge.usdBtn}
              </button>
            </div>
          )}

          {err && <div className="pay-msg pay-msg--err">{err}</div>}
          {paid && <div className="pay-msg pay-msg--ok">{m.recharge.paidOk}</div>}
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
              <img src={order.qr} alt={m.recharge.qrAlt} width={180} height={180} />
              <span className="muted">{m.recharge.qrCaption(order.yuan ?? '')}</span>
            </div>
          )}
        </>
      )}
    </section>
  );
}
