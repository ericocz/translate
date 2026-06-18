// 单测结构分区纯逻辑：splitByTier（按 tier 拆组）+ translateByRegion（正文优先 + 终态聚合）。
// 镜像 lib/regions.ts / lib/translate-cached.ts 的纯逻辑，改源码请同步这里。

// ---- 镜像 splitByTier ----
function splitByTier(blocks) {
  const content = [];
  const chrome = [];
  for (const b of blocks) (b.tier === 'chrome' ? chrome : content).push(b);
  return { content, chrome };
}

// ---- 镜像 translateByRegion ----
function translateByRegion(content, chrome, handlers, makeJob, chromeDelayMs = 8000) {
  let aborted = false;
  let finished = false;
  let contentJob = null;
  let chromeJob = null;
  let chromeTimer = null;
  let chromeStarted = false;

  let contentSettled = content.length === 0;
  let chromeSettled = chrome.length === 0;
  const chromeStream = content.length === 0; // 纯外框页：外框升级 SSE
  let contentError = null;
  let chromeError = null;

  const systemic = (e) => !!e && (e.kind === 'quota' || e.kind === 'auth');

  const finalize = () => {
    if (finished || aborted || !contentSettled || !chromeSettled) return;
    finished = true;
    if (systemic(contentError)) handlers.onError(contentError);
    else if (systemic(chromeError)) handlers.onError(chromeError);
    else if (contentError) handlers.onError(contentError);
    else if (chromeError) handlers.onError(chromeError);
    else handlers.onDone();
  };

  const startChrome = () => {
    if (chromeStarted || aborted || chrome.length === 0) return;
    chromeStarted = true;
    if (chromeTimer) { clearTimeout(chromeTimer); chromeTimer = null; }
    chromeJob = makeJob(chrome, {
      onBlock: handlers.onBlock,
      onDone: () => { chromeSettled = true; finalize(); },
      onError: (f) => { chromeError = f; chromeSettled = true; finalize(); },
    }, chromeStream); // 外框默认非流式 HTTP；纯外框页升级 SSE
  };

  if (content.length > 0) {
    let firstSeen = false;
    contentJob = makeJob(content, {
      onBlock: (id, t) => { handlers.onBlock(id, t); if (!firstSeen) { firstSeen = true; startChrome(); } },
      onDone: () => { contentSettled = true; startChrome(); finalize(); },
      onError: (f) => { contentError = f; contentSettled = true; startChrome(); finalize(); },
    }, true); // 正文走 SSE
    if (chrome.length > 0) chromeTimer = setTimeout(startChrome, chromeDelayMs);
  } else {
    startChrome();
  }

  if (content.length === 0 && chrome.length === 0) handlers.onDone();

  return {
    abort: () => {
      aborted = true;
      if (chromeTimer) { clearTimeout(chromeTimer); chromeTimer = null; }
      contentJob?.abort();
      chromeJob?.abort();
    },
  };
}

// ---- 测试脚手架 ----
let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.log('  FAIL ' + name); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 收集 background→content 终态的 handlers 替身
function sink() {
  const blocks = [];
  let done = false;
  let error = null;
  return {
    h: {
      onBlock: (id, tr) => blocks.push([id, tr]),
      onDone: () => { done = true; },
      onError: (f) => { error = f; },
    },
    get blocks() { return blocks; },
    get done() { return done; },
    get error() { return error; },
  };
}

// 可手动驱动的 job 工厂：记录每次起的 job，测试再喂 onBlock/onDone/onError。
function factory() {
  const jobs = [];
  const make = (blocks, h, stream) => { const j = { blocks, h, stream, aborted: false, abort() { this.aborted = true; } }; jobs.push(j); return j; };
  return { make, jobs };
}

const C = (id) => ({ id, source: id, tier: 'content' });
const H = (id) => ({ id, source: id, tier: 'chrome' });

// === splitByTier ===
{
  const { content, chrome } = splitByTier([C('a'), H('b'), { id: 'c', source: 'c' }]);
  t('splitByTier 分组', content.map((b) => b.id).join() === 'a,c' && chrome.map((b) => b.id).join() === 'b');
  t('splitByTier 缺省 tier 归正文', splitByTier([{ id: 'x', source: 'x' }]).content.length === 1);
}

// === 正文优先：chrome 在正文首段前不起 ===
{
  const s = sink();
  const f = factory();
  translateByRegion([C('c1')], [H('h1')], s.h, f.make, 50);
  t('先只起正文 job', f.jobs.length === 1 && f.jobs[0].blocks[0].id === 'c1');
  t('正文 job 走 SSE(stream=true)', f.jobs[0].stream === true);
  f.jobs[0].h.onBlock('c1', 'C1');
  t('正文首段后才起 chrome job', f.jobs.length === 2 && f.jobs[1].blocks[0].id === 'h1');
  t('外框 job 走非流式 HTTP(stream=false)', f.jobs[1].stream === false);
  t('首段已转发', s.blocks.length === 1 && s.blocks[0][0] === 'c1');
}

