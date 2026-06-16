# CLAUDE.md（仓库总览）

「秒懂翻译 / aha translate」（原名「沉浸式翻译」）—— 一个把英文网页整页翻成中文的浏览器扩展，正从自用工具演进为可上架产品。本仓库是 **monorepo**：扩展 + 后端 + 管理台。

本文件是**仓库级**基准；每个子项目另有自己的 `CLAUDE.md`，**改哪块先读哪块的**。

## 仓库布局

- **`front/`** —— 浏览器扩展（Chrome / Edge MV3，WXT + TS + React）。**只碰 DOM**：抽取 / 标记 / 重建 / 还原 + 调后端 API，**不持有任何密钥**。见 [`front/CLAUDE.md`](front/CLAUDE.md)。
- **`server/`** —— FastAPI + PostgreSQL 后端，拥有「翻译这件事」的全部业务：密钥 / 提示词 / 模型调用 / 标记校验 / 账号 / 配额 / 限流 / Token 记账 / 额度扣费 / 收单 / 应用层加密 / 打点 / 管理 API。见 [`server/CLAUDE.md`](server/CLAUDE.md)。
- **`admin/`** —— Next.js 管理台，连后端 `/admin/*` 看统计 / 用户 / 日志 / 上游 Key。见 [`admin/CLAUDE.md`](admin/CLAUDE.md)。

根级还有几份**非代码描述**的独立文档：经验库《[翻译问题记录.md](翻译问题记录.md)》、测试语料《[测试网站清单.md](测试网站清单.md)》《[测试运行记录.md](测试运行记录.md)》、上架材料《[隐私政策.md](隐私政策.md)》《[上架材料.md](上架材料.md)》。

## 整体数据流

扩展抽取页面可见文本 → 先查**本地 IndexedDB 缓存**（命中不发服务端、不计费）→ 未命中块经 service worker 以 **SSE** 调后端 `/v1/translate` → 后端**去重 / 按 token 预算分批 / 标记校验 / Token 记账**后调 DeepSeek（关思考、稳定前缀）→ 流式回 `{id, 译文}` → 扩展校验标记、重建 DOM、淡入替换、写回本地缓存。

账号（邮箱+密码 JWT）、匿名配额（每页一次 / 每天 3 页）、登录免页数限制、Token 记账、梯度限流、付费扣费（credits）、买断收单、打点 —— **全部在后端**。服务端**不留存用户译文**（隐私），缓存只在客户端本地。可选**应用层加密**：带 `X-Eph-Pub` 头时原文 / 译文走 `ct` 密文。

## 跨子项目约定

- **职责边界**：客户端只做 DOM + 本地译文缓存；密钥、提示词、模型调用、记账、扣费、限流全在 `server`。`styleMap`（占位编号 → 原始内联元素）只存客户端，发后端的是带 `<gN>` 标记的文本（加密开启时再包成 `ct`）。
- **改协议须两端同步**：SSE 帧格式、事件名、字段、API 端点——`front` 与 `server` 任一改动，另一端同改。
- **密钥**：DeepSeek Key 只在 `server/.env`（gitignore），**绝不进扩展产物、绝不入日志 / 事件**。
- **本地开发**：仓库根 `./dev.sh`（tmux 三窗格起 server:8000 / admin:3001 / front WXT；`./dev.sh server admin` 起子集；需 `brew install tmux`、`server/.env` + Postgres 已起）。
- **提交前各自验证**：`front` 跑 `pnpm compile`、`server` 跑 `uv run pytest`、`admin` 跑 `pnpm build`。
- **网络（作者在国内，直连受限）**：`server` 的 uv 用清华镜像、`admin` 的 pnpm 用 npmmirror；装依赖遇代理报错时命令前清 `*PROXY*` 环境变量（`env -u ALL_PROXY -u HTTP_PROXY -u HTTPS_PROXY …`）。DeepSeek 直连可达，后端 httpx 用 `trust_env=False` 绕开个人 SOCKS 代理。
- 修「某页面翻译出问题」前先查经验库《翻译问题记录.md》同类前例，修完回填。

## 文档纪律（防代码↔文档脱节）

架构 / 设计 / 决策 / 「为什么」一律写进**离代码最近的 `CLAUDE.md`**——它每次会话加载、随代码同改、是唯一权威，不再另开分散的设计文档。独立 `.md` 只留**非代码描述**之物：活档（经验库）、测试语料 / 记录、对外法务 / 上架材料。新增「为什么 / 设计决策」就近补进对应 `CLAUDE.md`。
