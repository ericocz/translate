# front/CLAUDE.md —— 浏览器扩展

「秒懂翻译 / aha translate」浏览器扩展。仓库总览见 [`../CLAUDE.md`](../CLAUDE.md)。

把网页**整页**翻成目标语言（导航 / 按钮 / 页脚等可见文字全翻）——**源 / 目标语言由用户选**，作者自用主场景是英文技术页 → 中文阅读。**翻译流水线在后端**（`../server`）；扩展只负责 DOM（抽取 / 标记 / 重建 / 还原）+ 调后端 API，**不持有任何密钥**。

## 体验设计基准（「隐形」哲学）

衡量这插件好不好的唯一标准是它有多**隐形**——译文干净、不打扰，像这页本来就是中文写的。横幅 / 水印 / 进度条 / 骨架屏 / 闪烁都是向这个目标收税，加任何 UI 前先问它配不配。由此而来的产品决策：

- **按域名激活、单一开关**：白名单内的站一打开就自动全页翻译；图标是唯一常驻接触点（用自身两态表达开 / 关，见 `lib/icon.ts`）。关掉即刻还原原文（原文常驻、瞬时）。**刻意无「临时翻译一次」入口**——只看一次的页面：加域名 → 读 → 关。
- **整页全部可见文字都翻**，正文与界面（导航 / 按钮 / 页脚）在「翻不翻」上一视同仁；藏在属性里的（图片 `alt`、`placeholder`）暂不翻。**但在调度顺序上做结构识别**（见铁律 7）：正文区先翻、外框（导航/页眉/侧栏/页脚）后翻——为响应速度，刻意反转了早期「完全不做正文识别」的取舍。
- **失败段静默保持原文 + 段内「重试翻译」文字按钮**：失败段（模型漏译 / 标记校验不过 / 部分失败）与「还没轮到」视觉无异（不报错、不空块）；译流结束后在该段**内部**追加一个极轻的「重试翻译」按钮（在 `[data-trans-id]` 子树内 → 抽取器天然跳过）。点击带**前后各 2 段上下文**重新请求（走 `bypassCache` 确保上下文真发给模型）。系统性失败（quota / auth）不挂按钮，交 popup 引导登录 / 充值。
- **查看原文**：Ctrl/⌘+点击单段就地粘滞切换中↔英；整页看原文用快捷键 / popup 取消翻译此站（即刻还原、瞬时、无需重译）。
- **出错说人话、分来源**：`errorKind` 区分「网络 / 代理未连通」与「模型接口报错」；`quota` 不是错误而是引导（柔和提示 + 登录 / 充值 CTA，不显示红色报错）。

## 技术栈

