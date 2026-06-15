// 工具栏图标的状态表现（按 tab）。母题：青绿底白「A / 文 + aha 火花」满铺翻译标，专为工具栏。
//   off  —— 未开启：主图（无角标）
//   on   —— 已开启翻译：主图 + 右下角绿色圆角方块白勾 ✓
//
// 只有 off / on 两态：用户一点开启即切 on，不随翻译成功/完成/出错变化——
// 图标只反映「这个站开没开翻译」。两态各一套位图（角标已烤进 PNG），按状态 setIcon 切图。
// 仅用 chrome.action 原生能力，无第三方依赖。

export type IconState = 'off' | 'on';

const MASTER = { 16: 'icon/16.png', 32: 'icon/32.png', 48: 'icon/48.png', 128: 'icon/128.png' };
const ON = { 16: 'icon/on-16.png', 32: 'icon/on-32.png', 48: 'icon/on-48.png', 128: 'icon/on-128.png' };

/** on 用带绿勾的位图；off 用主图。 */
function iconPath(state: IconState) {
  return state === 'on' ? ON : MASTER;
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
