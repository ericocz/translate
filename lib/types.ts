// 跨模块共用类型定义。

/** 一个可翻译块：抽取阶段生成，贯穿请求 / 流式回填 / 重建。 */
export interface TransBlock {
  /** 稳定 ID，例如 b3；既挂到 DOM data-trans-id，又写入提示词的 [[id]]。 */
  id: string;
  /** 喂给模型的纯文本（含 <gN>/<xN> 占位标记）。 */
  source: string;
  /** 占位编号 → 原始内联元素（克隆，重建时再深拷贝）。 */
  styleMap: Map<number, Element>;
}

/** 失败原因分类，用于错误提示。 */
export type FailureKind = 'network' | 'api' | 'auth' | 'unknown';

export interface FailureInfo {
  kind: FailureKind;
  message: string;
}
