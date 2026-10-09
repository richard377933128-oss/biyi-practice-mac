/** 英文点词：内置离线词典（ECDICT 分片）+ 可选联网兜底 */

const cache = new Map();
const CACHE_MAX = 500;
const DICT_BASE = new URL("../data/en-dict/", import.meta.url);
const WORD_RE = /^[a-z][a-z'-]{0,21}$/;

const shardCache = new Map(); // letter -> Promise<Record>
let formsPromise = null;
let indexPromise = null;

let tipEl = null;
let tipHideTimer = 0;
let tipSeq = 0;

function normalizeWord(raw) {
  return String(raw || "")
    .trim()
    .replace(/^[^A-Za-z']+|[^A-Za-z']+$/g, "")
    .toLowerCase();
}

function isNativeApp() {
  const Cap = typeof window !== "undefined" ? window.Capacitor : null;
  return !!(Cap?.isNativePlatform && Cap.isNativePlatform());
}

async function fetchText(url) {
  const res = await fetch(url, { method: "GET", cache: "force-cache" });
  if (!res.ok) throw new Error(`dict http ${res.status}`);
  return res;
}

async function fetchJsonGz(url) {
  const res = await fetchText(url);
  if (typeof DecompressionStream === "undefined") {
    throw new Error("gzip unsupported");
  }
  const stream = res.body.pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).json();
}

async function fetchJson(url) {
  const res = await fetchText(url);
  return res.json();
}

async function loadIndex() {
  if (!indexPromise) {
    indexPromise = fetchJson(new URL("index.json", DICT_BASE).href).catch((err) => {
      indexPromise = null;
      throw err;
    });
  }
  return indexPromise;
}

async function loadForms() {
  if (!formsPromise) {
    formsPromise = (async () => {
      const index = await loadIndex().catch(() => null);
      const file = index?.forms || "forms.json.gz";
      const url = new URL(file, DICT_BASE).href;
      if (file.endsWith(".gz")) return fetchJsonGz(url);
      return fetchJson(url);
    })().catch((err) => {
      formsPromise = null;
      throw err;
    });
  }
  return formsPromise;
}

async function loadShard(letter) {
  const key = String(letter || "").toLowerCase();
  if (!/^[a-z]$/.test(key)) return null;
  if (!shardCache.has(key)) {
    const p = (async () => {
      const index = await loadIndex().catch(() => null);
      const meta = index?.shards?.[key];
      const file = meta?.file || `${key}.json.gz`;
      const url = new URL(file, DICT_BASE).href;
      if (String(file).endsWith(".gz")) return fetchJsonGz(url);
      return fetchJson(url);
    })().catch((err) => {
      shardCache.delete(key);
      throw err;
    });
    shardCache.set(key, p);
  }
  return shardCache.get(key);
}

function packInfo(word, phonetic, gloss) {
  const p = String(phonetic || "").trim().replace(/ә/g, "ə");
  const g = String(gloss || "").trim();
  if (!p && !g) return null;
  return { word, phonetic: p, gloss: g, offline: true };
}

function readEntry(map, word) {
  if (!map || !word) return null;
  const row = map[word];
  if (!row) return null;
  if (Array.isArray(row)) return packInfo(word, row[0], row[1]);
  if (typeof row === "object") return packInfo(word, row.p || row.phonetic, row.g || row.gloss || row.t);
  return null;
}

