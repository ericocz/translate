// 后端 API 客户端：替代「直连 DeepSeek」。在 service worker 里调本项目后端 /v1/translate，
// 消费 SSE（event: block/done/error），逐块回调。接口与旧 lib/deepseek.ts 的 client 同形（{abort}），
// 故 background.ts 几乎零改动即可切换。
//
// 为什么在 SW 里发：host_permissions 授权下 SW 的跨域 fetch 不受 CORS 限制，也不受页面 CSP 约束。

import { BACKEND_URL } from './config';
import { getDeviceId, localDateString } from './device';
import { getAccessToken } from './auth';
import { createSseParser } from './sse';
import { encryptionEnabled, ephemeralPublicKey, encryptField, decryptField } from './crypto';
import type { FailureInfo, FailureKind } from './types';

export interface ApiBlock {
  id: string;
  source: string;
}

export interface ApiHandlers {
  onBlock: (id: string, translated: string) => void;
  onDone: () => void;
  onError: (failure: FailureInfo) => void;
}

export interface ApiClient {
  abort: () => void;
}

/** 构建发往后端翻译端点的 fetch init（SSE 与非流式两条路共用：同样的鉴权头 / 加密 / body）。 */
async function buildTranslateInit(
  blocks: ApiBlock[],
  pageKey: string,
  signal: AbortSignal
): Promise<RequestInit> {
  let deviceId = 'unknown';
  try {
    deviceId = await getDeviceId();
  } catch {
    // storage 不可用时退化为匿名占位，不阻断翻译。
  }

  const accessToken = await getAccessToken();

  // D-13：加密开启时把每块 source 换成密文 ct，并带客户端临时公钥头（服务端据此派生会话密钥）。
  const useEnc = encryptionEnabled();
  let bodyBlocks: unknown[] = blocks;
  const extraHeaders: Record<string, string> = {};
  if (useEnc) {
    extraHeaders['X-Eph-Pub'] = await ephemeralPublicKey();
    bodyBlocks = await Promise.all(
      blocks.map(async (b) => ({ id: b.id, ct: await encryptField(b.source, `src:${b.id}`) }))
    );
  }

  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Device-Id': deviceId,
      ...extraHeaders,
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify({ blocks: bodyBlocks, localDate: localDateString(), pageKey }),
    signal,
  };
}

/** 把一块（明文 translated 或密文 ct）回填给 handlers；密文异步解密，失败则丢弃（节点保持原文）。 */
async function emitBlock(
  obj: { id: string; translated?: string; ct?: string },
  handlers: ApiHandlers
): Promise<void> {
  if (obj.ct !== undefined) {
    try {
      handlers.onBlock(obj.id, await decryptField(obj.ct, `dst:${obj.id}`));
    } catch {
      // 解密失败：丢弃该块，对应节点保持英文原样。
    }
  } else if (obj.translated !== undefined) {
    handlers.onBlock(obj.id, obj.translated);
  }
}

/** 调后端翻译一批块（正文路）：消费 SSE 逐块流式回调。返回可 abort 的 client。 */
export function translateViaBackend(
  blocks: ApiBlock[],
  pageKey: string,
  handlers: ApiHandlers
): ApiClient {
  const controller = new AbortController();

  void (async () => {
    let resp: Response;
    try {
      resp = await fetch(
        `${BACKEND_URL}/v1/translate`,
        await buildTranslateInit(blocks, pageKey, controller.signal)
      );
    } catch (e) {
      if (controller.signal.aborted) return;
      handlers.onError(classifyNetwork(e));
      return;
    }

    if (!resp.ok) {
      const kind: FailureKind = resp.status === 401 || resp.status === 403 ? 'auth' : 'api';
      handlers.onError({ kind, message: `后端报错 ${resp.status}` });
      return;
    }
    if (!resp.body) {
      handlers.onError({ kind: 'api', message: '后端无响应体' });
      return;
    }

    let settled = false;
    // 密文块异步解密：收集 pending，确保 onDone 在全部解密回填之后才发（否则 done 抢在最后一块前）。
    const pending: Promise<void>[] = [];
    const parser = createSseParser((ev) => {
      if (ev.event === 'block') {
        try {
          const obj = JSON.parse(ev.data) as { id: string; translated?: string; ct?: string };
          // 密文块异步解密后回填，块间无序无碍（各块按 id 独立定位）；收集 pending 确保 done 在其后。
          pending.push(emitBlock(obj, handlers));
        } catch {
          // 单事件坏 JSON 不致命，跳过。
        }
      } else if (ev.event === 'done') {
        settled = true;
        void Promise.all(pending).then(() => handlers.onDone());
      } else if (ev.event === 'error') {
        settled = true;
        handlers.onError(parseFailure(ev.data));
      } else if (ev.event === 'quota') {
        // 额度不足：非失败，是引导（popup 用柔和样式 + 领赠送/充值/买断提示）。
        settled = true;
        handlers.onError(parseQuota(ev.data));
      }
    });

    try {
      const reader = resp.body.getReader();
      const decoder = new TextDecoder('utf-8');
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.feed(decoder.decode(value, { stream: true }));
      }
      parser.flush();
      // 流自然结束但没收到 done/error：等未决解密回填后按完成处理（对齐旧 deepseek client 的收尾语义）。
      if (!settled) {
        await Promise.all(pending);
        handlers.onDone();
      }
    } catch (e) {
      if (controller.signal.aborted) return;
      handlers.onError(classifyNetwork(e));
    }
  })();

  return { abort: () => controller.abort() };
}

