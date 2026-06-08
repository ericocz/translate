// 运营打点 / 错误上报：fire-and-forget，绝不抛错、绝不阻断翻译、绝不带页面正文（只带 host + 计数）。
import { BACKEND_URL } from './config';
import { getDeviceId } from './device';
import { getAccessToken } from './auth';

async function authHeaders(): Promise<Record<string, string>> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  try {
    h['X-Device-Id'] = await getDeviceId();
    const t = await getAccessToken();
    if (t) h.Authorization = `Bearer ${t}`;
  } catch {
    // 忽略：打点不该因身份获取失败而出错。
  }
  return h;
}

export function track(type: string, host: string | null, props: Record<string, unknown> = {}): void {
  void (async () => {
    try {
      await fetch(`${BACKEND_URL}/v1/events`, {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ events: [{ type, host, props }] }),
      });
    } catch {
      // fire-and-forget
    }
  })();
}

export function reportError(
  kind: string,
  message: string,
  context: Record<string, unknown> = {}
): void {
  void (async () => {
    try {
      await fetch(`${BACKEND_URL}/v1/errors`, {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ errors: [{ kind, message, context }] }),
      });
    } catch {
      // fire-and-forget
    }
  })();
}
