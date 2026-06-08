import './globals.css';
import Link from 'next/link';
import type { ReactNode } from 'react';

export const metadata = { title: '沉浸式翻译 · 管理台' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh">
      <body>
        <nav className="nav">
          <span className="brand">沉浸式翻译 · 管理台</span>
          <Link href="/">概览</Link>
          <Link href="/users">用户</Link>
          <Link href="/logs">错误日志</Link>
          <Link href="/keys">API Key</Link>
          <Link href="/login">登录</Link>
        </nav>
        <main className="main">{children}</main>
      </body>
    </html>
  );
}