/** 调后端非流式端点 /v1/translate/batch（外框 / 重试路）：一次性收完 JSON，再逐块回调。
 *  与 translateViaBackend 同形（{abort}），可直接作 translate-cached 的 deps.server 注入。
 *  外框量小、重试是带上下文的小整批——都不需要流式首屏体感，少一条长连接、解析更简单。 */
export function translateViaBackendHttp(
  blocks: ApiBlock[],
  pageKey: string,
  handlers: ApiHandlers
): ApiClient {
  const controller = new AbortController();

  void (async () => {
    let resp: Response;
    try {
      resp = await fetch(
        `${BACKEND_URL}/v1/translate/batch`,
        await buildTranslateInit(blocks, pageKey, controller.signal)
      );
    } catch (e) {
      if (controller.signal.aborted) return;
      handlers.onError(classifyNetwork(e));
      return;
    }

    if (!resp.ok) {
      const kind: FailureKind = resp.status === 401 || resp.status === 403 ? 'auth' : 'api';
      handlers.onError({ kind, message: `后端报错 ${resp.status}` });
      return;
    }

    let body: { blocks?: { id: string; translated?: string; ct?: string }[]; error?: unknown; quota?: unknown };
    try {
      body = await resp.json();
    } catch {
      if (controller.signal.aborted) return;
      handlers.onError({ kind: 'api', message: '后端响应解析失败' });
      return;
    }
    if (controller.signal.aborted) return;

    // 先回填全部块（含密文异步解密），再据 quota/error 决定收尾——与 SSE 路「块在前、终态在后」一致。
    await Promise.all((body.blocks ?? []).map((b) => emitBlock(b, handlers)));
    if (controller.signal.aborted) return;

    if (body.quota !== undefined) handlers.onError(parseQuota(JSON.stringify(body.quota)));
    else if (body.error !== undefined) handlers.onError(parseFailure(JSON.stringify(body.error)));
    else handlers.onDone();
  })();

  return { abort: () => controller.abort() };
}

function parseFailure(data: string): FailureInfo {
  try {
    const obj = JSON.parse(data) as { kind?: string; message?: string };
    const kind: FailureKind = (['network', 'api', 'auth', 'unknown', 'quota'] as const).includes(
      obj.kind as FailureKind
    )
      ? (obj.kind as FailureKind)
      : 'unknown';
    return { kind, message: obj.message ?? '翻译失败' };
  } catch {
    return { kind: 'unknown', message: '翻译失败' };
  }
}

function parseQuota(data: string): FailureInfo {
  // 已无免费配额：零额度模型下「quota」=余额不足，引导领赠送 ¥2 / 充值 / 买断。
  const fallback = '额度不足：可领取赠送额度、充值，或买断后用自己的模型';
  try {
    const obj = JSON.parse(data) as { message?: string };
    return { kind: 'quota', message: obj.message ?? fallback };
  } catch {
    return { kind: 'quota', message: fallback };
  }
}

function classifyNetwork(e: unknown): FailureInfo {
  const msg = e instanceof Error ? e.message : String(e);
  // 连不上后端：多半是后端没起 / 代理拦了本地请求。
  return { kind: 'network', message: `无法连通翻译后端（${BACKEND_URL}）：${msg}` };
}
