// 买断码激活：客户端填码 → 后端 POST /v1/redeem/verify 验码 + 绑当前设备。
// 成功即在本地记买断态、解锁 BYOK（后续翻译走客户端直连，不再经本服务）。

import { BACKEND_URL } from './config';
import { getDeviceId } from './device';
import { getBuyout, setBuyout } from './storage';

export interface RedeemOutcome {
  ok: boolean;
  product?: string;
  /** 失败原因：missing_device | invalid_code | device_limit | network。 */
  reason?: string;
}

const REASON_TEXT: Record<string, string> = {
  missing_device: '设备标识缺失，请重试',
  invalid_code: '激活码无效或已失效',
  device_limit: '此激活码绑定的设备已达上限',
  network: '无法连接服务器，请检查网络',
};

export function reasonText(reason?: string): string {
  return (reason && REASON_TEXT[reason]) || '激活失败，请重试';
}

/** 提交买断码激活；成功时落地买断态。 */
export async function redeemVerify(code: string): Promise<RedeemOutcome> {
  const trimmed = code.trim();
  if (!trimmed) return { ok: false, reason: 'invalid_code' };
  let deviceId: string;
  try {
    deviceId = await getDeviceId();
  } catch {
    return { ok: false, reason: 'missing_device' };
  }
  let r: Response;
  try {
    r = await fetch(`${BACKEND_URL}/v1/redeem/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-Id': deviceId },
      body: JSON.stringify({ code: trimmed }),
    });
  } catch {
    return { ok: false, reason: 'network' };
  }
  if (!r.ok) return { ok: false, reason: 'network' };
  const data = (await r.json().catch(() => ({}))) as RedeemOutcome;
  if (data.ok) {
    const prev = await getBuyout();
    await setBuyout({ ...prev, active: true, code: trimmed, activatedAt: Date.now() });
  }
  return data;
}
