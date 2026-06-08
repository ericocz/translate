// 后端 API 客户端：替代「直连 DeepSeek」。在 service worker 里调本项目后端 /v1/translate，
// 消费 SSE（event: block/done/error），逐块回调。接口与旧 lib/deepseek.ts 的 client 同形（{abort}），
// 故 background.ts 几乎零改动即可切换。
//
// 为什么在 SW 里发：host_permissions 授权下 SW 的跨域 fetch 不受 CORS 限制，也不受页面 CSP 约束。

import { BACKEND_URL } from './config';
import { getDeviceId, localDateString } from './device';
import { getAccessToken } from './auth';
import { createSseParser } from './sse';
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

/** 调后端翻译一批块；返回可 abort 的 client，结果经 handlers 流式回调。 */
export function translateViaBackend(
  blocks: ApiBlock[],
  pageKey: string,
  handlers: ApiHandlers
): ApiClient {
  const controller = new AbortController();

  void (async () => {
    let deviceId = 'unknown';
    try {
      deviceId = await getDeviceId();
    } catch {
      // storage 不可用时退化为匿名占位，不阻断翻译。
    }

    const accessToken = await getAccessToken();

    let resp: Response;
    try {
      resp = await fetch(`${BACKEND_URL}/v1/translate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Device-Id': deviceId,
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({ blocks, localDate: localDateString(), pageKey }),
        signal: controller.signal,
      });
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
    const parser = createSseParser((ev) => {
      if (ev.event === 'block') {
        try {
          const { id, translated } = JSON.parse(ev.data) as { id: string; translated: string };
          handlers.onBlock(id, translated);
        } catch {
          // 单事件坏 JSON 不致命，跳过。
        }
      } else if (ev.event === 'done') {
        settled = true;
        handlers.onDone();
      } else if (ev.event === 'error') {
        settled = true;
        handlers.onError(parseFailure(ev.data));
      } else if (ev.event === 'quota') {
        // 免费额度用尽：非失败，是引导（popup 用柔和样式 + 登录提示）。
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
      // 流自然结束但没收到 done/error：按完成处理（对齐旧 deepseek client 的收尾语义）。
      if (!settled) handlers.onDone();
    } catch (e) {
      if (controller.signal.aborted) return;
      handlers.onError(classifyNetwork(e));
    }
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
  try {
    const obj = JSON.parse(data) as { message?: string };
    return { kind: 'quota', message: obj.message ?? '今日免费额度已用完' };
  } catch {
    return { kind: 'quota', message: '今日免费额度已用完' };
  }
}

function classifyNetwork(e: unknown): FailureInfo {
  const msg = e instanceof Error ? e.message : String(e);
  // 连不上后端：多半是后端没起 / 代理拦了本地请求。
  return { kind: 'network', message: `无法连通翻译后端（${BACKEND_URL}）：${msg}` };
}
