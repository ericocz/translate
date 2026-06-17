// 按 [[id]] 切块。照搬后端 server/app/services/block_splitter.py，并加「中档」容错归一化。
//
// 流式难点（与后端同源教训）：模型逐 token 返回，一个 [[id]] 标记常被拆散到多个小 chunk
// （如 "[["、"b"、"1"、"]]"）。绝不能在单个 chunk 内就地判定边界——必须把已到文本累积进 acc，
// 每次在完整的 acc 上重扫标记。acc 始终保留「最后一个已出现标记」及其之后的文本（可能还在增长）。

// id 字符类必须含 `.`：沉降补抽 / SPA 新路由块 id 形如 r2.b30；漏 `.` 会让 [[r2.b30]] 整批匹配
// 不上 → 该批译文无法切块回填、整页保持原文（历史踩坑，与后端正则逐字一致）。
const MARKER_RE = /\[\[([A-Za-z0-9_.\-]+)\]\]/g;

/**
 * 中档容错：喂入前对缓冲做轻规范化，救回常见模型偏差，再切块。
 *  · 全角方括号 ［ ］（U+FF3B/U+FF3D）→ 半角 [ ]。
 *  · 双括号间夹了空格/制表（[ [ / ] ]）→ 贴合成 [[ / ]]。仅吃空格与 tab、不跨行，避免误并正文。
 * 归一化是幂等的：对已规范文本重复执行不变，故可在每次重扫前安全套用。
 */
function normalize(s: string): string {
  return s
    .replace(/[［]/g, '[')
    .replace(/[］]/g, ']')
    .replace(/\[[ \t]+\[/g, '[[')
    .replace(/\][ \t]+\]/g, ']]');
}

export type OnBlock = (id: string, text: string) => void;

export class BlockSplitter {
  private acc = '';
  constructor(private readonly onBlock: OnBlock) {}

  /** 喂入一段流文本；识别出的完整块即时回调，缓冲在内部累积。 */
  feed(chunk: string): void {
    this.acc += chunk;
    this.process(false);
  }

  /** 流结束时调用，确认并回调最后一块。 */
  flush(): void {
    this.process(true);
  }

  private process(flushAll: boolean): void {
    this.acc = normalize(this.acc);
    const marks: { id: string; start: number; end: number }[] = [];
    MARKER_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MARKER_RE.exec(this.acc)) !== null) {
      marks.push({ id: m[1], start: m.index, end: MARKER_RE.lastIndex });
    }
    if (marks.length === 0) return;
    // 非 flush 时，最后一个标记后的文本可能还没收完，留到下次 / flush 再确认。
    const upto = flushAll ? marks.length : marks.length - 1;
    for (let i = 0; i < upto; i++) {
      const textEnd = i + 1 < marks.length ? marks[i + 1].start : this.acc.length;
      this.onBlock(marks[i].id, this.acc.slice(marks[i].end, textEnd).trim());
    }
    // 丢弃已确认部分；保留从最后一个标记起的尾巴（flush 后清空）。
    this.acc = flushAll ? '' : this.acc.slice(marks[marks.length - 1].start);
  }
}
