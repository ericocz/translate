// 翻译缓存：内容寻址（按块 source 哈希），IndexedDB 持久化。
//
// 设计：
// - 键 = `${VERSION}:${cyrb53(source)}`。VERSION 由 模型名 + SYSTEM_PROMPT 派生；一旦
//   prompt / 模型变化，旧缓存自然不再命中（并随 LRU 逐步淘汰），绝不返回过期译文。
// - 内容寻址：只要段落 source 不变，无论同页刷新还是跨页出现相同段落都命中。
// - LRU：每条记录带最后访问时间 a；超过 MAX_ENTRIES 时淘汰最久未用的。
// - 仅在 background（service worker）使用；IndexedDB 在 SW 中可用且跨重启持久。
// - 所有 IDB 失败都吞掉退化为"未命中 / 不写入"——缓存只是优化，绝不能阻断翻译。

import { SYSTEM_PROMPT } from './prompt';
import { MODEL } from './deepseek';

const DB_NAME = 'imt-translate-cache';
const STORE = 'blocks';
const DB_VERSION = 1;
const MAX_ENTRIES = 50000;

// 非加密快速哈希（cyrb53）：碰撞概率约 1/2^53，对内容寻址足够。
function cyrb53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hash = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return hash.toString(36);
}

// 版本前缀：模型 / 提示词任一变化 → 前缀变化 → 旧缓存自动失效。
const VERSION = cyrb53(MODEL + '\u0000' + SYSTEM_PROMPT);
const keyOf = (source: string) => `${VERSION}:${cyrb53(source)}`;

interface CacheRecord {
  key: string;
  t: string; // 译文
  a: number; // 最后访问时间（ms）
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'key' });
        store.createIndex('a', 'a');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/**
 * 批量查缓存：返回 source → 译文（仅命中项）；命中的同时刷新其最后访问时间（LRU）。
 * 任意失败都退化为"全未命中"。
 */
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
  await new Promise<void>((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE, 'readwrite');
    } catch {
      resolve();
      return;
    }
    const store = tx.objectStore(STORE);
    const now = Date.now();
    for (const src of uniq) {
      const g = store.get(keyOf(src));
      g.onsuccess = () => {
        const rec = g.result as CacheRecord | undefined;
        if (rec && typeof rec.t === 'string') {
          hits.set(src, rec.t);
          rec.a = now; // 刷新 LRU
          store.put(rec);
        }
      };
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
  return hits;
}

/**
 * 批量写入译文；写后若超出上限按 LRU 淘汰最久未用的。
 * 任意失败都静默退化为"不写入"。
 */
export async function cacheSetMany(entries: { source: string; translated: string }[]): Promise<void> {
  if (entries.length === 0) return;
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return;
  }
  await new Promise<void>((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE, 'readwrite');
    } catch {
      resolve();
      return;
    }
    const store = tx.objectStore(STORE);
    const now = Date.now();
    for (const e of entries) {
      const rec: CacheRecord = { key: keyOf(e.source), t: e.translated, a: now };
      store.put(rec);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
  await evictIfNeeded(db);
}

async function evictIfNeeded(db: IDBDatabase): Promise<void> {
  await new Promise<void>((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE, 'readwrite');
    } catch {
      resolve();
      return;
    }
    const store = tx.objectStore(STORE);
    const countReq = store.count();
    countReq.onsuccess = () => {
      const over = countReq.result - MAX_ENTRIES;
      if (over <= 0) return;
      // 按最后访问时间升序游标，删掉最旧的 over 条。
      let removed = 0;
      const cursorReq = store.index('a').openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor || removed >= over) return;
        cursor.delete();
        removed++;
        cursor.continue();
      };
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}
