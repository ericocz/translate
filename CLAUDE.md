# CLAUDE.md（仓库总览）

本仓库是「沉浸式翻译」从自用扩展演进为可上架产品的 **monorepo**：浏览器扩展 + FastAPI 后端 + Next.js 管理台。
本文件是**仓库级**开发基准；每个子项目另有自己的 `CLAUDE.md`，**改哪块就先读哪块的**。

---

## 仓库布局

- **`front/`** —— 浏览器扩展（Chrome / Edge MV3，WXT + TS + React）。**只碰 DOM**：抽取 / 标记 / 重建 / 还原 + 调后端 API。详见 [`front/CLAUDE.md`](front/CLAUDE.md)。
- **`server/`** —— FastAPI + PostgreSQL 后端。拥有「翻译这件事」的全部业务：密钥 / 提示词 / 缓存 / 模型调用 / 标记校验 / 账号 / 配额 / 限流 / Token 记账 / 打点 / 管理 API。详见 [`server/CLAUDE.md`](server/CLAUDE.md)。
- **`admin/`** —— Next.js 管理台，连后端 `/admin/*` 看统计 / 用户 / 日志 / 上游 Key。详见 [`admin/CLAUDE.md`](admin/CLAUDE.md)。
- **`docs/`** —— 设计与分阶段实现计划（`docs/superpowers/plans/2026-06-08-p*.md`，P0–P8）。
- **根级文档**：产品设计《[产品设计-服务端化与账号体系.md](产品设计-服务端化与账号体系.md)》、体验设计《[沉浸式翻译插件-用户体验设计.md](沉浸式翻译插件-用户体验设计.md)》、经验库《[翻译问题记录.md](翻译问题记录.md)》、测试语料《[测试网站清单.md](测试网站清单.md)》与《[测试运行记录.md](测试运行记录.md)》、上架《[隐私政策.md](隐私政策.md)》《[上架材料.md](上架材料.md)》。

---

## 整体架构（一句话）

扩展（`front`）抽取页面可见文本 → service worker 经 **SSE** 调后端 `/v1/translate` → 后端**缓存优先 / 去重 / 分批 / 标记校验 / Token 记账**后调 DeepSeek（关思考、稳定前缀）→ 流式回 `{id, 译文}` → 扩展校验标记、重建 DOM、淡入替换。
账号（邮箱+密码 JWT）、匿名「每页一次 / 每天 3 页」配额、登录免页数限制、Token 记账（缓存命中也计）、梯度限流、打点 / 错误上报——**全部在后端**；管理台读后端做运营。

---

## 跨子项目约定

- **职责边界**：客户端只做 DOM；密钥、提示词、缓存、模型调用、记账、限流全部在 `server`。`styleMap`（占位编号→原始内联元素）只存客户端，发后端的是带 `<gN>` 标记的文本。
- **本地起开发环境**：仓库根 `./dev.sh`（tmux 三窗格起 server:8000 / admin:3001 / front WXT；`./dev.sh server admin` 起子集；需先 `brew install tmux`；server 仍依赖 `server/.env` + Postgres 已起）。
- **密钥**：DeepSeek Key 只在 `server/.env`（gitignore），**绝不进扩展产物、绝不入日志 / 事件**。
- **网络（作者在国内，pypi / npm 直连受限）**：`server` 的 uv 用清华镜像（`server/pyproject.toml` 的 `[[tool.uv.index]]`）、`admin` 的 pnpm 用 npmmirror（`admin/.npmrc`）；装依赖遇代理报错时，命令前清 `*PROXY*` 环境变量（`env -u ALL_PROXY -u HTTP_PROXY -u HTTPS_PROXY …`）。DeepSeek 直连可达，后端 httpx 用 `trust_env=False` 绕开个人 SOCKS 代理。
- **提交前各自验证**：`front` 跑 `pnpm compile`、`server` 跑 `uv run pytest`、`admin` 跑 `pnpm build`。
- **本次重构的来龙去脉**见《产品设计-服务端化与账号体系.md》与 `docs/superpowers/plans/`（P0 后端基座 → P8 上架准备）。
- 修「某页面翻译出问题」前先查经验库《翻译问题记录.md》同类前例，修完回填。
```
