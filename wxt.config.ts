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
    permissions: ['storage', 'commands'],
    host_permissions: ['<all_urls>', 'https://api.deepseek.com/*'],
    // 默认（未开启）图标：素方案的灰色双线。已开启时由 background 运行时
    // 换成 on-*（下线灌桃红）。图标文件在 public/icon/，构建后位于扩展根。
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
