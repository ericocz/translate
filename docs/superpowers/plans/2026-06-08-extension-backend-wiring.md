# P1 客户端接线：扩展改调后端 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把扩展的翻译来源从「内容脚本/SW 直连 DeepSeek」切换为「SW 调本项目后端 `POST /v1/translate` 的 SSE」，并退场客户端的翻译流水线模块，使整条链路在真实浏览器里走后端。

**Architecture:** 网络调用仍走 **service worker（background）**——绕开页面 CSP 与 CORS（host_permissions 授权下 SW fetch 不受 CORS 限制），且 `content.ts` 已说端口协议（发 `{kind:'start',blocks}`、收 `block/done/error`），故 **content.ts 不改**。新增 `lib/sse.ts`（纯 SSE 事件解析，可 node 单测）、`lib/api.ts`（`translateViaBackend`：fetch 后端 + 消费 SSE，接口与旧 `translateBlocks` 同形 `{abort}`）、`lib/device.ts`（匿名 deviceId + 本地日期，为 P2 配额铺路）。`background.ts` 仅把 `translateBlocks(()=>KEY, …)` 换成 `translateViaBackend(…)`。`lib/config.ts` 从「读 DeepSeek Key」改为「读后端基址」。退场 `lib/translator.ts`/`deepseek.ts`/`cache.ts`/`prompt.ts`（逻辑已在 `server/`）。

**Tech Stack:** TypeScript strict · WXT/Vite（`import.meta.env.WXT_*` 构建时注入）· 浏览器 `fetch` + `ReadableStream` SSE · 纯函数 node `.mjs` 单测 + `pnpm compile`（tsc）+ Chrome DevTools(:9222) 端到端。

**前置：** 后端已就绪（`server/`，`uv run uvicorn app.main:app --port 8000`）。本计划让扩展指向 `http://localhost:8000`。

**约定：** commit message 用中文，末尾加 `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`（commit 步骤为简洁省略，执行时带上）。

---

## 文件结构（本计划创建/修改/删除）

```
lib/
  sse.ts          # 新增：纯 SSE 事件解析器 createSseParser（跨 chunk 缓冲重扫）
  api.ts          # 新增：translateViaBackend(blocks, handlers) -> {abort}
  device.ts       # 新增：getDeviceId（chrome.storage 持久 UUID）+ localDateString
  config.ts       # 改：DEEPSEEK_API_KEY → BACKEND_URL
  translator.ts   # 删（逻辑已搬 server/app/services/translator.py）
  deepseek.ts     # 删（搬 server/app/services/deepseek.py）
  cache.ts        # 删（搬 server/app/services/cache.py + db）
  prompt.ts       # 删（搬 server/app/core/prompt.py）
entrypoints/
  background.ts   # 改：翻译来源 translateBlocks → translateViaBackend
wxt.config.ts     # 改：host_permissions 去掉 deepseek
.env.example      # 改：客户端改需 WXT_BACKEND_URL（DeepSeek Key 移到 server/.env）
.test-sse.mjs     # 新增：内联 SSE 解析逻辑的 node 单测
```

不动：`content.ts`、`extractor.ts`、`markers.ts`、`rebuilder.ts`、`messages.ts`、`types.ts`、`storage.ts`、`icon.ts`、`dom-compat.content.ts`、popup/options。

---

## Task 1: 纯 SSE 事件解析器 `lib/sse.ts` + node 单测

**Files:**
- Create: `.test-sse.mjs`（内联实现 + 断言，node 直跑——与既有 `.test-restore-wrapper.mjs` 同套路）
- Create: `lib/sse.ts`

- [ ] **Step 1: 写算法单测（内联实现）**

`.test-sse.mjs`：

