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

const IPA_DIPH = ["aɪ", "aʊ", "eɪ", "oʊ", "əʊ", "ɔɪ", "ɪə", "eə", "ʊə", "ɑɪ", "ei", "ai", "au", "ɔi", "əu", "ou"];
const IPA_AFFR = ["tʃ", "dʒ"];
const IPA_NUCLEUS_RE = /^[aeiouyæɑɒʌəɚɝɨɪʊɔɛɜœøʏäëïöüāēīōūєə]$/i;
const PH_NUCLEUS =
  /aɪ|aʊ|eɪ|oʊ|əʊ|ɔɪ|ɪə|eə|ʊə|[aeiouyæɑɒʌəɚɝɨɪʊɔɛɜœøʏäëïöüāēīōūæ̃ãõ]+/gi;

function isOrthoVowel(ch) {
  return /[aeiouy]/i.test(ch || "");
}

/** 清洗 ECDICT 音标：'/,/. 次重音、(r)、: 长音 */
export function formatPhonetic(phonetic) {
  return String(phonetic || "")
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/ә|є/g, "ə")
    .replace(/\([^)]*\)/g, "")
    .replace(/ˈ/g, "'")
    .replace(/ˌ/g, ",")
    .replace(/'/g, "ˈ")
    .replace(/,/g, "ˌ")
    .replace(/\./g, "ˌ")
    .replace(/:/g, "ː");
}

function repairPhoneticStress(phonetic) {
  // ECDICT 常把 -ation/-sion 的主重音误标在 ʃən 前
  return formatPhonetic(phonetic).replace(
    /([aeiouæɑɒʌəɚɝɨɪʊɔɛɜœy]ː?)ˈ([ʃsʒz]ə?n)$/i,
    "ˈ$1$2"
  );
}

function isIpaNucleus(tok) {
  if (!tok) return false;
  const base = tok.replace(/ː/g, "");
  if (IPA_DIPH.includes(tok) || IPA_DIPH.includes(base)) return true;
  return IPA_NUCLEUS_RE.test(base);
}

function tokenizeIpa(phonetic) {
  const raw = repairPhoneticStress(phonetic).replace(/[/\s-]/g, "");
  const out = [];
  for (let i = 0; i < raw.length; ) {
    const ch = raw[i];
    if (ch === "ˈ" || ch === "ˌ") {
      out.push(ch);
      i += 1;
      continue;
    }
    const two = raw.slice(i, i + 2);
    if (IPA_DIPH.includes(two) || IPA_AFFR.includes(two)) {
      out.push(two);
      i += 2;
      continue;
    }
    if (raw[i + 1] === "ː") {
      out.push(`${ch}ː`);
      i += 2;
      continue;
    }
    out.push(ch);
    i += 1;
  }
  return out;
}

function ipaNucleusCount(phonetic) {
  return tokenizeIpa(phonetic).filter(isIpaNucleus).length;
}

/** ˈ 后面、重读元音前面的辅音个数（/j/ /w/ 介音也算） */
function ipaStressedOnsetTokens(phonetic) {
  const tokens = tokenizeIpa(phonetic);
  const star = tokens.indexOf("ˈ");
  if (star < 0) return [];
  const onset = [];
  for (let i = star + 1; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t === "ˌ") continue;
    if (isIpaNucleus(t)) break;
    onset.push(t);
  }
  return onset;
}

/**
 * 音标里主重音落在第几个音节（0-based）。
 * ECDICT：' 写在重读音节前，如 kən'tempt → 1；'læŋgwidʒ → 0
 */
export function primaryStressIndex(phonetic) {
  const raw = repairPhoneticStress(phonetic).replace(/ˈ/g, "'");
  const mark = raw.indexOf("'");
  if (mark < 0) return -1;
  const before = raw.slice(0, mark);
  const vowelGroups = before.match(PH_NUCLEUS);
  return vowelGroups ? vowelGroups.length : 0;
}

/** 英文里合法的音节起首辅音长度（最大起首原则） */
function englishOnsetLen(cluster) {
  const c = String(cluster || "").toLowerCase();
  if (!c) return 0;
  if (c.length >= 3 && /^(scr|spl|spr|str|squ)/.test(c.slice(-3))) return 3;
  if (
    c.length >= 2 &&
    /^(bl|br|ch|cl|cr|dr|dw|fl|fr|gl|gr|kn|gn|pl|pr|ps|qu|sc|sh|sk|sl|sm|sn|sp|st|sw|th|tr|tw|wh|wr)$/.test(c.slice(-2))
  ) {
    return 2;
  }
  return 1;
}