function stemCandidates(word) {
  const out = [];
  const push = (w) => {
    if (w && w !== word && WORD_RE.test(w) && !out.includes(w)) out.push(w);
  };
  if (word.endsWith("'s") && word.length > 3) push(word.slice(0, -2));
  if (word.endsWith("ies") && word.length > 4) push(`${word.slice(0, -3)}y`);
  if (word.endsWith("ves") && word.length > 4) {
    push(`${word.slice(0, -3)}f`);
    push(`${word.slice(0, -3)}fe`);
  }
  if (word.endsWith("ing") && word.length > 5) {
    push(word.slice(0, -3));
    push(`${word.slice(0, -3)}e`);
    if (word.length > 6 && word.at(-4) === word.at(-5)) push(word.slice(0, -4));
  }
  if (word.endsWith("ed") && word.length > 4) {
    push(word.slice(0, -2));
    push(`${word.slice(0, -1)}`);
    if (word.length > 5 && word.at(-3) === word.at(-4)) push(word.slice(0, -3));
  }
  if (word.endsWith("es") && word.length > 4) push(word.slice(0, -2));
  if (word.endsWith("s") && word.length > 3 && !word.endsWith("ss")) push(word.slice(0, -1));
  return out;
}

async function lookupOffline(word) {
  const forms = await loadForms().catch(() => ({}));
  const base = forms?.[word] && WORD_RE.test(forms[word]) ? forms[word] : null;
  const tryWords = [word];
  if (base) tryWords.push(base);
  for (const s of stemCandidates(word)) tryWords.push(s);

  let best = null;
  for (const w of tryWords) {
    const shard = await loadShard(w[0]).catch(() => null);
    const info = readEntry(shard, w);
    if (!info) continue;
    if (!best) best = { ...info, word: w === word ? w : word };
    // 屈折词缺音标时，用原形音标补上
    if (best && !best.phonetic && info.phonetic && w !== word) {
      best = { ...best, phonetic: info.phonetic };
    }
    if (best?.phonetic && best?.gloss) break;
  }

  // 点到的是原形、但 forms 指向自己之外：若当前无音标，再读原形
  if (best && !best.phonetic && base && base !== word) {
    const shard = await loadShard(base[0]).catch(() => null);
    const baseInfo = readEntry(shard, base);
    if (baseInfo?.phonetic) best = { ...best, phonetic: baseInfo.phonetic };
  }
  return best;
}

async function httpGetJson(url, { timeoutMs = 4000 } = {}) {
  const Cap = typeof window !== "undefined" ? window.Capacitor : null;
  const Http = Cap?.Plugins?.CapacitorHttp;
  if (isNativeApp() && Http?.get) {
    const res = await Http.get({
      url,
      headers: {
        Accept: "application/json,text/plain,*/*",
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
      },
      responseType: "json",
      connectTimeout: timeoutMs,
      readTimeout: timeoutMs,
    });
    if (res?.status >= 400) throw new Error(`dict http ${res.status}`);
    return res?.data;
  }
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "force-cache",
      signal: ctrl?.signal,
    });
    if (!res.ok) throw new Error(`dict http ${res.status}`);
    return res.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function pickPhonetic(wordObj) {
  const us = String(wordObj?.usphone || "").trim();
  const uk = String(wordObj?.ukphone || "").trim();
  if (us && uk && us !== uk) return `美 ${us}  英 ${uk}`;
  return us || uk || "";
}

function collectGlossFromTrs(trs) {
  const parts = [];
  for (const item of trs || []) {
    if (!item || typeof item !== "object") continue;
    if (typeof item.tran === "string" && item.tran.trim()) {
      const pos = String(item.pos || "").trim();
      parts.push(pos ? `${pos} ${item.tran.trim()}` : item.tran.trim());
      continue;
    }
    for (const tr of item.tr || []) {
      const i = tr?.l?.i;
      if (Array.isArray(i)) {
        const s = i.filter((x) => typeof x === "string").join("").trim();
        if (s) parts.push(s);
      } else if (typeof i === "string" && i.trim()) {
        parts.push(i.trim());
      }
    }
  }
  return parts;
}

