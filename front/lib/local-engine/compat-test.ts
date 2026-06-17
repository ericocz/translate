// BYOK 兼容性自检（§7.3）：配好 provider 后，用一组含已知占位符的固定测试块跑完整 local-translator，
// 算「标记保留率」给模型打分（好/中/差）。差则 UI 软拦——警示 + 需用户确认才用（§12-D）。
//
// 为什么需要：不同模型对 <gN>/<xN/> 占位符与 [[id]] 协议的遵守度差异很大；弱模型会翻译/删改标记，
// 导致重建丢链接 / 丢字。这个自检让用户在「正式翻网页」前就知道所选模型靠不靠谱。

import type { ApiBlock } from '../api';
import type { FailureInfo } from '../types';
import { allowedIdsFromSource, validateMarkers } from '../markers';
import { translateLocal } from './local-translator';
import type { ProviderConfig } from './types';

// 固定测试块：覆盖成对标记、自闭合标记、多标记混排——都是真实网页常见结构。
const TEST_BLOCKS: ApiBlock[] = [
  { id: 't1', source: 'Read the <g0>full guide</g0> before you start.' },
  { id: 't2', source: 'Click <g0>Submit</g0><x1/> to continue your work.' },
  { id: 't3', source: 'See the <g0>API reference</g0> and <g1>changelog</g1> for details.' },
];

export type CompatScore = 'good' | 'fair' | 'poor';

export interface CompatResult {
  ok: boolean; // 是否完成测试（false=调用失败，看 error）
  score?: CompatScore;
  retention?: number; // 标记保留率 0~1
  passed?: number;
  total?: number;
  samples?: { source: string; translated: string; ok: boolean }[];
  error?: FailureInfo;
}

function scoreOf(retention: number): CompatScore {
  if (retention >= 0.9) return 'good';
  if (retention >= 0.6) return 'fair';
  return 'poor';
}

/** 跑兼容性自检。在 SW 上下文调用（fetch 走 host_permissions 绕 CORS）。 */
export function runCompatTest(cfg: ProviderConfig): Promise<CompatResult> {
  return new Promise((resolve) => {
    const got = new Map<string, string>();
    translateLocal(
      TEST_BLOCKS,
      cfg,
      {
        onBlock: (id, translated) => got.set(id, translated),
        onDone: () => {
          const samples = TEST_BLOCKS.map((b) => {
            const translated = got.get(b.id) ?? '';
            const ok =
              translated !== '' && validateMarkers(translated, allowedIdsFromSource(b.source)).ok;
            return { source: b.source, translated, ok };
          });
          const passed = samples.filter((s) => s.ok).length;
          const total = samples.length;
          const retention = total > 0 ? passed / total : 0;
          resolve({ ok: true, score: scoreOf(retention), retention, passed, total, samples });
        },
        onError: (error) => resolve({ ok: false, error }),
      }
    );
  });
}
