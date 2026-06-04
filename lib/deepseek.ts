// DeepSeek 客户端 + SSE 流解析 + 按 [[id]] 切块。
//
// 设计要点：
// - messages: [{ system: SYSTEM_PROMPT }, { user: 块列表 }]，system 逐字节稳定，命中前缀缓存。
// - stream:true，并显式关闭思考模式（thinking.type='disabled'）。注意：DeepSeek V4 Flash
//   默认是开启思考的，会先流式输出 reasoning_content 再输出 content——翻译不需要推理，
//   关闭后首 token 快约 3.5×、且不再产生/计费 reasoning_tokens。
// - 解析：把流到的 content 文本按 [[id]] ... [[id]] 切块；每识别完一块就回调。
// - 失败分类：
//     - fetch reject / AbortError / TypeError → network（多半是代理未连通）
//     - 401/403 → auth
//     - 4xx/5xx → api
//     - 其余兜底 → unknown

import { SYSTEM_PROMPT } from './prompt';
import type { FailureInfo } from './types';

const ENDPOINT = 'https://api.deepseek.com/v1/chat/completions';
export const MODEL = 'deepseek-v4-flash';

export interface DeepSeekRequestBlock {
  id: string;
  source: string;
}

export interface DeepSeekHandlers {
  /** 每识别完一块的回调（按 [[id]] 切分）。 */
  onBlock: (id: string, translated: string) => void;
  /** 流结束。 */
  onDone: () => void;
  /** 错误。 */
  onError: (failure: FailureInfo) => void;
}

export interface DeepSeekClient {
  /** 取消正在进行的流。 */
  abort: () => void;
}

/**
 * 启动一次翻译流。返回 client（可 abort）。
 */
export function streamTranslate(
  apiKey: string,
  blocks: DeepSeekRequestBlock[],
  handlers: DeepSeekHandlers
): DeepSeekClient {
  const controller = new AbortController();

  const userMessage = blocks.map((b) => `[[${b.id}]] ${b.source}`).join('\n');

  const body = {
    model: MODEL,
    stream: true,
    // 关闭思考模式：翻译是确定性改写，无需链式推理；temperature 偏低换稳定。
    thinking: { type: 'disabled' },
    temperature: 0.2,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
  };

  (async () => {
    let resp: Response;
    try {
      resp = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // 注意：authorization 头永远不能写日志。
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      // fetch 阶段失败：绝大多数是代理 / DNS / TLS 问题。
      if (controller.signal.aborted) return;
      handlers.onError(classifyNetworkError(e));
      return;
    }

    if (!resp.ok) {
      const text = await safeReadText(resp);
      handlers.onError(classifyHttpError(resp.status, text));
      return;
    }
    if (!resp.body) {
      handlers.onError({ kind: 'api', message: 'DeepSeek 未返回响应体' });
      return;
    }

    try {
      await consumeSse(resp.body, handlers);
    } catch (e) {
      if (controller.signal.aborted) return;
      handlers.onError(classifyNetworkError(e));
    }
  })();

  return {
    abort: () => controller.abort(),
  };
}

async function safeReadText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return '';
  }
}

function classifyHttpError(status: number, body: string): FailureInfo {
  if (status === 401 || status === 403) {
    return { kind: 'auth', message: 'DeepSeek API Key 无效或已过期，请到设置页更新。' };
  }
  // body 可能含敏感字段；只展示状态码与首段提示。
  const summary = body.slice(0, 200).replace(/\s+/g, ' ').trim();
  return { kind: 'api', message: `DeepSeek 接口报错 ${status}${summary ? `：${summary}` : ''}` };
}

function classifyNetworkError(e: unknown): FailureInfo {
  const msg = e instanceof Error ? e.message : String(e);
  // 常见代理失败信号：Failed to fetch / NetworkError / ECONNRESET / ERR_PROXY_CONNECTION_FAILED。
  const proxyHints = /failed to fetch|networkerror|err_proxy|err_connection|err_tunnel|econnreset|fetch failed|enotfound|ehostunreach/i;
  if (proxyHints.test(msg)) {
    return {
      kind: 'network',
      message: '无法连通 DeepSeek，多半是 Clash 代理没开或未生效。请先检查代理。',
    };
  }
  return { kind: 'network', message: `网络错误：${msg}` };
}

/**
 * 消费 SSE 流：拼装出 delta.content，再按 [[id]] 切块并回调。
 */
async function consumeSse(stream: ReadableStream<Uint8Array>, handlers: DeepSeekHandlers) {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  // 按行解析：SSE 以 \n\n 分事件，行以 "data: " 开头。
  let textBuf = '';
  const splitter = createBlockSplitter((id, translated) => handlers.onBlock(id, translated));

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nlIdx: number;
      while ((nlIdx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nlIdx).replace(/\r$/, '');
        buf = buf.slice(nlIdx + 1);
        if (line === '' || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trimStart();
        if (data === '[DONE]') {
          // 收尾：刷出最后一块。
          textBuf = splitter.flush(textBuf);
          handlers.onDone();
          return;
        }
        try {
          const json = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
          };
          const delta = json.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta.length > 0) {
            textBuf = splitter.feed(textBuf, delta);
          }
        } catch {
          // 单事件解析失败不致命，继续读下一条。
        }
      }
    }
    // 流自然结束但没收到 [DONE]：也刷一次。
    splitter.flush(textBuf);
    handlers.onDone();
  } finally {
    reader.releaseLock();
  }
}

/**
 * 按 [[id]] 切块。
 *
 * 流式输入的关键难点：模型逐 token 返回，一个 [[id]] 标记会被拆散到多个小 chunk
 * （实测 DeepSeek 常把 "[["、"b"、"1"、"]]" 分成独立的 delta）。所以绝不能在单个
 * chunk 内就地判定标记边界——必须把已到文本累积进缓冲区 acc，每次在完整的 acc 上
 * 重新扫描标记，被拆散的 "[[id]]" 才能拼回来匹配上。
 *
 * 策略：acc 始终保留"最后一个已出现标记"及其之后的文本（这段文本可能还在增长）。
 * 每出现一个新标记，就把它之前那一段确认为上一 id 的完整译文并回调一次；末尾在
 * flush 时确认最后一块。第一个标记之前的任何前言 / 空白直接丢弃。
 */
function createBlockSplitter(onBlock: (id: string, translated: string) => void) {
  let acc = '';
  const MARKER = /\[\[([A-Za-z0-9_-]+)\]\]/g;

  const process = (flushAll: boolean) => {
    MARKER.lastIndex = 0;
    const marks: { id: string; start: number; end: number }[] = [];
    let m: RegExpExecArray | null;
    while ((m = MARKER.exec(acc)) !== null) {
      marks.push({ id: m[1]!, start: m.index, end: MARKER.lastIndex });
    }
    if (marks.length === 0) return;
    // 非 flush 时，最后一个标记后面的文本可能还没收完，留到下次 / flush 再确认。
    const upto = flushAll ? marks.length : marks.length - 1;
    for (let i = 0; i < upto; i++) {
      const cur = marks[i]!;
      const next = marks[i + 1];
      const textEnd = next ? next.start : acc.length;
      onBlock(cur.id, acc.slice(cur.end, textEnd).trim());
    }
    // 丢弃已确认部分；保留从最后一个标记起的尾巴（flush 后清空）。
    acc = flushAll ? '' : acc.slice(marks[marks.length - 1]!.start);
  };

  return {
    feed(_prevBuf: string, chunk: string): string {
      acc += chunk;
      process(false);
      return '';
    },
    flush(_prevBuf: string): string {
      process(true);
      return '';
    },
  };
}