function vowelGroupsOrtho(lower) {
  const groups = [];
  for (let i = 0; i < lower.length; ) {
    if (!isOrthoVowel(lower[i])) {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < lower.length && isOrthoVowel(lower[j])) j += 1;
    groups.push([i, j]);
    i = j;
  }
  if (
    groups.length > 1 &&
    lower.endsWith("e") &&
    !lower.endsWith("le") &&
    !lower.endsWith("ue") &&
    groups[groups.length - 1][0] === lower.length - 1 &&
    lower.length >= 2 &&
    !isOrthoVowel(lower[lower.length - 2])
  ) {
    groups.pop();
  }
  return groups;
}

/** 音标音节更多时，拆开 ia/io 这类连写，避免 -iation 被合成一个核 */
function orthoNucleusStarts(lower, ipaCount) {
  const groups = vowelGroupsOrtho(lower).map((g) => g.slice());
  while (groups.length < ipaCount) {
    const hi = groups.findIndex((g) => g[1] - g[0] > 1);
    if (hi < 0) break;
    const [a, b] = groups[hi];
    groups.splice(hi, 1, [a, a + 1], [a + 1, b]);
  }
  return groups.map((g) => g[0]);
}

/** 简易英文分音节（按元音核 + 尽量把辅音起首留给后一音节） */
export function syllabifyOrtho(word, phonetic) {
  const original = String(word || "");
  const lower = original.toLowerCase();
  if (!lower) return [];
  const marked = phonetic ? markStressOnWord(original, phonetic) : "";
  if (marked.includes("ˈ")) {
    const at = marked.indexOf("ˈ");
    const left = original.slice(0, at);
    const right = original.slice(at);
    return left ? [left, right] : [right];
  }
  if (lower.length <= 2) return [original];
  const nuclei = orthoNucleusStarts(lower, 0);
  if (!nuclei.length) return [original];
  if (nuclei.length === 1) return [original];

  const breaks = [];
  for (let n = 0; n < nuclei.length - 1; n += 1) {
    let vowelEnd = nuclei[n];
    while (vowelEnd < lower.length && isOrthoVowel(lower[vowelEnd])) vowelEnd += 1;
    const cluster = lower.slice(vowelEnd, nuclei[n + 1]);
    const onset = englishOnsetLen(cluster);
    breaks.push(nuclei[n + 1] - onset);
  }
  const parts = [];
  let start = 0;
  for (const br of breaks) {
    const cut = Math.max(start + 1, Math.min(br, original.length - 1));
    parts.push(original.slice(start, cut));
    start = cut;
  }
  parts.push(original.slice(start));
  return parts.filter(Boolean);
}

/**
 * 在拼写上插入主重音符号。
 * 按音标里 ˈ 后的起首辅音来切：ˌʌnˈiːkwəl → unˈequal，而不是 uˈnequal。
 */
export function markStressOnWord(word, phonetic) {
  const w = String(word || "");
  if (!w) return w;
  const idx = primaryStressIndex(phonetic);
  if (idx < 0) return w;
  const lower = w.toLowerCase();
  const nuclei = orthoNucleusStarts(lower, ipaNucleusCount(phonetic));
  if (!nuclei.length) return w;
  const i = Math.min(Math.max(0, idx), nuclei.length - 1);
  const vowelAt = nuclei[i];
  if (i === 0) return `ˈ${w}`;

  let clusterStart = nuclei[i - 1] + 1;
  while (clusterStart < vowelAt && isOrthoVowel(lower[clusterStart])) clusterStart += 1;
  const cluster = lower.slice(clusterStart, vowelAt);
  const onsetToks = ipaStressedOnsetTokens(phonetic);
  const glideOnly = onsetToks.length === 1 && (onsetToks[0] === "j" || onsetToks[0] === "w");
  const glideInSpelling = /[jyw]/i.test(cluster);
  let onsetLetters;
  if (!onsetToks.length || (glideOnly && !glideInSpelling)) onsetLetters = 0;
  else onsetLetters = englishOnsetLen(cluster);
  let cut = clusterStart + (cluster.length - onsetLetters);
  cut = Math.max(0, Math.min(cut, w.length));
  return `${w.slice(0, cut)}ˈ${w.slice(cut)}`;
}

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
