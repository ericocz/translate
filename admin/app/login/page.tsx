'use client';
import { useState } from 'react';
import { API, setToken } from '@/lib/api';

export default function Login() {
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setErr(null);
    try {
      const res = await fetch(`${API}/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: pw }),
      });
      if (!res.ok) {
        setErr('邮箱或密码错误');
        return;
      }
      const r = (await res.json()) as { token: string };
      setToken(r.token);
      window.location.href = '/';
    } catch {
      setErr('无法连接后端');
    }
  };

  return (
    <div className="card" style={{ maxWidth: 360, margin: '60px auto' }}>
      <h1>管理员登录</h1>
      <div className="row">
        <input placeholder="邮箱" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="row">
        <input placeholder="密码" type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
      </div>
      {err && <p className="err">{err}</p>}
      <button onClick={() => void submit()}>登录</button>
    </div>
  );
}
