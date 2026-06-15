# CLAUDE.md（仓库总览）

本仓库是「秒懂翻译 / aha translate」（原名「沉浸式翻译」）从自用扩展演进为可上架产品的 **monorepo**：浏览器扩展 + FastAPI 后端 + Next.js 管理台。
本文件是**仓库级**开发基准；每个子项目另有自己的 `CLAUDE.md`，**改哪块就先读哪块的**。

---

## 仓库布局

- **`front/`** —— 浏览器扩展（Chrome / Edge MV3，WXT + TS + React）。**只碰 DOM**：抽取 / 标记 / 重建 / 还原 + 调后端 API。详见 [`front/CLAUDE.md`](front/CLAUDE.md)。
- **`server/`** —— FastAPI + PostgreSQL 后端。拥有「翻译这件事」的全部业务：密钥 / 提示词 / 模型调用 / 标记校验 / 账号 / 配额 / 限流 / Token 记账 / 额度扣费 / 收单签码 / 应用层加密 / 打点 / 管理 API（服务端不再缓存译文，D-11）。详见 [`server/CLAUDE.md`](server/CLAUDE.md)。
- **`admin/`** —— Next.js 管理台，连后端 `/admin/*` 看统计 / 用户 / 日志 / 上游 Key。详见 [`admin/CLAUDE.md`](admin/CLAUDE.md)。
- **`docs/`** —— 设计与分阶段实现计划：`docs/superpowers/plans/2026-06-08-p*.md`（P0–P8 后端基座→上架）+ `2026-06-14-*.md`（D-11~D-18：服务端去缓存 / 前端本地缓存 / 全文 token 预算分批 / 应用层加密 / credits 账本与扣费 / Creem 收单）。
- **根级文档**（均为「非代码描述」的独立档，理由见下「文档纪律」）：经验库《[翻译问题记录.md](翻译问题记录.md)》、测试语料《[测试网站清单.md](测试网站清单.md)》与《[测试运行记录.md](测试运行记录.md)》、上架《[隐私政策.md](隐私政策.md)》《[上架材料.md](上架材料.md)》。产品 / 体验设计基准已并入各 `CLAUDE.md`（front 的「体验设计基准」、server 的「为什么服务端化」）。

---

## 整体架构（一句话）

扩展（`front`）抽取页面可见文本 → **先查本地 IndexedDB 缓存（命中不发服务端、不计费，D-11b）** → 未命中块经 service worker **SSE** 调后端 `/v1/translate` → 后端**去重 / 按 token 预算分批 / 标记校验 / Token 记账**后调 DeepSeek（关思考、稳定前缀；服务端不再缓存译文，D-11a）→ 流式回 `{id, 译文}` → 扩展校验标记、重建 DOM、淡入替换、写回本地缓存。**可选应用层加密**（D-13：带 `X-Eph-Pub` 头则原文/译文走 `ct` 密文）。
账号（邮箱+密码 JWT）、匿名「每页一次 / 每天 3 页」配额、登录免页数限制、Token 记账、梯度限流、**付费用户按实耗扣 credits（有账户即付费模式、余额门控且跳限流，休眠至首充）**、买断收单幂等签发注册码、打点 / 错误上报——**全部在后端**；管理台读后端做运营。

---

## 跨子项目约定

- **职责边界**：客户端只做 DOM + 本地译文缓存（IndexedDB，D-11b）；密钥、提示词、模型调用、记账、扣费、限流全部在 `server`（服务端不缓存译文，D-11a）。`styleMap`（占位编号→原始内联元素）只存客户端，发后端的是带 `<gN>` 标记的文本（加密开启时再包成 `ct`）。
- **本地起开发环境**：仓库根 `./dev.sh`（tmux 三窗格起 server:8000 / admin:3001 / front WXT；`./dev.sh server admin` 起子集；需先 `brew install tmux`；server 仍依赖 `server/.env` + Postgres 已起）。
- **密钥**：DeepSeek Key 只在 `server/.env`（gitignore），**绝不进扩展产物、绝不入日志 / 事件**。
- **网络（作者在国内，pypi / npm 直连受限）**：`server` 的 uv 用清华镜像（`server/pyproject.toml` 的 `[[tool.uv.index]]`）、`admin` 的 pnpm 用 npmmirror（`admin/.npmrc`）；装依赖遇代理报错时，命令前清 `*PROXY*` 环境变量（`env -u ALL_PROXY -u HTTP_PROXY -u HTTPS_PROXY …`）。DeepSeek 直连可达，后端 httpx 用 `trust_env=False` 绕开个人 SOCKS 代理。
- **提交前各自验证**：`front` 跑 `pnpm compile`、`server` 跑 `uv run pytest`、`admin` 跑 `pnpm build`。
- **本次重构的来龙去脉**见各子项目 `CLAUDE.md` 的「为什么」段与 `docs/superpowers/plans/`（P0 后端基座 → P8 上架 + D-11~D-18 商业化）。
- 修「某页面翻译出问题」前先查经验库《翻译问题记录.md》同类前例，修完回填。
- **文档纪律（防代码↔文档脱节）**：架构 / 设计 / 决策 / 「为什么」一律写进**离代码最近的 `CLAUDE.md`**（每次会话加载、随代码同改、唯一权威），不再另开分散的设计文档。独立 `.md` 只留**非代码描述**之物：活档（经验库）、测试语料 / 记录、对外法务 / 上架材料、带日期的一次性计划（`docs/superpowers/plans/`，写完即冻结、不回改）。**脱节根因**＝同一事实两处来源、且设计文档离代码远、改代码时没有同改触发器；CLAUDE.md 因被反复加载 + 就地编辑而能持续自纠。新增「为什么/设计决策」就近补进对应 CLAUDE.md，别再起独立文档。
```