function parseYoudaoPayload(data, word) {
  const ec = data?.ec;
  let wordObj = null;
  if (Array.isArray(ec?.word)) wordObj = ec.word[0];
  else if (ec?.word && typeof ec.word === "object") wordObj = ec.word;

  let phonetic = pickPhonetic(wordObj || {});
  let gloss = collectGlossFromTrs(wordObj?.trs).join("；");

  if (!phonetic) {
    const simple = data?.simple?.word;
    const sw = Array.isArray(simple) ? simple[0] : simple;
    phonetic = pickPhonetic(sw || {});
  }
  if (!gloss) {
    const entries = data?.data?.entries;
    if (Array.isArray(entries) && entries[0]?.explain) gloss = String(entries[0].explain).trim();
  }
  if (!gloss) {
    const web = data?.web_trans?.["web-translation"];
    const first = Array.isArray(web) ? web[0] : null;
    const tran = first?.trans?.[0]?.value || first?.["@key"];
    if (tran) gloss = String(tran).trim();
  }
  if (!phonetic && !gloss) return null;
  return {
    word: String(wordObj?.["return-phrase"] || wordObj?.prototype || word || "").trim() || word,
    phonetic,
    gloss,
    offline: false,
  };
}

async function lookupOnlineFallback(word) {
  const q = encodeURIComponent(word);
  const urls = [];
  if (!isNativeApp()) {
    urls.push(`/api/en-dict?q=${q}`);
    urls.push(`http://127.0.0.1:8768/api/en-dict?q=${q}`);
    urls.push(`http://127.0.0.1:28767/api/en-dict?q=${q}`);
  }
  urls.push(`https://dict.youdao.com/jsonapi_s?doctype=json&jsonversion=4&q=${q}`);
  urls.push(`https://dict.youdao.com/suggest?num=1&ver=3.0&doctype=json&cache=false&le=en&q=${q}`);

  for (const url of urls) {
    try {
      const data = await httpGetJson(url, { timeoutMs: 3500 });
      if (data?.ok && (data.phonetic || data.gloss)) {
        return {
          word: String(data.word || word).trim() || word,
          phonetic: String(data.phonetic || "").trim(),
          gloss: String(data.gloss || "").trim(),
          offline: false,
        };
      }
      const parsed = parseYoudaoPayload(data, word);
      if (parsed) return parsed;
    } catch (_) {}
  }
  return null;
}

/**
 * @param {string} rawWord
 * @returns {Promise<{word:string,phonetic:string,gloss:string,offline?:boolean}|null>}
 */
export async function lookupEnWord(rawWord) {
  const word = normalizeWord(rawWord);
  if (!word || !WORD_RE.test(word)) return null;
  if (cache.has(word)) return cache.get(word);

  let info = null;
  try {
    info = await lookupOffline(word);
  } catch (err) {
    console.warn("[en-dict] offline failed", err);
  }
  if (!info) {
    try {
      info = await lookupOnlineFallback(word);
    } catch (_) {}
  }

  if (cache.size >= CACHE_MAX) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
  cache.set(word, info);
  return info;
}

/** 预热 index + forms，进入英文区时可调用 */
export async function warmEnDict() {
  await Promise.all([loadIndex().catch(() => null), loadForms().catch(() => null)]);
}

/** 重音/分音节纯函数已抽到 lib/stress.js（可独立单测）；此处重导出保持既有导入路径不变 */
import {
  formatPhonetic,
  primaryStressIndex,
  syllabifyOrtho,
  markStressOnWord,
} from "./lib/stress.js?v=20261009lib";
export { formatPhonetic, primaryStressIndex, syllabifyOrtho, markStressOnWord };

/** 把重音标到点词按钮上（dataset.word 仍是原词，供朗读） */
export function applyStressToWordEl(el, word, phonetic) {
  if (!el) return;
  const raw = String(word || el.dataset.word || "").trim();
  if (!raw) return;
  const marked = markStressOnWord(raw, phonetic);
  el.classList.toggle("has-stress", marked.includes("ˈ"));
  el.replaceChildren();
  const at = marked.indexOf("ˈ");
  if (at < 0) {
    el.textContent = raw;
    return;
  }
  if (at > 0) el.append(marked.slice(0, at));
  const mark = document.createElement("span");
  mark.className = "en-stress-mark";
  mark.textContent = "ˈ";
  mark.setAttribute("aria-hidden", "true");
  el.appendChild(mark);
  const syl = document.createElement("span");
  syl.className = "en-stress-syl";
  syl.textContent = marked.slice(at + 1);
  el.appendChild(syl);
}

