# CLAUDE.md

本文件是本项目的开发基准，供 Claude Code 在每次会话开始时读取。
配套的体验设计见《沉浸式翻译插件-用户体验设计.md》；本文件只关心“如何实现得不跑偏”。

---

## 项目概述

一个自用的 Chrome 浏览器扩展，把英文网页**整页**翻译成中文（不只是正文，导航/按钮/页脚等可见文字全翻），面向技术文章与英文站点的高效阅读。翻译模型为 DeepSeek V4 Flash。核心体验是“原文先垫着、译文流式逐块替换、只显示译文”。

---

## 技术栈（默认方案，可与我确认后调整）

- **语言**：TypeScript（strict 模式）。
- **扩展规范**：Chrome Manifest V3。
- **框架**：[WXT](https://wxt.dev/)（基于 Vite，处理 MV3 样板、内容脚本 HMR）。若不用 WXT，则用 Vite + `@crxjs/vite-plugin`。
- **包管理**：pnpm。
- **UI（popup/设置页）**：React（项目作者有十年 React 经验）。
- **存储**：`chrome.storage.local`（白名单、API Key、快捷键等设置）；**翻译缓存用 IndexedDB**（见 `lib/cache.ts`）。
- 偏好轻量、可组合的模块，避免引入重框架；**引入任何较重的依赖前先与我确认**。

---

## 体验铁律（实现时不可违背）

1. **系统提示词逐字节稳定。** 系统提示词是一个常量字符串，放在每次请求的最前面。绝不把页面内容、块编号等任何动态信息拼进系统提示词。变化的内容一律放在它之后。这是 DeepSeek 前缀缓存命中的前提，直接关系速度与成本。
2. **原文永不销毁。** 用译文替换某块之前，必须先把该块的原始 HTML 保存下来（按块 ID 存入 Map，或挂到 DOM 节点的 data 属性）。Ctrl+点击切换、整页翻面、重试、失败降级全都依赖它。
3. **占位标记协议必须校验。** 内联样式以成对 `<g0>…</g0>` 和自闭合 `<x0/>` 标记交给模型；样式映射表只存在客户端，绝不发给模型。模型返回后，重建样式前先校验标记是否平衡、编号是否合法；校验不通过的块视为失败，保持英文原文。
4. **显式关闭思考模式。** `deepseek-v4-flash` **默认开启**思考（会先流式输出 `reasoning_content` 再出 `content`，慢且多耗 token）。必须在请求体顶层加 `thinking: { type: 'disabled' }` 关闭；翻译是确定性改写，不需要推理，关闭后首 token 快约 3.5×。模型字符串 `deepseek-v4-flash`。
5. **块 ID 稳定。** 每个可翻译块分配稳定 ID（如 `data-trans-id`），用于流式回填、重试、切换的定位。
6. **代码不翻。** 抽取时跳过代码块；行内代码（如 `fetch()`）保持英文。
7. **全部可见文字都翻，不区分内容类型，按 DOM 顺序自上而下。** 不做正文识别，不做视口优先。
8. **原文先渲染。** 页面加载即显示完整英文原文，译文到达后逐块替换，替换用短暂淡入过渡，不可硬切。
9. **API Key 绝不写入日志**，只存 `chrome.storage`。

---

## 翻译流水线

1. **触发**：内容脚本判断当前域名是否在白名单；在则自动运行。
2. **抽取**：用 `TreeWalker` 遍历 `document.body`，识别块级元素（p / li / h1~h6 / td / blockquote 等）为翻译单元，分配 ID，存原文 HTML。对每块递归处理其内部：文本节点拼成待译文本，承载样式的内联元素就地转成 `<gN>`/`<xN>` 标记，并记录“编号→原始内联元素”映射。
3. **请求（带缓存）**：内容脚本把所有块（DOM 顺序）发给 service worker；worker 先查 IndexedDB 缓存（`lib/cache.ts`），命中的块直接回传（0 token、毫秒级），未命中的按 source **去重**、再**分批（每批约 40 块，避免输出超 `max_tokens` 被截断）** 调用 DeepSeek（流式、关思考），译出并校验通过后写入缓存。
4. **流式回填**：service worker 通过长连接（`chrome.runtime.connect` port）把流块转发给内容脚本；内容脚本边收边按 `[[id]]` 切分，每收齐一块就校验标记、重建样式、淡入替换对应 DOM 节点。
5. **失败处理**：失败/未达的块保持英文原文；popup 提供“重试未完成的部分”，因前缀缓存而廉价快速。流被中途切断同理。单批失败不影响其余批次。
6. **查看原文**：Ctrl+点击某块 → 该块在原文/译文间粘滞切换；快捷键 → 整页在全中文/全英文间瞬间翻面（均无需重新请求，靠本地保存的原文）。
7. **取消**：白名单关闭某域名 → 当前页所有块立即还原为英文原文。

---

## 协议定义（系统提示词与解析器必须一致）

**输入（user 消息，变化部分）**，每块独占一行：
```
[[b1]] You must call <g0>fetch()</g0> before <g1>rendering</g1>.
[[b2]] ...
```

**期望输出**，保持相同 id，仅输出译文：
```
[[b1]] 在<g1>渲染</g1>之前，你必须先调用 <g0>fetch()</g0>。
[[b2]] ...
```

**系统提示词草案（常量，置于前缀）**：见 `lib/prompt.ts`（唯一来源）。改动它会令 DeepSeek 前缀缓存与翻译缓存（其版本键含 prompt 哈希）全部失效。

---

## DeepSeek 接入要点

- **模型**：`deepseek-v4-flash`（旧别名 `deepseek-chat`/`deepseek-reasoner` 计划于 2026-07-24 弃用，分别对应非思考/思考模式；新代码用显式名 + thinking 参数）。
- **接口**：OpenAI 兼容，base URL `https://api.deepseek.com`，端点 `/v1/chat/completions`；用 `stream: true` 走 SSE。
- **关思考参数（已确认）**：请求体顶层 `"thinking": {"type": "disabled"}`（实测对 `stream:true` + `/v1/chat/completions` 生效，关闭后流里不再有 `reasoning_content`）。文档：https://api-docs.deepseek.com/guides/thinking_mode 。
- **流式切块易错点**：模型逐 token 返回，`[[id]]` 标记常被拆到多个小 chunk（如 `[[`、`b`、`1`、`]]`）。切块器必须把已到文本累积进缓冲、在**完整缓冲**上重新扫描标记，不能在单个 chunk 内就地判定边界（见 `lib/deepseek.ts` 的 `createBlockSplitter`，这是历史上踩过的坑）。
- **缓存命中核对**：用响应里的 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` 核对前缀缓存；务必把稳定系统提示词放最前、逐字节不变。
- 注意：作者在中国通过 Clash 代理访问，请求失败需区分“网络/代理未连通”与“接口报错”，错误信息要据此分类提示。

---

## 模块划分（实际结构）

```
entrypoints/
  content.ts            # 内容脚本（isolated，document_idle）：抽取、标记、流式回填、Ctrl+点击、整页翻面、还原
  background.ts         # service worker：缓存查询/写入 + 去重 + 分批 DeepSeek 调用 + SSE 流转发
  dom-compat.content.ts # MAIN world / document_start：补丁 removeChild/insertBefore，防 React 协调崩溃
  popup/  options/      # React：站点开关/重试/进度；白名单、API Key、快捷键
lib/
  extractor.ts  # TreeWalker 抽取块 + 生成 <gN>/<xN> 标记 + styleMap
  markers.ts    # 标记序列化/校验/还原；allowedIdsFromSource（从 source 反推编号，供 bg 端做等价校验）
  rebuilder.ts  # 依据 styleMap 把带标记的译文重建为 DOM
  deepseek.ts   # 请求构造（稳定前缀 + thinking:disabled）、SSE 解析、createBlockSplitter 流式切块
  cache.ts      # IndexedDB 内容寻址翻译缓存（键 = 版本(模型+prompt 哈希):cyrb53(source)；LRU 淘汰）
  storage.ts    # 白名单 / API Key / 设置
  prompt.ts     # 系统提示词常量（唯一来源，禁止动态拼接）
  messages.ts   # content ↔ background ↔ popup 消息协议
  types.ts      # 共享类型
```

---

## 已知限制 / 跨框架坑

- **React/Next.js 站点（如 react.dev）**：直接替换 DOM 会与 React 协调冲突，曾导致 `removeChild NotFoundError` → 错误边界 → 整页“client-side exception”崩溃；缓存+关思考让译文在 hydration 期间就快速注入，会稳定触发。已由 `dom-compat.content.ts`（MAIN world、React 之前打补丁使 removeChild/insertBefore 容错）消除**致命**崩溃；残留一个**良性**的 hydration 文本不匹配告警（React #418），不影响渲染与翻译。
- 翻译动态/交互界面不如静态正文稳定：页面自身 JS 重渲染可能把已替换的中文打回英文。
- 仅处理加载时已存在的内容；异步追加的内容不自动翻译（不上 MutationObserver）。
- **缓存是内容寻址**：页面每次渲染的块集若有变化（动态内容），变化部分会重新翻译，刷新请求数收敛到“变化块”而非 0，属正确行为。

---

## 编码约定

- TypeScript strict；小而专注、可组合的模块；命名清晰。
- 关键逻辑写中文注释（尤其抽取、标记校验、流式解析这三处易错点）。
- 优先用浏览器原生 API（TreeWalker、ReadableStream、IndexedDB），少引第三方库。
- **命令**：`pnpm dev`（开发，HMR）/ `pnpm build`（产物 → `output/chrome-mv3`，作为“解包扩展”加载）/ `pnpm compile`（`tsc --noEmit` 类型检查，提交前必跑）/ `pnpm zip`（打包）。
- **验证**：纯函数（markers / 切块 / 缓存逻辑）用一次性 `node xxx.mjs` 脚本单测；端到端用 Chrome DevTools（调试 Chrome 开在 `:9222`）——可连扩展 service worker 的 CDP 目标看 DeepSeek 请求/响应、用 `chrome.runtime.reload()` 从磁盘重载解包扩展、查页面控制台崩溃。注意 background 发出的请求在页面 network 里看不到，要去 service worker 上下文查。
```
