// 纯 SSE 事件解析：把字节流按「空行分事件、event:/data: 分字段」切出事件。
//
// 关键（与流式切块同源的教训）：一个 SSE 事件常被网络切到多个 chunk，绝不能在单个 chunk 内
// 就地判定事件边界——把已到文本累积进 buf，每次在完整 buf 上找 `\n\n` 事件分隔符。

export interface SseEvent {
  /** event: 行的值；缺省 'message'。 */
  event: string;
  /** data: 行拼接（去掉前导一个空格）。 */
  data: string;
}

export function createSseParser(onEvent: (ev: SseEvent) => void) {
  let buf = '';

  const emit = (raw: string): void => {
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (dataLines.length) onEvent({ event, data: dataLines.join('\n') });
  };

  return {
    /** 喂入一段流文本；识别出的完整事件即时回调。 */
    feed(chunk: string): void {
      buf += chunk;
      let sep: number;
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        emit(buf.slice(0, sep));
        buf = buf.slice(sep + 2);
      }
    },
    /** 流结束时调用，确认末尾不带空行的最后一个事件。 */
    flush(): void {
      if (buf.trim()) {
        emit(buf);
        buf = '';
      }
    },
  };
}
