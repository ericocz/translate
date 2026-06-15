// 工具栏图标的状态表现（按 tab）。母题：橙色双气泡「A / 文」翻译标，透明底，专为工具栏。
//   off          —— 未开启：主图（双气泡 A / 文，无角标）
//   on           —— 已开启 / 已译完：主图 + 右下角绿色圆角方块白勾 ✓
//   translating  —— 正在翻译：主图 + 右下角琥珀圆角方块白「…」
//   error        —— 翻译出错：主图 + 右下角红色圆角方块白叉 ✕
//
// 四态各一套位图（角标已烤进 PNG），按状态 setIcon 切图，不用运行时原生角标。
// 工具栏图标无法做逐帧动画（service worker 会休眠、setInterval 不可靠），
// 逐段生长的动效只在 popup 内呈现。仅用 chrome.action 原生能力，无第三方依赖。

export type IconState = 'off' | 'on' | 'translating' | 'error';

const MASTER = { 16: 'icon/16.png', 32: 'icon/32.png', 48: 'icon/48.png', 128: 'icon/128.png' };
const ON = { 16: 'icon/on-16.png', 32: 'icon/on-32.png', 48: 'icon/on-48.png', 128: 'icon/on-128.png' };
const TRANSLATING = {
  16: 'icon/translating-16.png',
  32: 'icon/translating-32.png',
  48: 'icon/translating-48.png',
  128: 'icon/translating-128.png',
};
const ERROR = { 16: 'icon/error-16.png', 32: 'icon/error-32.png', 48: 'icon/error-48.png', 128: 'icon/error-128.png' };

/** 每个状态对应一套已烤好角标的位图；off 用主图。 */
function iconPath(state: IconState) {
  if (state === 'on') return ON;
  if (state === 'translating') return TRANSLATING;
  if (state === 'error') return ERROR;
  return MASTER; // off
}

/** 设置某个 tab 的工具栏图标。任何失败（tab 已关闭等）静默忽略。 */
export async function setTabIcon(tabId: number, state: IconState): Promise<void> {
  try {
    await chrome.action.setIcon({ tabId, path: iconPath(state) });
  } catch {
    return; // tab 不存在了
  }
  // 不用原生角标（状态已烤进位图）；清掉历史可能残留的角标。
  try {
    await chrome.action.setBadgeText({ tabId, text: '' });
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
