'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface Stats {
  users: number;
  translations: number;
  errors: number;
  tokens: number;
  topHosts: { host: string; count: number }[];
}

export default function Dashboard() {
  const [s, setS] = useState<Stats | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<Stats>('/admin/stats')
      .then(setS)
      .catch((e) => setErr(e instanceof Error ? e.message : '加载失败'));
  }, []);

  if (err) return <p className="err">{err}</p>;
  if (!s) return <p>加载中…</p>;

  return (
    <div>
      <h1>概览</h1>
      <div className="cards">
        <Card label="用户数" value={s.users} />
        <Card label="翻译次数" value={s.translations} />
        <Card label="错误数" value={s.errors} />
        <Card label="累计 Token" value={s.tokens} />
      </div>
      <h2>Top 域名</h2>
      <table>
        <thead>
          <tr>
            <th>域名</th>
            <th>次数</th>
          </tr>
        </thead>
        <tbody>
          {s.topHosts.map((h) => (
            <tr key={h.host}>
              <td>{h.host}</td>
              <td>{h.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Card({ label, value }: { label: string; value: number }) {
  return (
    <div className="card stat">
      <div className="stat-v">{value}</div>
      <div className="stat-l">{label}</div>
    </div>
  );
}