/** 分片已在内存时同步查离线词条（禁止联网，供批量标重音） */
function lookupOfflineFromMaps(word, forms, getShard) {
  const base = forms?.[word] && WORD_RE.test(forms[word]) ? forms[word] : null;
  const tryWords = [word];
  if (base) tryWords.push(base);
  for (const s of stemCandidates(word)) tryWords.push(s);

  let best = null;
  for (const w of tryWords) {
    const info = readEntry(getShard(w[0]), w);
    if (!info) continue;
    if (!best) best = { ...info, word: w === word ? w : word };
    if (best && !best.phonetic && info.phonetic && w !== word) {
      best = { ...best, phonetic: info.phonetic };
    }
    if (best?.phonetic && best?.gloss) break;
  }
  if (best && !best.phonetic && base && base !== word) {
    const baseInfo = readEntry(getShard(base[0]), base);
    if (baseInfo?.phonetic) best = { ...best, phonetic: baseInfo.phonetic };
  }
  return best;
}

/**
 * 给点词按钮批量标重音（仅离线词典，绝不联网）
 * @param {ParentNode|null} root
 * @param {{token?:number,isStale?:()=>boolean}} [opts]
 */
export async function annotateEnTapStress(root, opts = {}) {
  const host = root || document.getElementById("en-full-block");
  if (!host) return;
  const token = opts.token;
  const buttons = Array.from(host.querySelectorAll(".en-tap-word:not([data-stress])"));
  if (!buttons.length) return;
  await warmEnDict();
  const forms = (await loadForms().catch(() => null)) || {};

  const letters = new Set();
  for (const el of buttons) {
    const w = normalizeWord(el.dataset.word || "");
    if (!w) continue;
    letters.add(w[0]);
    const base = forms[w];
    if (base && WORD_RE.test(base)) letters.add(base[0]);
    for (const s of stemCandidates(w)) letters.add(s[0]);
  }
  await Promise.all([...letters].map((L) => loadShard(L).catch(() => null)));
  if (token != null && opts.isStale?.()) return;

  const shardMaps = new Map();
  for (const L of letters) {
    try {
      shardMaps.set(L, await loadShard(L));
    } catch {
      shardMaps.set(L, null);
    }
  }
  const getShard = (L) => shardMaps.get(L) || null;

  for (const el of buttons) {
    if (token != null && opts.isStale?.()) return;
    const raw = el.dataset.word || "";
    const word = normalizeWord(raw);
    if (!word) continue;
    let info = cache.has(word) ? cache.get(word) : null;
    if (!cache.has(word)) {
      info = lookupOfflineFromMaps(word, forms, getShard);
      if (cache.size >= CACHE_MAX) {
        const first = cache.keys().next().value;
        cache.delete(first);
      }
      cache.set(word, info);
    }
    el.dataset.stress = "1";
    if (!info?.phonetic) continue;
    const ph = formatPhonetic(info.phonetic);
    applyStressToWordEl(el, raw, ph);
    const bits = [ph ? `/${ph}/` : "", info.gloss || ""].filter(Boolean).join(" · ");
    if (bits) el.title = `${markStressOnWord(raw, ph)} ${bits}`;
  }
}

function ensureTipEl() {
  if (tipEl && tipEl.isConnected) return tipEl;
  tipEl = document.createElement("div");
  tipEl.id = "en-word-tip";
  tipEl.className = "en-word-tip";
  tipEl.hidden = true;
  tipEl.setAttribute("role", "status");
  tipEl.setAttribute("aria-live", "polite");
  document.body.appendChild(tipEl);
  return tipEl;
}

