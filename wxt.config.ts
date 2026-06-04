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
    permissions: ['storage', 'activeTab', 'scripting', 'commands'],
    host_permissions: ['<all_urls>', 'https://api.deepseek.com/*'],
    action: {
      default_title: '沉浸式翻译',
    },
    commands: {
      'toggle-flip': {
        // 注意：Ctrl+A 与浏览器原生"全选"冲突，网页常会先吞掉事件。
        // 若实际按下无效，可在 chrome://extensions/shortcuts 改成其他组合。
        suggested_key: {
          default: 'Ctrl+A',
          mac: 'Command+A',
        },
        description: '整页在中文 / 英文之间瞬间翻面',
      },
    },
  },
});
