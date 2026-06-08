'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface E {
  id: number;
  ts: string;
  kind: string;
  message: string;
  userId: number | null;
}

export default function Logs() {
  const [rows, setRows] = useState<E[]>([]);

  useEffect(() => {
    api<E[]>('/admin/errors').then(setRows).catch(() => {});
  }, []);

  return (
    <div>
      <h1>错误日志</h1>
      <table>
        <thead>
          <tr>
            <th>时间</th>
            <th>类型</th>
            <th>消息</th>
            <th>用户</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.id}>
              <td>{e.ts.slice(0, 19).replace('T', ' ')}</td>
              <td>{e.kind}</td>
              <td>{e.message}</td>
              <td>{e.userId ?? '匿名'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
