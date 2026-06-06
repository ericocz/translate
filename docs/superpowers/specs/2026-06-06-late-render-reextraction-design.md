# 设计：晚渲染 SPA 的有界「沉降-补抽」（修 ext=0）

- 日期：2026-06-06
- 关联：[`翻译问题记录.md` #3](../../../翻译问题记录.md)（MongoDB 文档 ext=0 的功能性缺口）
- 状态：✅ 已实现并端到端验证通过（2026-06-06）
- 实现：`entrypoints/content.ts`（`extractInto` / `settleAndReextract` / `waitForIdle` + openPortAndStart 加 `port===p` 守卫 + state.translating 防重入）
- 验证结果：MongoDB `/docs/manual/` 与 `/docs/manual/introduction/` 由 `ext=0` → **172/172 全译**；回归 MDN(684 不变)/react.dev(202)/Docusaurus(#1 logo 32×32)/firecrawl(#2 无竖排) 行为不变、`reextractIds=0`（正常站 no-op）、无重复翻译；`pnpm compile` 通过。

## 问题

部分 SPA（实测 **MongoDB 文档** `www.mongodb.com/docs/manual/`）首屏正文是客户端**渐进渲染**，晚于内容脚本的抽取时机：

- 实测时间线（reload 后原始可翻块级元素数）：`t0=8 → t1-5≈52~55 → t6=116`，~6-7s 才稳；`readyState` 长时间停在 `interactive`，`load` 迟迟不触发。
- 内容脚本当前**只抽一次**（`waitForHydration()` 后 `runTranslation()`，8s 绝对兜底）。抽取时机正好卡在内容渲染窗口边缘 → 有时抽到 0（`ext=0` 整页不翻），有时抽到部分。
- 已确认**内容在光 DOM、无 shadow DOM、无 iframe**（shadowHosts=0）——所以是**纯时序**问题，重抽可救。

不在范围：shadow DOM 内容（Reddit 类，另一类限制）；已抽块被 SPA 重渲染打回英文（#29 Reddit 实测未发生）。

## 方案（A：有界「沉降-补抽」循环）

只改 `entrypoints/content.ts`；**不碰** `extractor.ts` / 标记协议 / 缓存 / `prompt.ts`。

利用现有事实：`extractBlocks` 的 `acceptNode` 会 `FILTER_REJECT` 掉 `[data-trans-id]` 子树 → **重跑 `extractBlocks` 只会返回新出现的块**。

### 流程

1. `waitForHydration()` → 初次抽取+翻译（与现状一致，原文已垫着）。
2. **沉降循环**（初译后）：最多 `MAX_ROUNDS=5` 轮，每轮 `await sleep(1200)` 后重抽：
   - 重抽得到的新块 append 进 `state.records`（**不 `clear`**）。
   - 某轮新块数 `=== 0` → 判定已稳，**跳出**。
   - 累积所有晚到块。
3. 循环结束后，若有累积的晚到块：等当前 port job 结束（`state.running===false`，避免 `openPortAndStart` 互相 disconnect 取消在途任务），再用**一个** port job 串行补译这些晚到块。

### 关键性质

- **正常站零影响**：第 1 轮就 0 新块 → 立即跳出（仅一次额外 `extractBlocks`，可忽略，且在初译之后、不阻塞首屏）。
- **MongoDB（初抽 0）**：循环跟到内容稳（~6-7s），补译那批块。
- **有界自限**：`MAX_ROUNDS=5` + 单轮间隔 1200ms（总 ≤ ~6-8s）；长轮询/动态站最多 5 轮即停——直接回应 CLAUDE.md 当初不上 MutationObserver 的「跑飞」顾虑。
- **不重复翻译**：extractBlocks 跳过已认领子树；records 按 id 去重。
- **晚到块一次性补译**（非流式）：本就是晚内容，可接受。
- **不并发 port**：补译在初译 job 完成后串行发起。

## 组件 / 改动

`entrypoints/content.ts`：

- 新增 `extractInto(): {id,source}[]` —— 跑 `extractBlocks(document.body)`，把**新块** append 进 `state.records`（沿用现有 BlockRecord 结构与 originalHTML 保存），返回新块。**不** clear。
  - **关键：id 冲突处理**。`extractBlocks` 内部 `let nextId = 1` 每次调用都从 `b1` 重新编号，重抽会和上轮 id 撞、覆盖 records 且让两个元素带同一 `data-trans-id`。故在 content.ts 按**轮次前缀重打 id**：第 0 轮用原 `b{n}`；第 ≥1 轮把块改写为 `r{round}.b{n}` 并 `root.dataset.transId = uid`。这样 records 唯一、`closest('[data-trans-id]')` 去重与 Ctrl+点击查找都正确。**不改 extractor.ts**。
- `runTranslation()` 改为：首轮调用 `extractInto()` 拿到初始块 → 若 >0 则 `openPortAndStart`；**去掉**「`blocks.length===0` 直接 return」的早退（改由沉降循环兜底）。
- 新增 `settleAndReextract()` —— 实现上面的有界循环 + 串行补译；在 `main()` 里 `await runTranslation()` 后调用。
- 常量：`const MAX_ROUNDS = 5, ROUND_INTERVAL = 1200;`

## 数据流

DOM（光）→ `extractBlocks`（跳过已认领）→ 新 BlockRecord 入 `state.records` → port `start` → background/translator → `block` 回填 → 淡入替换。沉降循环只是把这条链在初译后再触发几次、仅处理新块。

## 错误 / 边界

- 初抽 0 且内容始终不出现（纯图页/空页）：5 轮均 0 新块 → 跳出，无补译。成本 = 5 次空抽取（有界）。
- 循环期间用户 Ctrl+点击/popup 关站：沿用现有 `cancelStream`/`restoreAllEnglish`；晚到补译前检查 `state.mode`/白名单仍有效。
- 补译 job 与初译 job 串行（等 `running===false`），不互相取消。

## 测试

1. **纯函数单测不可行（已验证）**：试用 linkedom 测"重抽只返回新块"——linkedom 的 `TreeWalker` **不支持 `FILTER_REJECT`**（探针：本应跳过的子树仍被访问），无法模拟 extractor 靠 `closest('[data-trans-id]')→FILTER_REJECT` 跳已认领子树的核心机制。`dataset/closest` 在 linkedom 正常，但 TreeWalker 是死穴。故此机制**只能端到端验证**（真实浏览器 FILTER_REJECT 正常）。
2. **端到端**（chrome-devtools，本项目对 DOM/时序集成的既定验证方式）：
   - **MongoDB** `www.mongodb.com/docs/manual/`：修复前 `ext=0` → 修复后有译出（沉降循环补到晚渲染内容）。
   - **回归**：MDN / react.dev / Docusaurus(#1 logo 32×32 wrapper 在) / firecrawl(#2 无竖排) —— 正常站第 1 轮即 0 新块、不触发补译、行为与现状一致；无重复翻译（块数不异常翻倍）。
3. `pnpm compile` 通过。

## YAGNI / 未来扩展点

- 触发判据将来要"广版"（处理"已抽部分、还差很多"或持续观察）只需改循环条件 / 加触发门槛，`extractInto` 可复用。
- MongoDB 类站的补译延迟（~6-7s）可接受；若要更快可让循环在"块数稳定"而非"固定轮次"时提前停（当前 0-新块即停已是此意）。
