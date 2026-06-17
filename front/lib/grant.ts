// 领取赠送额度 ¥2：调后端 /v1/grant/gift。
// 防薅：带 X-Instance-Id（chrome.instanceID，清 storage 免疫）——同一实例反复领会被后端幂等拦下。

import { BACKEND_URL } from './config';
import { getDeviceId, getInstanceId } from './device';

export interface GiftOutcome {
  ok: boolean;
  balance?: number; // 元
  error?: string;
}

export async function claimGift(): Promise<GiftOutcome> {
  const [deviceId, instanceId] = await Promise.all([getDeviceId(), getInstanceId()]);
  try {
    const r = await fetch(`${BACKEND_URL}/v1/grant/gift`, {
      method: 'POST',
      headers: {
        'X-Device-Id': deviceId,
        ...(instanceId ? { 'X-Instance-Id': instanceId } : {}),
      },
    });
    if (!r.ok) return { ok: false, error: 'network' };
    return (await r.json()) as GiftOutcome;
  } catch {
    return { ok: false, error: 'network' };
  }
}