```js
// 单测 createSseParser：SSE 事件常被网络切成多个 chunk（event:/data: 行、空行分隔）。
// 与 lib/sse.ts 实现保持一致（这里内联一份，node 直接跑）。
function createSseParser(onEvent) {
  let buf = '';
  const emit = (raw) => {
    let event = 'message';
    const dataLines = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (dataLines.length) onEvent({ event, data: dataLines.join('\n') });
  };
  return {
    feed(chunk) {
      buf += chunk;
      let sep;
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        emit(buf.slice(0, sep));
        buf = buf.slice(sep + 2);
      }
    },
    flush() { if (buf.trim()) { emit(buf); buf = ''; } },
  };
}

let pass = 0, fail = 0;
const collect = (chunks) => {
  const out = [];
  const p = createSseParser((e) => out.push(e));
  for (const c of chunks) p.feed(c);
  p.flush();
  return out;
};
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got:  ${g}\n       want: ${w}`); }
};

// 1) 一个完整事件
eq('单事件', collect(['event: block\ndata: {"id":"b1","translated":"你好"}\n\n']),
  [{ event: 'block', data: '{"id":"b1","translated":"你好"}' }]);

// 2) 事件被切成多个 chunk（关键：跨 chunk 缓冲重扫）
eq('跨 chunk 拼接', collect(['event: bl', 'ock\nda', 'ta: {"id":"b1"}', '\n\n']),
  [{ event: 'block', data: '{"id":"b1"}' }]);

// 3) 多事件连续 + done
eq('多事件 + done', collect(['event: block\ndata: {"id":"b1"}\n\nevent: done\ndata: {}\n\n']),
  [{ event: 'block', data: '{"id":"b1"}' }, { event: 'done', data: '{}' }]);

// 4) 末尾无空行靠 flush 收尾
eq('flush 收尾', collect(['event: done\ndata: {}']),
  [{ event: 'done', data: '{}' }]);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
```

- [ ] **Step 2: 跑单测，预期通过（验证算法）**

Run: `node .test-sse.mjs`
Expected: `ALL PASS: 4 passed, 0 failed`

- [ ] **Step 3: 写 `lib/sse.ts`（与上面算法一致的 TS 版）**

```typescript
// 纯 SSE 事件解析：把字节流按「空行分事件、event:/data: 分字段」切出事件。
//
// 关键（与流式切块同源的教训）：一个 SSE 事件常被网络切到多个 chunk，绝不能在单个 chunk 内
// 就地判定事件边界——把已到文本累积进 buf，每次在完整 buf 上找 `\n\n` 事件分隔符。

export interface SseEvent {
  /** event: 行的值；缺省 'message'。 */
  event: string;
  /** data: 行拼接（去掉前导一个空格）。 */
  data: string;
}

export function createSseParser(onEvent: (ev: SseEvent) => void) {
  let buf = '';

  const emit = (raw: string): void => {
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (dataLines.length) onEvent({ event, data: dataLines.join('\n') });
  };

  return {
    /** 喂入一段流文本；识别出的完整事件即时回调。 */
    feed(chunk: string): void {
      buf += chunk;
      let sep: number;
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        emit(buf.slice(0, sep));
        buf = buf.slice(sep + 2);
      }
    },
    /** 流结束时调用，确认末尾不带空行的最后一个事件。 */
    flush(): void {
      if (buf.trim()) {
        emit(buf);
        buf = '';
      }
    },
  };
}
```

- [ ] **Step 4: Commit**

```bash
git add lib/sse.ts .test-sse.mjs
git commit -m "P1 客户端: 纯 SSE 事件解析器 lib/sse.ts + node 单测"
```

---

## Task 2: 匿名设备标识与本地日期 `lib/device.ts`

**Files:**
- Create: `lib/device.ts`
- Modify: `.test-sse.mjs` 末尾不动；本任务的纯函数 `localDateString` 用临时内联校验

- [ ] **Step 1: 写 `lib/device.ts`**

```typescript
// 匿名身份：首次运行生成并持久化 deviceId（UUID），随每次翻译请求带给后端。
// 本地日期（用户时区 YYYY-MM-DD）：匿名「每页一次 / 3 页一天」按本地日跨天重置（P2 用）。

