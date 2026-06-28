// React 页面用的 i18n hook。把核心 i18n.ts 与 React 解耦（content 脚本只用 i18n.ts、不打包 React）。

import { useCallback, useEffect, useState } from 'react';
import {
  detectUiLocale,
  getMessages,
  getStoredUiLocale,
  onUiLocaleChanged,
  setUiLocale,
  type Messages,
  type UiLocale,
} from './i18n';

export interface UseTResult {
  /** 当前生效的界面语言。 */
  locale: UiLocale;
  /** 当前界面语言的全部文案。 */
  m: Messages;
  /** 用户手动设置的语言；null = 跟随浏览器。供设置页区分「自动」与显式选择。 */
  stored: UiLocale | null;
  /** 改界面语言（null = 恢复跟随浏览器）。写入 storage 后本 hook 与其它页面会自动重渲染。 */
  setLocale: (locale: UiLocale | null) => Promise<void>;
}

/**
 * 取当前界面语言 + 文案。首渲染先用浏览器推断值（同步、无闪烁），
 * 再异步读回用户设置覆盖；并订阅 storage 变化，跨页面 / 设置页改动即时生效。
 */
export function useT(): UseTResult {
  // 同步初值：先按浏览器推断，避免首帧空白；随后 effect 读回用户设置。
  const [locale, setLoc] = useState<UiLocale>(() => detectUiLocale());
  const [stored, setStored] = useState<UiLocale | null>(null);

  const reload = useCallback(async () => {
    const s = await getStoredUiLocale();
    setStored(s);
    setLoc(s ?? detectUiLocale());
  }, []);

  useEffect(() => {
    void reload();
    return onUiLocaleChanged(() => void reload());
  }, [reload]);

  const setLocale = useCallback(async (next: UiLocale | null) => {
    await setUiLocale(next);
    // storage 监听会触发 reload；这里不抢跑，交给监听统一刷新。
  }, []);

  return { locale, m: getMessages(locale), stored, setLocale };
}
