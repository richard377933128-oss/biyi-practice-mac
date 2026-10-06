/** 用户导入的整篇全文音频（按题目 passageKey 存，优先于 TTS） */

const META_KEY = "biyi_full_article_audio";
const IDB_NAME = "pte-tts-audio";
const IDB_STORE = "clips";
const IDB_PREFIX = "full-article|";
const NATIVE_DIR = "full-audio";

function idbKey(passageKey) {
  return `${IDB_PREFIX}${String(passageKey || "").trim()}`;
}

function readMetaMap() {
  try {
    const raw = JSON.parse(localStorage.getItem(META_KEY) || "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch (_) {
    return {};
  }
}

function writeMetaMap(map) {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(map || {}));
  } catch (_) {}
}

export function getFullArticleAudioMeta(passageKey) {
  const key = String(passageKey || "").trim();
  if (!key) return null;
  const row = readMetaMap()[key];
  return row && typeof row === "object" ? row : null;
}

export function hasFullArticleAudio(passageKey) {
  return !!getFullArticleAudioMeta(passageKey);
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("idb"));
  });
}

async function idbPut(key, blob) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("idb put"));
    tx.objectStore(IDB_STORE).put(blob, key);
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error || new Error("idb get"));
  });
}

async function idbDelete(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("idb del"));
    tx.objectStore(IDB_STORE).delete(key);
  });
}

function nativeFs() {
  try {
    const Cap = globalThis.Capacitor;
    if (!Cap?.isNativePlatform?.()) return null;
    return Cap.Plugins?.Filesystem || null;
  } catch (_) {
    return null;
  }
}