TypeScript strict；Chrome **MV3**；[WXT](https://wxt.dev/)（基于 Vite，处理 MV3 样板 / 内容脚本 HMR）；pnpm；popup / options 用 React。存储 `chrome.storage.local`（白名单、匿名 `deviceId`、登录 token、设置）。偏轻量可组合，引入较重依赖前先确认。

## 体验铁律

1. **原文永不销毁。** 替换某块前先存其原始 HTML（`content.ts` 的 `records`）；Ctrl/⌘+点击切换、关站还原、失败降级都靠它。
2. **占位标记校验。** 内联样式以成对 `<g0>…</g0>` / 自闭合 `<x0/>` 标记承载，**styleMap 只在客户端**。收到译文先用 `markers.ts` 校验标记平衡 / 编号合法，再用 `rebuilder.ts` 重建；不通过则该块保持原文。`restoreSoleWrapper` 补回模型整对省略的「最外层唯一内联包装」（超链接坑，见经验库 #7）。
3. **块 ID 稳定**（`data-trans-id`）：用于流式回填 / 切换定位。沉降补抽 / SPA 新路由用 `r{batch}.b{n}` **带点**前缀，故后端 SSE 切块正则须含 `.`。
4. **代码不翻**：抽取跳过代码块；行内代码（如 `fetch()`）保持原样。
5. **全部可见文字都翻**，按 DOM 顺序自上而下抽取。
6. **原文先渲染**：加载即显完整原文，译文到达逐块淡入（短暂过渡，不硬切）。
7. **结构感知调度（正文优先 + 传输分流）**：抽取时 `classifyTier`（`regions.ts`）按最近地标把每块分到正文(`main`/`article`) / 外框(`nav`/`header`/`footer`/`aside`)；background 据此**拆两路并发提交**、正文优先（chrome 等正文首段或兜底延时后再起）。**正文走 SSE**（流式逐块淡入、首屏「秒懂」）、**外框走普通 HTTP**（`/v1/translate/batch` 一次性返 JSON——量小、不在视线焦点，不值一条长连接）；**重试(bypassCache)同走非流式 HTTP**。**例外：纯外框页（content 为空，如导航/着陆页/仪表盘）外框升级走 SSE**——此时外框是用户唯一在看的内容，给回逐块淡入体感。由 `translateByRegion` 的 `makeJob(blocks,h,stream)` 第三参表达，background 据此选 SSE/HTTP 客户端。外框整组失败现与正文一致 onError 上报（popup 弹红+引导，不再静默吞）；两路各自**部分**失败块统一由 content 侧 finalizeJob 挂「重试翻译」。**为什么**：DOM 顶部多是导航，按纯 DOM 顺序翻会让用户在读的正文排在导航后才出；正文先翻才对得起「秒懂」。**这反转了早期「不做正文识别 / 视口优先」原则**——当年为「隐形」刻意不做，现为速度做。无地标的简单页全归正文＝退化回历史 DOM 顺序行为（零回归）。聚合与失败语义见 `translate-cached.ts` 的 `translateByRegion`。

> 模型侧铁律（系统提示词逐字节稳定、关思考、真实 usage、API Key 不暴露）在 `../server`。扩展产物里**不含任何密钥**。

## 数据流

1. **触发**：内容脚本判断当前域名是否在白名单，在则自动运行。SPA 同文档路由跳转由 service worker 的 `webNavigation.onHistoryStateUpdated` 通知 content（`handleSpaNavigation`，epoch 防串扰、seq 保证带前缀 id 唯一）。
2. **抽取**：`extractor.ts` 用 `TreeWalker` 抽块级元素，生成 `<gN>/<xN>` 标记 + styleMap，存原文 HTML；每块经 `regions.ts` `classifyTier` 标上结构层（正文/外框）。
3. **结构分区 + 本地缓存优先 + 请求**：`background.ts`（service worker）按 tier 拆两路、经 `translate-cached.ts` `translateByRegion` **并发提交、正文优先**；每路先查本地 IndexedDB（`local-cache.ts`）：命中块直接回填、**不发服务端**；未命中块才经 `api.ts` 发后端：正文 `translateViaBackend` POST `/v1/translate`（SSE），外框/重试 `translateViaBackendHttp` POST `/v1/translate/batch`（非流式 JSON）——均带 `X-Device-Id`、`pageKey`、`localDate`，登录则带 `Authorization`；校验通过的块写回本地。加密开启时（构建注入 `SERVER_PUBKEY`）source 经 `crypto.ts` 加密为 `ct`、带 `X-Eph-Pub` 头。**网络调用在 SW 发**，不受页面 CSP / CORS 限制。
4. **流式回填**：后端发结构化 SSE 事件（`block {id,translated}` / `done` / `error` / `quota`）；`sse.ts createSseParser` 跨 chunk 累积解析；content 收 `block` → `restoreSoleWrapper` → 校验 → `rebuilder` 重建 → 淡入替换。
5. **失败 / 配额**：`error` / `quota` 经 port 回 content，`errorKind` 透到 popup；`quota` 用柔和样式 + 登录引导，不报红错。

## 模块地图

```
entrypoints/
  content.ts            # 抽取 / 标记 / 流式回填 / Ctrl+点击 / 还原；有界沉降补抽 settleAndReextract +
                        #   SPA 软导航重译 handleSpaNavigation；失败段收尾 finalizeJob + 段内重试 retryBlock
  background.ts         # service worker：port 适配 → 经 translate-cached 调后端；图标两态；webNavigation 软导航监听；埋点；
                        #   onInstalled(reason='install') 打开引导页 welcome.html（更新/重启不弹）
  dom-compat.content.ts # MAIN world / document_start：补丁 removeChild/insertBefore 防崩溃 + 发 hydration 就绪信号
  popup/  options/      # React「素 Quiet」：popup 账号区 + 额度区(GiftBar 未登录领 ¥2/显分桶余额、登录显分桶余额+充值入口跳 options) + 翻译按钮；
                        #   options 管白名单 + 充值卡(Recharge.tsx 登录后：微信扫码档位/¥桶 + Creem $9.9/$桶；轮询到账)
  welcome/              # 首装引导页（welcome.html，整页标签）：三步上手 + 末尾领 ¥2（claimGift）；
                        #   领取门控浏览器标识——getInstanceId() 取不到('')则禁用领取、提示去设置充值
lib/
  api.ts          # translateViaBackend：正文路，调 /v1/translate 消费 SSE；translateViaBackendHttp：外框/重试路，调 /v1/translate/batch 非流式收 JSON；二者同形(ApiClient)、共用 buildTranslateInit(鉴权头/加密/body)+emitBlock(密文解密回填)；带 deviceId/pageKey/Authorization
  local-cache.ts  # 本地译文缓存（IndexedDB）：内容寻址键含语言对；LRU 200MB / 90 天逐出
  translate-cached.ts # 本地优先编排：命中即回不发服务端，未命中发后端、校验通过写回；bypassCache=跳本地整批发（重试带上下文用）；
                  #   translateByRegion=正文/外框两路并发提交、正文优先 + 终态聚合（systemic 错上报/正文失败上报/chrome 非系统失败吞掉）
  auth.ts         # token 持久化 + 注册 / 登录 / 登出 + access 静默刷新
  device.ts       # 匿名 deviceId + getInstanceId(chrome.instanceID，清 storage 免疫，赠送防薅用) + 本地日期 + pageKeyFromUrl（cyrb53，URL 不出本机）
  grant.ts        # 领赠送 ¥2：POST /v1/grant/gift，带 X-Device-Id + X-Instance-Id（防薅）
  recharge.ts     # 充值（须登录）：POST /v1/recharge/create 选微信档位拿二维码 + fetchBalances（分桶）轮询到账
  telemetry.ts    # 打点 / 错误上报（fire-and-forget，只带 host）
  sse.ts          # 纯 SSE 事件解析 createSseParser（跨 chunk 缓冲重扫）
  crypto.ts       # 应用层加密：ECDH(P-256)+HKDF+AES-GCM，钉死服务端公钥 / 会话级临时密钥
  extractor.ts    # TreeWalker 抽块 + 生成 <gN>/<xN> 标记 + styleMap
  regions.ts      # 结构分区 classifyTier（最近地标→正文/外框）+ splitByTier（拆两组，供按区域并发）
  markers.ts      # 标记词法 tokenizeMarkers / validateMarkers / restoreSoleWrapper / allowedIdsFromSource
  rebuilder.ts    # 依 styleMap + tokenize 把带标记译文重建为 DOM
  storage.ts      # 白名单 / 设置（缓存开关）薄封装
  icon.ts         # 工具栏图标两态（off/on，一点开启即 on、不随翻译进度变化）
  config.ts       # BACKEND_URL + SERVER_PUBKEY（空＝明文 dev）+ CREEM_RECHARGE_URL（Creem 充值 link，空＝options 不显美元充值入口）唯一读取处，构建期由 .env 的 WXT_* 注入
  messages.ts     # content ↔ background ↔ popup 协议（含 quota 失败类、StatusReply.errorKind）
  types.ts        # 共享类型（FailureKind 含 'quota'）
design/           # 工具栏图标资产：build-icons.sh 由 icon-src 生成 4 态 × 4 尺寸
```

## 后端契约

`BACKEND_URL` 构建期由 `WXT_BACKEND_URL` 注入。用到的端点：`POST /v1/translate`(SSE，正文)、`POST /v1/translate/batch`(非流式 JSON，外框/重试)、`GET /v1/usage`(返分桶余额 giftCny/cny/usd)、`POST /v1/auth/{register,login,refresh,logout}`、`POST /v1/grant/gift`、`POST /v1/recharge/create`(微信充值)、`POST /v1/events`、`POST /v1/errors`。**改协议须同步 `../server`**（事件名、字段、SSE 格式）。

## 计费 / 充值（统一走平台 key）

翻译统一走平台后端 key、统一计费——**已取消买断与 BYOK（2026-06-19）**：原买断 $9.99 解锁的「自带模型客户端直连」整套（`lib/local-engine/`、`Byok.tsx`、`redeem.ts`、`storage.resolveTranslateRoute`、`config.BUYOUT_URL`、金标向量 `test-vectors/` 与 `.test-local-engine.mjs`）全部删除。

**额度三桶 + 充值（详见 `../server/CLAUDE.md` 额度模型）**：余额分 `giftCny`（赠送·人民币）/ `cny`（充值·人民币）/ `usd`（充值·美元）三桶，扣费优先级 `赠送 → 人民币 → 美元`、按桶币种计价不换汇。前端只展示与引导：

- **赠送 ¥2**：popup GiftBar / welcome 页 `claimGift`（`/v1/grant/gift`，instanceID 防薅）。
- **微信充值（人民币桶）**：options `Recharge.tsx` 选档位 ¥10/30/68 → `/v1/recharge/create` 拿二维码 → 轮询 `fetchBalances` 到账。
- **Creem 充值（美元桶，$9.9）**：options `Recharge.tsx` 跳 `CREEM_RECHARGE_URL`（Creem 静态 payment link，`WXT_CREEM_RECHARGE_URL` 注入）外开支付；**须用注册邮箱付款**（webhook 凭邮箱匹配账户入账），回页后轮询美元桶到账。
- **余额展示**：popup `balanceParts` / options `balanceText` —— 各桶 >0 才列（如「赠送 ¥1.80 · $9.90」），赠送用光即不再显示「赠送余额」。

## 已知坑（详见经验库《[../翻译问题记录.md](../翻译问题记录.md)》）

- **React / Next.js 站点（如 react.dev）**：直接改 DOM 与 React 协调冲突曾致 `removeChild` 崩溃。两道防线：`dom-compat.content.ts` 补丁消致命崩溃 + 推迟到 hydration 后再抽取注入。把 hydration 延迟 / 流式到 `load` 后的站仍有**可恢复**的 #418/#425。
- 主要处理加载时已有内容；例外是**有界沉降补抽**（最多 5 轮、每轮 1200ms）+ **SPA 软导航重译**。**不上常驻 MutationObserver**。
- **缓存=客户端本地**：译文存 IndexedDB（内容寻址，键含语言对），命中不发服务端、不扣额度；动态变化块标记不同 → 键不同 → 重译（属正确行为）。

## 编码约定与命令

- TS strict；小而专注、可组合模块；抽取 / 标记校验 / SSE 解析三处易错点写中文注释。
- 命令（在 `front/` 下）：`pnpm dev`（HMR）/ `pnpm build`（产物 `output/chrome-mv3`，作解包扩展加载）/ `pnpm compile`（`tsc --noEmit`，**提交前必跑**）/ `pnpm zip`。
- **验证**：纯函数（markers / 切块 / sse / pageKey）用一次性 `node .test-*.mjs` 脚本单测；端到端用 Chrome DevTools（调试 Chrome 开 `:9222`）连扩展 SW——注意 background 发的请求在页面 network 看不到，要去 SW 上下文查。
- **全站回归**：语料见《[../测试网站清单.md](../测试网站清单.md)》（150 站），结果汇总进《[../测试运行记录.md](../测试运行记录.md)》，❌ 转经验库立案。改抽取 / 标记 / 重建后据此回归。

## 平台范围：只有浏览器扩展

**现状即终态（当前规划内）：前端只有浏览器扩展（Chrome / Edge MV3），没有 iOS / Android 客户端，也没有在做。** 多端（手机 app / Safari 扩展）不是路线图，别按「三端」假设设计或抽层。

> 备忘（仅供日后万一重提，非计划）：真要上手机端，没有「一套代码同时出扩展 + app」——宿主环境（`chrome.*` vs 原生 / WebView）跨不了，能共用的只有业务逻辑；前置是先把翻译逻辑（extractor / markers / rebuilder / api / cache / crypto / device）抽成平台无关 `core`。**在没有明确决策前不要为此做任何抽层 / 改目录。**
