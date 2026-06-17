// provider 适配：唯二两套（见 BYOK-第二批方案 §5.4）。
//  · openai 兼容：覆盖 DeepSeek / OpenAI / Kimi / GLM / Ollama（chat/completions + SSE delta）。
//  · anthropic：覆盖 Claude（messages + content_block_delta）。
//
// 统一接口让 local-translator 不关心 provider 差异：headers / body / 逐事件解析三件事各家自洽，
// provider 专有字段全部走 cfg.extraBody（如 DeepSeek 关思考），不为每家写死分支。

import type { ProviderConfig } from './types';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/** 一个 SSE 事件解析结果：内容增量 delta 与（末帧）真实用量 usage，按需出现。 */
export interface ParsedEvent {
  delta?: string;
  usage?: Usage;
}

export interface ProviderAdapter {
  /** 请求头（含鉴权）。 */
  headers(cfg: ProviderConfig): Record<string, string>;
  /** 请求体：含 stream:true，并把 cfg.extraBody merge 进顶层。 */
  buildBody(cfg: ProviderConfig, systemPrompt: string, blocks: ApiBlockLite[]): object;
  /** 解析单个 SSE 事件的 data 串；无可用内容（[DONE]/ping/坏 JSON）返回 null。 */
  parseEvent(data: string): ParsedEvent | null;
}

/** 喂给 provider 的块：与 lib/api.ts 的 ApiBlock 同形，但本模块自持，避免反向依赖。 */
export interface ApiBlockLite {
  id: string;
  source: string;
}

/** 把块拼成 user 消息：每块一行 `[[id]] source`（与后端 deepseek.build_request_body 一致）。 */
function buildUserContent(blocks: ApiBlockLite[]): string {
  return blocks.map((b) => `[[${b.id}]] ${b.source}`).join('\n');
}

// —— openai 兼容适配器 ——
const openaiAdapter: ProviderAdapter = {
  headers(cfg) {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    // 本地模型（ollama 等）可无 key；有则带 Bearer。
    if (cfg.apiKey) h['Authorization'] = `Bearer ${cfg.apiKey}`;
    return h;
  },
  buildBody(cfg, systemPrompt, blocks) {
    return {
      model: cfg.model,
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.2,
      max_tokens: cfg.maxOutput,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: buildUserContent(blocks) },
      ],
      ...cfg.extraBody, // provider 专有：如 DeepSeek {thinking:{type:'disabled'}}、OpenAI o 系 {reasoning_effort}
    };
  },
  parseEvent(data) {
    if (data === '[DONE]') return null;
    let obj: any;
    try {
      obj = JSON.parse(data);
    } catch {
      return null;
    }
    const out: ParsedEvent = {};
    const u = obj?.usage;
    if (u) {
      out.usage = {
        inputTokens: Number(u.prompt_tokens ?? 0),
        outputTokens: Number(u.completion_tokens ?? 0),
      };
    }
    const delta = obj?.choices?.[0]?.delta?.content;
    if (typeof delta === 'string' && delta) out.delta = delta;
    return out.delta !== undefined || out.usage !== undefined ? out : null;
  },
};

// —— anthropic 适配器 ——
const anthropicAdapter: ProviderAdapter = {
  headers(cfg) {
    return {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
      // 扩展 SW 直连 Anthropic 需显式声明（否则 CORS 拒绝浏览器侧直连）。
      'anthropic-dangerous-direct-browser-access': 'true',
    };
  },
  buildBody(cfg, systemPrompt, blocks) {
    return {
      model: cfg.model,
      stream: true,
      max_tokens: cfg.maxOutput,
      temperature: 0.2,
      system: systemPrompt, // anthropic 的系统提示在顶层，不进 messages
      messages: [{ role: 'user', content: buildUserContent(blocks) }],
      ...cfg.extraBody,
    };
  },
  parseEvent(data) {
    let obj: any;
    try {
      obj = JSON.parse(data);
    } catch {
      return null;
    }
    switch (obj?.type) {
      case 'content_block_delta': {
        const text = obj?.delta?.text;
        return typeof text === 'string' && text ? { delta: text } : null;
      }
      case 'message_start': {
        // 输入 token 在开头一次性给出；输出在 message_delta 累加。
        const inTok = Number(obj?.message?.usage?.input_tokens ?? 0);
        return inTok ? { usage: { inputTokens: inTok, outputTokens: 0 } } : null;
      }
      case 'message_delta': {
        const outTok = Number(obj?.usage?.output_tokens ?? 0);
        return outTok ? { usage: { inputTokens: 0, outputTokens: outTok } } : null;
      }
      default:
        return null; // ping / message_stop / content_block_start 等无内容事件
    }
  },
};

const ADAPTERS: Record<ProviderConfig['format'], ProviderAdapter> = {
  openai: openaiAdapter,
  anthropic: anthropicAdapter,
};

export function adapterFor(format: ProviderConfig['format']): ProviderAdapter {
  return ADAPTERS[format];
}
