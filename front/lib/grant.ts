// 领取赠送额度 ¥2：调后端 /v1/grant/gift。
// 防薅：带 X-Instance-Id（chrome.instanceID，清 storage 免疫）——同一实例反复领会被后端幂等拦下。

import { BACKEND_URL } from './config';
import { getDeviceId, getInstanceId } from './device';

// 领取失败的原因：
//  - 'network'：请求根本没到后端（后端没起 / 断网 / 浏览器走的代理拦截了 localhost——dev 常见，
//    Clash 等系统代理会对 http://localhost:8000 回 503）；
//  - 'server'：到了后端但回非 2xx（5xx / 限流 / 数据库挂）。
// 注意：领取**不依赖任何浏览器权限**——gcm（chrome.instanceID）取不到只是防薅退化、绝不阻断领取
// （见 device.ts getInstanceId 与后端 fallback）。故失败从来不是「缺权限」，没有可引导用户授权的动作。
export type GiftError = 'network' | 'server';

export interface GiftOutcome {
  ok: boolean;
  balance?: number; // 元
  error?: GiftError;
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
    if (!r.ok) return { ok: false, error: 'server' };
    return (await r.json()) as GiftOutcome;
  } catch {
    return { ok: false, error: 'network' };
  }
}
