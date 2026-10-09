/**
 * IndexedDB 写穿缓存 KV 存储。
 *
 * 背景：WKWebView 的 localStorage 上限约 5MB 且超限静默写入失败（数据丢失无报错）。
 * 这里把大键值（词库、自定义文本）挪到 IndexedDB：启动时一次性读进内存 Map，
 * 之后 kvGet/kvSet 都是同步 API（写操作后台刷盘），调用方无需改成 async。
 * IndexedDB 不可用（隐私模式等极端情况）时自动回退 localStorage。
 *
 * 使用约定：
 *   1. app 启动时先 await initKvStore([...要迁移的 localStorage key])
 *   2. 之后所有读写走 kvGet / kvSet / kvRemove
 */

const DB_NAME = "biyi-kv";
const STORE = "kv";

let db = null; // null = IndexedDB 不可用或未初始化
let useLocal = false; // IndexedDB 不可用时为 true
const mem = new Map();
let initPromise = null;

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("indexedDB open failed"));
  });
}

function idbPut(key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function idbDelete(key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function idbGetAll() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    const keysReq = store.getAllKeys();
    const valsReq = store.getAll();
    tx.oncomplete = () => resolve([keysReq.result || [], valsReq.result || []]);
    tx.onerror = () => reject(tx.error);
  });
}

/** 后台刷盘；失败只告警，不打扰调用方（内存副本仍在，下次启动前一般不丢） */
function flushSet(key, value) {
  idbPut(key, value).catch((err) => console.warn("[kv-store] 写入 IndexedDB 失败", key, err));
}
function flushDel(key) {
  idbDelete(key).catch((err) => console.warn("[kv-store] 删除 IndexedDB 失败", key, err));
}

/**
 * 初始化：打开 IndexedDB、全量读入内存；
 * migrateKeys 里列出的 localStorage 旧 key，若 IndexedDB 没有则迁移过来并删掉 localStorage 副本。
 * 必须在首次 kvGet 之前 await。
 */
export function initKvStore(migrateKeys = []) {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      db = await idbOpen();
      const [keys, vals] = await idbGetAll();
      keys.forEach((k, i) => mem.set(String(k), vals[i]));
    } catch (err) {
      console.warn("[kv-store] IndexedDB 不可用，回退 localStorage", err);
      db = null;
      useLocal = true;
    }
    // 旧 localStorage 数据迁移
    for (const key of migrateKeys) {
      let legacy = null;
      try {
        legacy = localStorage.getItem(key);
      } catch (_) {}
      if (legacy == null) continue;
      if (useLocal) {
        mem.set(key, legacy); // 回退模式下仍从 localStorage 读，无需搬运
        continue;
      }
      if (!mem.has(key)) {
        mem.set(key, legacy);
        try {
          await idbPut(key, legacy);
          localStorage.removeItem(key);
        } catch (err) {
          console.warn("[kv-store] 迁移失败，保留 localStorage 副本", key, err);
        }
      } else {
        // IndexedDB 已有新数据：清掉旧副本，避免下次启动重复判断
        try {
          localStorage.removeItem(key);
        } catch (_) {}
      }
    }
  })();
  return initPromise;
}

export function kvGet(key) {
  if (mem.has(key)) return mem.get(key);
  if (useLocal) {
    try {
      return localStorage.getItem(key);
    } catch (_) {
      return null;
    }
  }
  return null;
}

export function kvSet(key, value) {
  const v = String(value);
  mem.set(key, v);
  if (useLocal) {
    try {
      localStorage.setItem(key, v);
    } catch (err) {
      console.warn("[kv-store] localStorage 写入失败（可能超限）", key, err);
    }
    return;
  }
  if (db) flushSet(key, v);
}

export function kvRemove(key) {
  mem.delete(key);
  if (useLocal) {
    try {
      localStorage.removeItem(key);
    } catch (_) {}
    return;
  }
  if (db) flushDel(key);
}
