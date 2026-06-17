// BYOK provider 预设表（用户可覆盖）。见 BYOK-第二批方案 §4。
//
// 加新模型 = 在此加一行；通用适配器靠 format + extraBody 兜住差异，不改代码。

import type { ProviderConfig, ProviderFormat } from './types';

/** 预设项：去掉用户运行时才填的 apiKey（配置时补）。 */
export type ProviderPreset = Omit<ProviderConfig, 'apiKey'>;

// 系统提示词的粗略 token 占用（zh 版 + few-shot 常量），用于 batchBudget 缺省推导留余量。
// 宁可高估：低估只会让某箱略超预算、被模型输出上限兜底，不致命。
const SYSTEM_PROMPT_TOKENS = 600;

/**
 * batchBudget 缺省推导：min(maxOutput, (contextWindow − systemPrompt − 余量) / 2)。
 * 除以 2 是因为上下文要同时容纳「输入原文 + 输出译文」，两者量级相当。
 */
export function deriveBatchBudget(contextWindow: number, maxOutput: number): number {
  const usable = contextWindow - SYSTEM_PROMPT_TOKENS;
  const half = Math.floor(usable / 2);
  return Math.max(1, Math.min(maxOutput, half));
}

const K = 1024;
const M = 1024 * K;

/** 内置预设表。custom 由用户在 UI 全量手填，不在此列。 */
export const PRESETS: ProviderPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek V4 Flash',
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    model: 'deepseek-v4-flash',
    format: 'openai',
    contextWindow: 1 * M,
    maxOutput: 384 * K,
    batchBudget: 384000,
    concurrency: 4,
    promptLang: 'zh',
    // 关思考靠这个字段、与 key 无关；不发则默认开思考 → temperature 失效、变慢变贵。
    extraBody: { thinking: { type: 'disabled' } },
  },
  {
    id: 'openai',
    label: 'OpenAI GPT',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o-mini',
    format: 'openai',
    contextWindow: 128 * K,
    maxOutput: 16 * K,
    batchBudget: 12000,
    concurrency: 4,
    promptLang: 'zh',
  },
  {
    id: 'claude',
    label: 'Claude',
    endpoint: 'https://api.anthropic.com/v1/messages',
    model: 'claude-haiku-4-5-20251001',
    format: 'anthropic',
    contextWindow: 200 * K,
    maxOutput: 8 * K,
    batchBudget: 6000,
    concurrency: 4,
    promptLang: 'zh',
  },
  {
    id: 'ollama',
    label: 'Ollama（本地）',
    endpoint: 'http://localhost:11434/v1/chat/completions',
    model: 'qwen2.5:7b',
    format: 'openai',
    contextWindow: 8 * K,
    maxOutput: 4 * K,
    batchBudget: 3000,
    concurrency: 1, // 本地算力有限，串行
    promptLang: 'zh',
  },
];

/** custom provider 的空白模板：format 默认 openai 兼容（覆盖面最广），ctx/out 给保守缺省。 */
export function customTemplate(): ProviderPreset {
  const contextWindow = 32 * K;
  const maxOutput = 4 * K;
  return {
    id: 'custom',
    label: '自定义',
    endpoint: '',
    model: '',
    format: 'openai' as ProviderFormat,
    contextWindow,
    maxOutput,
    batchBudget: deriveBatchBudget(contextWindow, maxOutput),
    concurrency: 2,
    promptLang: 'zh',
  };
}

/** 按 id 取预设（含 custom 模板）。 */
export function presetById(id: string): ProviderPreset | undefined {
  if (id === 'custom') return customTemplate();
  return PRESETS.find((p) => p.id === id);
}