const DEVICE_KEY = 'device_id';

/** 取或建匿名设备 ID（持久在 chrome.storage.local）。 */
export async function getDeviceId(): Promise<string> {
  const got = await chrome.storage.local.get(DEVICE_KEY);
  const existing = got[DEVICE_KEY];
  if (typeof existing === 'string' && existing) return existing;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ [DEVICE_KEY]: id });
  return id;
}

/** 用户本地时区的 YYYY-MM-DD（注意用本地 getFullYear/getMonth/getDate，不是 UTC）。 */
export function localDateString(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
```

- [ ] **Step 2: 验证 `localDateString`（临时内联 node 校验）**

Run:
```bash
node -e "const d=new Date(2026,0,5,23,30); const f=(x)=>{const y=x.getFullYear(),m=String(x.getMonth()+1).padStart(2,'0'),da=String(x.getDate()).padStart(2,'0');return y+'-'+m+'-'+da}; console.log(f(d)==='2026-01-05'?'ok':'FAIL '+f(d))"
```
Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add lib/device.ts
git commit -m "P1 客户端: 匿名 deviceId + 本地日期（为 P2 配额铺路）"
```

---

## Task 3: `lib/config.ts` 改为后端基址 + .env

**Files:**
- Modify: `lib/config.ts`
- Modify: `.env.example`
- Modify: `.env`（本地，已 gitignore）

- [ ] **Step 1: 改 `lib/config.ts`**（整文件替换）

```typescript
// 后端 API 基址的唯一读取处。
//
// 构建时由 .env 的 WXT_BACKEND_URL 注入（见 .env.example）；缺省指向本地开发后端。
// DeepSeek API Key 已移到服务端（server/.env），客户端不再持有任何密钥。
export const BACKEND_URL = (import.meta.env.WXT_BACKEND_URL ?? 'http://localhost:8000').replace(/\/+$/, '');
```

- [ ] **Step 2: 改 `.env.example`**（整文件替换）

```
# 复制本文件为 .env。客户端只需后端基址；DeepSeek Key 已移到 server/.env（不再进扩展产物）。
WXT_BACKEND_URL=http://localhost:8000
```

- [ ] **Step 3: 写本地 `.env`（追加 WXT_BACKEND_URL，保留既有行）**

Run:
```bash
grep -q '^WXT_BACKEND_URL=' .env || printf 'WXT_BACKEND_URL=http://localhost:8000\n' >> .env
grep -c '^WXT_BACKEND_URL=' .env   # 期望输出 1
```
Expected: `1`

- [ ] **Step 4: Commit**

```bash
git add lib/config.ts .env.example
git commit -m "P1 客户端: config 从 DeepSeek Key 改为后端基址 WXT_BACKEND_URL"
```

---

## Task 4: 后端 API 客户端 `lib/api.ts`

**Files:**
- Create: `lib/api.ts`

- [ ] **Step 1: 写 `lib/api.ts`**

```typescript
// 后端 API 客户端：替代「直连 DeepSeek」。在 service worker 里调本项目后端 /v1/translate，
// 消费 SSE（event: block/done/error），逐块回调。接口与旧 lib/deepseek.ts 的 client 同形（{abort}），
// 故 background.ts 几乎零改动即可切换。
//
// 为什么在 SW 里发：host_permissions 授权下 SW 的跨域 fetch 不受 CORS 限制，也不受页面 CSP 约束。

import { BACKEND_URL } from './config';
import { getDeviceId, localDateString } from './device';
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
export function translateViaBackend(blocks: ApiBlock[], handlers: ApiHandlers): ApiClient {
  const controller = new AbortController();

  void (async () => {
    let deviceId = 'unknown';
    try {
      deviceId = await getDeviceId();
    } catch {
      // storage 不可用时退化为匿名占位，不阻断翻译。
    }

    let resp: Response;
    try {
      resp = await fetch(`${BACKEND_URL}/v1/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Device-Id': deviceId },
        body: JSON.stringify({ blocks, localDate: localDateString() }),
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
    const kind = (['network', 'api', 'auth', 'unknown'] as const).includes(obj.kind as FailureKind)
      ? (obj.kind as FailureKind)
      : 'unknown';
    return { kind, message: obj.message ?? '翻译失败' };
  } catch {
    return { kind: 'unknown', message: '翻译失败' };
  }
}

