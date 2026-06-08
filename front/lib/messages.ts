// content ↔ background ↔ popup 之间的消息协议。

export const PORT_NAME = 'translate-stream';

/** content -> background：开始翻译一批块。 */
export interface StartMsg {
  kind: 'start';
  blocks: { id: string; source: string }[];
}

/** content -> background：取消当前流。 */
export interface CancelMsg {
  kind: 'cancel';
}

export type ContentToBg = StartMsg | CancelMsg;

/** background -> content：一块翻译完成。 */
export interface BlockDoneMsg {
  kind: 'block';
  id: string;
  translated: string;
}

/** background -> content：整个流结束。 */
export interface DoneMsg {
  kind: 'done';
}

/** background -> content：错误。 */
export interface ErrorMsg {
  kind: 'error';
  failure: { kind: 'network' | 'api' | 'auth' | 'unknown' | 'quota'; message: string };
}

export type BgToContent = BlockDoneMsg | DoneMsg | ErrorMsg;

// ---------- popup ↔ content（chrome.tabs.sendMessage）----------

export type PopupQuery =
  | { kind: 'query-status' }
  | { kind: 'toggle-site'; enabled: boolean };

/** background -> content：SPA 同文档导航（History API pushState/replaceState）发生，需对新路由重译。 */
export interface SpaNavigatedMsg {
  kind: 'spa-navigated';
  url: string;
}

/** content 的 chrome.runtime.onMessage 监听的全部消息（popup + background）。 */
export type TabMessage = PopupQuery | SpaNavigatedMsg;

export interface StatusReply {
  /** 是否正在翻译中。 */
  running: boolean;
  /** 错误（若有）。 */
  error?: string;
  /** 错误/引导的分类（quota 表示免费额度用尽，popup 用柔和样式而非红色报错）。 */
  errorKind?: 'network' | 'api' | 'auth' | 'unknown' | 'quota';
  /** 已译完段数（用于 popup 的极轻进度文字；未抽取时不带）。 */
  done?: number;
  /** 总段数。 */
  total?: number;
}
