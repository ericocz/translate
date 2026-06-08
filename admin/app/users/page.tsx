'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface U {
  id: number;
  email: string;
  tokensToday: number;
  tier: number;
  createdAt: string | null;
}

export default function Users() {
  const [rows, setRows] = useState<U[]>([]);

  useEffect(() => {
    api<U[]>('/admin/users').then(setRows).catch(() => {});
  }, []);

  return (
    <div>
      <h1>用户</h1>
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>邮箱</th>
            <th>今日 Token</th>
            <th>档位</th>
            <th>注册</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((u) => (
            <tr key={u.id}>
              <td>{u.id}</td>
              <td>{u.email}</td>
              <td>{u.tokensToday}</td>
              <td>{u.tier}</td>
              <td>{u.createdAt?.slice(0, 10) ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
