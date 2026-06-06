// 重建器：把模型返回的带标记译文重建为 DOM 片段。
//
// 输入：translated（已通过 validateMarkers），styleMap（编号→原始元素克隆）。
// 输出：DocumentFragment，调用方负责清空目标节点后 append。
//
// 词法解析复用 markers.tokenizeMarkers——与校验同一套语法，不会再出现"校验和重建
// 对同一串标记理解不一致"的历史 bug。这里只做"按 token 装配 DOM"：
//   open  → 克隆原始内联元素的空壳，压栈接收后续文字 / 嵌套；
//   close → 弹栈；
//   void  → 克隆完整子树（代码块 / 图片 / br 等）插入当前容器；
//   text  → 作为文本节点插入当前栈顶。

import { tokenizeMarkers } from './markers';

export function rebuild(
  translated: string,
  styleMap: ReadonlyMap<number, Element>
): DocumentFragment {
  const frag = document.createDocumentFragment();
  const tokens = tokenizeMarkers(translated);
  // 正常情况下调用方已校验过，tokens 必不为 null；防御性兜底：整段当纯文本放回。
  if (tokens === null) {
    frag.appendChild(document.createTextNode(translated));
    return frag;
  }

  // 栈顶是当前正在填充的容器；最外层就是 fragment 本身。
  const stack: (DocumentFragment | Element)[] = [frag];
  const top = () => stack[stack.length - 1]!;

  for (const t of tokens) {
    switch (t.type) {
      case 'text':
        if (t.text.length > 0) top().appendChild(document.createTextNode(t.text));
        break;
      case 'void': {
        // 自闭合：克隆完整子树插入（代码 / 媒体 / br 等原物整体贴回）。
        const original = styleMap.get(t.n);
        if (original) top().appendChild(original.cloneNode(true));
        break;
      }
      case 'open': {
        // 打开：克隆"壳"（无子节点），压栈以接收后续文字 / 嵌套。
        const original = styleMap.get(t.n);
        const shell = original
          ? (original.cloneNode(false) as Element)
          : document.createElement('span'); // 理论不可达（validate 已挡），保险用 span 维持栈深
        top().appendChild(shell);
        stack.push(shell);
        break;
      }
      case 'close':
        // 关闭：弹栈；validate 已保证配对，这里多一层 guard 防御。
        if (stack.length > 1) stack.pop();
        break;
    }
  }

  return frag;
}