function hashName(key) {
  let h1 = 0xdeadbeef ^ key.length;
  let h2 = 0x41c6ce57 ^ key.length;
  for (let i = 0; i < key.length; i += 1) {
    const ch = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

function extFromMime(mime, fileName = "") {
  const fromName = /\.([a-z0-9]+)$/i.exec(String(fileName || ""));
  if (fromName) return fromName[1].toLowerCase();
  const m = String(mime || "").toLowerCase();
  if (m.includes("wav") || m === "audio/wave" || m === "audio/x-wav") return "wav";
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return "m4a";
  if (m.includes("ogg")) return "ogg";
  if (m.includes("flac")) return "flac";
  return "mp3";
}

function normalizeAudioFile(file) {
  if (!(file instanceof Blob)) return file;
  const name = String(file.name || "audio");
  let mime = String(file.type || "").toLowerCase();
  if (!mime || mime === "application/octet-stream") {
    if (/\.wav$/i.test(name)) mime = "audio/wav";
    else if (/\.wave$/i.test(name)) mime = "audio/wav";
    else if (/\.m4a$/i.test(name)) mime = "audio/mp4";
    else if (/\.aac$/i.test(name)) mime = "audio/aac";
    else if (/\.mp3$/i.test(name)) mime = "audio/mpeg";
    else if (/\.ogg$/i.test(name)) mime = "audio/ogg";
    else if (/\.flac$/i.test(name)) mime = "audio/flac";
    else if (/\.mp4$/i.test(name)) mime = "audio/mp4";
    else mime = "audio/mpeg";
  }
  if (mime === "audio/x-wav" || mime === "audio/wave") mime = "audio/wav";
  if (file.type === mime && typeof File !== "undefined" && file instanceof File) return file;
  if (typeof File !== "undefined") return new File([file], name, { type: mime });
  return new Blob([file], { type: mime });
}

function bytesToBase64(bytes) {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  const bin = atob(String(b64 || ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function writeNative(passageKey, blob, fileName) {
  const Fs = nativeFs();
  if (!Fs) return null;
  const key = String(passageKey || "").trim();
  const ext = extFromMime(blob.type, fileName);
  const path = `${NATIVE_DIR}/${hashName(key)}.${ext}`;
  try {
    await Fs.mkdir({ path: NATIVE_DIR, directory: "DATA", recursive: true });
  } catch (_) {}
  const audioBase64 = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
  await Fs.writeFile({ path, data: audioBase64, directory: "DATA" });
  return { path, ext };
}

async function readNative(meta) {
  const Fs = nativeFs();
  if (!Fs || !meta?.nativePath) return null;
  try {
    const res = await Fs.readFile({ path: meta.nativePath, directory: "DATA" });
    const bytes = base64ToBytes(res.data);
    if (!bytes.length) return null;
    return new Blob([bytes], { type: meta.mime || "audio/mpeg" });
  } catch (_) {
    return null;
  }
}

async function deleteNative(meta) {
  const Fs = nativeFs();
  if (!Fs || !meta?.nativePath) return;
  try {
    await Fs.deleteFile({ path: meta.nativePath, directory: "DATA" });
  } catch (_) {}
}

export async function saveFullArticleAudio(passageKey, file) {
  const key = String(passageKey || "").trim();
  if (!key) throw new Error("当前没有题目");
  const normalized = normalizeAudioFile(file);
  if (!(normalized instanceof Blob) || !normalized.size) throw new Error("请选择音频文件");
  const mime = normalized.type || "audio/mpeg";
  const fileName = String(normalized.name || file?.name || "full-audio").slice(0, 120);
  await idbPut(idbKey(key), normalized);
  let nativePath = "";
  try {
    const native = await writeNative(key, normalized, fileName);
    nativePath = native?.path || "";
  } catch (err) {
    console.warn(err);
  }
  const map = readMetaMap();
  map[key] = {
    fileName,
    mime,
    size: normalized.size,
    at: Date.now(),
    nativePath,
  };
  writeMetaMap(map);
  return map[key];
}

export async function loadFullArticleAudioBlob(passageKey) {
  const key = String(passageKey || "").trim();
  if (!key) return null;
  const meta = getFullArticleAudioMeta(key);
  if (!meta) return null;
  try {
    const hit = await idbGet(idbKey(key));
    if (hit instanceof Blob && hit.size) {
      if (!hit.type && meta.mime) return new Blob([hit], { type: meta.mime });
      return hit;
    }
  } catch (_) {}
  const native = await readNative(meta);
  if (native) {
    try {
      await idbPut(idbKey(key), native);
    } catch (_) {}
    return native;
  }
  return null;
}

export async function deleteFullArticleAudio(passageKey) {
  const key = String(passageKey || "").trim();
  if (!key) return;
  const map = readMetaMap();
  const meta = map[key];
  delete map[key];
  writeMetaMap(map);
  try {
    await idbDelete(idbKey(key));
  } catch (_) {}
  await deleteNative(meta);
}

/**
 * 用 HTMLAudioElement 播整篇导入音频（按时长比例近似跳转）。
 * @returns {{ pause:()=>void, resume:()=>void, stop:()=>void, isPaused:()=>boolean, audio:HTMLAudioElement }}
 */
export function playImportedFullAudio(blob, { startRatio = 0, onTime, onEnded, onError } = {}) {
  if (!(blob instanceof Blob) || !blob.size) throw new Error("没有可播放的音频");
  const url = URL.createObjectURL(blob);
  const audio = new Audio();
  audio.preload = "auto";
  audio.src = url;
  let stopped = false;
  let seekDone = false;

  const cleanup = () => {
    try {
      audio.pause();
    } catch (_) {}
    try {
      audio.removeAttribute("src");
      audio.load();
    } catch (_) {}
    URL.revokeObjectURL(url);
  };

  const emitTime = () => {
    if (stopped) return;
    const currentTime = audio.currentTime || 0;
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    onTime?.({ currentTime, duration });
  };

  const onTimeUpdate = () => emitTime();

  const onEndedInner = () => {
    if (stopped) return;
    stopped = true;
    audio.removeEventListener("timeupdate", onTimeUpdate);
    cleanup();
    onEnded?.();
  };

  const onErrorInner = () => {
    if (stopped) return;
    stopped = true;
    audio.removeEventListener("timeupdate", onTimeUpdate);
    const err = new Error("导入音频播放失败");
    cleanup();
    onError?.(err);
  };

  const applyStart = () => {
    if (stopped || seekDone) return;
    const ratio = Math.max(0, Math.min(0.98, Number(startRatio) || 0));
    if (ratio > 0 && Number.isFinite(audio.duration) && audio.duration > 0) {
      try {
        audio.currentTime = audio.duration * ratio;
      } catch (_) {}
    }
    seekDone = true;
    emitTime();
  };

  audio.addEventListener("timeupdate", onTimeUpdate);
  audio.addEventListener("ended", onEndedInner, { once: true });
  audio.addEventListener("error", onErrorInner, { once: true });
  audio.addEventListener("loadedmetadata", applyStart, { once: true });

  const playPromise = audio.play();
  if (playPromise?.catch) {
    playPromise.catch((err) => {
      if (!stopped) onErrorInner(err);
    });
  }

  return {
    audio,
    pause: () => {
      try {
        audio.pause();
      } catch (_) {}
    },
    resume: () => {
      audio.play()?.catch?.(() => {});
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      audio.removeEventListener("timeupdate", onTimeUpdate);
      cleanup();
    },
    isPaused: () => !!audio.paused && !audio.ended,
  };
}