function placeTipNear(anchor) {
  const tip = ensureTipEl();
  if (!anchor || !tip) return;
  const rect = anchor.getBoundingClientRect();
  tip.hidden = false;
  tip.style.visibility = "hidden";
  tip.style.left = "0px";
  tip.style.top = "0px";
  const tw = tip.offsetWidth || 220;
  const th = tip.offsetHeight || 72;
  const margin = 8;
  let left = rect.left + rect.width / 2 - tw / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - tw - margin));
  let top = rect.bottom + 6;
  if (top + th > window.innerHeight - margin) {
    top = Math.max(margin, rect.top - th - 6);
  }
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
  tip.style.visibility = "visible";
}

/**
 * @param {HTMLElement|null} anchor
 * @param {{word?:string,phonetic?:string,gloss?:string}|null} info
 * @param {{loading?:boolean,error?:string}} [opts]
 */
export function showEnWordTip(anchor, info, opts = {}) {
  const tip = ensureTipEl();
  clearTimeout(tipHideTimer);
  const seq = ++tipSeq;

  tip.replaceChildren();
  if (opts.loading) {
    tip.textContent = "查释义…";
    tip.classList.add("is-loading");
    placeTipNear(anchor);
    return seq;
  }
  tip.classList.remove("is-loading");

  if (opts.error) {
    tip.textContent = opts.error;
    placeTipNear(anchor);
    return seq;
  }

  const word = String(info?.word || "").trim();
  const phonetic = String(info?.phonetic || "").trim().replace(/^\/+|\/+$/g, "");
  const gloss = String(info?.gloss || "").trim();
  if (!word && !phonetic && !gloss) {
    hideEnWordTip();
    return seq;
  }

  if (word) {
    const w = document.createElement("div");
    w.className = "en-word-tip-word";
    const marked = phonetic ? markStressOnWord(word, phonetic) : word;
    const at = marked.indexOf("ˈ");
    if (at < 0) {
      w.textContent = marked;
    } else {
      if (at > 0) w.append(marked.slice(0, at));
      const mark = document.createElement("span");
      mark.className = "en-stress-mark";
      mark.textContent = "ˈ";
      w.appendChild(mark);
      const syl = document.createElement("span");
      syl.className = "en-stress-syl";
      syl.textContent = marked.slice(at + 1);
      w.appendChild(syl);
    }
    tip.appendChild(w);
  }
  if (phonetic) {
    const p = document.createElement("div");
    p.className = "en-word-tip-phonetic";
    p.textContent = `/${formatPhonetic(phonetic)}/`;
    tip.appendChild(p);
  }
  if (gloss) {
    const g = document.createElement("div");
    g.className = "en-word-tip-gloss";
    g.textContent = gloss;
    tip.appendChild(g);
  }
  if (word && typeof opts.onAdd === "function") {
    const add = document.createElement("button");
    add.type = "button";
    add.className = "en-word-tip-add";
    add.textContent = opts.saved ? "已添加" : "添加";
    add.disabled = !!opts.saved;
    add.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (add.disabled) return;
      opts.onAdd({ word, phonetic, gloss });
      add.textContent = "已添加";
      add.disabled = true;
    });
    tip.appendChild(add);
  }
  placeTipNear(anchor);
  return seq;
}

export function hideEnWordTip(delayMs = 0) {
  clearTimeout(tipHideTimer);
  const tip = tipEl;
  if (!tip) return;
  if (delayMs > 0) {
    tipHideTimer = setTimeout(() => {
      tip.hidden = true;
      tip.replaceChildren();
    }, delayMs);
    return;
  }
  tip.hidden = true;
  tip.replaceChildren();
}

export function scheduleHideEnWordTip(ms = 4200) {
  hideEnWordTip(ms);
}

export function bindEnWordTipDismiss() {
  document.addEventListener(
    "pointerdown",
    (e) => {
      const tip = tipEl;
      if (!tip || tip.hidden) return;
      if (tip.contains(e.target)) return;
      if (e.target?.closest?.(".en-tap-word")) return;
      hideEnWordTip();
    },
    true
  );
  window.addEventListener("scroll", () => hideEnWordTip(), true);
}
