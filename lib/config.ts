// DeepSeek API Key 的唯一读取处。
//
// 构建时由 .env 里的 WXT_DEEPSEEK_API_KEY 注入（见 .env.example）。Vite/WXT 会把
// import.meta.env.WXT_* 静态替换为字面量，因此在 background service worker 里也能直接用。
// .env 已被 .gitignore 忽略，key 不进 git；产物 JS 里会有这串 key（纯自用可接受）。
//
// 铁律：绝不写入日志、绝不在 UI 暴露。
export const DEEPSEEK_API_KEY = (import.meta.env.WXT_DEEPSEEK_API_KEY ?? '').trim();
