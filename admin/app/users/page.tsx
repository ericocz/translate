'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface U {
  id: number;
  email: string;
  tokensToday: number;
  giftCny: number;  // 赠送·人民币（元）
  cny: number;      // 充值·人民币（元）
  usd: number;      // 充值·美元（$）
  createdAt: string | null;
}

const BUCKETS: Record<string, string> = {
  gift_cny: '赠送·人民币',
  recharge_cny: '充值·人民币',
  recharge_usd: '充值·美元',
};

/** 三桶余额展示：各 >0 才列。 */
function balanceText(u: U): string {
  const parts: string[] = [];
  if (u.giftCny > 0) parts.push('赠送 ¥' + u.giftCny.toFixed(2));
  if (u.cny > 0) parts.push('¥' + u.cny.toFixed(2));
  if (u.usd > 0) parts.push('$' + u.usd.toFixed(2));
  return parts.length ? parts.join(' · ') : '0';
}

export default function Users() {
  const [rows, setRows] = useState<U[]>([]);

  const load = () => api<U[]>('/admin/users').then(setRows).catch(() => {});
  useEffect(() => {
    load();
  }, []);

  // 手动调额度（客服补单 / 退款纠正）：选桶 + 正补发 / 负扣回（单位＝桶币种）。
  const adjust = async (u: U) => {
    const bucket = window.prompt(
      `给 ${u.email} 调哪个桶？输入：gift_cny / recharge_cny / recharge_usd`,
      'recharge_cny'
    );
    if (bucket === null || !(bucket in BUCKETS)) {
      if (bucket !== null) window.alert('桶名非法');
      return;
    }
    const unit = bucket === 'recharge_usd' ? '$' : '¥';
    const input = window.prompt(`调「${BUCKETS[bucket]}」额度（${unit}，正补发 / 负扣回）：`, '');
    if (input === null || input.trim() === '') return;
    const amount = Number(input);
    if (!Number.isFinite(amount) || amount === 0) {
      window.alert('请输入非零数字');
      return;
    }
    try {
      const r = await api<{ bucket: string; balance: number }>('/admin/credits/grant', {
        method: 'POST',
        body: JSON.stringify({ userId: u.id, amount: String(amount), bucket }),
      });
      window.alert(`已调整，${u.email} 「${BUCKETS[bucket]}」当前余额 ${unit}${r.balance.toFixed(2)}`);
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
              <td>{balanceText(u)}</td>
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
