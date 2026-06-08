# P8 上架准备 Implementation Plan

> REQUIRED SUB-SKILL: superpowers:executing-plans（Inline）。

**Goal:** 备齐 Chrome/Edge 上架材料：隐私政策、权限用途说明、商店文案/素材清单，并记录端到端回归口径。

**Architecture:** 纯文档交付（仓库根新增 `隐私政策.md`、`上架材料.md`）。代码层只做最终 sanity（后端 pytest + 客户端 compile/build）。

**约定：** commit 中文 + Co-Authored-By。

---

## Task 1: 隐私政策

**Files:** `隐私政策.md`(新)

- [ ] 写 `隐私政策.md`：收集了什么（账号邮箱、匿名 device id、打点仅 host+计数、为翻译发送的页面文本与缓存、每用户 Token 用量）、用途、第三方（DeepSeek）、保留与删除、不做什么（不卖数据、不存完整 URL/正文超出翻译所需）、联系方式。中文为主，注明上架需英文版。
- [ ] Commit — `P8: 隐私政策`

## Task 2: 上架材料 + 权限说明

**Files:** `上架材料.md`(新)

- [ ] 写 `上架材料.md`：商店名称/简介/详细描述/类目/语言；逐项权限用途说明（storage/commands/webNavigation/host_permissions）；素材清单（图标已有、截图 1280×800 待出）；隐私政策 URL 占位；Chrome/Edge 提交注意（账号体系需声明数据用途）。
- [ ] Commit — `P8: 上架材料 + 权限用途说明`

## Task 3: 回归口径 + 最终 sanity + 合并

- [ ] 后端全量 `cd server && uv run pytest -q`（全绿）。
- [ ] 客户端 `pnpm compile` + `node .test-*.mjs`；`admin` `pnpm build`。
- [ ] 在 `上架材料.md` 记录端到端回归口径（引用 [`测试网站清单.md`] 150 站；P1 流水线等价已验；上架前建议跑一轮全站回归汇总进 [`测试运行记录.md`]）。
- [ ] 合并 main，删分支。

---

## Self-Review
- 覆盖设计 P8：隐私政策、权限说明、商店材料、回归口径。
- 截图需真机出图（autonomous 无法生成），列为待办；其余材料齐备。
