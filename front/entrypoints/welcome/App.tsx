import { useEffect, useState } from 'react';
import { claimGift } from '@/lib/grant';
import { getInstanceId } from '@/lib/device';

/** 余额（元）→「¥X.XX」。 */
function yuan(n: number | undefined): string {
  return '¥' + (n ?? 0).toFixed(2);
}

const STEPS: { t: string; d: string }[] = [
  {
    t: '添加要翻译的网站',
    d: '在想看中文的网页上点工具栏图标、把该域名加入白名单；之后一打开就自动整页翻译——原文先垫着，译文逐块淡入替换。',
  },
  {
    t: '一键开 / 关',
    d: '工具栏图标点一下开、再点一下关；关掉即刻还原原文，瞬时无需重译。也可用快捷键 ⌘/Alt+Shift+A。',
  },
  {
    t: '随时看原文',
    d: 'Ctrl / ⌘ + 点击任意一段，就地在中 ↔ 英之间切换，核对原文不打断阅读。',
  },
];

type ClaimState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'done'; balance: number }
  | { kind: 'error'; msg: string };

export function Welcome() {
  // 浏览器标识（chrome.instanceID）：undefined=检测中、''=取不到、其余=可领取。
  const [instanceId, setInstanceId] = useState<string | undefined>(undefined);
  const [claim, setClaim] = useState<ClaimState>({ kind: 'idle' });

  useEffect(() => {
    void getInstanceId().then(setInstanceId);
  }, []);

  const checking = instanceId === undefined;
  const noIdentifier = instanceId === '';

  const onClaim = async () => {
    setClaim({ kind: 'busy' });
    const res = await claimGift();
    if (res.ok) setClaim({ kind: 'done', balance: res.balance ?? 2 });
    else setClaim({ kind: 'error', msg: '领取失败，请稍后在弹窗里重试。' });
  };

  return (
    <div className="wrap">
      <header className="hero">
        <img className="hero-logo" src="/icon/128.png" alt="" />
        <h1>秒懂翻译 · aha translate</h1>
        <p className="hero-sub">打开网页，整页秒变中文。译文干净、不打扰，像这页本来就是中文写的。</p>
      </header>

      <section className="card">
        <div className="card-h">
          <h2>三步上手</h2>
        </div>
        <ol className="steps">
          {STEPS.map((s, i) => (
            <li key={i} className="step">
              <span className="step-n">{i + 1}</span>
              <div className="step-b">
                <strong>{s.t}</strong>
                <p className="muted">{s.d}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="card claim">
        <div className="card-h">
          <h2>领取 ¥2 新人额度</h2>
        </div>
        <p className="muted">
          翻译消耗按用量从额度扣费。新装用户可免费领取 <strong>¥2</strong> 体验额度，用完可在设置里充值，
          也可买断解锁「自带模型」。
        </p>

        {claim.kind === 'done' ? (
          <div className="claim-ok">
            <span className="claim-badge">已到账</span>
            <span>
              当前余额 <strong>{yuan(claim.balance)}</strong>，去任意网页打开弹窗、添加网站就能开始翻译。
            </span>
          </div>
        ) : (
          <>
            <div className="claim-row">
              <button
                className="add"
                onClick={() => void onClaim()}
                disabled={checking || noIdentifier || claim.kind === 'busy'}
              >
                {claim.kind === 'busy' ? '领取中…' : '领取 ¥2'}
              </button>
              {claim.kind === 'error' && <span className="claim-err">{claim.msg}</span>}
            </div>
            {noIdentifier && (
              <p className="claim-err">
                无法获取浏览器标识（领取赠送额度需要它来防止重复领取）。你的浏览器可能禁用了相关能力——
                仍可在设置里充值后正常使用。
              </p>
            )}
          </>
        )}
      </section>

      <footer className="foot">
        <button className="ghost" onClick={() => chrome.runtime.openOptionsPage()}>
          打开设置 · 管理白名单
        </button>
        <span className="foot-hint">关掉本页即可开始使用。</span>
      </footer>
    </div>
  );
}
