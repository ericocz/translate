export const API = process.env.NEXT_PUBLIC_API || 'http://localhost:8000';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('imt_admin_token');
}

export function setToken(t: string | null): void {
  if (typeof window === 'undefined') return;
  if (t) localStorage.setItem('imt_admin_token', t);
  else localStorage.removeItem('imt_admin_token');
}

/** 带管理员 token 的 fetch；401 自动清 token 跳登录页。 */
export async function api<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) {
    setToken(null);
    if (typeof window !== 'undefined') window.location.href = '/login';
    throw new Error('未登录');
  }
  if (!res.ok) throw new Error(`请求失败 ${res.status}`);
  return (await res.json()) as T;
}
