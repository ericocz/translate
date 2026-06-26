import { useEffect, useState } from 'react';
import { claimGift } from '@/lib/grant';
import { getInstanceId } from '@/lib/device';
import { targetLanguages, defaultTargetLang, isZhUi } from '@/lib/languages';
import { getTargetLang, setTargetLang } from '@/lib/storage';

/** 余额（元）→「¥X.XX」。 */
function yuan(n: number | undefined): string {
  return '¥' + (n ?? 0).toFixed(2);
}

const TOTAL = 4;

/* ───────────────────────── 文案（中 / 英双语） ───────────────────────── */

type Ui = 'zh' | 'en';

interface DemoLine {
  src: string;
  dst: string;
}
interface Strings {
  docTitle: string;
  brand: string;
  skip: string;
  next: string;
  back: string;
  // step1
  s1Title: string;
  s1Lead: [string, string, string]; // 前 / 高亮 / 后
  s1Field: string;
  s1Hint: string;
  demoTitleSrc: string;
  demoTitleDst: string;
  demoLines: DemoLine[];
  demoCapSrc: string;
  demoCapDst: string;
  // step2
  s2Title: string;
  s2Lead: [string, string, string];
  s2c1: string;
  s2c2: string;
  s2ext: string;
  s2name: string;
  s2List: [string, string];
  s2Hint: string;
  // step3
  s3Title: string;
  s3PopTo: string;
  s3PopPill: string;
  s3PopToggle: string;
  s3Steps: { t: string; d: string }[];
  // step4
  s4Title: string;
  s4Lead: [string, string, string];
  s4Claim: string;
  s4Claiming: string;
  s4Done: string;
  s4DoneTail: string;
  s4Fallback: string;
  s4ClaimErr: string;
  s4CloseHint: string;
}

const STR: Record<Ui, Strings> = {
  zh: {
    docTitle: '探索秒懂翻译更多功能',
    brand: '秒懂翻译',
    skip: '跳过',
    next: '下一步 →',
    back: '← 上一步',
    s1Title: '打开网页，整页秒变中文',
    s1Lead: ['导航、正文、按钮、页脚——所有看得见的文字都翻。译文干净、不打扰，', '像这页本来就是中文写的', '。'],
    s1Field: '我想把网页翻成',
    s1Hint: '随时可在弹窗里改。',
    demoTitleSrc: 'A long-form essay',
    demoTitleDst: '一篇英文长文',
    demoLines: [
      { src: 'The real cost of AI is being paid', dst: 'AI 的真实成本，正由远离硅谷的人' },
      { src: 'by experts far from Silicon Valley.', dst: '在硅谷之外默默承担。' },
      { src: 'Below is an extract from the report.', dst: '以下是该报告的节选内容。' },
    ],
    demoCapSrc: '原文先垫着…',
    demoCapDst: '译文逐块淡入替换',
    s2Title: '先把图标固定到工具栏',
    s2Lead: ['秒懂翻译', '只有一个常驻接触点', '——工具栏上的图标。点一下开、再点一下关，图标自身就告诉你当前站点翻没翻。'],
    s2c1: '① 点这个拼图图标',
    s2c2: '② 点图钉固定到工具栏',
    s2ext: '扩展程序',
    s2name: '秒懂翻译 · aha translate',
    s2List: ['点浏览器右上角的拼图（扩展）图标', '在「秒懂翻译」一行点图钉，固定到工具栏'],
    s2Hint: '固定后图标常驻，照着左图操作即可。',
    s3Title: '就这么用',
    s3PopTo: '翻译为',
    s3PopPill: '简体中文',
    s3PopToggle: '翻译此页',
    s3Steps: [
      {
        t: '自动翻译',
        d: '打开网页就整页变成你选的语言——原文先垫着，译文逐块淡入替换，无需任何设置。',
      },
      {
        t: '一键开 / 关',
        d: '点工具栏图标开、再点一下关；关掉即刻还原原文，无需重译。也可用快捷键 ⌘ / Alt+Shift+A。',
      },
      {
        t: '随时看原文',
        d: 'Ctrl / ⌘ + 点击任意一段，就地在原文 ↔ 译文间切换，核对不打断阅读。',
      },
    ],
    s4Title: '准备好了，送你 ¥2 体验额度',
    s4Lead: ['翻译按用量从额度扣费、用完即停（没有匿名免费额度）。新装用户可免费领取', ' ¥2 ', '体验额度，用完可在弹窗里充值。'],
    s4Claim: '领取 ¥2 体验额度',
    s4Claiming: '领取中…',
    s4Done: '已到账',
    s4DoneTail: '，打开任意网页就会自动翻译。',
    s4Fallback: '检测不到浏览器标识时，会以设备标识防重领取——不影响领取。',
    s4ClaimErr: '领取失败，请稍后在弹窗里重试。',
    s4CloseHint: '关掉本页即可开始使用。',
  },
  en: {
    docTitle: 'Explore aha translate',
    brand: 'aha translate',
    skip: 'Skip',
    next: 'Next →',
    back: '← Back',
    s1Title: 'Open any page — read it in your language',
    s1Lead: ['Nav, body, buttons, footer — every visible word is translated. Clean and unobtrusive, ', 'as if the page were written in your language', '.'],
    s1Field: 'Translate pages into',
    s1Hint: 'You can change this anytime in the popup.',
    demoTitleSrc: '一篇中文长文',
    demoTitleDst: 'A long-form essay',
    demoLines: [
      { src: '人工智能的真实成本，', dst: 'The real cost of AI is being paid' },
      { src: '正由远离硅谷的人默默承担。', dst: 'by experts far from Silicon Valley.' },
      { src: '以下是该报告的节选内容。', dst: 'Below is an extract from the report.' },
    ],
    demoCapSrc: 'Original shown first…',
    demoCapDst: 'Translation fades in, block by block',
    s2Title: 'First, pin the icon to your toolbar',
    s2Lead: ['aha translate has ', 'just one place you touch', ' — the toolbar icon. Click to turn on, click again to turn off; the icon itself tells you whether the current site is translated.'],
    s2c1: '① Click the puzzle icon',
    s2c2: '② Click the pin to add it',
    s2ext: 'Extensions',
    s2name: 'aha translate · 秒懂翻译',
    s2List: ['Click the puzzle (Extensions) icon at the top-right', 'Click the pin next to “aha translate” to add it to the toolbar'],
    s2Hint: 'Once pinned the icon stays put — just follow the picture on the left.',
    s3Title: 'How it works',
    s3PopTo: 'Translate to',
    s3PopPill: 'Simplified Chinese',
    s3PopToggle: 'Translate this page',
    s3Steps: [
      {
        t: 'Automatic translation',
        d: 'Open a page and the whole thing turns into your language — original shown first, translation fading in block by block. No setup needed.',
      },
      {
        t: 'One click on / off',
        d: 'Click the toolbar icon to turn on, click again to turn off; the original is restored instantly, no re-translation. Shortcut: ⌘ / Alt+Shift+A.',
      },
      {
        t: 'See the original anytime',
        d: 'Ctrl / ⌘ + click any paragraph to toggle between original and translation in place, without breaking your reading.',
      },
    ],
    s4Title: 'You’re all set — here’s ¥2 to start',
    s4Lead: ['Translation is billed by usage from your balance and stops when it runs out (no anonymous free tier). New users can claim', ' ¥2 ', 'to get started; top up in the popup when it runs out.'],
    s4Claim: 'Claim ¥2 credit',
    s4Claiming: 'Claiming…',
    s4Done: 'Added',
    s4DoneTail: ' — open any web page and it translates automatically.',
    s4Fallback: 'If a browser identifier isn’t available, your device identifier guards against duplicate claims — claiming still works.',
    s4ClaimErr: 'Claim failed. Please retry from the popup later.',
    s4CloseHint: 'Close this page to start using.',
  },
};

