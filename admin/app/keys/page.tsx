'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface K {
  id: number;
  label: string;
  masked: string;
  status: string;
  usedTokens: number;
  balanceNote: string | null;
}

export default function Keys() {
  const [rows, setRows] = useState<K[]>([]);
  const [label, setLabel] = useState('');
  const [key, setKey] = useState('');

  const load = () => {
    api<K[]>('/admin/keys').then(setRows).catch(() => {});
  };
  useEffect(() => load(), []);

  const add = async () => {
    if (!label || !key) return;
    await api('/admin/keys', { method: 'POST', body: JSON.stringify({ label, key }) });
    setLabel('');
    setKey('');
    load();
  };

  const toggle = async (k: K) => {
    await api(`/admin/keys/${k.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: k.status === 'active' ? 'disabled' : 'active' }),
    });
    load();
  };

  return (
    <div>
      <h1>API Key（上游 DeepSeek）</h1>
      <div className="row">
        <input placeholder="标签" value={label} onChange={(e) => setLabel(e.target.value)} />
        <input placeholder="DeepSeek Key" value={key} onChange={(e) => setKey(e.target.value)} />
        <button onClick={() => void add()}>添加</button>
      </div>
      <table>
        <thead>
          <tr>
            <th>标签</th>
            <th>Key（脱敏）</th>
            <th>状态</th>
            <th>用量</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((k) => (
            <tr key={k.id}>
              <td>{k.label}</td>
              <td>{k.masked}</td>
              <td>{k.status}</td>
              <td>{k.usedTokens}</td>
              <td>
                <button onClick={() => void toggle(k)}>
                  {k.status === 'active' ? '停用' : '启用'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
