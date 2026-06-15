# front/CLAUDE.md —— 浏览器扩展

本目录是「秒懂翻译 / aha translate」浏览器扩展。仓库总览见上一级 [`../CLAUDE.md`](../CLAUDE.md)。

> **关键：翻译流水线已搬到后端（`../server`）。** 扩展只负责 DOM（抽取 / 标记 / 重建 / 还原）+ 调后端 API，**不再持有任何密钥**。本文件描述重构后的现状。

---

## 概述

把英文网页**整页**翻成中文（导航 / 按钮 / 页脚等可见文字全翻），面向技术阅读。核心体验：**原文先垫着、译文流式逐块淡入替换、只显示译文**。

## 体验设计基准（「隐形」哲学）

衡量这插件好不好的唯一标准是它有多**隐形**——译文干净、不打扰，像这页本来就是中文写的。横幅 / 水印 / 进度条 / 骨架屏 / 闪烁都是向这个目标收税，加任何 UI 前先问它配不配。下列产品决策由此而来（与下面「体验铁律」的技术约束互为表里）：

- **按域名激活、单一开关**：白名单内的站一打开就自动全页翻译；图标是唯一常驻接触点（用自身状态表达开/关，见 `lib/icon.ts` 两态）。关掉即刻还原英文（原文常驻、瞬时）。**刻意无「临时翻译一次」入口**——只看一次的页面：加域名 → 读 → 关，为换激活模型极简而接受的取舍。
- **整页全部可见文字都翻**，正文与界面（导航/按钮/页脚）一视同仁、不做正文识别；藏在属性里的（图片 `alt`、`placeholder`）暂不翻。
- **失败 / 未轮到都静默保持英文**：得益于「原文先垫」，失败段与「还没轮到」视觉无异——不报错、不空块、不加特殊处理。补救＝关掉再开整页重译（命中本地缓存便宜快），**不设「重试」按钮**。
- **查看原文**：Ctrl/⌘+点击单段就地粘滞切换中↔英（对照可疑译文）；要整页看原文就用快捷键 / popup 取消翻译此站（即刻还原，原文常驻、瞬时、无需重译）。
- **出错说人话、分来源**：`errorKind` 区分「网络 / 代理未连通」与「模型接口报错」（一眼判断查代理还是重试）；`quota` 不是错误而是引导（柔和提示 + 登录 / 充值 CTA，不显示红色报错）。

> 本节由原《沉浸式翻译插件-用户体验设计.md》提炼并对齐现状（该文已删——其「客户端 DeepSeek API Key 设置」「重试未完成按钮」「客户端不留缓存」等表述均已被后续重构推翻，是典型的文档脱节）。

## 技术栈

