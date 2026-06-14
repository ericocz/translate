// 账号态：token 持久化（chrome.storage.local）+ 注册/登录/登出 + access 静默刷新。
import { BACKEND_URL } from './config';
import { encryptionEnabled, ephemeralPublicKey, encryptField } from './crypto';

const KEY = 'auth';
const ACCESS_TTL_MS = 30 * 60 * 1000; // 与后端 access_ttl_min 一致（本地估算用）

interface AuthStore {
  access: string;
  refresh: string;
  email: string;
  accessExp: number; // ms 时间戳；提前 60s 视为过期
}

async function read(): Promise<AuthStore | null> {
  const g = await chrome.storage.local.get(KEY);
  const v = g[KEY] as AuthStore | undefined;
  return v && typeof v.access === 'string' ? v : null;
}

async function write(s: AuthStore | null): Promise<void> {
  if (s) await chrome.storage.local.set({ [KEY]: s });
  else await chrome.storage.local.remove(KEY);
}

export async function register(email: string, password: string): Promise<string> {
  return doAuth('/v1/auth/register', email, password);
}

export async function login(email: string, password: string): Promise<string> {
  return doAuth('/v1/auth/login', email, password);
}

async function doAuth(path: string, email: string, password: string): Promise<string> {
  // D-13：加密开启时把邮箱/密码打包成一个 ct（AAD="auth"），带临时公钥头；否则明文。
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  let body: string;
  if (encryptionEnabled()) {
    headers['X-Eph-Pub'] = await ephemeralPublicKey();
    body = JSON.stringify({ ct: await encryptField(JSON.stringify({ email, password }), 'auth') });
  } else {
    body = JSON.stringify({ email, password });
  }
  const r = await fetch(`${BACKEND_URL}${path}`, { method: 'POST', headers, body });
  if (!r.ok) {
    const d = (await r.json().catch(() => ({}))) as { detail?: string };
    throw new Error(d.detail ?? '操作失败');
  }
  const t = (await r.json()) as { access: string; refresh: string; email: string };
  await write({ access: t.access, refresh: t.refresh, email: t.email, accessExp: Date.now() + ACCESS_TTL_MS });
  return t.email;
}

export async function logout(): Promise<void> {
  const s = await read();
  if (s) {
    try {
      await fetch(`${BACKEND_URL}/v1/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh: s.refresh }),
      });
    } catch {
      // 网络失败也照常清本地态。
    }
  }
  await write(null);
}

export async function getEmail(): Promise<string | null> {
  return (await read())?.email ?? null;
}

/** 返回可用 access token；过期则用 refresh 换新；refresh 失败则登出并返回 null。 */
export async function getAccessToken(): Promise<string | null> {
  const s = await read();
  if (!s) return null;
  if (Date.now() < s.accessExp - 60_000) return s.access;
  try {
    const r = await fetch(`${BACKEND_URL}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh: s.refresh }),
    });
    if (!r.ok) throw new Error('refresh failed');
    const t = (await r.json()) as { access: string };
    await write({ ...s, access: t.access, accessExp: Date.now() + ACCESS_TTL_MS });
    return t.access;
  } catch {
    await write(null);
    return null;
  }
}