/* ───────────────────────── 左侧视觉演示区 ───────────────────────── */

/** Step 1 演示：原文先垫着、译文逐块淡入替换——「像这页本来就是中文写的」。 */
function FadeDemo({ L }: { L: Strings }) {
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
function PinDemo({ L }: { L: Strings }) {
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
function PopupDemo({ L }: { L: Strings }) {
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
          <span>{L.brand}</span>
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

function ClaimGift({ L }: { L: Strings }) {
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
    else setClaim({ kind: 'error', msg: L.s4ClaimErr });
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
          {claim.kind === 'busy' ? L.s4Claiming : L.s4Claim}
        </button>
        {claim.kind === 'error' && <span className="claim-err">{claim.msg}</span>}
      </div>
      {noIdentifier && <p className="muted center">{L.s4Fallback}</p>}
    </>
  );
}

/* ───────────────────────── 主流程 ───────────────────────── */

export function Welcome() {
  const [ui, setUi] = useState<Ui>(isZhUi() ? 'zh' : 'en');
  const L = STR[ui];

  const [step, setStep] = useState(0);
  const langs = targetLanguages(ui === 'zh');
  const [lang, setLang] = useState<string>(defaultTargetLang(ui === 'zh'));

  // 页签标题随界面语言。
  useEffect(() => {
    document.title = L.docTitle;
    document.documentElement.lang = ui === 'zh' ? 'zh-CN' : 'en';
  }, [L.docTitle, ui]);

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
          <span className="brand-name">{L.brand}</span>
        </div>
        <div className="top-r">
          <div className="lang-toggle" role="group" aria-label="语言 / language">
            <button className={ui === 'zh' ? 'lt on' : 'lt'} onClick={() => setUi('zh')}>
              中
            </button>
            <button className={ui === 'en' ? 'lt on' : 'lt'} onClick={() => setUi('en')}>
              EN
            </button>
          </div>
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
              <PopupDemo L={L} />
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
              <ClaimGift L={L} />
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
