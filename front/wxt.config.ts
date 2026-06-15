import { defineConfig } from 'wxt';

// WXT 配置：见 https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: '.',
  outDir: 'output',
  manifest: {
    name: '沉浸式翻译（DeepSeek V4 Flash）',
    description: '把英文网页整页翻译成中文：原文先垫、流式逐块替换。',
    version: '0.1.0',
    // webNavigation：监听 SPA 同文档导航（pushState/replaceState），对新路由触发翻译。
    permissions: ['storage', 'commands', 'webNavigation'],
    // 客户端不再直连 DeepSeek；后端 fetch 走 <all_urls>（含 http://localhost 开发后端）。
    host_permissions: ['<all_urls>'],
    // 默认（未开启）图标：橙色双气泡「A / 文」主图。已开启 / 翻译中 / 出错时由
    // background 运行时换成 on-*/translating-*/error-*（右下角烤入角标）。
    // 图标文件在 public/icon/，由 design/build-icons.sh 生成，构建后位于扩展根。
    icons: {
      16: 'icon/16.png',
      32: 'icon/32.png',
      48: 'icon/48.png',
      128: 'icon/128.png',
    },
    action: {
      default_title: '沉浸式翻译',
      default_icon: {
        16: 'icon/16.png',
        32: 'icon/32.png',
        48: 'icon/48.png',
        128: 'icon/128.png',
      },
    },
    commands: {
      'toggle-site': {
        // Alt+Shift 组合不与"全选"等常用快捷键冲突，网页也极少拦截 Alt 系组合。
        // 用户仍可在 chrome://extensions/shortcuts 自行改键。
        suggested_key: {
          default: 'Alt+Shift+A',
          mac: 'Command+Shift+A',
        },
        description: '翻译 / 取消翻译此网站',
      },
    },
  },
});
