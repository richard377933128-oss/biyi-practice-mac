/**
 * 英文重音/分音节纯函数库。
 * 从 en-word-dict.js 抽出：无 DOM、无网络依赖，可独立单测（tests/stress.test.mjs）。
 */

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

/** 英文里合法的音节起首辅音长度（最大起首原则）；ph/gh/rh/kh/dj 这类双字母单音素起首要整体算 */
function englishOnsetLen(cluster) {
  const c = String(cluster || "").toLowerCase();
  if (!c) return 0;
  if (c.length >= 3 && /^(scr|spl|spr|str|squ)/.test(c.slice(-3))) return 3;
  if (
    c.length >= 2 &&
    /^(bl|br|ch|cl|cr|dj|dr|dw|fl|fr|gh|gl|gn|gr|kh|kn|ph|pl|pr|ps|qu|rh|sc|sh|sk|sl|sm|sn|sp|st|sw|th|tr|tw|wh|wr)$/.test(c.slice(-2))
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

/** 音标音节更多时，拆开 ia/io 这类连写，避免 -iation 被合成一个核。
 *  优先拆 i/u 起首的组（ia/io/ua 常是两个音节），eu/au/ou/ea 这类通常是一个音素，尽量不动 */
function orthoNucleusStarts(lower, ipaCount) {
  const groups = vowelGroupsOrtho(lower).map((g) => g.slice());
  while (groups.length < ipaCount) {
    let hi = groups.findIndex((g) => g[1] - g[0] > 1 && /[iu]/.test(lower[g[0]]));
    if (hi < 0) hi = groups.findIndex((g) => g[1] - g[0] > 1);
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
