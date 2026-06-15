# admin/CLAUDE.md —— Next.js 管理台

本目录是「秒懂翻译 / aha translate」管理台，连后端 `/admin/*` 做运营。仓库总览见 [`../CLAUDE.md`](../CLAUDE.md)，后端见 [`../server/CLAUDE.md`](../server/CLAUDE.md)。

---

## 技术栈

- **Next.js 14（App Router）+ React 18 + TypeScript**。
- **精简原生组件实现**（不引 shadcn/ui、Tremor、TanStack——降安装 / 构建面与风险；产品设计里它们是推荐项，此处记为有意偏差，后续可叠加）。原生 `fetch` + 轻量表格 / 卡片 + 一份全局 CSS。
- 包管理 pnpm；**registry 用 npmmirror**（`admin/.npmrc`，npm 直连被墙）。装依赖遇代理报错时命令前清 `*PROXY*` 环境变量。

## 结构

```
app/
  layout.tsx        # 根布局 + 顶部导航（概览/用户/错误日志/API Key/登录）
  globals.css       # 全局样式（素净、青绿强调，与扩展同色系）
  login/page.tsx    # 'use client'：邮箱密码 → POST /admin/login → 存 token → 跳 /
  page.tsx          # 概览：/admin/stats（用户/翻译/错误/Token 卡片 + Top 域名）
  users/page.tsx    # /admin/users（邮箱/今日 token/档位/注册）
  logs/page.tsx     # /admin/errors（时间/类型/消息/用户）
  keys/page.tsx     # /admin/keys（label/脱敏 key/状态 + 添加 + 启停 PATCH）
lib/api.ts          # API 封装：localStorage 存 imt_admin_token，自动带 Authorization；401 清 token 跳 /login；base 用 NEXT_PUBLIC_API（缺省 http://localhost:8000）
```

## 鉴权

- 管理员**独立于终端用户**：后端 `admins` 表 + JWT `scope:admin`（`server/app/core/security.py create_admin_token`）。
- 建管理员（在 `../server`）：`uv run python scripts/create_admin.py <email> <password>`。
- 登录页直接 fetch `/admin/login`（不过 `api()` 包装，避免 401 重定向回环）；其余页用 `api()`，401 自动清 token 跳 `/login`。

## 后端契约

`GET /admin/stats` · `GET /admin/users` · `GET /admin/errors` · `GET /admin/events` · `GET|POST /admin/keys` · `PATCH /admin/keys/{id}` · `POST /admin/login`。
**上游 Key 全程脱敏**：列表 / 创建只回 `masked`（末 4 位），绝不回完整 key（呼应「Key 不在 UI 暴露」）。改协议须同步 `../server` 的 `app/routers/admin.py`。

## 命令

- 开发：`pnpm dev`（:3001）；构建（即类型检查，作为验证）：`pnpm build`；类型：`pnpm typecheck`。
- 联调：先起后端 `:8000` + 建管理员；`NEXT_PUBLIC_API` 指后端（默认 localhost:8000，可在 `.env.local` 覆盖）。localhost 在调试 Chrome 内可达。

## 注意

- 提交前跑 `pnpm build`（覆盖类型检查 + 6 路由构建）。
- 不在前端存任何上游密钥；管理员 token 仅存 localStorage。
- 样式走原生 CSS，新增页面复用 `globals.css` 既有类（`.card`/`.stat`/`table`/`.row` 等）。
