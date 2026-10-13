/** 合成过的朗读留在本机。换题、刷新都还在；读完后再写入磁盘，清站点数据也能找回。 */

const DB_NAME = "pte-tts-audio";
const STORE = "clips";
const DB_VERSION = 1;
const LOCAL_TTS_PORT = "http://127.0.0.1:8767/tts-cache";

let dbPromise = null;
let persistPromise = null;
const inflight = new Map();

function cacheEndpoints() {
  // 桌面 Electron 版才会有本机磁盘缓存读写需求，
  // 网页版（包括 iPhone Capacitor）跳过 HTTP 端点，只走 indexedDB / 原生文件
  try {
    const isElectron = typeof navigator !== "undefined" &&
      /electron/i.test(navigator.userAgent || "") ||
      (typeof window !== "undefined" && window.process?.versions?.electron);
    if (!isElectron) return [];
  } catch (_) {}
  const targets = [];
  try {
    if (location.protocol === "http:" || location.protocol === "https:") {
      targets.push(`${location.origin}/tts-cache`);
    }
  } catch (_) {}
  if (!targets.includes(LOCAL_TTS_PORT)) targets.push(LOCAL_TTS_PORT);
  return targets;
}

function ensurePersistentStorage() {
  if (persistPromise) return persistPromise;
  persistPromise = (async () => {
    try {
      if (navigator.storage?.persist) await navigator.storage.persist();
    } catch (_) {}
  })();
  return persistPromise;
}

function bytesToBase64(bytes) {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

export function speechCacheKey(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function openDb() {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("no idb"));
  ensurePersistentStorage();
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        try { db.close(); } catch (_) {}
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error || new Error("idb"));
    };
  });
  return dbPromise;
}

function idbGet(key) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error || new Error("idb get"));
      })
  );
}

function idbPut(key, blob) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error("idb put"));
        tx.objectStore(STORE).put(blob, key);
      })
  );
}

export async function readSpeechClip(text) {
  const key = speechCacheKey(text);
  if (!key) return null;
  try {
    const blob = await idbGet(key);
    if (blob instanceof Blob && blob.size) return blob;
    return null;
  } catch (_) {
    return null;
  }
}

export async function writeSpeechClip(text, blob) {
  const key = speechCacheKey(text);
  if (!key || !(blob instanceof Blob) || !blob.size) return;
  try {
    await idbPut(key, blob);
  } catch (_) {}
}

async function readDiskSpeechClip(text) {
  const key = speechCacheKey(text);
  if (!key) return null;
  for (const url of cacheEndpoints()) {
    try {
      const res = await fetch(`${url}?text=${encodeURIComponent(key)}`);
      if (!res.ok) continue;
      const blob = await res.blob();
      if (blob.size) return blob.type ? blob : new Blob([blob], { type: "audio/mpeg" });
    } catch (_) {}
  }
  return null;
}

/* ---------- iPhone / Capacitor：音频文件存 App 沙盒，不会被浏览器存储回收 ---------- */

const NATIVE_DIR = "tts-cache";
const nativeKnown = new Set(); // 本次运行里确认已落盘的 key
const diskArchived = new Set(); // 本次运行里已推到桌面磁盘缓存的 key

function nativeFs() {
  try {
    const Cap = globalThis.Capacitor;
    if (!Cap?.isNativePlatform?.()) return null;
    return Cap.Plugins?.Filesystem || null;
  } catch (_) {
    return null;
  }
}

/** cyrb53：同一文本得到稳定文件名（不依赖 crypto.subtle） */
function clipFileName(key) {
  let h1 = 0xdeadbeef ^ key.length;
  let h2 = 0x41c6ce57 ^ key.length;
  for (let i = 0; i < key.length; i += 1) {
    const ch = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const id = (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
  return `${NATIVE_DIR}/${id}-${key.length}.mp3`;
}

async function readNativeClip(key) {
  const FS = nativeFs();
  if (!FS) return null;
  try {
    const res = await FS.readFile({ path: clipFileName(key), directory: "DATA" });
    const b64 = typeof res?.data === "string" ? res.data : "";
    if (!b64) return null;
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    if (!bytes.length) return null;
    nativeKnown.add(key);
    return new Blob([bytes], { type: "audio/mpeg" });
  } catch (_) {
    return null;
  }
}

async function writeNativeClip(key, blob) {
  const FS = nativeFs();
  if (!FS || nativeKnown.has(key)) return nativeKnown.has(key);
  try {
    const data = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
    await FS.writeFile({
      path: clipFileName(key),
      directory: "DATA",
      data,
      recursive: true,
    });
    nativeKnown.add(key);
    return true;
  } catch (err) {
    console.warn("[tts-cache] native write failed", err);
    return false;
  }
}

/** 把这段音频永久存到本机：浏览器库 + iPhone 沙盒文件 + 桌面磁盘缓存。 */
export async function archiveSpeechClip(text, blob) {
  const key = speechCacheKey(text);
  if (!key || !(blob instanceof Blob) || !blob.size) return false;
  await writeSpeechClip(key, blob);
  await ensurePersistentStorage();
  let saved = await writeNativeClip(key, blob);
  if (diskArchived.has(key)) return saved || true;
  const audioBase64 = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
  for (const url of cacheEndpoints()) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: key, audioBase64 }),
      });
      if (res.ok) {
        saved = true;
        diskArchived.add(key);
      }
    } catch (_) {}
  }
  return saved;
}

