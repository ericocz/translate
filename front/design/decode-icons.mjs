// 把 design/icons.json（{ "icon/16.png": "<base64>", ... }）解码成真实 PNG 写入 public/。
// 一次性脚本：图标几何变了就重跑 evaluate_script 再跑这个。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const raw = JSON.parse(readFileSync(resolve(import.meta.dirname, 'icons.json'), 'utf8'));
// 容错：evaluate 工具可能把返回值包一层；取出「值全是 base64 字符串」的那个对象。
const map =
  raw && typeof raw === 'object' && Object.values(raw).every((v) => typeof v === 'string')
    ? raw
    : Object.values(raw).find(
        (v) => v && typeof v === 'object' && Object.values(v).every((x) => typeof x === 'string')
      );
if (!map) throw new Error('icons.json 结构无法识别');

for (const [rel, b64] of Object.entries(map)) {
  const dest = resolve(root, 'public', rel);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, Buffer.from(b64, 'base64'));
  console.log('written', 'public/' + rel, Buffer.from(b64, 'base64').length + 'B');
}
