import { translateEnLinesToZh, translateZhLinesToEn } from "./en-zh.js?v=20261011nowrap1";
import { deleteSpeechClips, speechCacheKey } from "./tts-cache.js?v=20261011nowrap1";
import { kvGet, kvSet } from "./lib/kv-store.js?v=20261011nowrap1";

const STORAGE_KEY = "pte_custom_texts";
export const CUSTOM_BANK_CODE = "CUSTOM";
export const CUSTOM_ADD_CODE = "CUSTOM_ADD";

function normalizeEn(raw) {
  return String(raw || "")
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .trim();
}

/** 按空格分词，尽量保留标点贴在词上 */
function tokenizeWords(text) {
  return String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function packWordChunks(sentence, maxWords = 6) {
  const words = tokenizeWords(sentence);
  if (words.length <= maxWords) return [sentence.replace(/\s+/g, " ").trim()];
  const out = [];
  for (let i = 0; i < words.length; i += maxWords) {
    out.push(words.slice(i, i + maxWords).join(" "));
  }
  return out.filter(Boolean);
}

/**
 * 把英语切成意群（对齐 RA 粒度：约 4–7 词一段）。
 * - 换行，或 / | ／ ｜ ，按标记手动切分
 * - 否则按句号切句，再按逗号/连接词软切
 */
export function splitEnglishSenseGroups(rawEn) {
  const text = normalizeEn(rawEn);
  if (!text) return [];

  let pieces;
  if (/[\n\/|／｜]/.test(text)) {
    pieces = text.split(/\s*(?:\n+|[\/|／｜]+)\s*/);
  } else {
    const sentences = text
      .split(/(?<=[.!?…])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const softSplit =
      /(?<=,|;|:|—|–)\s+|\s+(?=(?:and|but|or|so|because|which|that|who|when|while|if|as|about|to)\b)/i;
    pieces = [];
    for (const sentence of sentences) {
      const words = tokenizeWords(sentence);
      if (words.length <= 7) {
        pieces.push(sentence);
        continue;
      }
      const chunks = sentence.split(softSplit).map((s) => s.trim()).filter(Boolean);
      let buf = [];
      let bufWords = 0;
      const flush = () => {
        if (!buf.length) return;
        pieces.push(buf.join(" "));
        buf = [];
        bufWords = 0;
      };
      for (const chunk of chunks) {
        const n = tokenizeWords(chunk).length;
        if (n > 7) {
          flush();
          pieces.push(...packWordChunks(chunk, 6));
          continue;
        }
        if (bufWords && bufWords + n > 7) flush();
        buf.push(chunk);
        bufWords += n;
        if (bufWords >= 5) flush();
      }
      flush();
    }
  }

  return pieces
    .map((english) => english.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((english) => ({ english, chinese: "" }));
}

function normalizeSenseGroups(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((sg) => ({
      english: normalizeEn(sg?.english || sg?.en || ""),
      chinese: String(sg?.chinese || sg?.zh || "")
        .replace(/\r\n/g, "\n")
        .replace(/\u00a0/g, " ")
        .trim(),
    }))
    .filter((sg) => sg.english || sg.chinese);
}

/** 是否明确传入了意群（含纯中文、缺英），用于禁止自动翻译覆盖 */
function hasExplicitSenseGroups(raw) {
  return Array.isArray(raw) && normalizeSenseGroups(raw).length > 0;
}

function senseGroupsComplete(groups) {
  return (
    Array.isArray(groups) &&
    groups.length > 0 &&
    groups.every((sg) => String(sg?.chinese || "").trim() && String(sg?.english || "").trim())
  );
}

const CJK_RE = /[\u4e00-\u9fff]/;
const SRT_SKIP_RE = /(https?:\/\/|www\.|字幕来源|招募|更多精彩|BluRay|x265|CMCT)/i;

function isCjk(s) {
  return CJK_RE.test(String(s || ""));
}

function cleanSubLine(s) {
  return String(s || "")
    .replace(/\{\\[^}]*\}/g, "")
    .replace(/\\[NnHh]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[-–—:：\s]+|[-–—:：\s]+$/g, "")
    .trim();
}

function pairZhEnFromBlock(text) {
  const parts = String(text || "")
    .replace(/\r\n/g, "\n")
    .split(/\n+/)
    .map(cleanSubLine)
    .filter(Boolean);
  if (!parts.length) return null;
  if (SRT_SKIP_RE.test(parts.join(" "))) return null;
  let zh = "";
  let en = "";
  if (parts.length === 1) {
    if (isCjk(parts[0])) zh = parts[0];
    else en = parts[0];
  } else if (isCjk(parts[0]) && !isCjk(parts[parts.length - 1])) {
    zh = parts[0];
    en = parts.slice(1).join(" ");
  } else if (!isCjk(parts[0]) && isCjk(parts[parts.length - 1])) {
    en = parts[0];
    zh = parts[parts.length - 1];
  } else {
    zh = parts.filter(isCjk).join(" ");
    en = parts.filter((p) => !isCjk(p)).join(" ");
  }
  zh = cleanSubLine(zh);
  en = cleanSubLine(en);
  // 导入要求有中文：双语直接用；纯中文稍后翻译；纯英跳过
  if (!zh) return null;
  return { chinese: zh, english: en };
}

/** 中文意群大致字数（对齐英语 4–7 词粒度） */
const ZH_SENSE_MAX = 20;
const ZH_SENSE_SOFT = 14;

function zhCharLen(s) {
  return String(s || "").replace(/\s+/g, "").length;
}

/**
 * 把中文切成意群。
 * - 换行，或 / | ／ ｜ ，按标记手动切分
 * - 否则按句末标点切句，再按逗号软切并装箱
 */
export function splitChineseSenseGroups(rawZh) {
  const text = String(rawZh || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
  if (!text) return [];

  let pieces;
  if (/[\n\/|／｜]/.test(text)) {
    pieces = text.split(/\s*(?:\n+|[\/|／｜]+)\s*/);
  } else {
    const sentences = text
      .split(/(?<=[。！？!?…；;])\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
    pieces = [];
    for (const sentence of sentences) {
      if (zhCharLen(sentence) <= ZH_SENSE_MAX) {
        pieces.push(sentence);
        continue;
      }
      const chunks = sentence
        .split(/(?<=[，、,；;：:])/)
        .map((s) => s.trim())
        .filter(Boolean);
      let buf = "";
      const flush = () => {
        const t = buf.trim();
        if (t) pieces.push(t);
        buf = "";
      };
      for (const chunk of chunks) {
        const n = zhCharLen(chunk);
        if (n > ZH_SENSE_MAX) {
          flush();
          // 过长无标点：按字硬切
          const chars = chunk.replace(/\s+/g, "");
          for (let i = 0; i < chars.length; i += ZH_SENSE_SOFT) {
            pieces.push(chars.slice(i, i + ZH_SENSE_SOFT));
          }
          continue;
        }
        if (buf && zhCharLen(buf) + n > ZH_SENSE_MAX) flush();
        buf += chunk;
        if (zhCharLen(buf) >= ZH_SENSE_SOFT) flush();
      }
      flush();
    }
  }

  return pieces
    .map((chinese) => cleanSubLine(chinese))
    .filter((chinese) => chinese && isCjk(chinese))
    .map((chinese) => ({ chinese, english: "" }));
}

/**
 * 统计「中文下一行英文」与「英文下一行中文」对照对数。
 */
function countBilingualLinePairs(raw) {
  const lines = String(raw || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((l) => cleanSubLine(l))
    .filter(Boolean);
  let zhEn = 0;
  let enZh = 0;
  for (let i = 0; i + 1 < lines.length; i += 1) {
    const a = lines[i];
    const b = lines[i + 1];
    if (isCjk(a) && !isCjk(b)) zhEn += 1;
    else if (!isCjk(a) && isCjk(b)) enZh += 1;
  }
  return { lines, zhEn, enZh };
}

/**
 * 是否像中英对照 TXT（中文下一行英文，或英文下一行中文；可夹空行）。
 */
export function looksLikeZhEnLinePairs(raw) {
  const { lines, zhEn, enZh } = countBilingualLinePairs(raw);
  if (lines.length < 2) return false;
  const paired = Math.max(zhEn, enZh);
  // 至少两对，且对照行占多数（允许少量孤立行）
  if (paired < 2) return false;
  return paired * 2 >= Math.floor(lines.length * 0.6);
}

/**
 * 解析中英对照 TXT：支持「中文下一行英文」或「英文下一行中文」。
 * 返回形状与 parseSrt 一致。
 */
export function parseZhEnLinePairs(raw) {
  const { lines, zhEn, enZh } = countBilingualLinePairs(raw);
  const preferEnZh = enZh > zhEn;
  const sense_groups = [];
  for (let i = 0; i < lines.length; ) {
    const cur = lines[i];
    const next = i + 1 < lines.length ? lines[i + 1] : "";
    if (SRT_SKIP_RE.test(cur) || (next && SRT_SKIP_RE.test(next))) {
      i += 1;
      continue;
    }
    if (preferEnZh) {
      if (!isCjk(cur) && next && isCjk(next)) {
        sense_groups.push({ chinese: next, english: cur });
        i += 2;
        continue;
      }
    } else if (isCjk(cur) && next && !isCjk(next)) {
      sense_groups.push({ chinese: cur, english: next });
      i += 2;
      continue;
    }
    if (isCjk(cur)) {
      sense_groups.push({ chinese: cur, english: "" });
      i += 1;
      continue;
    }
    // 孤立英文：尽量保留，避免首行被静默丢掉
    sense_groups.push({ chinese: "", english: cur });
    i += 1;
  }
  if (!sense_groups.length) {
    throw new Error("未解析到中英对照。请确认格式为：英文一行下一行中文，或中文一行下一行英文");
  }
  const bilingualCount = sense_groups.filter(
    (g) => String(g.english || "").trim() && String(g.chinese || "").trim()
  ).length;
  const zhOnlyCount = sense_groups.length - bilingualCount;
  return {
    sense_groups,
    enText: sense_groups.map((g) => g.english).filter(Boolean).join("\n"),
    count: sense_groups.length,
    bilingualCount,
    zhOnlyCount,
    source: "txt-bilingual",
    pairOrder: preferEnZh ? "en-zh" : "zh-en",
  };
}

/**
 * 解析纯中文 TXT：自动切意群；english 可为空（不自动译英）。
 * 返回形状与 parseSrt 一致。
 */
export function parseChineseText(raw) {
  const sense_groups = splitChineseSenseGroups(raw);
  if (!sense_groups.length) {
    throw new Error("未解析到中文。请确认是中文 TXT，或用换行手动切意群");
  }
  return {
    sense_groups,
    enText: "",
    count: sense_groups.length,
    bilingualCount: 0,
    zhOnlyCount: sense_groups.length,
    source: "txt",
  };
}

/** 内容是否像 SRT（有时间轴） */
export function looksLikeSrt(raw) {
  return /-->/.test(String(raw || ""));
}

/**
 * 按扩展名 / 内容解析导入文本：
 * .srt / 时间轴 → 字幕；中英对照 TXT（英↔中交替）→ 双语；否则纯中文切意群。
 */
export function parseImportText(raw, fileName = "") {
  const name = String(fileName || "");
  if (/\.srt$/i.test(name) || looksLikeSrt(raw)) {
    const parsed = parseSrt(raw);
    return { ...parsed, source: "srt" };
  }
  if (looksLikeZhEnLinePairs(raw)) {
    return parseZhEnLinePairs(raw);
  }
  return parseChineseText(raw);
}

/**
 * 解析 SRT：支持中英双语或纯中文字幕。
 * english 可为空（纯汉字 cue）；不自动译英，由用户点击「译英」。
 * 返回 { sense_groups, enText, count, bilingualCount, zhOnlyCount }
 */
export function parseSrt(raw) {
  const text = String(raw || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
  if (!text) throw new Error("SRT 文件是空的");

  const blocks = text.split(/\n{2,}/);
  const sense_groups = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trimEnd());
    if (!lines.length) continue;
    let i = 0;
    if (/^\d+$/.test(lines[0].trim())) i = 1;
    if (i < lines.length && /-->/.test(lines[i])) i += 1;
    const body = lines.slice(i).join("\n").trim();
    if (!body) continue;
    const pair = pairZhEnFromBlock(body);
    if (pair) sense_groups.push(pair);
  }
  if (!sense_groups.length) {
    throw new Error("未解析到中文字幕。请确认是双语或纯中文 SRT");
  }
  const bilingualCount = sense_groups.filter((g) => String(g.english || "").trim()).length;
  const zhOnlyCount = sense_groups.length - bilingualCount;
  return {
    sense_groups,
    enText: sense_groups.map((g) => g.english).filter(Boolean).join("\n"),
    count: sense_groups.length,
    bilingualCount,
    zhOnlyCount,
  };
}

/** @deprecated 使用 parseSrt；保留兼容旧调用 */
export function parseBilingualSrt(raw) {
  const parsed = parseSrt(raw);
  if (parsed.zhOnlyCount) {
    throw new Error("未解析到中英对照字幕。请确认每条同时含中文和英文");
  }
  return parsed;
}

/**
 * 给缺英文的意群补翻译（仅在用户点击「译英」时调用）。
 * 保留已有英文；不丢弃仍缺英的条目（翻译失败时留空，便于重试）。
 * @param {{chinese:string,english?:string}[]} groups
 * @param {(done:number,total:number)=>void} [onProgress]
 * @param {{force?:boolean}} [opts] force=true 时重译全部有中文的意群
 */
export async function ensureSrtEnglish(groups, onProgress, opts = {}) {
  const list = (Array.isArray(groups) ? groups : []).map((g) => ({
    chinese: String(g?.chinese || "").trim(),
    english: String(g?.english || "").trim(),
  }));
  const force = !!opts.force;
  const needIdx = [];
  for (let i = 0; i < list.length; i += 1) {
    if (!list[i].chinese) continue;
    if (force || !list[i].english) needIdx.push(i);
  }
  if (needIdx.length) {
    const zhLines = needIdx.map((i) => list[i].chinese);
    const enLines = await translateZhLinesToEn(zhLines, onProgress);
    for (let j = 0; j < needIdx.length; j += 1) {
      const en = String(enLines[j] || "").trim();
      if (en) list[needIdx[j]] = { ...list[needIdx[j]], english: en };
    }
  }
  const out = list.filter((g) => g.chinese || g.english);
  if (!out.length) throw new Error("没有可翻译的意群");
  return out;
}

/** 浏览器里读 SRT 文件（兼容 UTF-8 / GBK） */
export async function readSrtFile(file) {
  if (!file) throw new Error("未选择文件");
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  // UTF-8 BOM
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  // UTF-16 LE/BE
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }
  try {
    const utf8 = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return utf8;
  } catch {
    try {
      return new TextDecoder("gb18030").decode(bytes);
    } catch {
      return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    }
  }
}

function titleFromSrtFileName(name) {
  return String(name || "")
    .replace(/\.[^.]+$/, "")
    .replace(/[._]+/g, " ")
    .trim()
    .slice(0, 80);
}

function loadRawList() {
  try {
    const raw = JSON.parse(kvGet(STORAGE_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .map((item, i) => {
        const en = normalizeEn(item?.en || item?.text || "");
        if (!en) return null;
        const num = Number(item?.num) || i + 1;
        const name = String(item?.name || "").trim() || `自定义 #${num}`;
        const id = String(item?.id || `${CUSTOM_BANK_CODE}-${num}`);
        return {
          id,
          num,
          name,
          en,
          sense_groups: normalizeSenseGroups(item?.sense_groups),
          at: Number(item?.at) || Date.now(),
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.num - b.num);
  } catch {
    return [];
  }
}

function saveRawList(list) {
  kvSet(STORAGE_KEY, JSON.stringify(list || []));
}

/** 把安装包里的自定义文章 seed 合并进 KV 存储（按 id；同名旧稿若缺首句英文也会修好） */
let seedMergePromise = null;
export async function ensureCustomTextsSeedMerged() {
  if (seedMergePromise) return seedMergePromise;
  seedMergePromise = (async () => {
    try {
      const res = await fetch("./data/custom-texts-seed.json", { cache: "no-store" });
      if (!res.ok) return loadRawList();
      const seeded = await res.json();
      if (!Array.isArray(seeded) || !seeded.length) return loadRawList();
      const cur = loadRawList();
      const byId = new Map(cur.map((x) => [x.id, x]));
      let changed = false;
      let nextNum = cur.reduce((m, x) => Math.max(m, Number(x.num) || 0), 0);

      const firstEn = (item) =>
        String((Array.isArray(item?.sense_groups) && item.sense_groups[0]?.english) || "")
          .trim();

      for (const item of seeded) {
        const en = normalizeEn(item?.en || item?.text || "");
        if (!en) continue;
        const id = String(item?.id || "").trim();
        const name = String(item?.name || "").trim() || `自定义 #${nextNum + 1}`;
        const sense_groups = normalizeSenseGroups(item?.sense_groups);
        const seedFirst = firstEn({ sense_groups });

        const applySeed = (prev) => {
          prev.name = name || prev.name;
          prev.en = en;
          prev.sense_groups = sense_groups;
          prev.at = Number(item?.at) || Date.now();
          changed = true;
        };

        if (id && byId.has(id)) {
          const prev = byId.get(id);
          // 同 id：英文全文或首句意群对不上则覆盖（修「漏第一行英文」旧稿）
          if (normalizeEn(prev.en) === en && firstEn(prev) === seedFirst) continue;
          applySeed(prev);
          continue;
        }

        // 同名旧导入（不同 id）也一并修好，避免自由练习里残留错位副本
        const sameName = cur.filter((x) => x.name === name);
        let repairedDup = false;
        for (const prev of sameName) {
          if (normalizeEn(prev.en) === en && firstEn(prev) === seedFirst) continue;
          applySeed(prev);
          repairedDup = true;
        }
        if (repairedDup || sameName.some((x) => normalizeEn(x.en) === en)) continue;

        nextNum += 1;
        const row = {
          id: id || `${CUSTOM_BANK_CODE}-${nextNum}`,
          num: Number(item?.num) || nextNum,
          name,
          en,
          sense_groups,
          at: Number(item?.at) || Date.now(),
        };
        while (cur.some((x) => x.num === row.num) || byId.has(row.id)) {
          nextNum += 1;
          row.num = nextNum;
          if (!id) row.id = `${CUSTOM_BANK_CODE}-${nextNum}`;
          else break;
        }
        cur.push(row);
        byId.set(row.id, row);
        changed = true;
      }
      if (changed) {
        cur.sort((a, b) => a.num - b.num);
        saveRawList(cur);
      }
      return loadRawList();
    } catch {
      return loadRawList();
    }
  })();
  return seedMergePromise;
}

export function loadCustomTexts() {
  return loadRawList();
}

export function customTextCount() {
  return loadRawList().length;
}

export function isCustomBankCode(code) {
  return String(code || "").toUpperCase() === CUSTOM_BANK_CODE;
}

export function isCustomAddCode(code) {
  return String(code || "").toUpperCase() === CUSTOM_ADD_CODE;
}

export function firstLineTitle(en) {
  const line = normalizeEn(en).split(/\n/)[0] || "";
  const clean = line.replace(/\s*[\/|／｜]+\s*/g, " ").trim();
  return clean.length > 36 ? `${clean.slice(0, 36)}…` : clean;
}

/**
 * 切分英文意群并自动译成中文，生成与 RA 相同结构的 sense_groups。
 */
export async function buildSenseGroupsWithZh(rawEn, { onProgress } = {}) {
  const groups = splitEnglishSenseGroups(rawEn);
  if (!groups.length) return [];
  const zhList = await translateEnLinesToZh(
    groups.map((g) => g.english),
    onProgress
  );
  return groups.map((g, i) => ({
    english: g.english,
    chinese: zhList[i] || "",
  }));
}

function toQuestion(item) {
  const groups = normalizeSenseGroups(item.sense_groups);
  const en =
    normalizeEn(item.en) ||
    groups
      .map((g) => g.english)
      .filter(Boolean)
      .join("\n");
  const sense_groups = groups.length
    ? groups
    : splitEnglishSenseGroups(en);
  const previewSrc =
    en ||
    groups
      .map((g) => g.chinese)
      .filter(Boolean)
      .join(" ");
  return {
    id: item.id || `${CUSTOM_BANK_CODE}-${item.num}`,
    code: CUSTOM_BANK_CODE,
    num: item.num,
    name: item.name || `自定义 #${item.num}`,
    preview: previewSrc.slice(0, 100),
    en,
    full: en,
    sense_groups,
    recite: true,
    source: "custom",
  };
}

export function buildCustomBank() {
  const list = loadRawList();
  const questions = list.map(toQuestion);
  return {
    code: CUSTOM_BANK_CODE,
    title: "自由练习",
    subtitle: "我的英语练习文本",
    recite: true,
    count: questions.length,
    source: "local",
    questions,
  };
}

export function getCustomText(num) {
  const n = Number(num);
  return loadRawList().find((item) => Number(item.num) === n) || null;
}

export async function addCustomText({ name, en, sense_groups: givenGroups, onProgress } = {}) {
  let sense_groups = normalizeSenseGroups(givenGroups);
  let text = normalizeEn(en);
  if (hasExplicitSenseGroups(givenGroups)) {
    // 编辑页/导入显式传入：不自动翻译（可纯中文、可双语）
    if (!text) text = sense_groups.map((g) => g.english).filter(Boolean).join("\n");
  } else if (senseGroupsComplete(sense_groups)) {
    if (!text) text = sense_groups.map((g) => g.english).join("\n");
  } else {
    if (!text) throw new Error("请输入英语文本");
    sense_groups = await buildSenseGroupsWithZh(text, { onProgress });
    if (!senseGroupsComplete(sense_groups)) {
      throw new Error("中文意群生成失败，请检查网络后重试");
    }
  }
  if (!sense_groups.length) throw new Error("没有可保存的意群");
  const list = loadRawList();
  const nextNum = list.reduce((max, item) => Math.max(max, Number(item.num) || 0), 0) + 1;
  const titleFallback =
    firstLineTitle(text) ||
    firstLineTitle(sense_groups.map((g) => g.chinese).filter(Boolean).join("\n")) ||
    `自定义 #${nextNum}`;
  const title = String(name || "").trim() || titleFallback;
  const item = {
    id: `${CUSTOM_BANK_CODE}-${nextNum}`,
    num: nextNum,
    name: title,
    en: text,
    sense_groups,
    at: Date.now(),
  };
  list.push(item);
  saveRawList(list);
  return item;
}

export async function updateCustomText(num, { name, en, sense_groups: givenGroups, onProgress } = {}) {
  const n = Number(num);
  let text = normalizeEn(en);
  const list = loadRawList();
  const idx = list.findIndex((item) => Number(item.num) === n);
  if (idx < 0) throw new Error("找不到这篇文本");
  const prev = list[idx];
  let sense_groups = normalizeSenseGroups(givenGroups);
  if (hasExplicitSenseGroups(givenGroups)) {
    // 覆盖写入编辑页意群：不自动翻译
    if (!text) text = sense_groups.map((g) => g.english).filter(Boolean).join("\n");
  } else if (senseGroupsComplete(sense_groups)) {
    if (!text) text = sense_groups.map((g) => g.english).join("\n");
  } else {
    if (!text) throw new Error("请输入英语文本");
    const sameEn = normalizeEn(prev.en) === text && senseGroupsComplete(prev.sense_groups);
    sense_groups = sameEn
      ? prev.sense_groups
      : await buildSenseGroupsWithZh(text, { onProgress });
    if (!senseGroupsComplete(sense_groups)) {
      throw new Error("中文意群生成失败，请检查网络后重试");
    }
  }
  if (!sense_groups.length) throw new Error("没有可保存的意群");
  const titleFallback =
    firstLineTitle(text) ||
    firstLineTitle(sense_groups.map((g) => g.chinese).filter(Boolean).join("\n")) ||
    prev.name ||
    `自定义 #${n}`;
  const title = String(name || "").trim() || titleFallback;
  const item = {
    ...prev,
    name: title,
    en: text,
    sense_groups,
    at: Date.now(),
  };
  list[idx] = item;
  saveRawList(list);
  const nextKeys = new Set(speechLinesOf(item).map(speechCacheKey));
  const removed = speechLinesOf(prev).filter((line) => !nextKeys.has(speechCacheKey(line)));
  if (removed.length) deleteSpeechClips(removed);
  return item;
}

export { titleFromSrtFileName };

/** 给旧数据补中文意群（打开自定义题库时调用） */
export async function ensureCustomTextZh(num, { onProgress } = {}) {
  const n = Number(num);
  const list = loadRawList();
  const idx = list.findIndex((item) => Number(item.num) === n);
  if (idx < 0) return null;
  const prev = list[idx];
  if (senseGroupsComplete(prev.sense_groups)) return prev;
  const sense_groups = await buildSenseGroupsWithZh(prev.en, { onProgress });
  if (!senseGroupsComplete(sense_groups)) {
    throw new Error("中文意群生成失败，请检查网络后重试");
  }
  const item = { ...prev, sense_groups, at: Date.now() };
  list[idx] = item;
  saveRawList(list);
  return item;
}

function speechLinesOf(item) {
  const groups = Array.isArray(item?.sense_groups) ? item.sense_groups : [];
  return groups.map((g) => String(g?.english || "").trim()).filter(Boolean);
}

export function deleteCustomText(num) {
  const n = Number(num);
  const prev = getCustomText(n);
  const list = loadRawList().filter((item) => Number(item.num) !== n);
  saveRawList(list);
  if (prev) deleteSpeechClips(speechLinesOf(prev));
  return list.length;
}
