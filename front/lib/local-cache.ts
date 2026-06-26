// 客户端本地译文缓存（IndexedDB · L1，D-11b）。
// D-11：服务端不再持有跨用户缓存（隐私=不留存用户内容）；缓存只剩这一层、在用户设备上。
// 键 = 语言对 + 原文（含 <gN> 标记）→ 译文；命中即不发服务端、天然不扣额度、同页重访秒出。
// 语义等价于把服务端「按 source 去重广播」扩展到跨页/跨时间：translated 只依赖 source 文本与
// 语言对，真实内联元素由客户端 styleMap 在重建期补回，故跨页复用同一 translated 安全。
//
// 运行上下文：既被 service worker（翻译编排）用，也被 options 页（清空/统计）用——同源共享
// 同一 IndexedDB。SW 30s 卸载不影响：IndexedDB 落盘持久。所有失败都静默降级（退回全发服务端）。

import { getTargetLang } from './storage';

const DB_NAME = 'imt-cache';
const DB_VERSION = 1;
const STORE = 'entries';
const META = 'meta';

// 语言对：源端不做检测（统一记 auto），目标端取用户所选目标语言 → 缓存按目标语言分桶，
// 同一原文翻成不同目标语言互不串扰。运行期由 langPair() 从设置读出，默认见 languages.defaultTargetLang。
const DEFAULT_LANG_PAIR = 'auto-zh';

/** 当前缓存语言对（auto-<目标语言>）；读不到设置时退默认。 */
async function langPair(): Promise<string> {
  try {
    return 'auto-' + (await getTargetLang());
  } catch {
    return DEFAULT_LANG_PAIR;
  }
}

// LRU 上限（O-13）：~200MB 或 90 天未用即逐出。size 以 UTF-16 字节估算。
export const MAX_BYTES = 200 * 1024 * 1024;
export const MAX_ENTRIES = 200_000;
export const TTL_MS = 90 * 24 * 60 * 60 * 1000;

export interface CacheEntry {
  key: string;
  translated: string;
  size: number; // 估算字节（key+译文，UTF-16）
  created: number;
  used: number; // 最近命中/写入（LRU 依据）
}

interface Stats {
  id: 'stats';
  count: number;
  bytes: number;
}

export interface CacheStats {
  count: number;
  bytes: number;
}

/** 内容寻址键：语言对 + NUL + 原文。直接用全文，零碰撞（不哈希）。 */
export function cacheKey(source: string, lang: string = DEFAULT_LANG_PAIR): string {
  return lang + '\u0000' + source;
}

function estimateSize(key: string, translated: string): number {
  return (key.length + translated.length) * 2;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'key' });
        os.createIndex('byUsed', 'used'); // 逐出按最近使用升序遍历
      }
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function reqDone<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * 纯逐出决策（与 evict 的游标遍历同构，便于 node 单测）。
 * entries 须按 used 升序（最久未用在前）；返回应删除的 key 列表：
 * 先逐最旧，直到字节与条数都达标；途中任一条过期（used 太旧）也删。
 * 升序保证：遇到一条既不过期、又已达标的就收工（后面都更新）。
 */
export function selectEvictions(
  entries: CacheEntry[],
  opts: { maxBytes: number; maxEntries: number; ttlMs: number; now: number }
): string[] {
  let bytes = entries.reduce((s, e) => s + e.size, 0);
  let count = entries.length;
  const out: string[] = [];
  for (const e of entries) {
    const stale = e.used < opts.now - opts.ttlMs;
    if (stale || bytes > opts.maxBytes || count > opts.maxEntries) {
      out.push(e.key);
      bytes -= e.size;
      count -= 1;
    } else {
      break;
    }
  }
  return out;
}

/** 批量查本地：返回命中 source→译文；命中顺带刷新 used（LRU 续命）。失败静默返回已得部分。 */
export async function cacheGetMany(sources: string[]): Promise<Map<string, string>> {
  const hits = new Map<string, string>();
  if (sources.length === 0) return hits;
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return hits;
  }
  const uniq = Array.from(new Set(sources));
  const now = Date.now();
  // 语言对在开 tx 前一次性读出（tx 内不能 await 别的异步，否则空转自动提交）。
  const lang = await langPair();
  try {
    // 读相：同一只读 tx 内同步发起全部 get 再 await（避免 tx 空转自动提交）。
    const rtx = db.transaction(STORE, 'readonly');
    const ros = rtx.objectStore(STORE);
    const got = await Promise.all(
      uniq.map((s) => reqDone(ros.get(cacheKey(s, lang))) as Promise<CacheEntry | undefined>)
    );
    const touch: CacheEntry[] = [];
    uniq.forEach((s, i) => {
      const e = got[i];
      if (e) {
        hits.set(s, e.translated);
        e.used = now;
        touch.push(e);
      }
    });
    // 触摸相：独立 readwrite tx 续命（best-effort，不影响命中结果）。
    if (touch.length) {
      const wtx = db.transaction(STORE, 'readwrite');
      const wos = wtx.objectStore(STORE);
      for (const e of touch) wos.put(e);
      await txDone(wtx).catch(() => {});
    }
  } catch {
    return hits;
  }
  return hits;
}

