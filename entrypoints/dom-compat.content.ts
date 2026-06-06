// MAIN world 兼容补丁：让 removeChild / insertBefore 容忍"目标已不在原处"。
//
// 背景：本扩展会替换页面 DOM（把英文块换成中文）。React / Next.js 等框架的虚拟 DOM 仍持有
// 被替换掉的原节点引用，等它在协调（commit）阶段提交删除时会调用 parentNode.removeChild(原节点)，
// 而该节点已被我们移除 → 抛 NotFoundError；该异常在 commit 阶段未被捕获，触发组件错误边界，
// 进而级联成整页崩溃（"client-side exception"）。开启缓存 + 关闭思考后翻译注入极快，常常正好与
// React hydration / 重渲染撞车，于是稳定复现。
//
// 修法（业界对"翻译类扩展使 React 崩溃"的通用做法）：在 React 之前（document_start、MAIN world）
// 把这两个原生方法改成——目标不在当前父节点时静默退化，而不是抛错。
// 对正常页面零行为影响：仅在原本就会抛 NotFoundError 的边界情况下才生效。

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    const w = window as unknown as { __imtDomPatched?: boolean };
    if (w.__imtDomPatched) return;
    w.__imtDomPatched = true;

    const origRemoveChild = Node.prototype.removeChild;
    Node.prototype.removeChild = function (this: Node, child: any) {
      if (child && child.parentNode !== this) {
        // 目标已不在此处（被翻译替换 / 移动）：静默 no-op，避免抛错崩溃。
        return child;
      }
      return origRemoveChild.call(this, child);
    } as typeof Node.prototype.removeChild;

    const origInsertBefore = Node.prototype.insertBefore;
    Node.prototype.insertBefore = function (this: Node, newNode: any, referenceNode: any) {
      if (referenceNode && referenceNode.parentNode !== this) {
        // 参考节点已失效：退化为追加，避免抛错。
        return origInsertBefore.call(this, newNode, null);
      }
      return origInsertBefore.call(this, newNode, referenceNode);
    } as typeof Node.prototype.insertBefore;

    // —— 通知内容脚本"可以开始注入了"：尽量把翻译推迟到 React hydration 之后 ——
    // 内容脚本据此信号才抽取并回填译文。在 hydrate 期间换文本会引发 React #418/#425（hydration
    // 文本不匹配，可恢复告警）。本实现用「load + requestIdleCallback」近似「hydration 已完成」：
    // 多数站（react.dev / docusaurus.io / redux / vue / nextjs 等）的 hydration 在此之前完成，0 告警。
    //
    // 已知不足（2026-06-06 实测，见 翻译问题记录.md #3）：部分站把 hydration **延迟/流式**到
    // load 之后（Jest / Webpack / Stripe / DigitalOcean / HackerNoon），此信号仍早于其 hydration，
    // 残留 #418；个别 SPA（MongoDB 文档）正文渲染更晚，抽取期为空导致 ext=0。
    // 试过「等 MutationObserver 持续静默再发信号」想覆盖延迟 hydration——实测**无效且有害**：
    // 目标站的 hydration 发生在静默窗口之后没被等到，反而把原本干净的 firecrawl 推进其 hydration 窗口
    // 而新增 #418，并给每页加 ~500ms 延迟。故保留这个简单快速的版本。这些 #418/#425 可恢复、页面仍
    // 正确译出；真正致命的 removeChild 崩溃由上面的方法补丁单独兜住，不依赖此信号时机。
    //
    // 本脚本在 React 同一世界（MAIN）跑，通过共享 DOM（属性 + 事件）把信号传给 isolated 世界的
    // 内容脚本——跨世界的 DOM 事件可被对方监听，属性更是共享，双保险。
    const signalReady = () => {
      document.documentElement.setAttribute('data-imt-ready', '1');
      document.dispatchEvent(new CustomEvent('imt-ready'));
    };
    const scheduleReady = () => {
      const idle = () => {
        if ('requestIdleCallback' in window) {
          window.requestIdleCallback(signalReady, { timeout: 2000 });
        } else {
          setTimeout(signalReady, 200);
        }
      };
      if (document.readyState === 'complete') idle();
      else window.addEventListener('load', idle, { once: true });
    };
    scheduleReady();
  },
});
