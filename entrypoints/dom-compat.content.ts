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
  },
});
