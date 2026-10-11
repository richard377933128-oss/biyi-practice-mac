/** 个人难词本：点单词气泡「添加」后可随时在「词典」里查 */

import { kvGet, kvSet, kvRemove } from "./lib/kv-store.js?v=20261011nowrap1";

const KEY = "biyi_wordbook";
const AUTH_KEY = "biyi_wordbook_auth";
const SYNC_AT_KEY = "biyi_wordbook_sync_at";
const SHOW_LIMIT = 800;
/** 指针库：按密钥哈希存最新词本地址；大对象另存，避开公共 API 日限额 */
const POINTER_BUCKET = "biyixunlian";
const POINTER_BASE = "https://keyvalue.immanuel.co/api/KeyVal";
const BLOB_BASE = "https://bytebin.lucko.me";

function normalize(word) {
  return String(word || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z'-]+/g, "");
}

function readRaw() {
  try {
    const raw = JSON.parse(kvGet(KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw;
  } catch (_) {
    return [];
  }
}

function hydrate(item) {
  if (item && typeof item.word === "string") {
    return {
      word: item.word,
      phonetic: String(item.phonetic || ""),
      gloss: String(item.gloss || ""),
      addedAt: Number(item.addedAt) || 0,
    };
  }
  if (Array.isArray(item) && typeof item[0] === "string") {
    return {
      word: item[0],
      phonetic: String(item[1] || ""),
      gloss: String(item[2] || ""),
      addedAt: Number(item[3]) || 0,
    };
  }
  return null;
}

function compact(item) {
  return [item.word, item.phonetic || "", item.gloss || "", item.addedAt || 0];
}

export function listWords() {
  return readRaw()
    .map(hydrate)
    .filter((x) => x && x.word.trim());
}

function saveWords(list, { toast } = {}) {
  const clipped = list.map(compact);
  kvSet(KEY, JSON.stringify(clipped));
  return true;
}

export function hasWord(word) {
  const key = normalize(word);
  if (!key) return false;
  return listWords().some((x) => normalize(x.word) === key);
}

export function addWord(entry, opts = {}) {
  const word = String(entry?.word || "").trim();
  const key = normalize(word);
  if (!key) return false;
  const phonetic = String(entry?.phonetic || "").trim();
  const gloss = String(entry?.gloss || "").trim();
  const rest = listWords().filter((x) => normalize(x.word) !== key);
  rest.unshift({ word, phonetic, gloss, addedAt: Date.now() });
  return saveWords(rest, opts);
}

export function removeWord(word, opts = {}) {
  const key = normalize(word);
  if (!key) return false;
  const next = listWords().filter((x) => normalize(x.word) !== key);
  return saveWords(next, opts);
}

function richerText(a, b) {
  const x = String(a || "").trim();
  const y = String(b || "").trim();
  if (!x) return y;
  if (!y) return x;
  if (y.length !== x.length) return y.length > x.length ? y : x;
  return y.localeCompare(x) > 0 ? y : x;
}

/** 两边按单词并集：同词不重复，释义/音标取更完整的一侧；删除不会传到另一端 */
export function unionWords(local, incoming) {
  const map = new Map();
  for (const item of [...(local || []), ...(incoming || [])]) {
    const hydrated = hydrate(item);
    if (!hydrated) continue;
    const key = normalize(hydrated.word);
    if (!key) continue;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, hydrated);
      continue;
    }
    map.set(key, {
      word: prev.word || hydrated.word,
      phonetic: richerText(prev.phonetic, hydrated.phonetic),
      gloss: richerText(prev.gloss, hydrated.gloss),
      addedAt: Math.max(Number(prev.addedAt) || 0, Number(hydrated.addedAt) || 0),
    });
  }
  return [...map.values()].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
}

function parseWordbookPayload(raw) {
  let data = raw;
  if (typeof raw === "string") {
    const text = raw.trim();
    if (!text) return [];
    data = JSON.parse(text);
  }
  if (data && typeof data === "object" && !Array.isArray(data)) {
    if (data.data && typeof data.data === "object") data = data.data;
    if (Array.isArray(data.words)) data = data.words;
    else return [];
  }
  if (!Array.isArray(data)) return [];
  return data.map(hydrate).filter((x) => x && x.word.trim());
}

export function exportWordbookPayload() {
  return {
    kind: "biyi-wordbook",
    version: 1,
    exportedAt: Date.now(),
    words: listWords().map(compact),
  };
}

export function normalizeSecret(raw) {
  return String(raw || "").trim();
}

/** 128 位熵，分组便于核对；不含 0/O/1/I/l */
export function generateRandomSecret() {
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const needed = 20;
  let out = "";
  while (out.length < needed) {
    const bytes = crypto.getRandomValues(new Uint8Array(needed * 2));
    const limit = Math.floor(256 / alphabet.length) * alphabet.length;
    for (let i = 0; i < bytes.length && out.length < needed; i += 1) {
      if (bytes[i] < limit) out += alphabet[bytes[i] % alphabet.length];
    }
  }
  return `${out.slice(0, 5)}-${out.slice(5, 10)}-${out.slice(10, 15)}-${out.slice(15, 20)}`;
}

function tryExecCopy(text, selectEl) {
  const value = String(text || "");
  if (!value) return false;
  try {
    if (selectEl) {
      selectEl.focus();
      selectEl.select();
      selectEl.setSelectionRange(0, value.length);
      if (document.execCommand("copy")) return true;
    }
  } catch (_) {}
  try {
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "0";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch (_) {
    return false;
  }
}

async function copyToClipboard(text, selectEl) {
  const value = String(text || "");
  if (!value) return false;
  if (tryExecCopy(value, selectEl)) return true;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch (_) {
    return false;
  }
}

async function shareSecret(text) {
  const value = String(text || "");
  if (!value) return false;
  try {
    const Share = window.Capacitor?.Plugins?.Share;
    if (Share?.share) {
      await Share.share({
        title: "词典同步密钥",
        text: value,
        dialogTitle: "发给另一台设备",
      });
      return true;
    }
  } catch (err) {
    if (/AbortError|canceled|cancelled|分享已取消/i.test(String(err?.message || err))) return true;
  }
  try {
    if (navigator.share) {
      await navigator.share({ title: "词典同步密钥", text: value });
      return true;
    }
  } catch (err) {
    if (/AbortError|canceled|cancelled/i.test(String(err?.name || err?.message || err))) return true;
  }
  return copyToClipboard(value);
}

function readAuthHex() {
  const hex = String(kvGet(AUTH_KEY) || "").trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : "";
}

function saveAuthHex(authHex) {
  if (authHex) kvSet(AUTH_KEY, authHex);
  else kvRemove(AUTH_KEY);
  kvRemove("biyi_wordbook_account");
}

export function clearSavedSecret() {
  saveAuthHex("");
}

function readSyncAt() {
  const n = Number(kvGet(SYNC_AT_KEY) || 0);
  return Number.isFinite(n) ? n : 0;
}

function saveSyncAt(ts = Date.now()) {
  kvSet(SYNC_AT_KEY, String(ts));
}

function formatSyncAt(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function bytesToB64(bytes) {
  let bin = "";
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i += 1) bin += String.fromCharCode(arr[i]);
  return btoa(bin);
}

function b64ToBytes(b64) {
  const bin = atob(String(b64 || ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function secretToAuth(secret) {
  const key = normalizeSecret(secret);
  if (key.length < 4) return null;
  const hex = await sha256Hex(`biyi-wordbook-key-v1\n${key}`);
  return hex;
}

async function importAesKey(authHex) {
  const raw = new Uint8Array(authHex.match(/.{2}/g).map((h) => parseInt(h, 16)));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptPayload(payload, authHex) {
  const key = await importAesKey(authHex);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(JSON.stringify(payload))
  );
  return { v: 1, iv: bytesToB64(iv), ct: bytesToB64(ct) };
}

async function decryptPayload(blob, authHex) {
  if (!blob) return [];
  if (blob && typeof blob === "object" && Array.isArray(blob.words)) {
    return parseWordbookPayload(blob);
  }
  if (!blob || blob.v !== 1 || !blob.iv || !blob.ct) {
    const err = new Error("bad-vault");
    err.code = "bad-vault";
    throw err;
  }
  try {
    const key = await importAesKey(authHex);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64ToBytes(blob.iv) },
      key,
      b64ToBytes(blob.ct)
    );
    return parseWordbookPayload(JSON.parse(new TextDecoder().decode(pt)));
  } catch (err) {
    const e = new Error("bad-password");
    e.code = "bad-password";
    e.cause = err;
    throw e;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryableStatus(status) {
  return status === 403 || status === 408 || status === 425 || status === 429 || status >= 500;
}

async function cloudFetch(url, opts = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const res = await fetch(url, {
        ...opts,
        headers: {
          Accept: "application/json",
          ...(opts.body ? { "Content-Type": "application/json" } : {}),
          ...(opts.headers || {}),
        },
      });
      if (res.status === 404) {
        const err = new Error("not-found");
        err.code = 404;
        throw err;
      }
      if (!res.ok) {
        const err = new Error(`http ${res.status}`);
        err.status = res.status;
        err.code = "http";
        if (attempt < 3 && isRetryableStatus(res.status)) {
          lastErr = err;
          await sleep(350 * (attempt + 1) * (attempt + 1));
          continue;
        }
        throw err;
      }
      if (res.status === 204) return null;
      const text = await res.text();
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch (_) {
        return text;
      }
    } catch (err) {
      if (err?.code === 404 || err?.code === "http") throw err;
      lastErr = err;
      if (attempt >= 3) break;
      await sleep(350 * (attempt + 1) * (attempt + 1));
    }
  }
  const e = new Error(lastErr?.message || "network");
  e.code = "network";
  e.cause = lastErr;
  throw e;
}

function pointerUrl(authHex, value) {
  const key = encodeURIComponent(authHex);
  if (value == null) return `${POINTER_BASE}/GetValue/${POINTER_BUCKET}/${key}`;
  return `${POINTER_BASE}/UpdateValue/${POINTER_BUCKET}/${key}/${encodeURIComponent(value)}`;
}

async function readPointer(authHex) {
  try {
    const raw = await cloudFetch(pointerUrl(authHex));
    const text = raw == null ? "" : String(raw).trim();
    return /^[A-Za-z0-9_-]{4,64}$/.test(text) ? text : "";
  } catch (err) {
    if (err?.code === 404) return "";
    throw err;
  }
}

async function writePointer(authHex, blobKey) {
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const res = await fetch(pointerUrl(authHex, blobKey), {
        method: "POST",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        const err = new Error(`http ${res.status}`);
        err.status = res.status;
        err.code = "http";
        if (attempt < 3 && isRetryableStatus(res.status)) {
          lastErr = err;
          await sleep(350 * (attempt + 1) * (attempt + 1));
          continue;
        }
        throw err;
      }
      return;
    } catch (err) {
      if (err?.code === "http") throw err;
      lastErr = err;
      if (attempt >= 3) break;
      await sleep(350 * (attempt + 1) * (attempt + 1));
    }
  }
  const e = new Error(lastErr?.message || "network");
  e.code = "network";
  e.cause = lastErr;
  throw e;
}

async function readBlob(blobKey) {
  if (!blobKey) return null;
  try {
    return await cloudFetch(`${BLOB_BASE}/${encodeURIComponent(blobKey)}`);
  } catch (err) {
    if (err?.code === 404) return null;
    throw err;
  }
}

async function writeBlob(payload) {
  const data = await cloudFetch(`${BLOB_BASE}/post`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  const key = data && typeof data === "object" ? String(data.key || "").trim() : "";
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(key)) {
    const err = new Error("bad-blob");
    err.code = "network";
    throw err;
  }
  return key;
}

export async function syncWordbookCloud({ secret, toast } = {}) {
  let authHex = readAuthHex();
  if (secret) {
    const hex = await secretToAuth(secret);
    if (!hex) {
      const err = new Error("need-secret");
      err.code = "need-secret";
      throw err;
    }
    authHex = hex;
  }
  if (!authHex) {
    const err = new Error("need-secret");
    err.code = "need-secret";
    throw err;
  }

  const before = listWords();
  const blobKey = await readPointer(authHex);
  const remoteBlob = await readBlob(blobKey);
  const incoming = remoteBlob ? await decryptPayload(remoteBlob, authHex) : [];
  const next = unionWords(before, incoming);
  if (!saveWords(next, { toast })) {
    return { ok: false, added: 0, total: before.length };
  }
  const vaultBlob = await encryptPayload(exportWordbookPayload(), authHex);
  const nextKey = await writeBlob(vaultBlob);
  await writePointer(authHex, nextKey);
  saveAuthHex(authHex);
  saveSyncAt();
  const beforeKeys = new Set(before.map((x) => normalize(x.word)));
  const added = next.filter((x) => !beforeKeys.has(normalize(x.word))).length;
  return { ok: true, added, total: next.length, incoming: incoming.length };
}

export function bindWordbook({ $, toast, speakWord } = {}) {
  const page = $("#view-wordbook");
  const practice = $("#view-practice");
  const listEl = $("#wordbook-list");
  const searchEl = $("#wordbook-search");
  const emptyEl = $("#wordbook-empty");
  const countEl = $("#wordbook-count");
  const keyEl = $("#wordbook-secret");
  const generatedEl = $("#wordbook-generated");
  const setupEl = $("#wordbook-setup");
  const statusEl = $("#wordbook-sync-status");
  const syncBtn = $("#btn-wordbook-sync");
  const logoutBtn = $("#btn-wordbook-logout");
  const generateBtn = $("#btn-wordbook-generate");
  const copyBtn = $("#btn-wordbook-copy");
  const shareBtn = $("#btn-wordbook-share");
  let syncing = false;

  function setStatus(text) {
    if (!statusEl) return;
    const msg = String(text || "").trim();
    statusEl.hidden = !msg;
    statusEl.textContent = msg;
  }

  function paintSession() {
    const loggedIn = !!readAuthHex();
    setupEl?.classList.toggle("hidden", loggedIn);
    logoutBtn?.classList.toggle("hidden", !loggedIn);
    if (keyEl && !loggedIn && keyEl !== document.activeElement) {
      keyEl.placeholder = "生成侧点复制会自动填入；另一台粘贴这里";
    }
    const at = readSyncAt();
    if (loggedIn && at) setStatus(`本机已保存密钥 · 上次同步 ${formatSyncAt(at)}`);
    else if (loggedIn) setStatus("本机已保存密钥，点「同步」拉取并集");
    else setStatus("生成密钥 → 复制（本机填入）→ 发给对方粘贴后同步");
  }

  function close() {
    page?.classList.add("hidden");
    practice?.classList.remove("hidden");
    window.scrollTo(0, 0);
  }

  function open() {
    if (!page) return;
    if (searchEl) searchEl.value = "";
    practice?.classList.add("hidden");
    page.classList.remove("hidden");
    paintSession();
    render();
    window.scrollTo(0, 0);
    if (readAuthHex()) searchEl?.focus();
    else keyEl?.focus();
  }

  function render() {
    if (!listEl) return;
    const q = String(searchEl?.value || "")
      .trim()
      .toLowerCase();
    const all = listWords();
    const rows = q
      ? all.filter(
          (x) =>
            String(x.word || "").toLowerCase().includes(q) ||
            String(x.gloss || "").toLowerCase().includes(q)
        )
      : all;
    const shown = rows.slice(0, SHOW_LIMIT);
    listEl.replaceChildren();
    if (emptyEl) emptyEl.hidden = all.length > 0;
    if (countEl) {
      if (!all.length) {
        countEl.hidden = true;
        countEl.textContent = "";
      } else {
        countEl.hidden = false;
        if (q) {
          countEl.textContent =
            rows.length > SHOW_LIMIT
              ? `找到 ${rows.length} 个，先显示前 ${SHOW_LIMIT} 个`
              : `找到 ${rows.length} 个`;
        } else if (all.length > SHOW_LIMIT) {
          countEl.textContent = `共 ${all.length} 个词，先显示最近 ${SHOW_LIMIT} 个，搜索可查找全部`;
        } else {
          countEl.textContent = `共 ${all.length} 个词`;
        }
      }
    }
    if (!shown.length) {
      if (all.length) {
        const none = document.createElement("p");
        none.className = "wordbook-none";
        none.textContent = "没有匹配的词";
        listEl.appendChild(none);
      }
      return;
    }
    for (const item of shown) {
      const row = document.createElement("div");
      row.className = "wordbook-row";
      const main = document.createElement("button");
      main.type = "button";
      main.className = "wordbook-main";
      main.title = "点读这个词";
      const w = document.createElement("strong");
      w.className = "wordbook-word";
      w.textContent = item.word;
      main.appendChild(w);
      if (item.phonetic) {
        const p = document.createElement("span");
        p.className = "wordbook-phonetic";
        p.textContent = `/${item.phonetic.replace(/^\/+|\/+$/g, "")}/`;
        main.appendChild(p);
      }
      if (item.gloss) {
        const g = document.createElement("span");
        g.className = "wordbook-gloss";
        g.textContent = item.gloss;
        main.appendChild(g);
      }
      main.addEventListener("click", () => {
        speakWord?.(item.word);
      });
      const del = document.createElement("button");
      del.type = "button";
      del.className = "wordbook-del";
      del.textContent = "删除";
      del.title = `从词典去掉 ${item.word}`;
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        removeWord(item.word, { toast });
        render();
        toast?.(`已去掉 ${item.word}`);
      });
      row.append(main, del);
      listEl.appendChild(row);
    }
  }

  async function runSync() {
    if (syncing) return;
    const secret = normalizeSecret(keyEl?.value || "");
    if (!readAuthHex() && secret.length < 4) {
      toast?.(secret ? "密钥至少 4 个字" : "先填密钥");
      keyEl?.focus();
      return;
    }
    syncing = true;
    if (syncBtn) syncBtn.disabled = true;
    setStatus("正在同步…");
    try {
      const result = await syncWordbookCloud({ secret, toast });
      if (keyEl) keyEl.value = "";
      paintSession();
      render();
      if (!result.ok) {
        toast?.("同步失败");
        setStatus("同步失败，本机词还在");
        return;
      }
      if (result.added) toast?.(`已并入 ${result.added} 个新词，现共 ${result.total} 个`);
      else toast?.(`已同步，共 ${result.total} 个词`);
    } catch (err) {
      console.warn(err);
      if (err?.code === "need-secret") {
        toast?.("先填密钥");
        setStatus("先填同一条密钥");
      } else if (err?.code === "bad-password" || err?.code === "bad-vault") {
        toast?.("密钥不对");
        setStatus("密钥不对");
      } else if (err?.status) {
        toast?.(`云端暂时不可用（${err.status}），稍后再试`);
        setStatus(`联网失败 ${err.status}，本机词还在`);
      } else {
        toast?.("联网同步失败，稍后再点一次同步");
        setStatus("联网失败，本机词还在；可再试");
      }
    } finally {
      syncing = false;
      if (syncBtn) syncBtn.disabled = false;
    }
  }

  $("#btn-wordbook")?.addEventListener("click", () => open());
  $("#btn-wordbook-close")?.addEventListener("click", () => close());
  searchEl?.addEventListener("input", () => render());
  syncBtn?.addEventListener("click", () => {
    runSync().catch((err) => console.warn(err));
  });
  generateBtn?.addEventListener("click", () => {
    if (!generatedEl) return;
    generatedEl.value = generateRandomSecret();
    generatedEl.focus();
    generatedEl.select();
    toast?.("已生成，点「复制」填入本机并可发给对方");
  });
  copyBtn?.addEventListener("click", () => {
    const value = normalizeSecret(generatedEl?.value || "");
    if (!value) {
      toast?.("先点「生成密钥」");
      generateBtn?.focus();
      return;
    }
    if (keyEl) keyEl.value = value;
    copyToClipboard(value, generatedEl).then((ok) => {
      toast?.(
        ok
          ? "已填入本机并复制，可粘贴发给另一台"
          : "已填入本机；复制失败请长按密钥，或点「发给对方」"
      );
    });
  });
  shareBtn?.addEventListener("click", () => {
    const value = normalizeSecret(generatedEl?.value || "");
    if (!value) {
      toast?.("先点「生成密钥」");
      generateBtn?.focus();
      return;
    }
    if (keyEl) keyEl.value = value;
    shareSecret(value).then((ok) => {
      toast?.(ok ? "已填入本机并打开分享" : "已填入本机；分享不可用，请复制后自行发给对方");
    });
  });
  logoutBtn?.addEventListener("click", () => {
    clearSavedSecret();
    if (keyEl) keyEl.value = "";
    paintSession();
    toast?.("已清除本机密钥，词还在");
  });
  keyEl?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    runSync().catch((err) => console.warn(err));
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!page || page.classList.contains("hidden")) return;
    e.preventDefault();
    close();
  });
}
