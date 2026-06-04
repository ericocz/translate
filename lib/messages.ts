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

/** background -> content：流式中间块（暂未拼齐，可以丢给前端做进度计数）。 */
export interface ProgressMsg {
  kind: 'progress';
  done: number;
  total: number;
}

/** background -> content：整个流结束。 */
export interface DoneMsg {
  kind: 'done';
}

/** background -> content：错误。 */
export interface ErrorMsg {
  kind: 'error';
  failure: { kind: 'network' | 'api' | 'auth' | 'unknown'; message: string };
}

export type BgToContent = BlockDoneMsg | ProgressMsg | DoneMsg | ErrorMsg;

// ---------- popup ↔ content（chrome.tabs.sendMessage）----------

export type PopupQuery =
  | { kind: 'query-status' }
  | { kind: 'retry-failed' }
  | { kind: 'flip-page' }
  | { kind: 'toggle-site'; enabled: boolean };

export interface StatusReply {
  /** 是否激活（在白名单中）。 */
  enabled: boolean;
  /** 当前进度。 */
  done: number;
  total: number;
  failed: number;
  /** 是否正在翻译中。 */
  running: boolean;
  /** 错误（若有）。 */
  error?: string;
}
