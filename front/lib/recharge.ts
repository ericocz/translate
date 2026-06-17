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

/** 当前登录用户余额（元）；未登录或失败返回 null。用于充值后轮询到账。 */
export async function fetchBalance(): Promise<number | null> {
  const token = await getAccessToken();
  if (!token) return null;
  try {
    const r = await fetch(`${BACKEND_URL}/v1/usage`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const d = (await r.json()) as { balance?: number };
    return typeof d.balance === 'number' ? d.balance : null;
  } catch {
    return null;
  }
}
