'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface U {
  id: number;
  email: string;
  tokensToday: number;
  balance: number; // 元
  createdAt: string | null;
}

export default function Users() {
  const [rows, setRows] = useState<U[]>([]);

  const load = () => api<U[]>('/admin/users').then(setRows).catch(() => {});
  useEffect(() => {
    load();
  }, []);

  // 手动调额度（客服补单 / 退款纠正）：正数补发、负数扣回。
  const adjust = async (u: U) => {
    const input = window.prompt(`给 ${u.email} 调额度（元，正补发 / 负扣回）：`, '');
    if (input === null || input.trim() === '') return;
    const amount = Number(input);
    if (!Number.isFinite(amount) || amount === 0) {
      window.alert('请输入非零数字');
      return;
    }
    try {
      const r = await api<{ balance: number }>('/admin/credits/grant', {
        method: 'POST',
        body: JSON.stringify({ userId: u.id, amount: String(amount) }),
      });
      window.alert(`已调整，${u.email} 当前余额 ¥${r.balance.toFixed(2)}`);
      load();
    } catch (e) {
      window.alert(`失败：${e instanceof Error ? e.message : e}`);
    }
  };

  return (
    <div>
      <h1>用户</h1>
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>邮箱</th>
            <th>今日 Token</th>
            <th>余额</th>
            <th>注册</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((u) => (
            <tr key={u.id}>
              <td>{u.id}</td>
              <td>{u.email}</td>
              <td>{u.tokensToday}</td>
              <td>¥{u.balance.toFixed(2)}</td>
              <td>{u.createdAt?.slice(0, 10) ?? ''}</td>
              <td>
                <button onClick={() => adjust(u)}>调额度</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
