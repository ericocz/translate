// 充值 credits（须登录）：选档位 → 后端 YunGouOS 微信扫码下单 → 拿付款二维码 → 支付后异步到账。
import { BACKEND_URL } from './config';
import { getAccessToken } from './auth';

export interface RechargeOrder {
  ok: boolean;
  qr?: string; // 付款二维码图片地址
  outTradeNo?: string;
  yuan?: number;
  error?: string;
}

export async function createRecharge(tier: string): Promise<RechargeOrder> {
  const token = await getAccessToken();
  if (!token) return { ok: false, error: 'login_required' };
  try {
    const r = await fetch(`${BACKEND_URL}/v1/recharge/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ tier }),
    });
    if (!r.ok) return { ok: false, error: 'network' };
    return (await r.json()) as RechargeOrder;
  } catch {
    return { ok: false, error: 'network' };
  }
}

/** 当前登录用户分桶余额（giftCny/cny 元、usd 美元）。 */
export interface Balances {
  giftCny: number;
  cny: number;
  usd: number;
}

/** 当前登录用户分桶余额；未登录或失败返回 null。用于充值后轮询到账（任一桶变大即到账）。 */
export async function fetchBalances(): Promise<Balances | null> {
  const token = await getAccessToken();
  if (!token) return null;
  try {
    const r = await fetch(`${BACKEND_URL}/v1/usage`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const d = (await r.json()) as Partial<Balances>;
    return { giftCny: d.giftCny ?? 0, cny: d.cny ?? 0, usd: d.usd ?? 0 };
  } catch {
    return null;
  }
}
