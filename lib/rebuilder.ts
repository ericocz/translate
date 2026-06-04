// 重建器：把模型返回的带标记译文重建为 DOM 片段。
//
// 输入：translated 字符串（已通过 markers.validate），styleMap（编号→原始元素克隆）。
// 输出：DocumentFragment，调用方负责清空目标节点的子树后 append。
//
// 实现上用一个简单的 token 扫描：遇到 <gN> 入栈、新建对应 DOM 元素；
// 遇到 </gN> 出栈；遇到 <xN/> 直接 append styleMap[N] 的克隆；
// 普通文本则 append 一个 text node 到当前栈顶。

const TOKEN_RE = /<(\/?)([gx])(\d+)(\/?)>/g;

export function rebuild(
  translated: string,
  styleMap: ReadonlyMap<number, Element>
): DocumentFragment {
  const frag = document.createDocumentFragment();
  // 栈顶是当前正在填充的容器；最外层就是 fragment 本身。
  const stack: (DocumentFragment | Element)[] = [frag];
  let lastIndex = 0;

  const flushText = (until: number) => {
    if (until > lastIndex) {
      const text = translated.slice(lastIndex, until);
      if (text.length > 0) {
        stack[stack.length - 1]!.appendChild(document.createTextNode(text));
      }
    }
  };

  let m: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(translated)) !== null) {
    flushText(m.index);
    const [, slash, kind, numStr, selfClose] = m;
    const n = Number(numStr);
    const original = styleMap.get(n);
    if (kind === 'x' || (kind === 'g' && selfClose === '/')) {
      // 自闭合：克隆完整子树插入当前容器。
      if (original) {
        stack[stack.length - 1]!.appendChild(original.cloneNode(true));
      }
    } else if (kind === 'g') {
      if (slash === '/') {
        // 关闭：弹栈；如果意外提前关，吞掉以保证不崩。
        if (stack.length > 1) stack.pop();
      } else {
        // 打开：克隆"壳"（无子节点），压栈以接收后续文字 / 嵌套。
        if (original) {
          const shell = original.cloneNode(false) as Element;
          stack[stack.length - 1]!.appendChild(shell);
          stack.push(shell);
        } else {
          // styleMap 没这个编号——validate 应已拦下；保险起见塞个 span 占位以维持栈深。
          const placeholder = document.createElement('span');
          stack[stack.length - 1]!.appendChild(placeholder);
          stack.push(placeholder);
        }
      }
    }
    lastIndex = TOKEN_RE.lastIndex;
  }
  flushText(translated.length);

  // 残留未关栈一般 validate 已拦下；这里直接忽略即可，DOM 仍然合法。
  return frag;
}