/** 批量写回（仅传入已通过标记校验的块）。更新统计并按需逐出。失败静默忽略。 */
export async function cachePutMany(
  items: { source: string; translated: string }[]
): Promise<void> {
  if (items.length === 0) return;
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return;
  }
  const now = Date.now();
  // 语言对在开 tx 前一次性读出（同 cacheGetMany）。
  const lang = await langPair();
  // 同批同 key 去重，保留最后一个。
  const byKey = new Map<string, { source: string; translated: string }>();
  for (const it of items) byKey.set(cacheKey(it.source, lang), it);
  const keys = Array.from(byKey.keys());
  try {
    // 读相：现有 entry（算 size 差 / 保留 created）+ stats，全部同步发起后 await。
    const rtx = db.transaction([STORE, META], 'readonly');
    const ros = rtx.objectStore(STORE);
    const rms = rtx.objectStore(META);
    const entryReqs = keys.map((k) => reqDone(ros.get(k)) as Promise<CacheEntry | undefined>);
    const statsReq = reqDone(rms.get('stats')) as Promise<Stats | undefined>;
    const existing = await Promise.all(entryReqs);
    const stats = (await statsReq) ?? { id: 'stats' as const, count: 0, bytes: 0 };

    let count = stats.count;
    let bytes = stats.bytes;
    const puts: CacheEntry[] = [];
    keys.forEach((k, i) => {
      const old = existing[i];
      const it = byKey.get(k)!;
      const size = estimateSize(k, it.translated);
      if (old) bytes += size - old.size;
      else {
        bytes += size;
        count += 1;
      }
      puts.push({ key: k, translated: it.translated, size, created: old?.created ?? now, used: now });
    });

    // 写相：entries + stats 一起 put，全部同步发起。
    const wtx = db.transaction([STORE, META], 'readwrite');
    const wos = wtx.objectStore(STORE);
    const wms = wtx.objectStore(META);
    for (const e of puts) wos.put(e);
    wms.put({ id: 'stats', count, bytes } satisfies Stats);
    await txDone(wtx);

    if (bytes > MAX_BYTES || count > MAX_ENTRIES) await evict(db, { count, bytes });
  } catch {
    // 写失败不影响翻译（缓存只是加速层）。
  }
}

/** 逐出：按 used 升序游标删旧 + 删过期，直到达标；最后单独写回 stats。 */
async function evict(db: IDBDatabase, stats: { count: number; bytes: number }): Promise<void> {
  const now = Date.now();
  let { count, bytes } = stats;
  const tx = db.transaction(STORE, 'readwrite');
  const idx = tx.objectStore(STORE).index('byUsed');
  await new Promise<void>((resolve, reject) => {
    const req = idx.openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return resolve();
      const e = c.value as CacheEntry;
      if (e.used < now - TTL_MS || bytes > MAX_BYTES || count > MAX_ENTRIES) {
        c.delete();
        bytes -= e.size;
        count -= 1;
        c.continue();
      } else {
        resolve(); // 升序：后面都更新且达标，收工
      }
    };
    req.onerror = () => reject(req.error);
  });
  await txDone(tx);
  const mtx = db.transaction(META, 'readwrite');
  mtx.objectStore(META).put({ id: 'stats', count, bytes } satisfies Stats);
  await txDone(mtx);
}

/** 清空缓存（设置页「清空」）。 */
export async function clearCache(): Promise<void> {
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return;
  }
  try {
    const tx = db.transaction([STORE, META], 'readwrite');
    tx.objectStore(STORE).clear();
    tx.objectStore(META).put({ id: 'stats', count: 0, bytes: 0 } satisfies Stats);
    await txDone(tx);
  } catch {
    // 忽略
  }
}

/** 当前占用（设置页展示）。 */
export async function cacheStats(): Promise<CacheStats> {
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return { count: 0, bytes: 0 };
  }
  try {
    const tx = db.transaction(META, 'readonly');
    const s = (await reqDone(tx.objectStore(META).get('stats'))) as Stats | undefined;
    return { count: s?.count ?? 0, bytes: s?.bytes ?? 0 };
  } catch {
    return { count: 0, bytes: 0 };
  }
}
