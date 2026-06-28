import { useEffect, useState } from 'react';
import { claimGift } from '@/lib/grant';
import { getInstanceId } from '@/lib/device';
import { targetLanguages, defaultTargetLang, type LangOption } from '@/lib/languages';
import { getTargetLang, setTargetLang } from '@/lib/storage';
import { useT } from '@/lib/i18n-react';
import { UI_LOCALES, UI_LOCALE_NAMES, type Messages, type UiLocale } from '@/lib/i18n';

/** 余额（元）→「¥X.XX」。 */
function yuan(n: number | undefined): string {
  return '¥' + (n ?? 0).toFixed(2);
}

const TOTAL = 4;

/** welcome 页文案（中央四语表的 welcome 段）。 */
type W = Messages['welcome'];

/* ───────────────────────── 左侧视觉演示区 ───────────────────────── */

/** Step 1 演示：原文先垫着、译文逐块淡入替换——「像这页本来就是中文写的」。 */
function FadeDemo({ L }: { L: W }) {
  const [translated, setTranslated] = useState(false);
  useEffect(() => {
    const id = setInterval(() => setTranslated((t) => !t), 2600);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="demo-page" aria-hidden>
      <div className="demo-bar">
        <span className="demo-dot" />
        <span className="demo-dot" />
        <span className="demo-dot" />
        <span className="demo-url">example.com/article</span>
      </div>
      <div className="demo-body">
        <div className="demo-title">{translated ? L.demoTitleDst : L.demoTitleSrc}</div>
        {L.demoLines.map((l, i) => (
          <div key={i} className="demo-line" style={{ transitionDelay: `${i * 140}ms` }}>
            <span className={'demo-en' + (translated ? ' hide' : '')}>{l.src}</span>
            <span className={'demo-zh' + (translated ? ' show' : '')}>{l.dst}</span>
          </div>
        ))}
      </div>
      <div className="demo-cap">{translated ? L.demoCapDst : L.demoCapSrc}</div>
    </div>
  );
}

/** Step 2 演示：浏览器工具栏 + 扩展菜单，编号标注「点拼图 → 固定图标」。 */
function PinDemo({ L }: { L: W }) {
  return (
    <div className="demo-page" aria-hidden>
      <div className="demo-bar">
        <span className="demo-dot" />
        <span className="demo-dot" />
        <span className="demo-dot" />
        <span className="demo-addr" />
        <span className="demo-tool puzzle ring">🧩</span>
        <span className="callout c1">{L.s2c1}</span>
      </div>
      <div className="ext-menu">
        <div className="ext-menu-h">{L.s2ext}</div>
        <div className="ext-row">
          <img className="ext-ico" src="/icon/on-32.png" alt="" />
          <span className="ext-name">{L.s2name}</span>
          <span className="ext-pin ring">📌</span>
        </div>
        <span className="callout c2">{L.s2c2}</span>
      </div>
    </div>
  );
}

/** Step 3 演示：固定后的工具栏图标 + 弹窗（开关 + 目标语言）。无白名单 / 加站——翻译自动。 */
function PopupDemo({ L, brand }: { L: W; brand: string }) {
  return (
    <div className="demo-page" aria-hidden>
      <div className="demo-bar">
        <span className="demo-dot" />
        <span className="demo-dot" />
        <span className="demo-dot" />
        <span className="demo-addr" />
        <img className="demo-tool pinned" src="/icon/on-32.png" alt="" />
      </div>
      <div className="pop">
        <div className="pop-h">
          <img className="pop-ico" src="/icon/on-32.png" alt="" />
          <span>{brand}</span>
        </div>
        <div className="pop-row">
          <span>{L.s3PopTo}</span>
          <span className="pop-pill">{L.s3PopPill}</span>
        </div>
        <div className="pop-toggle">
          <span>{L.s3PopToggle}</span>
          <span className="switch on" aria-hidden>
            <span className="knob" />
          </span>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── 领取额度（Step 4） ───────────────────────── */

type ClaimState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'done'; balance: number }
  | { kind: 'error'; msg: string };

function ClaimGift({ L, retry }: { L: W; retry: string }) {
  // 浏览器标识（chrome.instanceID）：undefined=检测中、''=取不到、其余=可领取。
  // 注意：instanceID 仅作「防重复领取」的增强键，取不到时后端回退 deviceId 幂等——
  // 故**不再据此禁用按钮**（大陆用户连不上 Google FCM 时 getID 会失败，禁用会误伤正常领取）。
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
    else setClaim({ kind: 'error', msg: res.error === 'server' ? L.s4ErrSrv : L.s4ErrNet });
  };

  if (claim.kind === 'done') {
    return (
      <div className="claim-ok">
        <span className="claim-badge">{L.s4Done}</span>
        <span>
          {yuan(claim.balance)}
          {L.s4DoneTail}
        </span>
      </div>
    );
  }

  return (
    <>
      <div className="claim-row">
        <button
          className="add big"
          onClick={() => void onClaim()}
          disabled={checking || claim.kind === 'busy'}
        >
          {claim.kind === 'busy' ? L.s4Claiming : claim.kind === 'error' ? retry : L.s4Claim}
        </button>
        {claim.kind === 'error' && <span className="claim-err">{claim.msg}</span>}
      </div>
      {noIdentifier && <p className="muted center">{L.s4Fallback}</p>}
    </>
  );
}

/* ───────────────────────── 主流程 ───────────────────────── */

export function Welcome() {
  const { m, locale, setLocale } = useT();
  const L = m.welcome;

  const [step, setStep] = useState(0);
  const [langs, setLangs] = useState<LangOption[]>(() => targetLanguages(locale));
  const [lang, setLang] = useState<string>(() => defaultTargetLang(locale));

  // 页签标题 + 文档语言随界面语言。
  useEffect(() => {
    document.title = L.docTitle;
    document.documentElement.lang = locale;
  }, [L.docTitle, locale]);

  // 界面语言变化时刷新目标语言清单（显示名 / 排序随之变）。
  useEffect(() => {
    setLangs(targetLanguages(locale));
  }, [locale]);

  // 读回已存目标语言（用户可能在 popup 选过）。
  useEffect(() => {
    void getTargetLang().then(setLang);
  }, []);

  const onPickLang = (code: string) => {
    setLang(code);
    void setTargetLang(code);
  };

  const next = () => setStep((s) => Math.min(s + 1, TOTAL - 1));
  const back = () => setStep((s) => Math.max(s - 1, 0));
  const last = step === TOTAL - 1;

  return (
    <div className="shell">
      <header className="top">
        <div className="brand">
          <img className="brand-logo" src="/icon/on-48.png" alt="" />
          <span className="brand-name">{m.brand}</span>
        </div>
        <div className="top-r">
          <select
            className="lang-toggle-sel"
            aria-label="语言 / language"
            value={locale}
            onChange={(e) => void setLocale(e.target.value as UiLocale)}
          >
            {UI_LOCALES.map((l) => (
              <option key={l} value={l}>
                {UI_LOCALE_NAMES[l]}
              </option>
            ))}
          </select>
          {!last && (
            <button className="link" onClick={() => setStep(TOTAL - 1)}>
              {L.skip}
            </button>
          )}
        </div>
      </header>

      <div className="progress" role="progressbar" aria-valuenow={step + 1} aria-valuemax={TOTAL}>
        {Array.from({ length: TOTAL }).map((_, i) => (
          <span key={i} className={'seg' + (i <= step ? ' on' : '')} />
        ))}
      </div>

      <main className="stage">
        {step === 0 && (
          <section className="split">
            <div className="visual">
              <FadeDemo L={L} />
            </div>
            <div className="copy">
              <h1>{L.s1Title}</h1>
              <p className="lead">
                {L.s1Lead[0]}
                <strong>{L.s1Lead[1]}</strong>
                {L.s1Lead[2]}
              </p>
              <label className="field">
                <span className="field-l">{L.s1Field}</span>
                <select className="sel" value={lang} onChange={(e) => onPickLang(e.target.value)}>
                  {langs.map((o) => (
                    <option key={o.code} value={o.code}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <p className="muted">{L.s1Hint}</p>
            </div>
          </section>
        )}

        {step === 1 && (
          <section className="split">
            <div className="visual">
              <PinDemo L={L} />
            </div>
            <div className="copy">
              <h1>{L.s2Title}</h1>
              <p className="lead">
                {L.s2Lead[0]}
                <strong>{L.s2Lead[1]}</strong>
                {L.s2Lead[2]}
              </p>
              <ol className="mini">
                <li>{L.s2List[0]}</li>
                <li>{L.s2List[1]}</li>
              </ol>
              <p className="muted">{L.s2Hint}</p>
            </div>
          </section>
        )}

        {step === 2 && (
          <section className="split">
            <div className="visual">
              <PopupDemo L={L} brand={m.brand} />
            </div>
            <div className="copy">
              <h1>{L.s3Title}</h1>
              <ol className="steps">
                {L.s3Steps.map((s, i) => (
                  <li key={i} className="step">
                    <span className="step-n">{i + 1}</span>
                    <div className="step-b">
                      <strong>{s.t}</strong>
                      <p className="muted">{s.d}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </section>
        )}

        {step === 3 && (
          <section className="finish">
            <div className="party">🎉</div>
            <h1>{L.s4Title}</h1>
            <p className="lead center">
              {L.s4Lead[0]}
              <strong>{L.s4Lead[1]}</strong>
              {L.s4Lead[2]}
            </p>
            <div className="claim-box">
              <ClaimGift L={L} retry={m.retry} />
            </div>
            <span className="muted">{L.s4CloseHint}</span>
          </section>
        )}
      </main>

      <footer className="nav">
        <button
          className="ghost"
          onClick={back}
          disabled={step === 0}
          style={{ visibility: step === 0 ? 'hidden' : 'visible' }}
        >
          {L.back}
        </button>
        {!last && (
          <button className="add" onClick={next}>
            {L.next}
          </button>
        )}
      </footer>
    </div>
  );
}
