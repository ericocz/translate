// BYOK 本地翻译引擎的核心配置类型。
//
// 设计要点（见 BYOK-第二批方案 §4）：两个难题——「提示词适配」「上下文差异」——都收敛到
// 这一个 ProviderConfig。加新模型 = 加一行配置，不改适配器代码。provider 专有差异统一塞进
// extraBody，由通用适配器 merge 进请求体。

/** 适配器格式：唯二两套。openai 兼容覆盖 DeepSeek / OpenAI / Kimi / GLM / Ollama；anthropic 覆盖 Claude。 */
export type ProviderFormat = 'openai' | 'anthropic';

/** 提示词语言版本（按目标语言 fork，非模型）。第二批先落 zh。 */
export type PromptLang = 'zh';

export interface ProviderConfig {
  /** 预设 id 或 'custom'：'deepseek' | 'openai' | 'claude' | 'ollama' | 'custom'。 */
  id: string;
  /** UI 显示名。 */
  label: string;
  /** chat/completions（openai）或 messages（anthropic）的完整 URL。 */
  endpoint: string;
  /** 存 chrome.storage.local，永不上传；本地模型（如 ollama）可为空串。 */
  apiKey: string;
  /** model id。 */
  model: string;
  /** 适配器格式，决定请求体与 SSE 解析。 */
  format: ProviderFormat;
  /** 上下文 token 上限（推导 batchBudget 用）。 */
  contextWindow: number;
  /** 输出 token 上限（= 请求 max_tokens）。 */
  maxOutput: number;
  /** 装箱输出预算：喂给 batchByTokenBudget。可由 ctx/out 推导（deriveBatchBudget）或手填。 */
  batchBudget: number;
  /** 并发批数。本地模型应降到 1。 */
  concurrency: number;
  /** 选哪版提示词。 */
  promptLang: PromptLang;
  /** provider 专有字段，merge 进请求体顶层（如 DeepSeek 关思考 {thinking:{type:'disabled'}}）。 */
  extraBody?: Record<string, unknown>;
}