function classifyNetwork(e: unknown): FailureInfo {
  const msg = e instanceof Error ? e.message : String(e);
  // 连不上后端：多半是后端没起 / 代理拦了本地请求。
  return { kind: 'network', message: `无法连通翻译后端（${BACKEND_URL}）：${msg}` };
}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm compile`
Expected: 无错误（此时 background 仍引用旧 translator，但尚未删除，应仍能编译通过）。

- [ ] **Step 3: Commit**

```bash
git add lib/api.ts
git commit -m "P1 客户端: lib/api.ts 调后端 /v1/translate 消费 SSE（{abort} 同形）"
```

---

## Task 5: `background.ts` 切换翻译来源 + manifest 权限

**Files:**
- Modify: `entrypoints/background.ts`
- Modify: `wxt.config.ts`

- [ ] **Step 1: 改 `background.ts` 的导入**

把：
```typescript
import { translateBlocks, type TranslationJob } from '@/lib/translator';
import { DEEPSEEK_API_KEY } from '@/lib/config';
```
改为：
```typescript
import { translateViaBackend, type ApiClient } from '@/lib/api';
```
并把顶部注释「不含任何翻译业务逻辑（都在 lib/translator.ts）。」改为「不含任何翻译业务逻辑（都在后端 /v1/translate）。」

- [ ] **Step 2: 改 job 类型与翻译调用**

把 `let job: TranslationJob | null = null;` 改为 `let job: ApiClient | null = null;`。

把：
```typescript
      const thisJob: TranslationJob = translateBlocks(
        async () => DEEPSEEK_API_KEY,
        msg.blocks,
        {
          onBlock: (id, translated) => send({ kind: 'block', id, translated }),
```
改为：
```typescript
      const thisJob: ApiClient = translateViaBackend(
        msg.blocks,
        {
          onBlock: (id, translated) => send({ kind: 'block', id, translated }),
```
（其余 onDone/onError 回调体不变；注意删掉原来的 `async () => DEEPSEEK_API_KEY,` 这一行参数。）

- [ ] **Step 3: 改 `wxt.config.ts` 的 host_permissions**

把：
```typescript
    host_permissions: ['<all_urls>', 'https://api.deepseek.com/*'],
```
改为：
```typescript
    // 客户端不再直连 DeepSeek；后端 fetch 走 <all_urls>（含 http://localhost 开发后端）。
    host_permissions: ['<all_urls>'],
```

- [ ] **Step 4: 类型检查**

Run: `pnpm compile`
Expected: 无错误。

- [ ] **Step 5: Commit**

```bash
git add entrypoints/background.ts wxt.config.ts
git commit -m "P1 客户端: background 翻译来源切到后端 translateViaBackend + 收紧权限"
```

---

## Task 6: 退场客户端翻译流水线模块

**Files:**
- Delete: `lib/translator.ts`, `lib/deepseek.ts`, `lib/cache.ts`, `lib/prompt.ts`

- [ ] **Step 1: 删除四个模块**

```bash
git rm lib/translator.ts lib/deepseek.ts lib/cache.ts lib/prompt.ts
```

- [ ] **Step 2: 类型检查（确认无悬空引用）**

Run: `pnpm compile`
Expected: 无错误。若报某文件仍引用被删模块 → 那是 Task 5 没切干净，回到 Task 5 修正。

- [ ] **Step 3: 跑既有纯函数单测（确认没误伤）**

Run:
```bash
node .test-restore-wrapper.mjs && node .test-sse.mjs
```
Expected: 两个都 `ALL PASS`。

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "P1 客户端: 退场客户端翻译流水线（translator/deepseek/cache/prompt 已搬服务端）"
```

---

## Task 7: 构建 + Chrome 端到端验证（真实走后端）

**Files:** 无（验证任务）

- [ ] **Step 1: 起后端**

```bash
cd server && uv run uvicorn app.main:app --port 8000 --log-level info &
sleep 2 && curl -s http://localhost:8000/health
cd ..
```
Expected: `{"status":"ok"}`

- [ ] **Step 2: 构建扩展**

Run: `pnpm build`
Expected: 产物在 `output/chrome-mv3`，无构建错误。

- [ ] **Step 3: 在调试 Chrome(:9222) 加载并重载扩展**

用 chrome-devtools MCP（见经验库 [[chrome-devtools-mcp-connect]]）连 :9222：
- 确保 `output/chrome-mv3` 已作为「解包扩展」加载；若已加载，连扩展 service worker 的 CDP 目标执行 `chrome.runtime.reload()` 从磁盘重载。
- 充分预热后再判（紧接 reload 的首刷可能 content script 尚未注册）。

- [ ] **Step 4: 翻译一个测试页，确认走后端**

- 打开一个英文页（如 `https://en.wikipedia.org/wiki/Backend`），在 popup 点「翻译此网站」。
- 期望：页面逐块淡入中文。
- 在**扩展 service worker** 的 network 里确认有 `POST http://localhost:8000/v1/translate`（注意 background 发的请求在页面 network 看不到，要去 SW 上下文查）。
- 核对后端缓存表新增了行：
  ```bash
  psql -h localhost -p 5432 -d imt -c "select count(*) from translation_cache;"
  ```
  期望计数随翻译增长。

- [ ] **Step 5: 回归三个交互**

- **Ctrl+点击**某已译块 → 在中/英间粘滞切换（仍靠本地 originalHTML，不重新请求）。
- popup **取消翻译此网站** → 整页立即还原英文。
- **再次开启** → 整页重译；第二次应明显更快（后端缓存命中）。

- [ ] **Step 6: 收尾**

```bash
kill %1   # 停后端（若仍在前台后台运行）
```
记录验证结果；如有异常按经验库立案。

---

## Self-Review 记录

- **Spec 覆盖**：设计文档 P1 客户端侧——`lib/api.ts`（Task 4）、`lib/device.ts`（Task 2）、`background.ts` 改调后端（Task 5）、退场 deepseek/cache/config/prompt/translator（Task 3 改 config、Task 6 删四件）。`content.ts`/`markers`/`rebuilder` 保留不动（设计要求）。
- **铁律核对**：原文永不销毁（content.ts originalHTML 不变）· 标记校验 + restoreSoleWrapper 仍在 content.applyBlock（不变）· 流式跨 chunk 重扫（lib/sse.ts，Task 1 测试）· 密钥不进客户端（config 改基址、删 DeepSeek Key，Task 3）。
- **占位扫描**：无 TBD；每个改代码步骤给了完整代码/精确编辑与命令。
- **类型一致**：`ApiClient.{abort}` 对齐旧 `DeepSeekClient`/`TranslationJob.{abort}`，故 background 的 `job` 变量替换无缝；`ApiHandlers.{onBlock,onDone,onError}` 与 background 现有回调一致；`FailureInfo/FailureKind`（types.ts）复用。
- **已知后续**：`X-Device-Id`/`localDate` 后端 P1 暂不消费（P2 配额接入）；`quota` 失败类型与 popup 登录引导属 P2/P3；CORS 无需配置（SW + host_permissions）。
```
