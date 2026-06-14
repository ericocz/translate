// 后端 API 基址的唯一读取处。
//
// 构建时由 .env 的 WXT_BACKEND_URL 注入（见 .env.example）；缺省指向本地开发后端。
// DeepSeek API Key 已移到服务端（server/.env），客户端不再持有任何密钥。
export const BACKEND_URL = (import.meta.env.WXT_BACKEND_URL ?? 'http://localhost:8000').replace(/\/+$/, '');

// D-13 应用层加密：服务端静态公钥（base64 未压缩点）。构建期注入；空＝明文（dev）。公钥可公开。
export const SERVER_PUBKEY = (import.meta.env.WXT_SERVER_PUBKEY ?? '').trim();
