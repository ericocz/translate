// 工具栏图标的状态表现（按 tab）。素方案的「英→中」双线图标：
//   off          —— 未开启：灰色双线（manifest 默认图标）
//   on           —— 已开启 / 已译完：下线灌桃红
//   translating  —— 已开启且正在翻译：on 图标 + 一枚桃红角标（活动指示）
//   error        —— 翻译出错：on 图标 + 红色「!」角标
//
// 工具栏图标无法做逐帧动画（service worker 会休眠、setInterval 不可靠），所以
// 「翻译中」用静态 on 图标 + 角标表达，逐段生长的动效只在 popup 内呈现。
// 仅用 chrome.action 原生能力，无第三方依赖。

export type IconState = 'off' | 'on' | 'translating' | 'error';

const OFF = { 16: 'icon/16.png', 32: 'icon/32.png', 48: 'icon/48.png', 128: 'icon/128.png' };
const ON = { 16: 'icon/on-16.png', 32: 'icon/on-32.png', 48: 'icon/on-48.png', 128: 'icon/on-128.png' };

const PEACH = '#E0517A';
const RED = '#C8372D';

/** 设置某个 tab 的工具栏图标与角标。任何失败（tab 已关闭等）静默忽略。 */
export async function setTabIcon(tabId: number, state: IconState): Promise<void> {
  try {
    await chrome.action.setIcon({ tabId, path: state === 'off' ? OFF : ON });
  } catch {
    return; // tab 不存在了，角标也不必设
  }
  // 角标：翻译中一枚桃红点，出错一枚红「!」，其余清空。
  const text = state === 'translating' ? '•' : state === 'error' ? '!' : '';
  try {
    await chrome.action.setBadgeText({ tabId, text });
    if (text) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: state === 'error' ? RED : PEACH });
    }
  } catch {
    // 忽略
  }
}

/** 从 URL 取主机名；非 http(s) 或无法解析返回空串。 */
export function hostOf(url: string | undefined): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname : '';
  } catch {
    return '';
  }
}