/** 纯查询：某个 key 的音频是否已在本机缓存（IDB / iPhone 沙盒 / 桌面磁盘）；不触发联网合成 */
export async function hasSpeechBlob(key) {
  const k = String(key || "").trim();
  if (!k) return false;
  if (inflight.has(k)) return true;
  if (nativeKnown.has(k)) return true;
  try {
    const idb = await idbGet(k);
    if (idb instanceof Blob && idb.size) return true;
  } catch (_) {}
  const FS = nativeFs();
  if (FS) {
    try {
      const stat = await FS.stat({ path: clipFileName(k), directory: "DATA" });
      if (stat?.size > 0) return true;
    } catch (_) {}
  }
  for (const url of cacheEndpoints()) {
    try {
      const res = await fetch(`${url}?text=${encodeURIComponent(k)}&head=1`, { method: "HEAD" });
      if (res.ok) return true;
    } catch (_) {}
  }
  return false;
}

/**
 * 先读浏览器库 → iPhone 沙盒文件 → 桌面磁盘缓存，都没有再联网合成。
 * 合成成功后立刻永久落盘（不等播放结束）。
 *
 * @param {string} text
 * @param {(onProgress?: (p:{ratio:number|null})=>void)=>Promise<Blob>} synthesize
 * @param {{onProgress?:(p:{phase:'cache'|'loading'|'saving'|'done', ratio:number|null})=>void}} [opts]
 *   phase=cache  命中本机缓存（无需下载）
 *   phase=loading 联网合成中，ratio 为 0~1；null 表示无法估算
 *   phase=saving 合成完，正在永久保存
 *   phase=done   已保存
 */
export function loadSpeechBlob(text, synthesize, opts = {}) {
  const key = speechCacheKey(text);
  if (!key) return Promise.resolve(null);
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;
  const existing = inflight.get(key);
  if (existing) {
    if (onProgress) existing.listeners.add(onProgress);
    return existing.promise;
  }
  const listeners = new Set();
  if (onProgress) listeners.add(onProgress);
  const emit = (p) => {
    for (const fn of listeners) {
      try { fn(p); } catch (_) {}
    }
  };
  const promise = (async () => {
    const hit = await readSpeechClip(key);
    if (hit) {
      // 浏览器库里有、沙盒里没有：悄悄补一份，防止被系统回收后丢失
      writeNativeClip(key, hit).catch(() => {});
      emit({ phase: "cache", ratio: 1 });
      return hit;
    }
    const nativeHit = await readNativeClip(key);
    if (nativeHit) {
      await writeSpeechClip(key, nativeHit);
      emit({ phase: "cache", ratio: 1 });
      return nativeHit;
    }
    const file = await readDiskSpeechClip(key);
    if (file) {
      await writeSpeechClip(key, file);
      writeNativeClip(key, file).catch(() => {});
      emit({ phase: "cache", ratio: 1 });
      return file;
    }
    emit({ phase: "loading", ratio: 0 });
    let blob = null;
    try {
      blob = await synthesize((p) => {
        const ratio = p && Number.isFinite(p.ratio) ? Math.max(0, Math.min(1, p.ratio)) : null;
        emit({ phase: "loading", ratio });
      });
    } catch (_) {
      // 直连微软 TTS 和 HTTP 代理链都失败时静默返回 null，交给调用方 fallback
      return null;
    }
    if (blob instanceof Blob && blob.size) {
      emit({ phase: "saving", ratio: 1 });
      await archiveSpeechClip(key, blob).catch(() => {});
      emit({ phase: "done", ratio: 1 });
    }
    return blob || null;
  })().finally(() => {
    const cur = inflight.get(key);
    if (cur && cur.promise === promise) inflight.delete(key);
  });
  inflight.set(key, { promise, listeners });
  return promise;
}

export async function deleteSpeechClips(texts) {
  const keys = [...new Set((texts || []).map(speechCacheKey).filter(Boolean))];
  if (!keys.length) return;
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("idb delete"));
      const store = tx.objectStore(STORE);
      for (const key of keys) store.delete(key);
    });
  } catch (_) {}
}