- TypeScript strict；Chrome **MV3**；[WXT](https://wxt.dev/)（基于 Vite，处理 MV3 样板 / 内容脚本 HMR）；pnpm；popup / options 用 React。
- 存储 `chrome.storage.local`：白名单、匿名 `deviceId`、登录 token、设置。
- 偏轻量可组合，少引第三方库；引入较重依赖前先确认。

## 体验铁律（前端侧仍须遵守）

1. **原文永不销毁。** 替换某块前先存其原始 HTML（`content.ts` 的 `records`）；Ctrl/⌘+点击切换、关站还原、失败降级都靠它。
2. **占位标记校验。** 内联样式以成对 `<g0>…</g0>` / 自闭合 `<x0/>` 标记承载，**styleMap 只在客户端**。收到译文先用 `markers.ts` 校验标记平衡 / 编号合法，再用 `rebuilder.ts` 重建；不通过则该块保持英文。`restoreSoleWrapper` 补回模型整对省略的「最外层唯一内联包装」（超链接坑，见经验库 #7）。
3. **块 ID 稳定**（`data-trans-id`）：用于流式回填 / 切换定位。沉降补抽 / SPA 新路由用 `r{batch}.b{n}` **带点**前缀，故 SSE 切块（在后端）正则须含 `.`。
4. **代码不翻**：抽取跳过代码块；行内代码（如 `fetch()`）保持英文。
5. **全部可见文字都翻**，按 DOM 顺序自上而下，不做正文识别 / 视口优先。
6. **原文先渲染**：加载即显完整英文，译文到达逐块淡入（短暂过渡，不硬切）。

> 「系统提示词逐字节稳定、关思考、真实 usage、API Key 不暴露」等**模型侧铁律已移到 `../server`**（见 `server/CLAUDE.md`）。扩展产物里**不含任何密钥**。

## 数据流

1. **触发**：内容脚本判断当前域名是否在白名单，在则自动运行。SPA 同文档路由跳转由后端 service worker 的 `webNavigation.onHistoryStateUpdated` 监听后通知 content（`content.ts handleSpaNavigation`，epoch 防串扰、seq 保证带前缀 id 唯一）。
2. **抽取**：`extractor.ts` 用 `TreeWalker` 抽块级元素、生成 `<gN>/<xN>` 标记 + styleMap、存原文 HTML。
3. **本地缓存优先 + 请求**：`background.ts`（service worker）先经 `lib/translate-cached.ts` 查本地 IndexedDB（`lib/local-cache.ts`）：命中块直接回填、**不发服务端**（天然不扣额度）；未命中块才经 `lib/api.ts` `translateViaBackend` POST `${BACKEND_URL}/v1/translate`（SSE），带 `X-Device-Id`、`pageKey`（`pageKeyFromUrl` 规范化 URL 哈希，URL 不出本机）、`localDate`，登录则带 `Authorization`；服务端回的、标记校验通过的块写回本地。**加密开启时**（构建注入 `SERVER_PUBKEY`）source 经 `crypto.ts` 加密为 `ct`、带 `X-Eph-Pub` 头，SSE 译文为 `ct`、解密后再校验/重建（D-13；缓存与重建仍在明文域，加密对其透明）。**网络调用在 SW 发**：host_permissions 授权下不受页面 CSP / CORS 限制。
4. **流式回填**：后端发结构化 SSE 事件（`event: block` `{id,translated}` / `done` / `error` / `quota`）；`lib/sse.ts createSseParser` 跨 chunk 累积解析；content 收 `block` → `restoreSoleWrapper` → 校验 → `rebuilder` 重建 → 淡入替换对应节点。
5. **失败 / 配额**：`error` / `quota` 经 port 回 content，`errorKind` 透到 popup——`quota`（匿名超 3 页 / 登录超日上限）用**柔和样式 + 登录引导**，不显示红色报错。
6. **账号 / 匿名 / 打点**：`lib/auth.ts`（注册 / 登录 / 登出 / access 静默刷新，token 存 storage）；`lib/device.ts`（匿名 `deviceId` + `localDateString` + `pageKeyFromUrl`）；`lib/telemetry.ts`（`track` / `reportError`，fire-and-forget、只带 host + 计数）。

## 模块划分

```
entrypoints/
  content.ts            # 抽取 / 标记 / 流式回填 / Ctrl+点击 / 还原；有界沉降补抽 settleAndReextract + SPA 软导航重译 handleSpaNavigation；errorKind 透传
  background.ts         # service worker：port 适配 → 经 translate-cached（本地缓存优先）调后端；图标 off/on 两态；webNavigation 软导航监听；翻译生命周期埋点(track/reportError)
  dom-compat.content.ts # MAIN world / document_start：补丁 removeChild/insertBefore 防崩溃 + 发 hydration 就绪信号（消 #418）
  popup/  options/      # React「素 Quiet」：popup 账号区(登录/注册/登出)+免费额度N/3或今日token+翻译按钮+配额柔和提示；options 管白名单
lib/
  api.ts        # translateViaBackend：调后端 /v1/translate 消费 SSE（{abort} 同形旧 client）；带 deviceId/pageKey/Authorization
  local-cache.ts# 本地译文缓存（IndexedDB·L1，D-11b）：内容寻址键含语言对；先查本地/只发未命中/写回；LRU 200MB·90天逐出
  translate-cached.ts # 本地优先编排 translateWithCache：命中即回不发服务端，未命中发后端、校验通过写回（background 调它）
  auth.ts       # token 持久化 + 注册/登录/登出 + access 静默刷新
  device.ts     # 匿名 deviceId + 本地日期 + pageKeyFromUrl（cyrb53）
  telemetry.ts  # 打点 / 错误上报（fire-and-forget，只带 host）
  sse.ts        # 纯 SSE 事件解析 createSseParser（跨 chunk 缓冲重扫）
  crypto.ts     # 应用层加密（D-13）：ECDH(P-256)+HKDF+AES-GCM，钉死服务端公钥/会话级临时密钥；api.ts 用它加密 source/解密 translated
  extractor.ts  # TreeWalker 抽块 + 生成 <gN>/<xN> 标记 + styleMap
  markers.ts    # 标记词法 tokenizeMarkers / validateMarkers / restoreSoleWrapper / allowedIdsFromSource
  rebuilder.ts  # 依 styleMap + tokenize 把带标记译文重建为 DOM
  storage.ts    # 白名单 / 设置（含本地缓存开关 cacheEnabled）
  icon.ts       # 工具栏图标两态（off/on，一点开启即 on、不随翻译进度变化）
  config.ts     # BACKEND_URL + SERVER_PUBKEY（D-13 加密公钥，空＝明文 dev）唯一读取处（构建期由 .env 的 WXT_* 注入）
  messages.ts   # content ↔ background ↔ popup 协议（含 quota 失败类、StatusReply.errorKind）
  types.ts      # 共享类型（FailureKind 含 'quota'）
```
（已退场 `deepseek.ts` / `cache.ts` / `prompt.ts` / `translator.ts`——逻辑已用 Python 重写在 `../server`。）

## 后端契约

`BACKEND_URL`（构建期 `WXT_BACKEND_URL` 注入）。用到的后端端点：`POST /v1/translate`(SSE)、`GET /v1/usage`、`POST /v1/auth/{register,login,refresh,logout}`、`POST /v1/events`、`POST /v1/errors`。**改协议须同步 `../server`**（事件名、字段、SSE 格式）。

## 已知限制 / 坑（详见经验库《[../翻译问题记录.md](../翻译问题记录.md)》）

- **React / Next.js 站点（如 react.dev）**：直接改 DOM 与 React 协调冲突曾致 `removeChild` 崩溃。两道防线：`dom-compat.content.ts` 补丁消致命崩溃 + 推迟到 hydration 后再抽取注入消多数 #418。部分把 hydration 延迟 / 流式到 `load` 后的站仍有**可恢复**的 #418/#425。
- 主要处理加载时已有内容；例外：**有界沉降补抽**（最多 5 轮、每轮 1200ms，补晚渲染 SPA 的首屏块）+ **SPA 软导航重译**。仍**不上常驻 MutationObserver**。
- **缓存=客户端本地（D-11b）**：译文存 IndexedDB（内容寻址，键含语言对），命中不发服务端、不扣额度；动态变化块标记不同 → 键不同 → 重译，刷新请求收敛到「变化块」而非 0，属正确行为。服务端不再持有缓存（D-11a）。LRU 200MB / 90 天逐出，设置页可关可清。

## 编码约定

- TS strict；小而专注、可组合模块；抽取 / 标记校验 / SSE 解析三处易错点写中文注释。
- **命令**（在 `front/` 下）：`pnpm dev`（HMR）/ `pnpm build`（产物 `output/chrome-mv3`，作解包扩展加载）/ `pnpm compile`（`tsc --noEmit`，提交前必跑）/ `pnpm zip`。
- **验证**：纯函数（markers / 切块 / sse / pageKey）用一次性 `node .test-*.mjs` 脚本单测；端到端用 Chrome DevTools（调试 Chrome 开 `:9222`）连扩展 SW；注意 background 发的请求在页面 network 看不到，要去 SW 上下文查。
- **全站回归**：语料见《[../测试网站清单.md](../测试网站清单.md)》（150 站），结果汇总进《[../测试运行记录.md](../测试运行记录.md)》，❌ 转经验库立案。改抽取 / 标记 / 重建后据此回归。