// === 聚合 done：两路都完成才 done ===
{
  const s = sink();
  const f = factory();
  translateByRegion([C('c1')], [H('h1')], s.h, f.make, 50);
  f.jobs[0].h.onBlock('c1', 'C1');
  f.jobs[0].h.onDone();
  t('仅正文完成不 done', s.done === false);
  f.jobs[1].h.onBlock('h1', 'H1');
  f.jobs[1].h.onDone();
  t('两路皆完成才 done', s.done === true && s.error === null);
  t('两路 block 都转发', s.blocks.length === 2);
}

// === 系统性错误(quota)：正文报 quota → 上报 quota ===
{
  const s = sink();
  const f = factory();
  translateByRegion([C('c1')], [H('h1')], s.h, f.make, 50);
  f.jobs[0].h.onError({ kind: 'quota', message: 'no balance' }); // 正文 quota → 同时放行 chrome
  f.jobs[1].h.onError({ kind: 'quota', message: 'no balance' }); // chrome 也 quota
  t('quota 上报为 error', s.error && s.error.kind === 'quota' && s.done === false);
}

// === 正文 network 全失败 → 上报 network（即便 chrome done） ===
{
  const s = sink();
  const f = factory();
  translateByRegion([C('c1')], [H('h1')], s.h, f.make, 50);
  f.jobs[0].h.onError({ kind: 'network', message: 'down' }); // 正文失败放行 chrome
  f.jobs[1].h.onDone(); // chrome 成功
  t('正文 network 失败 → 上报 network', s.error && s.error.kind === 'network');
}

// === chrome 非系统性失败但正文 done → 上报 error（与正文对齐，不再吞掉） ===
{
  const s = sink();
  const f = factory();
  translateByRegion([C('c1')], [H('h1')], s.h, f.make, 50);
  f.jobs[0].h.onBlock('c1', 'C1');
  f.jobs[0].h.onDone();
  f.jobs[1].h.onError({ kind: 'network', message: 'blip' });
  t('chrome 整组失败 → 上报 error（对齐正文）', s.error && s.error.kind === 'network' && s.done === false);
}

// === 正文优先于外框错误：两路都非系统失败时报正文那个 ===
{
  const s = sink();
  const f = factory();
  translateByRegion([C('c1')], [H('h1')], s.h, f.make, 50);
  f.jobs[0].h.onError({ kind: 'api', message: 'content-fail' }); // 放行 chrome
  f.jobs[1].h.onError({ kind: 'network', message: 'chrome-fail' });
  t('两路皆失败优先报正文', s.error && s.error.kind === 'api');
}

// === chrome 为空：退化为单正文 job ===
{
  const s = sink();
  const f = factory();
  translateByRegion([C('c1')], [], s.h, f.make, 50);
  t('无 chrome 只起一个 job', f.jobs.length === 1);
  f.jobs[0].h.onDone();
  t('单正文完成即 done', s.done === true);
}

// === 纯外框页（content 空）：外框升级走 SSE(stream=true) ===
{
  const s = sink();
  const f = factory();
  translateByRegion([], [H('h1')], s.h, f.make, 50);
  t('content 空只起外框 job', f.jobs.length === 1 && f.jobs[0].blocks[0].id === 'h1');
  t('纯外框页外框走 SSE(stream=true)', f.jobs[0].stream === true);
  f.jobs[0].h.onDone();
  t('外框完成即 done', s.done === true);
}

// === 两者皆空：立即 done ===
{
  const s = sink();
  const f = factory();
  translateByRegion([], [], s.h, f.make, 50);
  t('两者皆空立即 done', s.done === true && f.jobs.length === 0);
}

// === 兜底定时器：正文迟迟无首段，chrome 仍按延时起 ===
await (async () => {
  const s = sink();
  const f = factory();
  translateByRegion([C('c1')], [H('h1')], s.h, f.make, 20);
  t('起初只有正文 job（定时器未到）', f.jobs.length === 1);
  await sleep(40);
  t('超时后 chrome 兜底起', f.jobs.length === 2);
})();

// === abort：中止两路 + 清定时器（不再起 chrome） ===
await (async () => {
  const s = sink();
  const f = factory();
  const job = translateByRegion([C('c1')], [H('h1')], s.h, f.make, 20);
  f.jobs[0].h.onBlock('c1', 'C1'); // 起了 chrome
  job.abort();
  t('abort 中止两路', f.jobs[0].aborted === true && f.jobs[1].aborted === true);
  await sleep(40);
  // abort 已清定时器/置 aborted：不应再多起 job，也不应 finalize
  f.jobs[0].h.onDone();
  f.jobs[1].h.onDone();
  t('abort 后不再 finalize', s.done === false);
})();

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
