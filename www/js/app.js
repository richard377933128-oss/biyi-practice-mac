import { bindVoiceMemo } from "./voice-memo.js?v=20261004a";
import { createTranslation } from "./translation.js?v=20261004g";
import { createScreenRecord } from "./screen-record.js?v=20261003v";
import { createSystemCamera } from "./system-camera.js?v=20261003i";
import { createEdgeSpeech, getTtsEngine, setTtsEngine, getSavedVoice, setSavedVoice, ROTATE_VOICE, isRotateVoice, rotateVoiceAt, peekRotateVoice } from "./edge-tts.js?v=20261005n";
import { isLockStressOn, setLockStressOn } from "./lock-screen.js?v=20261004t";
import {
  CUSTOM_BANK_CODE,
  CUSTOM_ADD_CODE,
  isCustomBankCode,
  isCustomAddCode,
  customTextCount,
  loadCustomTexts,
  ensureCustomTextsSeedMerged,
  getCustomText,
  addCustomText,
  updateCustomText,
  deleteCustomText,
  firstLineTitle,
  buildCustomBank,
  parseImportText,
  readSrtFile,
  titleFromSrtFileName,
} from "./custom-texts.js?v=20261006enzh";
import {
  translateZhToEn,
  bindTranslateEngineUi,
  loadTranslatePrefs,
  polishAndTranslateZhLinesViaDeepSeek,
} from "./en-zh.js?v=20261005dirty";
import {
  lookupEnWord,
  showEnWordTip,
  hideEnWordTip,
  scheduleHideEnWordTip,
  bindEnWordTipDismiss,
  warmEnDict,
  annotateEnTapStress,
  applyStressToWordEl,
  markStressOnWord,
  formatPhonetic,
} from "./en-word-dict.js?v=20261005stress";
import { addWord, hasWord, bindWordbook } from "./wordbook.js?v=20261005ui";
import {
  hasFullArticleAudio,
  getFullArticleAudioMeta,
  saveFullArticleAudio,
  loadFullArticleAudioBlob,
  deleteFullArticleAudio,
  playImportedFullAudio,
} from "./full-article-audio.js?v=20261006audio";
import {
  clampDictationTyped,
  autoAppendDictationExtras,
  isDictationAutoWord,
  normalizeDictationText,
  sameDictationChar,
  dictationCharLabel,
  dictationErrorHint,
} from "./typing-engine.js";

const $ = (sel, root = document) => root.querySelector(sel);

const state = {
  catalog: null,
  friendsEpisodes: [],
  bankCode: "",
  list: [],
  index: -1,
  question: null,
  bankCache: Object.create(null),
  translationMemory: loadJson("pte_translation_memory", {}),
  translation: {
    on: true,
    questionKey: "",
    idx: 0,
    target: "",
    typed: "",
    misses: 0,
    done: false,
    advanceTimer: 0,
    errorTimer: 0,
  },
  dictation: { on: false },
  passageFocus: { on: false },
};

let toastTimer = 0;
let translationApi = null;

function loadJson(key, fallback) {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || "null");
    return raw && typeof raw === "object" ? raw : fallback;
  } catch {
    return fallback;
  }
}

function saveTranslationMemory() {
  try {
    localStorage.setItem("pte_translation_memory", JSON.stringify(state.translationMemory || {}));
  } catch (_) {}
}

function toast(msg) {
  const el = $("#toast");
  if (!el) return;
  el.textContent = String(msg || "");
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 1800);
}

function passageMarkKey(q) {
  if (!q) return "";
  const code = String(q.code || bankBaseCode(state.bankCode) || "").toUpperCase();
  return `${code}|${q.num}`;
}

function currentQuestion() {
  return state.question;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`加载失败 ${res.status}: ${url}`);
  return res.json();
}

function friendsSeasonCode(code) {
  const m = /^FRIENDS_S(\d{2})$/i.exec(code || "");
  if (!m) return null;
  const season = Number(m[1]);
  return season >= 1 && season <= 10 ? season : null;
}

function friendsEpisodeCode(code) {
  const m = /^FRIENDS_S(\d{2})E(\d{2})$/i.exec(code || "");
  if (!m) return null;
  const season = Number(m[1]);
  const episode = Number(m[2]);
  if (season >= 1 && season <= 10 && episode >= 1) return [season, episode];
  return null;
}

function isFriendsFilterCode(code) {
  const c = String(code || "").toUpperCase();
  return c === "FRIENDS" || friendsSeasonCode(c) != null || friendsEpisodeCode(c) != null;
}

function bankBaseCode(code) {
  const c = String(code || "").toUpperCase();
  return isFriendsFilterCode(c) ? "FRIENDS" : c;
}

function bankTitle(code) {
  const c = String(code || "").toUpperCase();
  if (isCustomBankCode(c)) return "自由练习";
  if (isCustomAddCode(c)) return "新增英语文本";
  if (c === "FRIENDS") return "老友记（全部）";
  const ep = friendsEpisodeCode(c);
  if (ep) {
    const [s, e] = ep;
    const hit = state.friendsEpisodes.find(
      (x) => Number(x.season) === s && Number(x.episode) === e
    );
    return hit?.name ? `老友记 ${hit.name}` : `老友记 第${s}季第${e}集`;
  }
  const season = friendsSeasonCode(c);
  if (season != null) return `老友记 第${season}季`;
  const item = state.catalog?.banks?.find((b) => b.code === c);
  return item ? `${item.code} · ${item.title}` : c;
}

function filterFriendsList(list, code) {
  const ep = friendsEpisodeCode(code);
  if (ep) {
    const [season, episode] = ep;
    return list.filter(
      (q) => Number(q.season || 0) === season && Number(q.episode || 0) === episode
    );
  }
  const season = friendsSeasonCode(code);
  if (season != null) {
    return list.filter((q) => Number(q.season || 0) === season);
  }
  return list;
}

const SENSE_COLLAPSE_KEY = "biyi_sense_collapsed";
const SENSE_PER_PAGE = 3;
let sensePageScrollRaf = 0;
let sensePagerBound = false;
let senseResizeTimer = 0;
let sensePagerPageCount = 0;
/** @type {{idx:number,sg:any}[]} */
let sensePagerItems = [];
/** 已构建 DOM 的页码 */
let sensePagerBuilt = new Set();
/** 换题/整表重渲时递增，取消旧的重音标注任务（同一次构建的多页互不取消） */
let senseAnnotateGen = 0;

function isSenseCollapsed() {
  return localStorage.getItem(SENSE_COLLAPSE_KEY) === "1";
}

function sensePagerPageIndex() {
  const block = $("#sense-block");
  if (!block) return 0;
  const w = block.clientWidth || 1;
  return Math.max(0, Math.round(block.scrollLeft / w));
}

function syncSensePageMeta() {
  const meta = $("#sense-fold-meta");
  if (!meta) return;
  const n = sensePagerItems.length;
  const pages = sensePagerPageCount || 0;
  if (!n) {
    meta.textContent = "";
    return;
  }
  if (pages > 1) {
    const page = Math.min(pages, sensePagerPageIndex() + 1);
    meta.textContent = `（${n} · ${page}/${pages}）`;
  } else {
    meta.textContent = `（${n}）`;
  }
}

function syncSenseFoldUi() {
  const section = $("#sense-section");
  const btn = $("#btn-sense-fold");
  const collapsed = isSenseCollapsed();
  section?.classList.toggle("is-collapsed", collapsed);
  if (btn) {
    btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    btn.title = collapsed ? "展开意群" : "折叠意群；展开后左右滑动翻页";
  }
  syncSensePageMeta();
}

function setSenseCollapsed(collapsed) {
  const wasCollapsed = isSenseCollapsed();
  localStorage.setItem(SENSE_COLLAPSE_KEY, collapsed ? "1" : "0");
  syncSenseFoldUi();
  // 从折叠展开时需按真实宽度重新分页（display:none 时量不准）
  if (wasCollapsed && !collapsed && state.question) {
    requestAnimationFrame(() => {
      renderSenseChips(state.question, { keepPage: 0 });
    });
  }
  try {
    document.dispatchEvent(new CustomEvent("biyi-fold-change"));
  } catch (_) {}
}

function ensureSenseGroupsVisible() {
  setSenseCollapsed(false);
}

function toggleSenseFold() {
  setSenseCollapsed(!isSenseCollapsed());
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fillSenseEnTapWords(enSpan, enText) {
  const frag = document.createDocumentFragment();
  for (const part of tokenizeEnglishForTap(enText)) {
    if (part.type === "word") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "en-tap-word";
      btn.textContent = part.text;
      btn.dataset.word = part.text;
      btn.title = `点读：${part.text}`;
      frag.appendChild(btn);
    } else {
      const sep = document.createElement("span");
      sep.className = "en-tap-sep";
      sep.textContent = part.text;
      frag.appendChild(sep);
    }
  }
  enSpan.replaceChildren(frag);
}

function createSenseChip(sg, idx) {
  const en = String(sg?.english || "").trim();
  const zh = String(sg?.chinese || "").trim();
  if (!en && !zh) return null;

  // 用 div：内部要有点词 button，不能再套一层 button
  const chip = document.createElement("div");
  chip.className = "sense-chip";
  chip.dataset.senseIdx = String(idx);
  if (en) chip.dataset.speak = en;
  chip.title = en ? "点读这一意群" : "";
  chip.setAttribute("role", "group");
  chip.setAttribute("aria-label", en ? `意群 ${idx + 1}，点按朗读` : `意群 ${idx + 1}`);

  const enSpan = document.createElement("span");
  enSpan.className = "sense-en";
  if (en) fillSenseEnTapWords(enSpan, en);
  else enSpan.hidden = true;
  chip.appendChild(enSpan);

  const zhEl = document.createElement("small");
  zhEl.className = "sense-zh";
  zhEl.textContent = zh || "…";
  chip.appendChild(zhEl);

  return chip;
}

function pageIndexForSenseIdx(senseIdx) {
  const i = sensePagerItems.findIndex((x) => x.idx === senseIdx);
  if (i < 0) return 0;
  return Math.floor(i / SENSE_PER_PAGE);
}

/** 意群区目标高度：尽量占满上方空白 */
function sensePageTargetHeight() {
  return Math.max(280, Math.min(Math.round(window.innerHeight * 0.5), 460));
}

/**
 * 自适应放大字号，让本页 3 个气泡尽量填满可用高度（仍不溢出）
 */
function fitSensePageFontsForPage(page) {
  if (!page || !page.querySelector(".sense-chip")) return;
  const maxH = sensePageTargetHeight();
  page.classList.remove("is-filled");
  page.style.height = "auto";
  page.style.maxHeight = "none";
  page.style.minHeight = "";
  page.style.overflow = "hidden";
  page.querySelectorAll(".sense-chip").forEach((chip) => {
    chip.style.flex = "";
    chip.style.justifyContent = "";
  });

  let lo = 15;
  let hi = 36;
  let best = 15;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    page.style.setProperty("--sense-en-fs", `${mid}px`);
    page.style.setProperty("--sense-zh-fs", `${Math.max(12, Math.round(mid * 0.78))}px`);
    void page.offsetHeight;
    if (page.scrollHeight <= maxH + 2) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  page.style.setProperty("--sense-en-fs", `${best}px`);
  page.style.setProperty("--sense-zh-fs", `${Math.max(12, Math.round(best * 0.78))}px`);
  void page.offsetHeight;

  // 字号已到上限仍偏矮：固定页高 + 气泡均分拉伸，吃掉空白
  page.style.height = `${maxH}px`;
  page.style.maxHeight = `${maxH}px`;
  page.style.minHeight = `${maxH}px`;
  page.classList.add("is-filled");
  page.querySelectorAll(".sense-chip").forEach((chip) => {
    chip.style.flex = "1 1 0";
    chip.style.justifyContent = "center";
  });
}

function buildSensePage(block, pageIdx) {
  if (!block || pageIdx < 0 || pageIdx >= sensePagerPageCount) return;
  if (sensePagerBuilt.has(pageIdx)) return;
  const page = block.querySelector(`.sense-page[data-page="${pageIdx}"]`);
  if (!page) return;
  const start = pageIdx * SENSE_PER_PAGE;
  const slice = sensePagerItems.slice(start, start + SENSE_PER_PAGE);
  const frag = document.createDocumentFragment();
  for (const { idx, sg } of slice) {
    const chip = createSenseChip(sg, idx);
    if (chip) frag.appendChild(chip);
  }
  page.replaceChildren(frag);
  sensePagerBuilt.add(pageIdx);
  applySenseChipFonts(page);
  fitSensePageFontsForPage(page);

  // 同一次换题内多页并行标注，互不取消；只有整表重渲才作废
  const gen = senseAnnotateGen;
  annotateEnTapStress(page, {
    isStale: () => gen !== senseAnnotateGen,
  })
    .then(() => {
      if (gen !== senseAnnotateGen) return;
      applySenseChipFonts(page);
      fitSensePageFontsForPage(page);
      // 笔译描红行复用意群 chip 重音，标注完成后通知刷新
      try {
        document.dispatchEvent(
          new CustomEvent("biyi-sense-stress-ready", { detail: { pageIdx } })
        );
      } catch (_) {}
    })
    .catch((err) => console.warn(err));
}

/** 把当前练习页中/英文字体写到意群节点（兼容 iOS button） */
function applySenseChipFonts(root) {
  const host = root || $("#sense-block");
  if (!host) return;
  const cs = getComputedStyle(document.documentElement);
  const enStack = (cs.getPropertyValue("--practice-en-font") || "").trim();
  const enStyle = (cs.getPropertyValue("--practice-en-font-style") || "normal").trim() || "normal";
  const zhStack = (cs.getPropertyValue("--practice-lead-font") || "").trim();
  if (enStack) {
    host
      .querySelectorAll(
        ".sense-en, .sense-en .en-tap-word, .sense-en .en-tap-sep, .en-full-block .en-tap-word, .en-full-block .en-tap-sep"
      )
      .forEach((el) => {
      el.style.fontFamily = enStack;
      el.style.fontStyle = enStyle;
    });
  }
  if (zhStack) {
    host.querySelectorAll(".sense-zh").forEach((el) => {
      el.style.fontFamily = zhStack;
    });
  }
}

/** 只构建中心页及左右邻页，避免一次挂上千个意群 DOM */
function ensureSensePagesAround(centerPage) {
  const block = $("#sense-block");
  if (!block || !sensePagerPageCount) return;
  const c = Math.max(0, Math.min(sensePagerPageCount - 1, Number(centerPage) || 0));
  for (const p of [c - 1, c, c + 1]) {
    if (p >= 0 && p < sensePagerPageCount) buildSensePage(block, p);
  }
}

function ensureSensePageForSenseIdx(senseIdx) {
  ensureSensePagesAround(pageIndexForSenseIdx(senseIdx));
}

function scrollSenseChipPageIntoView(chipEl, { smooth = true } = {}) {
  const block = $("#sense-block");
  const page = chipEl?.closest?.(".sense-page");
  if (!block || !page || !block.contains(page)) return;
  const left = page.offsetLeft;
  if (Math.abs(block.scrollLeft - left) < 4) return;
  block.scrollTo({ left, behavior: smooth ? "smooth" : "auto" });
}

function bindSensePagerUi() {
  if (sensePagerBound) return;
  sensePagerBound = true;
  const block = $("#sense-block");
  block?.addEventListener(
    "scroll",
    () => {
      cancelAnimationFrame(sensePageScrollRaf);
      sensePageScrollRaf = requestAnimationFrame(() => {
        ensureSensePagesAround(sensePagerPageIndex());
        syncSensePageMeta();
      });
    },
    { passive: true }
  );
  block?.addEventListener("click", (e) => {
    const chip = e.target?.closest?.(".sense-chip");
    if (!chip || !block.contains(chip)) return;
    e.preventDefault();
    // 点中某个英文单词：只读这个词；点卡片其余位置（空白处/中文）：读整个意群
    const wordEl = e.target?.closest?.(".en-tap-word");
    if (wordEl && chip.contains(wordEl)) {
      speakEnFullWord(wordEl.dataset.word || "", wordEl).catch((err) => console.warn(err));
      return;
    }
    speakSenseChip(chip).catch((err) => console.warn(err));
  });
  const refitSenseFonts = () => {
    clearTimeout(senseResizeTimer);
    senseResizeTimer = setTimeout(() => {
      if (!state.question || isSenseCollapsed()) return;
      const block = $("#sense-block");
      if (!block) return;
      applySenseChipFonts(block);
      block.querySelectorAll(".sense-page").forEach((page) => {
        if (page.querySelector(".sense-chip")) fitSensePageFontsForPage(page);
      });
    }, 80);
  };
  window.addEventListener("resize", () => {
    clearTimeout(senseResizeTimer);
    senseResizeTimer = setTimeout(() => {
      if (!state.question || isSenseCollapsed()) return;
      const keep = sensePagerPageIndex();
      renderSenseChips(state.question, { keepPage: keep });
    }, 180);
  });
  // 中/英文字体切换后重新测算意群字号
  document.addEventListener("biyi-practice-fonts", refitSenseFonts);
}

function renderSenseChips(q, { keepPage = 0 } = {}) {
  const block = $("#sense-block");
  if (!block) return;
  bindSensePagerUi();
  senseAnnotateGen += 1;
  sensePagerBuilt = new Set();
  sensePagerItems = [];
  const groups = Array.isArray(q?.sense_groups) ? q.sense_groups : [];
  groups.forEach((sg, idx) => {
    const en = String(sg?.english || "").trim();
    const zh = String(sg?.chinese || "").trim();
    if (!en && !zh) return;
    sensePagerItems.push({ idx, sg });
  });

  if (!sensePagerItems.length) {
    sensePagerPageCount = 0;
    block.replaceChildren();
    syncSenseFoldUi();
    return;
  }

  sensePagerPageCount = Math.ceil(sensePagerItems.length / SENSE_PER_PAGE);
  void block.offsetWidth;
  const pageWidth = Math.max(
    160,
    block.clientWidth ||
      block.parentElement?.clientWidth ||
      $("#sense-section")?.clientWidth ||
      Math.min(window.innerWidth - 32, 720)
  );

  // 只建空页壳；真正的 chip 按需懒加载（当前页 ±1）
  const frag = document.createDocumentFragment();
  for (let pageIdx = 0; pageIdx < sensePagerPageCount; pageIdx += 1) {
    const page = document.createElement("div");
    page.className = "sense-page";
    page.dataset.page = String(pageIdx);
    page.setAttribute("aria-label", `意群第 ${pageIdx + 1} 页`);
    frag.appendChild(page);
  }
  block.replaceChildren(frag);

  const target = Math.max(0, Math.min(sensePagerPageCount - 1, Number(keepPage) || 0));
  block.scrollLeft = target * (block.clientWidth || pageWidth);
  ensureSensePagesAround(target);
  syncSenseFoldUi();
}

function stripLeadingQuestionNum(name, num) {
  const title = String(name || "").trim();
  const n = String(num ?? "").trim();
  if (!title) return "";
  if (!n) return title;
  const re = new RegExp(`^#?\\s*${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s*[·.•\\-—–:]\\s*|\\s+)`);
  return title.replace(re, "").trim() || title;
}

function syncCustomButtons() {
  // 任意文章都可新增 / 编辑文本
  $("#btn-custom-text-add")?.classList.remove("hidden");
  $("#btn-custom-text-edit")?.classList.toggle("hidden", !state.question);
}

function renderQuestion() {
  const q = state.question;
  const nameEl = $("#q-name");
  const metaEl = $("#q-meta");
  if (!q) {
    if (nameEl) nameEl.textContent = "请选择题库";
    if (metaEl) metaEl.textContent = "";
    $("#sense-block")?.replaceChildren();
    syncSenseFoldUi();
    syncCustomButtons();
    return;
  }
  if (nameEl) {
    const title = stripLeadingQuestionNum(q.name, q.num);
    nameEl.innerHTML = `<button type="button" class="practice-num-jump" id="btn-practice-jump" title="跳转题目" aria-haspopup="dialog" aria-controls="practice-jump-dialog">#${escapeHtml(String(q.num))}</button>${
      title ? ` <span class="q-title-text">${escapeHtml(title)}</span>` : ""
    }`;
  }
  if (metaEl) metaEl.textContent = `${bankTitle(state.bankCode)} · ${state.index + 1} / ${state.list.length}`;
  renderSenseChips(q);
  translationApi?.restoreTranslationFor(q);
  if (state.translation.on) {
    translationApi?.syncTranslationUI();
  }
  fillEnFullBlock(q);
  syncCustomButtons();
}

function syncNav() {
  const prev = $("#btn-prev");
  const next = $("#btn-next");
  if (prev) prev.disabled = state.index <= 0;
  if (next) next.disabled = state.index < 0 || state.index >= state.list.length - 1;
}

function buildEnglishFullText(q) {
  const groups = Array.isArray(q?.sense_groups) ? q.sense_groups : [];
  // 中英对照：一个意群一对（上中文、下英文）；只有中文的意群也显示，但不参与朗读
  const pairs = groups
    .map((sg) => ({
      zh: String(sg?.chinese || "").trim(),
      en: String(sg?.english || "").trim(),
    }))
    .filter((p) => p.en || p.zh);
  const groupLines = pairs.map((p) => p.en).filter(Boolean);
  // 优先按意群分行（一行一断句）；没有意群时再退回整段英文按换行切
  if (groupLines.length) {
    return {
      en: groupLines.join("\n"),
      lines: groupLines,
      count: groupLines.length,
      pairs,
    };
  }
  const saved = String(q?.en || "").trim();
  const lines = saved
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    en: lines.length ? lines.join("\n") : saved,
    lines: lines.length ? lines : saved ? [saved] : [],
    count: lines.length || (saved ? 1 : 0),
    pairs: lines.map((en) => ({ zh: "", en })),
  };
}

const EN_FULL_COLLAPSE_KEY = "biyi_en_full_collapsed";
const enFullSpeech = createEdgeSpeech();
let enFullPlayToken = 0;
let enFullStressToken = 0;
let enFullRawText = "";
/** @type {string[]} */
let enFullLines = [];
/** 与 enFullLines 一一对应的中文（锁屏英中对照） */
let enFullZhLines = [];
let enFullUiBound = false;
let enFullScrollRaf = 0;
/** 取出全文里每句英文（含重音标记：ˈ 和加粗音节）的片段，给锁屏卡片用；数量对不上就不用 */
function enFullRichLines() {
  const rows = Array.from(document.querySelectorAll("#en-full-block .en-full-en"));
  return rows.map((row) => {
    const segs = [];
    for (const word of row.childNodes) {
      if (word.nodeType === Node.TEXT_NODE) {
        segs.push({ t: word.textContent || "", b: false });
        continue;
      }
      const kids = Array.from(word.childNodes);
      if (!kids.length) continue;
      for (const k of kids) {
        const isStress =
          k.nodeType === Node.ELEMENT_NODE &&
          (k.classList.contains("en-stress-mark") || k.classList.contains("en-stress-syl"));
        segs.push({ t: k.textContent || "", b: isStress });
      }
    }
    return segs;
  });
}

const EN_FULL_LINE_PAUSE_MS = 420;

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function englishFullSpeakLines(text = enFullRawText, lines = enFullLines) {
  if (Array.isArray(lines) && lines.length) {
    return lines.map((l) => String(l || "").trim()).filter(Boolean);
  }
  return String(text || "")
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function isEnFullCollapsed() {
  // 默认展开英文全文
  return localStorage.getItem(EN_FULL_COLLAPSE_KEY) === "1";
}

function syncEnFullFoldUi() {
  const section = $("#en-full-section");
  const btn = $("#btn-en-full-fold");
  const meta = $("#en-full-fold-meta");
  const playBtn = $("#btn-en-full-play");
  const collapsed = isEnFullCollapsed();
  section?.classList.toggle("is-collapsed", collapsed);
  if (btn) {
    btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    btn.title = collapsed ? "展开全文" : "折叠全文";
  }
  if (playBtn) playBtn.hidden = collapsed || !enFullRawText;
  const dlBtn = $("#btn-en-full-dl");
  if (dlBtn) dlBtn.hidden = collapsed || !enFullRawText;
  paintEnFullImportBtn();
  const q = currentQuestion();
  const { count } = q ? buildEnglishFullText(q) : { count: 0 };
  if (meta) meta.textContent = count ? `（${count}）` : "";
}

function paintEnFullImportBtn() {
  const btn = $("#btn-en-full-import");
  if (!btn) return;
  const collapsed = isEnFullCollapsed();
  btn.hidden = collapsed || !enFullRawText;
  const key = passageMarkKey(currentQuestion());
  const info = key ? getFullArticleAudioMeta(key) : null;
  if (info) {
    btn.classList.add("is-imported");
    btn.textContent = "清除导入音频";
    btn.title = `已导入：${info.fileName || "音频"}（${Math.max(1, Math.round((info.size || 0) / 1024))} KB）。点此清除；全文朗读会优先播导入音频`;
  } else {
    btn.classList.remove("is-imported");
    btn.textContent = "导入全文音频";
    btn.title = "从本机选择整篇文章音频（mp3/m4a/wav 等）；有导入时全文朗读优先播它";
  }
}

function setEnFullCollapsed(collapsed) {
  localStorage.setItem(EN_FULL_COLLAPSE_KEY, collapsed ? "1" : "0");
  if (collapsed) {
    enFullPlayToken += 1;
    stopImportedFullAudio();
    enFullSpeech.stopPlayback?.();
    resetEnFullPlayBtn();
  }
  syncEnFullFoldUi();
  if (!collapsed) fillEnFullBlock();
  else {
    // 折叠时释放预加载
    enFullSpeech.release();
    const block = $("#en-full-block");
    if (block) {
      block.replaceChildren();
      block.style.height = "";
      block.style.maxHeight = "";
    }
  }
  try {
    document.dispatchEvent(new CustomEvent("biyi-fold-change"));
  } catch (_) {}
}

function tokenizeEnglishForTap(text) {
  const raw = String(text || "");
  const parts = [];
  const re = /([A-Za-z]+(?:'[A-Za-z]+)?)|([^A-Za-z]+)/g;
  let m;
  while ((m = re.exec(raw))) {
    if (m[1]) parts.push({ type: "word", text: m[1] });
    else if (m[2]) parts.push({ type: "sep", text: m[2] });
  }
  return parts;
}

function splitSpeakChunks(text, maxLen = 320) {
  // 先按行断句；行内过长再按句号切
  const lines = englishFullSpeakLines(text);
  if (!lines.length) return [];
  const chunks = [];
  for (const line of lines) {
    if (line.length <= maxLen) {
      chunks.push(line);
      continue;
    }
    const sentences = line.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [line];
    let buf = "";
    for (const sentence of sentences) {
      const t = sentence.trim();
      if (!t) continue;
      if (buf && buf.length + 1 + t.length > maxLen) {
        chunks.push(buf);
        buf = t;
      } else {
        buf = buf ? `${buf} ${t}` : t;
      }
    }
    if (buf) chunks.push(buf);
  }
  return chunks;
}

function clearEnTapSpeaking() {
  document
    .querySelectorAll("#en-full-block .en-tap-word.is-speaking, #sense-block .en-tap-word.is-speaking, #sense-block .sense-chip.is-speaking")
    .forEach((el) => el.classList.remove("is-speaking"));
}

let senseSpeakToken = 0;

function isEnFullPlaying() {
  return !!$("#btn-en-full-play")?.classList.contains("is-playing");
}

/** 全文当前这句用的声音：暂停后点单词，沿用这一刻轮到的音色 */
let enFullPlayOffset = 0;
let enFullLineVoice = "";

function rememberFullLineVoice(lineNo) {
  const engine = getTtsEngine();
  const saved = getFullVoice(engine);
  if (!isRotateVoice(saved)) {
    enFullLineVoice = saved || "";
    return;
  }
  const idx = Math.max(0, Math.floor(Number(lineNo) || 1) - enFullPlayOffset - 1);
  enFullLineVoice = rotateVoiceAt(engine, idx) || "";
}

function currentFullLineVoice() {
  if (isEnFullPlaying()) {
    if (enFullLineVoice) return enFullLineVoice;
    if (enFullPhase === "play" && enFullLineNo) rememberFullLineVoice(enFullLineNo);
    if (enFullLineVoice) return enFullLineVoice;
  }
  const engine = getTtsEngine();
  const saved = getFullVoice(engine);
  if (isRotateVoice(saved)) return peekRotateVoice(engine) || undefined;
  return saved || undefined;
}

function resumeEnFullAfterAside(wasPaused) {
  if (wasPaused) return;
  if (!isEnFullPlaying() || isEnFullCollapsed()) return;
  enFullSpeech.resumePlayback?.();
  renderEnFullPlayBtn();
}

async function speakSenseChip(chip) {
  const en = String(chip?.dataset?.speak || "").replace(/\s+/g, " ").trim();
  if (!en) {
    toast("这一意群没有英文");
    return;
  }
  const token = ++senseSpeakToken;
  const playing = isEnFullPlaying();
  const wasPaused = !!enFullSpeech.isPaused?.();
  clearEnTapSpeaking();
  hideEnWordTip();
  if (!playing) {
    enFullPlayToken += 1;
    resetEnFullPlayBtn();
  }
  chip.classList.add("is-speaking");
  const tts = createSenseTtsProgress(chip);
  try {
    await enFullSpeech.unlockAudio?.();
    if (playing) {
      await enFullSpeech.speakAside(en, { hold: true, voice: currentFullLineVoice(), onProgress: tts.update });
      resumeEnFullAfterAside(wasPaused);
    } else {
      await enFullSpeech.speakOnce(en, { onProgress: tts.update, rotateSense: true });
    }
  } catch (err) {
    console.warn(err);
    tts.remove();
    if (token === senseSpeakToken) toast("意群朗读失败");
  } finally {
    // 没触发过联网加载（命中本机缓存 / 本机引擎）就没有进度条可收
    tts.finish();
    if (token === senseSpeakToken) chip.classList.remove("is-speaking");
  }
}

/**
 * 意群卡片上的「在线朗读加载」进度条。
 * 命中本机缓存时不显示；联网合成时显示进度，存好后短暂提示「已存本机」。
 */
function createSenseTtsProgress(chip) {
  let bar = null;
  let fill = null;
  let label = null;
  let hideTimer = 0;
  let shown = false;

  const ensure = () => {
    if (bar?.isConnected) return;
    bar = document.createElement("div");
    bar.className = "sense-tts-progress";
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-label", "在线朗读加载进度");
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    fill = document.createElement("i");
    fill.className = "sense-tts-fill";
    label = document.createElement("span");
    label.className = "sense-tts-label";
    bar.append(fill, label);
    chip.appendChild(bar);
  };

  const remove = () => {
    clearTimeout(hideTimer);
    bar?.remove();
    bar = null;
    shown = false;
  };

  const update = (p) => {
    if (!p) return;
    if (p.phase === "cache") {
      remove();
      return;
    }
    ensure();
    clearTimeout(hideTimer);
    shown = true;
    bar.classList.remove("is-done");
    if (p.phase === "loading") {
      if (Number.isFinite(p.ratio)) {
        const pct = Math.max(1, Math.min(99, Math.round(p.ratio * 100)));
        bar.classList.remove("is-indeterminate");
        bar.setAttribute("aria-valuenow", String(pct));
        fill.style.width = `${pct}%`;
        label.textContent = `加载音频 ${pct}%`;
      } else {
        bar.classList.add("is-indeterminate");
        bar.removeAttribute("aria-valuenow");
        fill.style.width = "";
        label.textContent = "加载音频…";
      }
    } else if (p.phase === "saving") {
      bar.classList.remove("is-indeterminate");
      bar.setAttribute("aria-valuenow", "100");
      fill.style.width = "100%";
      label.textContent = "正在保存到本机…";
    } else if (p.phase === "done") {
      bar.classList.remove("is-indeterminate");
      bar.classList.add("is-done");
      bar.setAttribute("aria-valuenow", "100");
      fill.style.width = "100%";
      label.textContent = "已永久保存 ✓";
      hideTimer = setTimeout(remove, 1600);
    }
  };

  return {
    update,
    remove,
    /** 朗读结束：若还停在加载态（被打断等）就收掉；已完成的让它自己淡出 */
    finish() {
      if (!shown || !bar) return;
      if (!bar.classList.contains("is-done")) remove();
    },
  };
}

async function speakEnFullWord(word, el) {
  const w = String(word || "").trim();
  if (!w) return;
  const playing = isEnFullPlaying();
  const wasPaused = !!enFullSpeech.isPaused?.();
  senseSpeakToken += 1; // 打断正在读的整个意群
  clearEnTapSpeaking();
  el?.classList.add("is-speaking");

  showEnWordTip(el, null, { loading: true });
  const dictPromise = lookupEnWord(w)
    .then((info) => {
      if (info) {
        if (info.phonetic && el) applyStressToWordEl(el, w, info.phonetic);
        showEnWordTip(el, info, {
          saved: hasWord(info.word || w),
          onAdd: (entry) => {
            addWord(entry || { word: w, phonetic: info.phonetic, gloss: info.gloss }, { toast });
            toast("已加入词典");
            scheduleHideEnWordTip(1600);
          },
        });
        const marked = info.phonetic ? markStressOnWord(w, info.phonetic) : w;
        const bits = [info.phonetic ? `/${formatPhonetic(info.phonetic)}/` : "", info.gloss || ""]
          .filter(Boolean)
          .join(" · ");
        if (bits && el) el.title = `${marked} ${bits}`;
      } else {
        showEnWordTip(el, { word: w, phonetic: "", gloss: "暂无音标/释义" }, {
          saved: hasWord(w),
          onAdd: (entry) => {
            addWord(entry || { word: w, phonetic: "", gloss: "" }, { toast });
            toast("已加入词典");
            scheduleHideEnWordTip(1600);
          },
        });
      }
      return info;
    })
    .catch((err) => {
      console.warn(err);
      showEnWordTip(el, { word: w, phonetic: "", gloss: "释义加载失败" });
      return null;
    });

  try {
    await enFullSpeech.unlockAudio?.();
    if (playing) {
      await Promise.all([enFullSpeech.speakAside(w, { hold: true, voice: currentFullLineVoice() }), dictPromise]);
      resumeEnFullAfterAside(wasPaused);
    } else {
      await Promise.all([enFullSpeech.speakOnce(w), dictPromise]);
    }
  } catch (err) {
    console.warn(err);
    toast("单词朗读失败");
  } finally {
    el?.classList.remove("is-speaking");
    scheduleHideEnWordTip(4500);
  }
}

/** 全文朗读按钮文字：朗读中显示进度；暂停时显示「继续」 */
let enFullPhase = "";
let enFullLineNo = 0;
let enFullLineTotal = 0;

let enFullFocusedLine = 0;
/** 程序滚到当前句时，短暂忽略手动滚动回写进度 */
let enFullIgnoreScrollUntil = 0;
let enFullProgScrollRaf = 0;
let enFullScrollRestartTimer = 0;
/** 点暂停时的句号；拖动改进度后再点继续则从新句重开 */
let enFullPausedLine = 0;
/** 用户导入的整篇音频播放器 */
let importedFullCtrl = null;
let importedFullActive = false;

/** 把正在朗读的那一对（英文+中文）高亮，可选滚到全文框正中间 */
function focusEnFullLine(lineNo, { scroll = true } = {}) {
  const block = $("#en-full-block");
  if (!block || !lineNo) return;
  const ens = block.querySelectorAll(".en-full-pair .en-full-en");
  const row = ens[lineNo - 1]?.closest(".en-full-pair");
  if (!row) return;
  const same = lineNo === enFullFocusedLine;
  enFullFocusedLine = lineNo;
  if (!same) {
    block.querySelectorAll(".en-full-pair.is-reading").forEach((el) => el.classList.remove("is-reading"));
    row.classList.add("is-reading");
  }
  if (!scroll || !block.clientHeight) return;
  const b = block.getBoundingClientRect();
  const r = row.getBoundingClientRect();
  const top = block.scrollTop + (r.top - b.top) - (block.clientHeight - r.height) / 2;
  enFullIgnoreScrollUntil = Date.now() + 420;
  block.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
}

function clearEnFullFocus() {
  enFullFocusedLine = 0;
  document.querySelectorAll("#en-full-block .en-full-pair.is-reading").forEach((el) => el.classList.remove("is-reading"));
}

/** 全文框可视区域正中那一句的朗读序号（1-based） */
function speakLineAtEnFullViewport(block = $("#en-full-block")) {
  if (!block) return 0;
  const ens = block.querySelectorAll(".en-full-pair .en-full-en");
  if (!ens.length) return 0;
  const mid = block.getBoundingClientRect().top + block.clientHeight / 2;
  let best = 1;
  let bestDist = Infinity;
  for (let i = 0; i < ens.length; i += 1) {
    const row = ens[i].closest(".en-full-pair") || ens[i];
    const r = row.getBoundingClientRect();
    const c = (r.top + r.bottom) / 2;
    const d = Math.abs(c - mid);
    if (d < bestDist) {
      bestDist = d;
      best = i + 1;
    }
  }
  return best;
}

function paintEnFullProgressBtn() {
  const btn = $("#btn-en-full-play");
  if (!btn) return;
  const total = enFullLineTotal || englishFullSpeakLines().length;
  const no = Math.min(Math.max(enFullLineNo || 0, 0), total || 0);
  if (btn.classList.contains("is-playing")) {
    renderEnFullPlayBtn();
    return;
  }
  if (no > 1 && total) {
    btn.textContent = `从 ${no}/${total} 朗读`;
    btn.title = `从第 ${no} 句开始朗读全文`;
  } else {
    btn.textContent = "全文朗读";
    btn.title = "朗读全文（音色在顶部「音色」里选）";
  }
}

function applyEnFullScrollProgress(lineNo, { restartPlay = false } = {}) {
  const total =
    englishFullSpeakLines().length ||
    $("#en-full-block")?.querySelectorAll(".en-full-pair .en-full-en").length ||
    0;
  if (!total || !lineNo) return;
  const n = Math.min(Math.max(Math.floor(lineNo), 1), total);
  const changed = n !== enFullLineNo || total !== enFullLineTotal;
  enFullLineNo = n;
  enFullLineTotal = total;
  // 用户拖动时只高亮，不回滚位置，避免和滑块抢
  focusEnFullLine(n, { scroll: false });
  const btn = $("#btn-en-full-play");
  const playing = !!btn?.classList.contains("is-playing");
  const paused = !!enFullSpeech.isPaused?.();
  if (playing && btn) {
    const prog = ` ${enFullLineNo}/${enFullLineTotal}`;
    if (paused) {
      btn.textContent = `继续${prog}`;
      btn.title = "已暂停，点一下继续朗读；拖动全文可改起点";
      btn.classList.add("is-paused");
    } else {
      btn.classList.remove("is-paused");
      btn.title = "朗读中，点一下暂停；拖动全文可跳到该句";
      btn.textContent = enFullPhase === "prepare" ? `准备${prog}` : `朗读${prog}`;
    }
    if (restartPlay && changed && !paused) {
      clearTimeout(enFullScrollRestartTimer);
      enFullScrollRestartTimer = setTimeout(() => {
        if ($("#btn-en-full-play")?.classList.contains("is-playing") && !enFullSpeech.isPaused?.()) {
          playEnFullArticle(enFullLineNo).catch((err) => console.warn(err));
        }
      }, 280);
    }
  } else {
    paintEnFullProgressBtn();
  }
}

function onEnFullBlockScroll() {
  if (Date.now() < enFullIgnoreScrollUntil) return;
  cancelAnimationFrame(enFullProgScrollRaf);
  enFullProgScrollRaf = requestAnimationFrame(() => {
    if (Date.now() < enFullIgnoreScrollUntil) return;
    const line = speakLineAtEnFullViewport();
    if (!line) return;
    applyEnFullScrollProgress(line, { restartPlay: true });
  });
}

function stopImportedFullAudio() {
  try {
    importedFullCtrl?.stop?.();
  } catch (_) {}
  importedFullCtrl = null;
  importedFullActive = false;
}

function isImportedFullPaused() {
  return importedFullActive && !!importedFullCtrl?.isPaused?.();
}

function renderEnFullPlayBtn() {
  const btn = $("#btn-en-full-play");
  if (!btn || !btn.classList.contains("is-playing")) return;
  const paused = importedFullActive ? isImportedFullPaused() : !!enFullSpeech.isPaused?.();
  // 播放中自动跟读滚动；暂停时保留用户拖动的位置；导入整篇音频时不跟读逐句
  if (!importedFullActive && !paused && enFullPhase === "play" && enFullLineNo) {
    focusEnFullLine(enFullLineNo);
  }
  const prog = enFullLineTotal ? ` ${enFullLineNo}/${enFullLineTotal}` : "";
  if (paused) {
    btn.textContent = importedFullActive ? `继续播放${prog}` : `继续${prog}`;
    btn.title = importedFullActive
      ? "已暂停导入音频，点一下继续"
      : "已暂停，点一下继续朗读；拖动全文可改起点";
    btn.classList.add("is-paused");
    return;
  }
  btn.classList.remove("is-paused");
  if (importedFullActive) {
    btn.title = "正在播放导入的全文音频，点一下暂停";
    btn.textContent = enFullLineNo ? `播放${prog}` : "播放导入音频…";
    return;
  }
  btn.title = "朗读中，点一下暂停；拖动全文可跳到该句";
  btn.textContent = enFullPhase === "prepare" ? `准备${prog}` : enFullLineNo ? `朗读${prog}` : "朗读中…";
}

/** 点「全文朗读」→ 先选用谁的声音 */
function getFullVoice(engine = getTtsEngine()) {
  return getSavedVoice(engine);
}

const VOICE_SAMPLE = "Hello, this is how I sound when reading the full text.";

/** 打开音色选择时若正在全文朗读，先停下；关闭后从当前这句用（新）音色接着读 */
let voiceResumeFrom = 0;

function closeReadVoiceDialog() {
  const page = $("#view-read-voice");
  if (!page || page.classList.contains("hidden")) return;
  page.classList.add("hidden");
  $("#view-practice")?.classList.remove("hidden");
  window.scrollTo(0, 0);
  enFullSpeech.stopPlayback?.(); // 停掉试听
  const from = voiceResumeFrom;
  voiceResumeFrom = 0;
  if (from > 0) playEnFullArticle(from).catch((err) => console.warn(err));
}

async function openReadVoiceDialog() {
  const page = $("#view-read-voice");
  const list = $("#read-voice-list");
  if (!page || !list) return;
  let groups;
  try {
    groups = await enFullSpeech.listVoiceGroups();
  } catch (err) {
    console.warn(err);
    groups = null;
  }
  if (!groups || (!groups.online.length && !groups.apple.length)) {
    toast("取不到可选的音色");
    return;
  }
  // 正在全文朗读：先停下，选完再从这一句接着读
  const playBtn = $("#btn-en-full-play");
  if (playBtn?.classList.contains("is-playing")) {
    voiceResumeFrom = Math.max(1, enFullLineNo || 1);
    stopEnFullArticle();
  }
  // 当前选中 = 当前引擎 + 该引擎下记住的声音
  const curEngine = getTtsEngine() === "apple" ? "apple" : "online";
  const sets = [
    { engine: "online", title: "联网声音（需要网络）", voices: groups.online, def: groups.onlineDefault },
    { engine: "apple", title: "本机声音（系统自带，离线可用）", voices: groups.apple, def: groups.appleDefault },
  ];
  const desc = $("#read-voice-desc");
  if (desc) {
    desc.textContent = "统一设置所有朗读的音色：全文朗读、意群、点单词发音和笔译。「按顺序」每读完一个意群就换下一个声音，一圈后再从头。";
  }
  const frag = document.createDocumentFragment();
  for (const set of sets) {
    if (!set.voices.length) continue;
    const saved = getSavedVoice(set.engine);
    const voices = [{ id: ROTATE_VOICE, label: "按顺序" }, ...set.voices];
    const pick = isRotateVoice(saved) || set.voices.some((v) => v.id === saved) ? saved : set.def;
    const head = document.createElement("div");
    head.className = "read-voice-group";
    head.textContent = set.title;
    frag.appendChild(head);
    for (const v of voices) {
      const row = document.createElement("label");
      row.className = "read-voice-row";
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "read-voice";
      radio.value = `${set.engine}|${v.id}`;
      radio.checked = set.engine === curEngine && v.id === pick;
      const text = document.createElement("span");
      text.className = "read-voice-name";
      text.textContent = v.label;
      const tryBtn = document.createElement("button");
      tryBtn.type = "button";
      tryBtn.className = "btn btn-ghost btn-compact read-voice-try";
      tryBtn.textContent = "试听";
      tryBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        radio.checked = true;
        const sampleVoice = isRotateVoice(v.id) ? set.voices[0]?.id : v.id;
        enFullSpeech
          .speakOnce(VOICE_SAMPLE, { engine: set.engine, voice: sampleVoice })
          .catch(() => toast("试听失败"));
      });
      row.append(radio, text, tryBtn);
      frag.appendChild(row);
    }
  }
  list.replaceChildren(frag);
  $("#view-practice")?.classList.add("hidden");
  page.classList.remove("hidden");
  window.scrollTo(0, 0);
  setTimeout(() => list.querySelector("input:checked")?.scrollIntoView({ block: "center" }), 40);
}

function confirmReadVoice() {
  const checked = $("#read-voice-list input[type=radio]:checked");
  if (checked) {
    const [engine, ...rest] = String(checked.value).split("|");
    const id = rest.join("|");
    const eng = engine === "apple" ? "apple" : "online";
    setTtsEngine(eng);
    setSavedVoice(id, eng);
    // 全文朗读、笔译、意群点读共用这个声音
    try {
      document.dispatchEvent(new CustomEvent("biyi-tts-engine", { detail: { engine: eng, voice: id } }));
    } catch (_) {}
  }
  const label = checked?.closest(".read-voice-row")?.querySelector(".read-voice-name")?.textContent || "";
  closeReadVoiceDialog();
  if (label) toast(`音色已设为：${label}`);
}

/** 快速双击朗读按钮 → 输入意群序号，设为朗读起点 */
let enFullLastClick = 0;
let enFullPrePaused = false;
let readJumpResume = false;

function openReadJumpDialog() {
  const n = englishFullSpeakLines().length;
  const dialog = $("#read-jump-dialog");
  const input = $("#read-jump-input");
  if (!n || !dialog || !input) return;
  // 输入时先暂停；取消后恢复到双击之前的状态
  readJumpResume = importedFullActive ? !isImportedFullPaused() : !enFullPrePaused;
  if (importedFullActive) importedFullCtrl?.pause?.();
  else enFullSpeech.pausePlayback?.();
  renderEnFullPlayBtn();
  const desc = $("#read-jump-desc");
  if (desc) {
    desc.textContent = importedFullActive
      ? `输入 1–${n}：按全文比例跳到导入音频的大致位置`
      : `输入 1–${n} 之间的序号，从这一句开始朗读`;
  }
  input.min = "1";
  input.max = String(n);
  input.value = String(Math.min(Math.max(enFullLineNo || 1, 1), n));
  dialog.classList.remove("hidden");
  setTimeout(() => {
    input.focus();
    input.select();
  }, 40);
}

function closeReadJumpDialog({ resume = false } = {}) {
  const dialog = $("#read-jump-dialog");
  if (!dialog || dialog.classList.contains("hidden")) return;
  dialog.classList.add("hidden");
  if (resume && readJumpResume) {
    if (importedFullActive) importedFullCtrl?.resume?.();
    else enFullSpeech.resumePlayback?.();
  }
  readJumpResume = false;
  renderEnFullPlayBtn();
}

function confirmReadJump() {
  const n = englishFullSpeakLines().length;
  const input = $("#read-jump-input");
  const raw = Number(input?.value);
  if (!Number.isFinite(raw) || raw < 1 || raw > n) {
    toast(`请输入 1–${n} 的意群序号`);
    input?.focus();
    input?.select();
    return;
  }
  const start = Math.floor(raw);
  readJumpResume = false;
  closeReadJumpDialog();
  playEnFullArticle(start).catch((err) => console.warn(err));
}

function resetEnFullPlayBtn() {
  const btn = $("#btn-en-full-play");
  clearEnFullFocus();
  clearTimeout(enFullScrollRestartTimer);
  enFullPhase = "";
  enFullPlayOffset = 0;
  enFullLineVoice = "";
  enFullPausedLine = 0;
  const total = englishFullSpeakLines().length;
  const line = speakLineAtEnFullViewport();
  enFullLineTotal = total;
  enFullLineNo = line > 1 && total ? line : 0;
  if (enFullLineNo) focusEnFullLine(enFullLineNo, { scroll: false });
  if (!btn) return;
  btn.classList.remove("is-playing", "is-paused");
  paintEnFullProgressBtn();
}

async function playEnFullArticle(startAt = 1) {
  const all = englishFullSpeakLines();
  if (!all.length) {
    toast("暂无英文");
    return;
  }
  // 从第 startAt 句开始读（序号按全文计）
  const off = Math.min(Math.max(0, Math.floor(Number(startAt) || 1) - 1), all.length - 1);
  const lines = all.slice(off);
  const playBtn = $("#btn-en-full-play");
  const token = ++enFullPlayToken;
  stopImportedFullAudio();
  enFullSpeech.stopPlayback?.(); // 打断上一轮（含暂停中的）再重新开始
  clearEnTapSpeaking();
  enFullPhase = "";
  enFullLineNo = off + 1;
  enFullLineTotal = all.length;
  enFullPlayOffset = off;
  rememberFullLineVoice(off + 1);
  playBtn?.classList.add("is-playing");
  renderEnFullPlayBtn();
  if (off > 0) focusEnFullLine(off + 1); // 先把起点滚到正中间

  // 有用户导入的整篇音频时优先播放
  const passageKey = passageMarkKey(currentQuestion());
  if (passageKey && hasFullArticleAudio(passageKey)) {
    let playedImport = false;
    try {
      const blob = await loadFullArticleAudioBlob(passageKey);
      if (token !== enFullPlayToken) return;
      if (blob) {
        importedFullActive = true;
        enFullPhase = "play";
        renderEnFullPlayBtn();
        await new Promise((resolve, reject) => {
          importedFullCtrl = playImportedFullAudio(blob, {
            startRatio: all.length > 1 ? off / all.length : 0,
            onTime: ({ currentTime, duration }) => {
              if (token !== enFullPlayToken || !duration) return;
              const approx = Math.min(
                all.length,
                Math.max(1, Math.floor((currentTime / duration) * all.length) + 1)
              );
              if (approx !== enFullLineNo) {
                enFullLineNo = approx;
                focusEnFullLine(approx, { scroll: true });
                renderEnFullPlayBtn();
              }
            },
            onEnded: () => resolve(),
            onError: (err) => reject(err || new Error("播放失败")),
          });
        });
        playedImport = true;
        if (token === enFullPlayToken) toast("导入音频播放完成");
      }
    } catch (err) {
      if (token !== enFullPlayToken) return;
      console.warn(err);
      toast(err?.message || "导入音频播放失败，改用朗读");
      stopImportedFullAudio();
    }
    if (playedImport) {
      if (token === enFullPlayToken) resetEnFullPlayBtn();
      return;
    }
    if (token !== enFullPlayToken) return;
    stopImportedFullAudio();
  }

  try {
    await enFullSpeech.unlockAudio?.();
    const engine = getTtsEngine();
    // iPhone 本机：整段交给原生排队朗读，锁屏后也能继续（并出现锁屏播放控制）
    const queued = await enFullSpeech.speakLines?.(lines, {
      pauseMs: EN_FULL_LINE_PAUSE_MS,
      title: "全文朗读",
      subs: enFullZhLines.slice(off),
      rich: (() => {
        const r = enFullRichLines();
        return r.length === all.length ? r.slice(off) : [];
      })(),
      offset: off,
      grandTotal: all.length,
      voice: getFullVoice() || undefined,
      onPrepare: (done, total) => {
        // 联网：先备齐全部音频，再连续播放（锁屏后不依赖网页逐句下载）
        if (token !== enFullPlayToken) return;
        enFullPhase = "prepare";
        enFullLineNo = done;
        enFullLineTotal = total;
        renderEnFullPlayBtn();
      },
      onLine: (i, total) => {
        if (token !== enFullPlayToken) return;
        enFullPhase = "play";
        enFullLineNo = i;
        enFullLineTotal = total;
        rememberFullLineVoice(i);
        renderEnFullPlayBtn();
      },
      onStopped: () => {
        if (token === enFullPlayToken) stopEnFullArticle();
      },
    });
    if (queued) {
      if (token === enFullPlayToken && !queued.cancelled) {
        toast(`全文朗读完成（${engine === "apple" ? "本机" : "联网"}）`);
      }
      return;
    }
    // 一行一断句：读完停顿再读下一行，避免连读上气不接下气
    for (let i = 0; i < lines.length; i += 1) {
      if (token !== enFullPlayToken) return;
      await enFullSpeech.waitIfPaused?.(); // 暂停中就停在这一句前面
      if (token !== enFullPlayToken) return;
      enFullPhase = "play";
      enFullLineNo = off + i + 1;
      enFullLineTotal = all.length;
      rememberFullLineVoice(enFullLineNo);
      renderEnFullPlayBtn();
      await enFullSpeech.speakOnce(lines[i], { voice: currentFullLineVoice() || undefined, rotateSense: true });
      if (token !== enFullPlayToken) return;
      if (i < lines.length - 1) {
        await sleepMs(EN_FULL_LINE_PAUSE_MS);
      }
    }
    if (token === enFullPlayToken) toast(`全文朗读完成（${engine === "apple" ? "本机" : "联网"}）`);
  } catch (err) {
    if (token === enFullPlayToken) toast(err?.message || "全文朗读失败");
  } finally {
    if (token === enFullPlayToken) resetEnFullPlayBtn();
  }
}

/** 「下载全文音频」：把全文每一行的联网朗读音频提前存到本机 */
let enFullDownloading = false;
let enFullDownloadText = "";

function resetEnFullDownloadBtn() {
  const btn = $("#btn-en-full-dl");
  enFullDownloading = false;
  enFullDownloadText = "";
  if (!btn) return;
  btn.classList.remove("is-downloading");
  btn.textContent = "下载全文音频";
  btn.title = "把全文的联网朗读音频提前存到本机，之后锁屏、离线也能连续播放";
}

function cancelEnFullDownload() {
  if (!enFullDownloading) return;
  enFullSpeech.cancelPrefetch?.();
  resetEnFullDownloadBtn();
}

async function downloadEnFullAudio() {
  const btn = $("#btn-en-full-dl");
  if (!btn) return;
  if (enFullDownloading) {
    cancelEnFullDownload();
    toast("已停止下载，已存好的音频会保留");
    return;
  }
  const lines = englishFullSpeakLines();
  if (!lines.length) {
    toast("暂无英文");
    return;
  }
  enFullDownloading = true;
  enFullDownloadText = enFullRawText;
  btn.classList.add("is-downloading");
  btn.title = "点一下可停止下载";
  btn.textContent = "下载 0%";
  try {
    const res = await enFullSpeech.prefetchLines(lines, {
      voice: getFullVoice("online") || undefined,
      onProgress: ({ done, total }) => {
        if (!enFullDownloading) return;
        btn.textContent = `下载 ${done}/${total}`;
      },
    });
    if (res.cancelled) return; // 用户点了停止，或换题
    resetEnFullDownloadBtn();
    if (res.offline) {
      toast("网络不可用，下载已中止；已存好的音频会保留");
    } else if (res.failed) {
      toast(`全文音频已存本机（${res.total - res.failed}/${res.total} 行，${res.failed} 行失败，可再点一次补全）`);
    } else {
      toast(`全文音频已全部存到本机（${res.total} 行）`);
    }
  } catch (err) {
    console.warn(err);
    resetEnFullDownloadBtn();
    toast(err?.message || "下载全文音频失败");
  }
}

function stopEnFullArticle() {
  enFullPlayToken += 1;
  stopImportedFullAudio();
  enFullSpeech.stopPlayback?.();
  clearEnTapSpeaking();
  hideEnWordTip();
  resetEnFullPlayBtn();
}

function fitEnFullBlockHeight() {
  const block = $("#en-full-block");
  if (!block) return;
  if (isEnFullCollapsed()) {
    block.style.height = "";
    block.style.maxHeight = "";
    return;
  }
  const wrap = $("#passage-wrap");
  const transCollapsed = wrap?.classList.contains("is-collapsed");
  if (!transCollapsed) {
    block.style.height = "";
    block.style.maxHeight = "";
    return;
  }
  const top = block.getBoundingClientRect().top;
  let reserved = 52;
  if (wrap) {
    const prevH = wrap.getBoundingClientRect().height;
    if (prevH > 0) reserved = prevH;
  }
  const safe = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--safe-bottom")) || 0;
  const available = Math.floor(window.innerHeight - top - reserved - 18 - safe);
  const h = Math.max(200, available);
  block.style.maxHeight = `${h}px`;
  block.style.height = `${h}px`;
  if (!wrap) return;
  const overflow = Math.ceil(wrap.getBoundingClientRect().bottom - (window.innerHeight - 10));
  if (overflow > 0) {
    const next = Math.max(200, h - overflow);
    block.style.maxHeight = `${next}px`;
    block.style.height = `${next}px`;
  }
}

function bindEnFullUi() {
  if (enFullUiBound) return;
  enFullUiBound = true;
  window.addEventListener("resize", () => {
    cancelAnimationFrame(enFullScrollRaf);
    enFullScrollRaf = requestAnimationFrame(() => fitEnFullBlockHeight());
  });
  document.addEventListener("biyi-fold-change", () => {
    fitEnFullBlockHeight();
  });
}

function fillEnFullBlock(q = currentQuestion()) {
  const block = $("#en-full-block");
  if (!block) return;
  hideEnWordTip();
  if (!q) {
    enFullRawText = "";
    enFullLines = [];
    block.replaceChildren();
    block.style.height = "";
    block.style.maxHeight = "";
    enFullSpeech.release();
    syncEnFullFoldUi();
    return;
  }
  const { en, lines, pairs } = buildEnglishFullText(q);
  enFullRawText = String(en || "").trim();
  enFullLines = Array.isArray(lines) ? lines.slice() : englishFullSpeakLines(enFullRawText);
  enFullZhLines = (pairs || []).filter((p) => p.en).map((p) => p.zh || "");
  // 换了题：停掉上一题的音频下载
  if (enFullDownloading && enFullDownloadText !== enFullRawText) cancelEnFullDownload();
  if (!enFullRawText) {
    enFullLines = [];
    block.textContent = "（暂无英文）";
    block.style.height = "";
    block.style.maxHeight = "";
    enFullSpeech.release();
    syncEnFullFoldUi();
    return;
  }

  const frag = document.createDocumentFragment();
  const uniqueWords = [];
  const seen = new Set();
  let speakIdx = 0;
  for (const pair of pairs || []) {
    const row = document.createElement("div");
    row.className = "en-full-pair";
    if (pair.en) {
      speakIdx += 1;
      row.dataset.speakLine = String(speakIdx);
      const enEl = document.createElement("div");
      enEl.className = "en-full-en";
      for (const part of tokenizeEnglishForTap(pair.en)) {
        if (part.type === "word") {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "en-tap-word";
          btn.textContent = part.text;
          btn.dataset.word = part.text;
          btn.title = `点读：${part.text}`;
          enEl.appendChild(btn);
          const key = part.text.toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            uniqueWords.push(part.text);
          }
        } else {
          const sep = document.createElement("span");
          sep.className = "en-tap-sep";
          sep.textContent = part.text;
          enEl.appendChild(sep);
        }
      }
      row.appendChild(enEl);
    }
    // 英文在上，中文在下（与意群气泡一致）
    if (pair.zh) {
      const zhEl = document.createElement("div");
      zhEl.className = "en-full-zh";
      zhEl.lang = "zh-CN";
      zhEl.textContent = pair.zh;
      row.appendChild(zhEl);
    }
    frag.appendChild(row);
  }
  block.replaceChildren(frag);
  enFullFocusedLine = 0; // 重绘后高亮丢了，下一句会重新定位
  applySenseChipFonts(block);
  bindEnFullUi();
  fitEnFullBlockHeight();

  // 展开时按当前引擎预热（联网会缓存词；本机几乎无成本）
  if (!isEnFullCollapsed()) {
    try {
      warmEnDict();
      enFullSpeech.prepare(enFullRawText, uniqueWords);
    } catch (_) {}
    const stressToken = ++enFullStressToken;
    annotateEnTapStress(block, {
      token: stressToken,
      isStale: () => stressToken !== enFullStressToken,
    })
      .then(() => {
        if (stressToken === enFullStressToken) applySenseChipFonts(block);
      })
      .catch((err) => console.warn(err));
  }
  syncEnFullFoldUi();
}

function toggleEnFullFold() {
  if (!currentQuestion()) {
    toast("请先选择题");
    return;
  }
  setEnFullCollapsed(!isEnFullCollapsed());
}

function bindFullTextUi() {
  bindEnWordTipDismiss();
  bindEnFullUi();
  $("#btn-en-full-fold")?.addEventListener("click", () => toggleEnFullFold());
  // 暂停 / 继续状态变化（含锁屏界面、耳机触发）→ 同步按钮文字
  document.addEventListener("biyi-speech-pause", () => {
    if (!importedFullActive && enFullSpeech.isPaused?.()) {
      enFullPausedLine = Math.max(1, enFullLineNo || 1);
    }
    renderEnFullPlayBtn();
  });
  $("#btn-voice-pick")?.addEventListener("click", () => {
    openReadVoiceDialog().catch((err) => console.warn(err));
  });
  $("#btn-read-voice-cancel")?.addEventListener("click", () => closeReadVoiceDialog());
  $("#btn-read-voice-confirm")?.addEventListener("click", () => confirmReadVoice());
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const page = $("#view-read-voice");
    if (!page || page.classList.contains("hidden")) return;
    e.preventDefault();
    closeReadVoiceDialog();
  });
  $("#btn-read-jump-cancel")?.addEventListener("click", () => closeReadJumpDialog({ resume: true }));
  $("#btn-read-jump-confirm")?.addEventListener("click", () => confirmReadJump());
  $("#read-jump-dialog")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeReadJumpDialog({ resume: true });
  });
  $("#read-jump-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      confirmReadJump();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeReadJumpDialog({ resume: true });
    }
  });
  const lockStressEl = document.querySelector("[data-lock-stress]");
  if (lockStressEl) {
    lockStressEl.value = isLockStressOn() ? "1" : "0";
    lockStressEl.addEventListener("change", () => {
      setLockStressOn(lockStressEl.value !== "0");
    });
  }
  $("#btn-en-full-dl")?.addEventListener("click", () => {
    downloadEnFullAudio().catch((err) => console.warn(err));
  });
  $("#btn-en-full-import")?.addEventListener("click", () => {
    const key = passageMarkKey(currentQuestion());
    if (!key || !enFullRawText) {
      toast("请先选题");
      return;
    }
    if (hasFullArticleAudio(key)) {
      deleteFullArticleAudio(key)
        .then(() => {
          paintEnFullImportBtn();
          toast("已清除导入音频，全文朗读改回系统朗读");
        })
        .catch((err) => {
          console.warn(err);
          toast("清除失败");
        });
      return;
    }
    $("#en-full-audio-file")?.click();
  });
  $("#en-full-audio-file")?.addEventListener("change", (e) => {
    const file = e.target?.files?.[0];
    e.target.value = "";
    if (!file) return;
    const key = passageMarkKey(currentQuestion());
    if (!key) {
      toast("请先选题");
      return;
    }
    const btn = $("#btn-en-full-import");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "导入中…";
    }
    saveFullArticleAudio(key, file)
      .then((meta) => {
        paintEnFullImportBtn();
        toast(`已导入「${meta.fileName || "音频"}」，点全文朗读即可播放`);
      })
      .catch((err) => {
        console.warn(err);
        paintEnFullImportBtn();
        toast(err?.message || "导入失败");
      })
      .finally(() => {
        if (btn) btn.disabled = false;
      });
  });
  $("#btn-en-full-play")?.addEventListener("click", () => {
    const playBtn = $("#btn-en-full-play");
    const now = Date.now();
    if (playBtn?.classList.contains("is-playing")) {
      // 快速双击：打开「朗读起点」跳转
      if (now - enFullLastClick < 380) {
        enFullLastClick = 0;
        openReadJumpDialog();
        return;
      }
      enFullLastClick = now;
      // 单击：暂停 / 继续（若拖动改过进度，从新句重开）
      if (importedFullActive) {
        enFullPrePaused = isImportedFullPaused();
        if (enFullPrePaused) {
          const start = Math.max(1, enFullLineNo || 1);
          if (enFullPausedLine && start !== enFullPausedLine) {
            enFullPausedLine = 0;
            playEnFullArticle(start).catch((err) => console.warn(err));
          } else {
            importedFullCtrl?.resume?.();
            renderEnFullPlayBtn();
          }
        } else {
          enFullPausedLine = Math.max(1, enFullLineNo || 1);
          importedFullCtrl?.pause?.();
          renderEnFullPlayBtn();
        }
        return;
      }
      enFullPrePaused = !!enFullSpeech.isPaused?.();
      if (enFullPrePaused) {
        const start = Math.max(1, enFullLineNo || 1);
        if (enFullPausedLine && start !== enFullPausedLine) {
          enFullPausedLine = 0;
          playEnFullArticle(start).catch((err) => console.warn(err));
        } else {
          enFullSpeech.resumePlayback?.();
          renderEnFullPlayBtn();
        }
      } else {
        enFullPausedLine = Math.max(1, enFullLineNo || 1);
        enFullSpeech.pausePlayback?.();
        renderEnFullPlayBtn();
      }
      return;
    }
    const start = Math.max(1, enFullLineNo || 1);
    playEnFullArticle(start).catch((err) => console.warn(err));
  });
  $("#en-full-block")?.addEventListener(
    "scroll",
    () => {
      onEnFullBlockScroll();
    },
    { passive: true }
  );
  $("#en-full-block")?.addEventListener("click", (e) => {
    const wordEl = e.target?.closest?.(".en-tap-word");
    if (!wordEl || !$("#en-full-block")?.contains(wordEl)) return;
    e.preventDefault();
    speakEnFullWord(wordEl.dataset.word || "", wordEl).catch((err) => console.warn(err));
  });
  document.addEventListener("biyi-practice-fonts", () => applySenseChipFonts($("#en-full-block")));
  document.addEventListener("biyi-tts-engine", () => {
    if (!isEnFullCollapsed() && enFullRawText) {
      fillEnFullBlock();
    }
  });
  syncEnFullFoldUi();
}

async function loadBankQuestions(code) {
  if (isCustomBankCode(code)) {
    const bank = buildCustomBank();
    state.bankCache[CUSTOM_BANK_CODE] = bank.questions || [];
    return state.bankCache[CUSTOM_BANK_CODE];
  }
  const base = bankBaseCode(code);
  const cacheKey = String(code || "").toUpperCase();
  if (state.bankCache[cacheKey]) return state.bankCache[cacheKey];
  const data = await fetchJson(`/data/banks/${base}/index.json`);
  let questions = Array.isArray(data.questions) ? data.questions : Array.isArray(data) ? data : [];
  questions = filterFriendsList(questions, code);
  state.bankCache[cacheKey] = questions;
  return questions;
}

function savePracticePosition() {
  const item = state.list?.[state.index];
  if (!state.bankCode || !item) return;
  const num = item.num ?? item.id;
  try {
    localStorage.setItem("biyi_last_bank", String(state.bankCode));
    localStorage.setItem(`biyi_last_num_${state.bankCode}`, String(num));
    localStorage.setItem(
      "biyi_practice_position",
      JSON.stringify({
        bank: String(state.bankCode),
        num: Number(num),
        translationIdx: Number(state.translation?.idx) || 0,
        at: Date.now(),
      })
    );
  } catch (_) {}
}

function checkpointPractice() {
  translationApi?.persistCurrentTranslation();
  savePracticePosition();
}

async function openQuestionAt(i) {
  if (i < 0 || i >= state.list.length) return;
  translationApi?.persistCurrentTranslation();
  state.index = i;
  const item = state.list[i];
  const num = item.num ?? item.id;
  const questions = await loadBankQuestions(state.bankCode);
  const q = questions.find((x) => Number(x.num) === Number(num)) || questions[i] || null;
  if (!q) throw new Error("题目不存在");
  if (!q.code) q.code = isCustomBankCode(state.bankCode) ? CUSTOM_BANK_CODE : bankBaseCode(state.bankCode);
  state.question = q;
  savePracticePosition();
  renderQuestion();
  syncNav();
  if (state.translation.on) {
    setTimeout(() => $("#translation-input")?.focus(), 40);
  }
}

async function openBank(code, preferNum = null) {
  const c = String(code || "").toUpperCase();
  if (!c) return;
  if (isCustomAddCode(c)) {
    openCustomTextDialog({ manage: true });
    const sel = $("#bank-select");
    if (sel) {
      const fallback = isCustomBankCode(state.bankCode) ? CUSTOM_BANK_CODE : state.bankCode || "RA";
      if ([...sel.options].some((o) => o.value === fallback)) sel.value = fallback;
    }
    return;
  }
  translationApi?.persistCurrentTranslation();
  state.bankCode = c;
  localStorage.setItem("biyi_last_bank", c);

  let list;
  if (isCustomBankCode(c)) {
    delete state.bankCache[CUSTOM_BANK_CODE];
    const bank = buildCustomBank();
    list = bank.questions || [];
  } else {
    const base = bankBaseCode(c);
    const listData = await fetchJson(`/data/banks/${base}/list.json`);
    list = Array.isArray(listData.questions)
      ? listData.questions
      : Array.isArray(listData)
        ? listData
        : [];
    list = filterFriendsList(list, c);
  }
  list = list.filter((q) => q && (q.num != null || q.id != null));
  state.list = list;
  const sel = $("#bank-select");
  if (sel && [...sel.options].some((o) => o.value === c)) sel.value = c;
  fitBankSelectWidth();

  if (!state.list.length) {
    state.index = -1;
    state.question = null;
    renderQuestion();
    if (isCustomBankCode(c)) {
      toast("还没有练习文本，点「新增文本」添加");
      setTimeout(() => openCustomTextDialog({ manage: true }), 120);
    } else {
      toast("该题库暂无题目");
    }
    return;
  }

  let idx = -1;
  if (preferNum != null) {
    idx = state.list.findIndex((q) => Number(q.num ?? q.id) === Number(preferNum));
  }
  if (idx < 0) {
    const lastKey = `biyi_last_num_${c}`;
    const lastNum = Number(localStorage.getItem(lastKey) || 0);
    idx = state.list.findIndex((q) => Number(q.num ?? q.id) === lastNum);
  }
  if (idx < 0) idx = 0;
  await openQuestionAt(idx);
}

function move(delta) {
  if (state.index < 0) return false;
  const next = state.index + delta;
  if (next < 0 || next >= state.list.length) return false;
  openQuestionAt(next).catch((err) => {
    console.warn(err);
    toast(err.message || "切题失败");
  });
  return true;
}

async function ensureFriendsEpisodes() {
  if (state.friendsEpisodes.length) return state.friendsEpisodes;
  try {
    const data = await fetchJson("/data/friends-episodes.json");
    state.friendsEpisodes = Array.isArray(data.episodes) ? data.episodes : [];
  } catch (_) {
    state.friendsEpisodes = [];
  }
  return state.friendsEpisodes;
}

async function fillBankSelect() {
  const sel = $("#bank-select");
  if (!sel || !state.catalog?.banks) return;
  const banks = state.catalog.banks;
  const recite = banks.filter((b) => b.recite && b.code !== "FRIENDS");
  const other = banks.filter((b) => !b.recite && b.code !== "FRIENDS");
  const parts = [];
  const pushOpt = (value, label) => {
    parts.push(`<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`);
  };
  const customN = customTextCount();
  parts.push('<optgroup label="我的文本">');
  pushOpt(CUSTOM_BANK_CODE, `自由练习（${customN} 篇）`);
  parts.push("</optgroup>");
  if (recite.length) {
    parts.push('<optgroup label="背诵优先">');
    recite.forEach((b) => pushOpt(b.code, `${b.code} · ${b.title}（${b.count}）`));
    parts.push("</optgroup>");
  }
  if (other.length) {
    parts.push('<optgroup label="其他题型">');
    other.forEach((b) => pushOpt(b.code, `${b.code} · ${b.title}（${b.count}）`));
    parts.push("</optgroup>");
  }
  const episodes = await ensureFriendsEpisodes();
  parts.push('<optgroup label="老友记">');
  pushOpt("FRIENDS", "老友记（全部）");
  parts.push("</optgroup>");
  for (let s = 1; s <= 10; s += 1) {
    const sn = String(s).padStart(2, "0");
    const seasonEps = episodes.filter((e) => Number(e.season) === s);
    parts.push(`<optgroup label="老友记 · 第${s}季">`);
    pushOpt(`FRIENDS_S${sn}`, `第${s}季 · 全部`);
    seasonEps.forEach((e) => {
      const ep = Number(e.episode) || 0;
      const en = String(ep).padStart(2, "0");
      const code = `FRIENDS_S${sn}E${en}`;
      const name = e.name || `S${sn}E${en}`;
      pushOpt(code, `第${s}季 · 第${ep}集（${name}）`);
    });
    parts.push("</optgroup>");
  }
  const cur = sel.value;
  sel.innerHTML = parts.join("");
  if (cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
  fitBankSelectWidth();
}

/** 题库下拉按当前选项文字自适应宽度 */
function fitBankSelectWidth() {
  const sel = $("#bank-select");
  if (!sel) return;
  // 窄屏：CSS 已让题库占满右栏，不再用 JS 锁死宽度
  if (window.matchMedia && window.matchMedia("(max-width: 640px)").matches) {
    sel.style.width = "";
    return;
  }
  const label = (sel.selectedOptions?.[0]?.textContent || "").trim() || "题库";
  const cs = getComputedStyle(sel);
  const probe = document.createElement("span");
  probe.setAttribute("aria-hidden", "true");
  probe.textContent = label;
  probe.style.cssText = [
    "position:absolute",
    "left:-9999px",
    "top:0",
    "visibility:hidden",
    "pointer-events:none",
    "white-space:nowrap",
    `font:${cs.font}`,
    `letter-spacing:${cs.letterSpacing}`,
    `text-transform:${cs.textTransform}`,
  ].join(";");
  document.body.appendChild(probe);
  const textW = probe.getBoundingClientRect().width;
  probe.remove();
  const pad =
    (parseFloat(cs.paddingLeft) || 0) +
    (parseFloat(cs.paddingRight) || 0) +
    (parseFloat(cs.borderLeftWidth) || 0) +
    (parseFloat(cs.borderRightWidth) || 0);
  const need = Math.ceil(textW + pad + 2);
  const wrap = sel.closest(".topbar-right") || sel.parentElement;
  const topbar = sel.closest(".topbar");
  sel.style.width = "auto";
  const cap = Math.floor(
    Math.min(
      wrap?.clientWidth || need,
      topbar ? Math.max(120, topbar.clientWidth - 88) : need
    )
  );
  sel.style.width = `${Math.min(Math.max(need, 88), Math.max(cap, 88))}px`;
}

/** 录像/录屏/朗读/答案 一行排不下时整排等比缩小 */
function fitToolbarSwitchesScale() {
  const shell = document.querySelector(".passage-toolbar-switches");
  const row = document.querySelector(".passage-toolbar-switches-inner");
  if (!shell || !row) return;
  row.style.transform = "none";
  row.style.zoom = "";
  shell.style.height = "";
  shell.style.minHeight = "";
  void row.offsetWidth;
  const available = Math.max(40, shell.clientWidth || 0);
  const natural = Math.max(row.scrollWidth || 0, row.offsetWidth || 0);
  if (!(natural > 0) || !(available > 0)) return;
  const scale = Math.min(1, available / natural);
  row.style.transformOrigin = "right top";
  if (scale >= 0.999) {
    row.style.transform = "none";
    shell.style.height = "";
    return;
  }
  // iOS WebKit 对 transform 命中区域不直观，zoom 更稳
  if ("zoom" in row.style) {
    row.style.transform = "none";
    row.style.zoom = String(scale);
    shell.style.height = "";
    return;
  }
  row.style.transform = `scale(${scale})`;
  const h = row.offsetHeight || 0;
  shell.style.height = `${Math.ceil(h * scale)}px`;
}

function scheduleFitToolbarSwitchesScale() {
  cancelAnimationFrame(scheduleFitToolbarSwitchesScale._raf || 0);
  scheduleFitToolbarSwitchesScale._raf = requestAnimationFrame(() => {
    fitToolbarSwitchesScale();
    requestAnimationFrame(() => fitToolbarSwitchesScale());
  });
  clearTimeout(scheduleFitToolbarSwitchesScale._t1);
  clearTimeout(scheduleFitToolbarSwitchesScale._t2);
  scheduleFitToolbarSwitchesScale._t1 = setTimeout(() => fitToolbarSwitchesScale(), 120);
  scheduleFitToolbarSwitchesScale._t2 = setTimeout(() => fitToolbarSwitchesScale(), 400);
}

function resetCustomTextCardPos() {
  /* no-op: 全屏编辑页不再拖动 */
}

let pendingSrtGroups = null;
let liveTranslateGen = 0;
let liveRewriteTimer = 0;
let pairEditorSilent = false;

function cancelLivePairTranslate() {
  liveTranslateGen += 1;
  clearTimeout(liveRewriteTimer);
}

function pairIsDirty(row) {
  return String(row?.dataset?.dirty || "") === "1";
}

function markPairDirty(idx, on = true) {
  const { row } = pairRowEls(idx);
  if (!row) return;
  if (on) row.dataset.dirty = "1";
  else delete row.dataset.dirty;
}

function setPairZhBase(idx, zh) {
  const { row } = pairRowEls(idx);
  if (row) row.dataset.zhBase = String(zh || "").trim();
}

function currentEngineLabel() {
  const prefs = loadTranslatePrefs();
  if (prefs.mode === "deepseek") return "DeepSeek";
  if (prefs.mode === "local") return "本地";
  return "在线";
}

function pairRowEls(idx) {
  const row = document.querySelector(`#custom-text-pairs .custom-text-pair[data-pair-idx="${idx}"]`);
  return {
    row,
    zhEl: row?.querySelector(".custom-text-pair-zh"),
    enEl: row?.querySelector(".custom-text-pair-en"),
  };
}

/**
 * 只译有操作痕迹的意群。没动过的英文保持不动。
 * merge/split 立刻调用；改写中文走防抖。
 */
async function liveTranslatePair(idx, gen = liveTranslateGen) {
  const i = Number(idx);
  if (!Number.isFinite(i) || i < 0) return;
  const { row, zhEl, enEl } = pairRowEls(i);
  if (!pairIsDirty(row)) return;
  const zh = String(zhEl?.value || "").trim();
  if (!zh) {
    if (enEl && liveTranslateGen === gen) enEl.value = "";
    markPairDirty(i, false);
    setPairZhBase(i, "");
    if (liveTranslateGen === gen) commitPairsToPending();
    return;
  }
  const prefs = loadTranslatePrefs();
  if (prefs.mode === "deepseek" && !String(prefs.deepseekApiKey || "").trim()) {
    toast("请先填写 DeepSeek API Key");
    return;
  }
  const label = currentEngineLabel();
  const hint = $("#custom-text-srt-hint");
  enEl?.classList.add("is-translating");
  if (hint) hint.textContent = `${label}译英中… 仅意群 ${i + 1}`;
  try {
    const en = await translateZhToEn(zh, { skipSlowAsk: true });
    if (liveTranslateGen !== gen) return;
    const now = pairRowEls(i);
    if (!pairIsDirty(now.row)) return;
    if (String(now.zhEl?.value || "").trim() !== zh) return;
    if (now.enEl && en) now.enEl.value = en;
    markPairDirty(i, false);
    setPairZhBase(i, zh);
    commitPairsToPending();
    if (hint) hint.textContent = `已按${label}更新意群 ${i + 1}（其余未动）`;
  } catch (err) {
    if (liveTranslateGen !== gen) return;
    toast(err?.message || "译英失败");
  } finally {
    if (liveTranslateGen === gen) {
      pairRowEls(i).enEl?.classList.remove("is-translating");
    }
  }
}

function liveTranslatePairs(indexes) {
  const gen = liveTranslateGen;
  return Promise.all((indexes || []).map((idx) => liveTranslatePair(idx, gen)));
}

function dirtyPairIndexes() {
  const box = $("#custom-text-pairs");
  if (!box) return [];
  return [...box.querySelectorAll(".custom-text-pair")]
    .filter((row) => pairIsDirty(row))
    .map((row) => Number(row.dataset.pairIdx))
    .filter((idx) => Number.isFinite(idx));
}

function scheduleLiveTranslateOnZhEdit(idx) {
  const i = Number(idx);
  if (!Number.isFinite(i) || i < 0) return;
  const { row, zhEl } = pairRowEls(i);
  const now = String(zhEl?.value || "").trim();
  const base = String(row?.dataset?.zhBase || "");
  if (now === base) {
    markPairDirty(i, false);
    return;
  }
  markPairDirty(i, true);
  clearTimeout(liveRewriteTimer);
  const gen = liveTranslateGen;
  liveRewriteTimer = setTimeout(() => {
    if (liveTranslateGen !== gen) return;
    liveTranslatePair(i, gen).catch((err) => console.warn(err));
  }, 800);
}

function clearPendingSrtImport() {
  pendingSrtGroups = null;
  const hint = $("#custom-text-srt-hint");
  if (hint) hint.textContent = "";
  const fileEl = $("#custom-text-srt-file");
  if (fileEl) fileEl.value = "";
  renderSensePairEditor([]);
}

function setPairEditorVisible(on) {
  const wrap = $("#custom-text-pairs-wrap");
  const bodyField = $("#custom-text-body-field");
  wrap?.classList.toggle("hidden", !on);
  // 有对照面板时隐藏粘贴框：英文就是各条英文意群的合集
  bodyField?.classList.toggle("hidden", !!on);
}

function syncBodyFromPairs(groups) {
  const bodyEl = $("#custom-text-body");
  if (!bodyEl) return;
  bodyEl.value = (groups || [])
    .map((g) => String(g?.english || "").trim())
    .filter(Boolean)
    .join("\n");
}

function readSensePairsFromEditor() {
  const box = $("#custom-text-pairs");
  if (!box) return [];
  return [...box.querySelectorAll(".custom-text-pair")].map((row) => ({
    chinese: String(row.querySelector(".custom-text-pair-zh")?.value || "").trim(),
    english: String(row.querySelector(".custom-text-pair-en")?.value || "").trim(),
  })).filter((g) => g.english || g.chinese);
}

function renderSensePairEditor(groups) {
  const box = $("#custom-text-pairs");
  if (!box) return;
  const list = Array.isArray(groups) ? groups : [];
  setPairEditorVisible(list.length > 0);
  pairEditorSilent = true;
  if (!list.length) {
    box.innerHTML = "";
    pairEditorSilent = false;
    return;
  }
  box.innerHTML = list
    .map((g, i) => {
      const zhRaw = String(g?.chinese || "");
      const enRaw = String(g?.english || "");
      const zh = zhRaw.replace(/</g, "&lt;").replace(/"/g, "&quot;");
      const en = enRaw.replace(/</g, "&lt;").replace(/"/g, "&quot;");
      const dirty = g?.dirty ? "1" : "";
      const zhBase = zhRaw.trim().replace(/"/g, "&quot;");
      return `<div class="custom-text-pair" data-pair-idx="${i}" data-dirty="${dirty}" data-zh-base="${zhBase}" role="listitem">
        <div class="custom-text-pair-idx">#${i + 1}</div>
        <textarea class="custom-text-pair-zh" rows="2" placeholder="中文" spellcheck="false" enterkeyhint="enter">${zh}</textarea>
        <textarea class="custom-text-pair-en" rows="2" placeholder="English" spellcheck="false">${en}</textarea>
      </div>`;
    })
    .join("");
  pairEditorSilent = false;
}

function readAllSensePairsFromEditor() {
  const box = $("#custom-text-pairs");
  if (!box) return [];
  return [...box.querySelectorAll(".custom-text-pair")].map((row) => ({
    chinese: String(row.querySelector(".custom-text-pair-zh")?.value || ""),
    english: String(row.querySelector(".custom-text-pair-en")?.value || "").trim(),
    dirty: pairIsDirty(row),
  }));
}

function focusPairZh(idx, caret) {
  requestAnimationFrame(() => {
    const el = document.querySelector(
      `#custom-text-pairs .custom-text-pair[data-pair-idx="${idx}"] .custom-text-pair-zh`
    );
    if (!el) return;
    el.focus();
    const pos = Math.max(0, Math.min(Number(caret) || 0, el.value.length));
    try {
      el.setSelectionRange(pos, pos);
    } catch (_) {}
  });
}

/** 中文框开头退格：与上一意群合并 */
function mergeCustomPairWithPrevious(idx) {
  const i = Number(idx);
  if (!Number.isFinite(i) || i <= 0) return false;
  const pairs = readAllSensePairsFromEditor();
  if (i >= pairs.length) return false;
  cancelLivePairTranslate();
  const prev = pairs[i - 1];
  const cur = pairs[i];
  const joinedZh = `${String(prev.chinese || "")}${String(cur.chinese || "")}`;
  const joinedEn = [prev.english, cur.english].filter(Boolean).join(" ");
  const caret = String(prev.chinese || "").length;
  pairs[i - 1] = { chinese: joinedZh, english: joinedEn, dirty: true };
  pairs.splice(i, 1);
  pendingSrtGroups = pairs
    .map((g) => ({
      chinese: String(g.chinese || "").trim(),
      english: String(g.english || "").trim(),
      dirty: !!g.dirty,
    }))
    .filter((g) => g.chinese || g.english);
  renderSensePairEditor(pendingSrtGroups);
  syncBodyFromPairs(pendingSrtGroups);
  commitPairsToPending();
  focusPairZh(i - 1, caret);
  toast(`已合并意群 ${i}–${i + 1}`);
  liveTranslatePairs(dirtyPairIndexes()).catch((err) => console.warn(err));
  return true;
}

/** 中文框回车：在光标处拆成两条意群 */
function splitCustomPairAt(idx, caretPos) {
  const i = Number(idx);
  if (!Number.isFinite(i) || i < 0) return false;
  const pairs = readAllSensePairsFromEditor();
  if (i >= pairs.length) return false;
  const cur = pairs[i];
  const zh = String(cur.chinese || "");
  const cut = Math.max(0, Math.min(Number(caretPos) || 0, zh.length));
  if (cut <= 0 || cut >= zh.length) {
    toast(cut <= 0 ? "光标在开头，无法拆分" : "光标在末尾，无法拆分");
    return true;
  }
  cancelLivePairTranslate();
  const leftZh = zh.slice(0, cut);
  const rightZh = zh.slice(cut);
  pairs[i] = { chinese: leftZh, english: String(cur.english || "").trim(), dirty: true };
  pairs.splice(i + 1, 0, { chinese: rightZh, english: "", dirty: true });
  pendingSrtGroups = pairs
    .map((g) => ({
      chinese: String(g.chinese || "").trim(),
      english: String(g.english || "").trim(),
      dirty: !!g.dirty,
    }))
    .filter((g) => g.chinese || g.english);
  renderSensePairEditor(pendingSrtGroups);
  syncBodyFromPairs(pendingSrtGroups);
  commitPairsToPending();
  focusPairZh(i + 1, 0);
  toast(`已拆分意群 ${i + 1} → ${i + 1} / ${i + 2}`);
  liveTranslatePairs(dirtyPairIndexes()).catch((err) => console.warn(err));
  return true;
}

function handleCustomPairZhEditKey(e) {
  const zh = e.target?.closest?.(".custom-text-pair-zh");
  if (!zh || e.target !== zh) return false;
  if (e.isComposing) return false;
  const row = zh.closest(".custom-text-pair");
  const idx = Number(row?.dataset?.pairIdx);
  if (!Number.isFinite(idx)) return false;

  const isEnter =
    e.key === "Enter" ||
    e.code === "Enter" ||
    e.code === "NumpadEnter" ||
    e.inputType === "insertParagraph" ||
    e.inputType === "insertLineBreak";
  const isBack =
    e.key === "Backspace" ||
    e.code === "Backspace" ||
    e.inputType === "deleteContentBackward";

  if (isEnter) {
    const start = zh.selectionStart ?? 0;
    const end = zh.selectionEnd ?? start;
    // 有选区时按选区起点拆
    if (splitCustomPairAt(idx, Math.min(start, end))) {
      e.preventDefault();
      e.stopPropagation();
      return true;
    }
    return false;
  }

  if (isBack) {
    const start = zh.selectionStart ?? 0;
    const end = zh.selectionEnd ?? 0;
    if (start === 0 && end === 0 && idx > 0) {
      if (mergeCustomPairWithPrevious(idx)) {
        e.preventDefault();
        e.stopPropagation();
        return true;
      }
    }
  }
  return false;
}

function commitPairsToPending() {
  const groups = readSensePairsFromEditor();
  // 允许暂缺英文（刚拆分、正在译英）：保存时仍只收齐双语文案
  pendingSrtGroups = groups.filter((g) => g.english || g.chinese);
  syncBodyFromPairs(groups);
  const hint = $("#custom-text-srt-hint");
  if (hint && pendingSrtGroups.length) {
    hint.textContent = `对照面板 ${pendingSrtGroups.length} 条意群（开头退格合并 · 回车拆分）`;
  }
  scheduleCustomTextAutosave();
}

let customTextAutosaveTimer = 0;
let customTextAutosaveBusy = false;
let customTextAutosaveQueued = false;

function setCustomTextAutosaveTip(msg) {
  const tip = $("#custom-text-autosave-tip");
  if (tip) tip.textContent = msg;
}

function scheduleCustomTextAutosave({ immediate = false } = {}) {
  clearTimeout(customTextAutosaveTimer);
  if (immediate) {
    customTextAutosaveQuiet().catch((err) => console.warn(err));
    return;
  }
  customTextAutosaveTimer = setTimeout(() => {
    customTextAutosaveQuiet().catch((err) => console.warn(err));
  }, 450);
}

/** 编辑页静默落盘：不关页面；有意群（可缺英）即写入，不自动翻译 */
async function customTextAutosaveQuiet() {
  const page = $("#view-custom-text");
  if (!page || page.classList.contains("hidden")) return null;
  if (customTextAutosaveBusy) {
    customTextAutosaveQueued = true;
    return null;
  }
  const pairs = readSensePairsFromEditor()
    .map((g) => ({
      chinese: String(g?.chinese || "").trim(),
      english: String(g?.english || "").trim(),
    }))
    .filter((g) => g.chinese || g.english);
  if (!pairs.length) return null;

  const name = $("#custom-text-name")?.value || "";
  const editRaw = $("#custom-text-edit-num")?.value || "";
  const editNum = editRaw ? Number(editRaw) : null;
  const en = pairs.map((g) => g.english).filter(Boolean).join("\n");
  const zhTitle = pairs.map((g) => g.chinese).filter(Boolean).join("\n");
  const payload = {
    name: String(name || "").trim() || firstLineTitle(en) || firstLineTitle(zhTitle),
    en,
    sense_groups: pairs,
  };

  customTextAutosaveBusy = true;
  try {
    let item;
    if (editNum != null && !Number.isNaN(editNum) && getCustomText(editNum)) {
      item = await updateCustomText(editNum, payload);
    } else {
      item = await addCustomText(payload);
      const editNumEl = $("#custom-text-edit-num");
      if (editNumEl) editNumEl.value = String(item.num);
      const titleEl = $("#custom-text-dialog-title");
      if (titleEl) titleEl.textContent = "编辑英语文本";
    }
    pendingSrtGroups = pairs.map((g) => ({ ...g }));
    delete state.bankCache[CUSTOM_BANK_CODE];
    const missingEn = pairs.filter((g) => g.chinese && !g.english).length;
    setCustomTextAutosaveTip(
      missingEn
        ? `已自动保存 · ${pairs.length} 条（缺英 ${missingEn}，点「译英」）`
        : `已自动保存 · ${pairs.length} 条意群`
    );
    return item;
  } catch (err) {
    console.warn(err);
    setCustomTextAutosaveTip(err?.message || "自动保存失败");
    return null;
  } finally {
    customTextAutosaveBusy = false;
    if (customTextAutosaveQueued) {
      customTextAutosaveQueued = false;
      scheduleCustomTextAutosave({ immediate: true });
    }
  }
}

function collectOperatedPairsForTranslate() {
  const box = $("#custom-text-pairs");
  if (!box) return [];
  return [...box.querySelectorAll(".custom-text-pair")]
    .map((row, i) => ({
      i,
      zh: String(row.querySelector(".custom-text-pair-zh")?.value || "").trim(),
      en: String(row.querySelector(".custom-text-pair-en")?.value || "").trim(),
      dirty: pairIsDirty(row),
    }))
    .filter((x) => x.zh && x.dirty);
}

/** 只译有操作痕迹的意群；没动过的英文保持不动 */
async function retranslateAllChineseToEnglish() {
  const withZh = collectOperatedPairsForTranslate();
  if (!withZh.length) {
    toast("没有改动过的意群需要译英");
    return;
  }
  const btn = $("#btn-retranslate-en");
  const hint = $("#custom-text-srt-hint");
  const prefs = loadTranslatePrefs();
  const useDeepseek = prefs.mode === "deepseek";
  const prevLabel = btn?.textContent || (useDeepseek ? "校对译英" : "译英");
  if (btn) {
    btn.disabled = true;
    btn.textContent = useDeepseek ? "校对译英中…" : "译英中…";
  }
  try {
    const total = withZh.length;
    if (useDeepseek) {
      if (!String(prefs.deepseekApiKey || "").trim()) {
        throw new Error("请先填写 DeepSeek API Key");
      }
      for (const item of withZh) {
        const row = $(`#custom-text-pairs .custom-text-pair[data-pair-idx="${item.i}"]`);
        row?.querySelector(".custom-text-pair-zh")?.classList.add("is-translating");
        row?.querySelector(".custom-text-pair-en")?.classList.add("is-translating");
      }
      if (hint) hint.textContent = `DeepSeek 校对+译英 0 / ${total}…`;
      const results = await polishAndTranslateZhLinesViaDeepSeek(
        withZh.map((x) => x.zh),
        (done, all) => {
          if (btn) btn.textContent = `校对译英 ${done}/${all}`;
          if (hint) hint.textContent = `DeepSeek 校对+译英 ${done} / ${all}…`;
        }
      );
      let done = 0;
      for (let j = 0; j < withZh.length; j += 1) {
        const item = withZh[j];
        const r = results[j] || {};
        const row = $(`#custom-text-pairs .custom-text-pair[data-pair-idx="${item.i}"]`);
        const zhEl = row?.querySelector(".custom-text-pair-zh");
        const enEl = row?.querySelector(".custom-text-pair-en");
        if (zhEl && r.chinese) zhEl.value = r.chinese;
        if (enEl && r.english) enEl.value = r.english;
        markPairDirty(item.i, false);
        setPairZhBase(item.i, String(zhEl?.value || r.chinese || item.zh).trim());
        zhEl?.classList.remove("is-translating");
        enEl?.classList.remove("is-translating");
        if (r.english) done += 1;
      }
      commitPairsToPending();
      if (hint) hint.textContent = `DeepSeek 已校对并译英 ${done} 条改动意群（其余未动）`;
      toast(`DeepSeek 已校对并译英 ${done} 条改动意群`);
      return;
    }

    let done = 0;
    for (const item of withZh) {
      if (btn) btn.textContent = `译英 ${done + 1}/${total}`;
      if (hint) hint.textContent = `译英 ${done + 1} / ${total}…`;
      const row = $(`#custom-text-pairs .custom-text-pair[data-pair-idx="${item.i}"]`);
      const enEl = row?.querySelector(".custom-text-pair-en");
      enEl?.classList.add("is-translating");
      try {
        const en = await translateZhToEn(item.zh, { skipSlowAsk: true });
        if (enEl && en) enEl.value = en;
        markPairDirty(item.i, false);
        setPairZhBase(item.i, item.zh);
      } finally {
        enEl?.classList.remove("is-translating");
      }
      done += 1;
    }
    commitPairsToPending();
    if (hint) hint.textContent = `已译英 ${done} 条改动意群（其余未动）`;
    toast(`已译英 ${done} 条改动意群`);
  } catch (err) {
    toast(err?.message || "译英失败");
  } finally {
    $("#custom-text-pairs")
      ?.querySelectorAll(".is-translating")
      .forEach((el) => el.classList.remove("is-translating"));
    if (btn) {
      btn.disabled = false;
      btn.textContent = prevLabel;
    }
  }
}

function openCustomTextDialog({ manage = false, editNum = null, seedFromQuestion = null } = {}) {
  const page = $("#view-custom-text");
  const practice = $("#view-practice");
  if (!page) return;
  const nameEl = $("#custom-text-name");
  const bodyEl = $("#custom-text-body");
  const editNumEl = $("#custom-text-edit-num");
  const titleEl = $("#custom-text-dialog-title");
  const editing = editNum != null && editNum !== "" ? Number(editNum) : null;
  const existing = editing != null && !Number.isNaN(editing) ? getCustomText(editing) : null;

  clearTimeout(customTextAutosaveTimer);
  cancelLivePairTranslate();
  clearPendingSrtImport();
  setCustomTextAutosaveTip("只译动过的意群：合并 / 拆分 / 改写中文会实时译英，其余保持不动");

  if (existing) {
    if (editNumEl) editNumEl.value = String(existing.num);
    if (nameEl) nameEl.value = existing.name || "";
    if (bodyEl) bodyEl.value = existing.en || "";
    if (titleEl) titleEl.textContent = "编辑英语文本";
    const groups = Array.isArray(existing.sense_groups) ? existing.sense_groups : [];
    if (groups.length) {
      pendingSrtGroups = groups.map((g) => ({
        chinese: String(g?.chinese || "").trim(),
        english: String(g?.english || "").trim(),
      }));
      renderSensePairEditor(pendingSrtGroups);
      const hint = $("#custom-text-srt-hint");
      if (hint) hint.textContent = `对照面板 ${pendingSrtGroups.length} 条意群（编辑即自动保存）`;
    } else {
      setPairEditorVisible(false);
    }
  } else if (seedFromQuestion) {
    // 题库原文：带入当前文章，保存为自由练习新篇（不改原题库）
    if (editNumEl) editNumEl.value = "";
    const seedName = String(seedFromQuestion.name || "").trim() || firstLineTitle(String(seedFromQuestion.en || ""));
    if (nameEl) nameEl.value = seedName;
    const groups = Array.isArray(seedFromQuestion.sense_groups) ? seedFromQuestion.sense_groups : [];
    pendingSrtGroups = groups
      .map((g) => ({
        chinese: String(g?.chinese || "").trim(),
        english: String(g?.english || "").trim(),
      }))
      .filter((g) => g.chinese || g.english);
    const enText =
      String(seedFromQuestion.en || "").trim() ||
      pendingSrtGroups.map((g) => g.english).filter(Boolean).join("\n");
    if (bodyEl) bodyEl.value = enText;
    if (titleEl) titleEl.textContent = "编辑英语文本";
    if (pendingSrtGroups.length) {
      renderSensePairEditor(pendingSrtGroups);
      const hint = $("#custom-text-srt-hint");
      if (hint) {
        hint.textContent = `已载入当前文章 ${pendingSrtGroups.length} 条意群（保存到自由练习）`;
      }
      setCustomTextAutosaveTip("来自题库原文 · 编辑后自动保存到自由练习");
    } else {
      setPairEditorVisible(false);
    }
  } else {
    if (editNumEl) editNumEl.value = "";
    if (nameEl) nameEl.value = "";
    if (bodyEl) bodyEl.value = "";
    if (titleEl) titleEl.textContent = "新增英语文本";
    setPairEditorVisible(false);
  }

  practice?.classList.add("hidden");
  page.classList.remove("hidden");
  window.scrollTo(0, 0);
  setTimeout(() => {
    const firstZh = $("#custom-text-pairs .custom-text-pair-zh");
    (firstZh || bodyEl || nameEl)?.focus();
  }, 40);
}

async function closeCustomTextDialog() {
  clearTimeout(customTextAutosaveTimer);
  cancelLivePairTranslate();
  const keepNumRaw = $("#custom-text-edit-num")?.value || "";
  const keepNum = keepNumRaw ? Number(keepNumRaw) : null;
  try {
    await customTextAutosaveQuiet();
  } catch (_) {}
  const page = $("#view-custom-text");
  const practice = $("#view-practice");
  page?.classList.add("hidden");
  practice?.classList.remove("hidden");
  const editNumEl = $("#custom-text-edit-num");
  if (editNumEl) editNumEl.value = "";
  clearPendingSrtImport();
  window.scrollTo(0, 0);
  try {
    await fillBankSelect();
    if (keepNum != null && !Number.isNaN(keepNum) && getCustomText(keepNum)) {
      await openBank(CUSTOM_BANK_CODE, keepNum);
    } else if (isCustomBankCode(state.bankCode)) {
      await openBank(CUSTOM_BANK_CODE, state.question?.num);
    }
  } catch (err) {
    console.warn(err);
  }
}

async function importTextFromDialog(file) {
  if (!file) return;
  const hint = $("#custom-text-srt-hint");
  const importBtn = $("#btn-custom-text-import-srt");
  const prevBtnLabel = importBtn?.textContent;
  try {
    const name = String(file.name || "");
    if (name && !/\.srt$/i.test(name) && !/\.txt$/i.test(name)) {
      throw new Error("请选择 .srt 或 .txt 文件");
    }
    if (importBtn) {
      importBtn.disabled = true;
      importBtn.textContent = "导入中…";
    }
    if (hint) hint.textContent = "正在解析文本…";
    const raw = await readSrtFile(file);
    const parsed = parseImportText(raw, name);
    // 覆盖：清空旧意群后再写入，不自动翻译
    const groups = (parsed.sense_groups || [])
      .map((g) => ({
        chinese: String(g?.chinese || "").trim(),
        english: String(g?.english || "").trim(),
      }))
      .filter((g) => g.chinese || g.english);
    if (!groups.length) throw new Error("未解析到可用意群");
    pendingSrtGroups = groups;
    const nameEl = $("#custom-text-name");
    const bodyEl = $("#custom-text-body");
    const enText = groups.map((g) => g.english).filter(Boolean).join("\n");
    const zhText = groups.map((g) => g.chinese).filter(Boolean).join("\n");
    if (bodyEl) bodyEl.value = enText;
    // 重新导入：标题也按新文件重置
    if (nameEl) {
      nameEl.value =
        titleFromSrtFileName(file.name) || firstLineTitle(enText) || firstLineTitle(zhText) || "";
    }
    renderSensePairEditor(pendingSrtGroups);
    const modeHint =
      parsed.source === "txt-bilingual"
        ? `已覆盖导入 ${groups.length} 条中英对照（${parsed.pairOrder === "en-zh" ? "英文下一行中文" : "中文下一行英文"}）`
        : parsed.source === "txt"
          ? `已覆盖导入 ${groups.length} 条（TXT 已切意群，未译英）`
          : parsed.zhOnlyCount > 0 && parsed.bilingualCount === 0
            ? `已覆盖导入 ${groups.length} 条纯中文（未译英，可点「译英」）`
            : parsed.zhOnlyCount > 0
              ? `已覆盖导入 ${groups.length} 条（双语 ${parsed.bilingualCount} · 缺英 ${parsed.zhOnlyCount}）`
              : `已覆盖导入 ${groups.length} 条中英对照（未改译）`;
    if (hint) hint.textContent = modeHint;
    toast(`已覆盖导入 ${groups.length} 条`);
    scheduleCustomTextAutosave({ immediate: true });
  } catch (err) {
    clearPendingSrtImport();
    toast(err?.message || "文本导入失败");
  } finally {
    if (importBtn) {
      importBtn.disabled = false;
      importBtn.textContent = prevBtnLabel || "导入文本";
    }
    const fileEl = $("#custom-text-srt-file");
    if (fileEl) fileEl.value = "";
  }
}

async function openCustomTextByNum(num) {
  await openBank(CUSTOM_BANK_CODE, num);
}

async function deleteCustomTextByNum(num) {
  deleteCustomText(num);
  await fillBankSelect();
  if (isCustomBankCode(state.bankCode)) {
    const keepNum = state.question?.num;
    await openBank(CUSTOM_BANK_CODE, keepNum);
  }
  toast("已删除");
}

function jumpListItems() {
  return state.list.map((q) => {
    const num = Number(q.num ?? q.id);
    const name = String(q.name || "").trim();
    const preview = String(q.preview || "").trim();
    let label = `#${num}`;
    if (name) {
      if (name === `#${num}` || name.startsWith(`#${num} `) || name.startsWith(`#${num}·`) || name.startsWith(`#${num} ·`)) {
        label = name;
      } else {
        label = `#${num} · ${name}`;
      }
    } else if (preview) {
      label = `#${num} · ${preview.slice(0, 36)}${preview.length > 36 ? "…" : ""}`;
    }
    return {
      num,
      label,
      search: `${num} ${name} ${preview}`.toLowerCase(),
    };
  });
}

function fillJumpSelect(list, selectedNum, query) {
  const sel = $("#practice-jump-select");
  if (!sel) return;
  const q = String(query || "").trim().toLowerCase();
  const filtered = q ? list.filter((item) => item.search.includes(q) || String(item.num).includes(q)) : list;
  const frag = document.createDocumentFragment();
  filtered.forEach((item) => {
    const opt = document.createElement("option");
    opt.value = String(item.num);
    opt.textContent = item.label;
    if (Number(item.num) === Number(selectedNum)) opt.selected = true;
    frag.appendChild(opt);
  });
  sel.replaceChildren(frag);
  if (!sel.value && sel.options.length) sel.selectedIndex = 0;
}

function syncJumpDialogKeyboard() {
  const dialog = $("#practice-jump-dialog");
  if (!dialog || dialog.classList.contains("hidden")) return;
  const vv = window.visualViewport;
  if (!vv) {
    dialog.style.setProperty("--kb-inset", "0px");
    return;
  }
  // 键盘占用的可视高度（iOS WKWebView 常见）
  const inset = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
  dialog.style.setProperty("--kb-inset", `${inset}px`);
}

function closeJumpDialog() {
  const dialog = $("#practice-jump-dialog");
  dialog?.classList.add("hidden");
  dialog?.style.setProperty("--kb-inset", "0px");
}

function openJumpDialog() {
  if (!state.list.length) {
    toast("当前题库没有题目");
    return;
  }
  const dialog = $("#practice-jump-dialog");
  const search = $("#practice-jump-search");
  const desc = $("#practice-jump-desc");
  if (!dialog) return;
  if (desc) desc.textContent = `选择 ${bankTitle(state.bankCode)} 的题号与题目`;
  const list = jumpListItems();
  fillJumpSelect(list, state.question?.num, "");
  if (search) search.value = "";
  dialog.classList.remove("hidden");
  syncJumpDialogKeyboard();
  setTimeout(() => {
    syncJumpDialogKeyboard();
    (search || $("#practice-jump-select"))?.focus();
  }, 40);
}

async function confirmJump() {
  const sel = $("#practice-jump-select");
  const num = Number(sel?.value);
  if (!Number.isFinite(num)) {
    toast("请选择题目");
    return;
  }
  const idx = state.list.findIndex((q) => Number(q.num ?? q.id) === num);
  if (idx < 0) {
    toast("未找到该题");
    return;
  }
  closeJumpDialog();
  await openQuestionAt(idx);
}

function bindJumpUi() {
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("#btn-practice-jump, .practice-num-jump");
    if (!btn) return;
    e.preventDefault();
    openJumpDialog();
  });
  $("#btn-practice-jump-cancel")?.addEventListener("click", () => closeJumpDialog());
  $("#btn-practice-jump-confirm")?.addEventListener("click", () => {
    confirmJump().catch((err) => {
      console.warn(err);
      toast(err.message || "跳转失败");
    });
  });
  $("#practice-jump-dialog")?.addEventListener("click", (e) => {
    if (e.target === $("#practice-jump-dialog")) closeJumpDialog();
  });
  $("#practice-jump-search")?.addEventListener("input", (e) => {
    fillJumpSelect(jumpListItems(), state.question?.num, e.target.value);
  });
  $("#practice-jump-select")?.addEventListener("dblclick", () => {
    confirmJump().catch((err) => console.warn(err));
  });
  $("#practice-jump-search")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      confirmJump().catch((err) => console.warn(err));
    }
  });
  const vv = window.visualViewport;
  if (vv) {
    vv.addEventListener("resize", syncJumpDialogKeyboard);
    vv.addEventListener("scroll", syncJumpDialogKeyboard);
  }
  window.addEventListener("resize", syncJumpDialogKeyboard);
}

function bindCustomTextUi() {
  $("#btn-custom-text-add")?.addEventListener("click", () => openCustomTextDialog({ manage: true }));
  $("#btn-custom-text-back")?.addEventListener("click", () => {
    closeCustomTextDialog().catch((err) => console.warn(err));
  });
  $("#btn-custom-text-edit")?.addEventListener("click", () => {
    const q = currentQuestion();
    if (!q) {
      toast("请先选择题");
      return;
    }
    if (isCustomBankCode(q.code || state.bankCode)) {
      openCustomTextDialog({ manage: true, editNum: q.num });
      return;
    }
    // 任意题库文章：带入当前内容，编辑后保存到自由练习
    openCustomTextDialog({ manage: true, seedFromQuestion: q });
  });
  $("#btn-custom-text-import-srt")?.addEventListener("click", () => {
    $("#custom-text-srt-file")?.click();
  });
  $("#btn-retranslate-en")?.addEventListener("click", () => {
    retranslateAllChineseToEnglish().catch((err) => console.warn(err));
  });
  $("#custom-text-srt-file")?.addEventListener("change", (e) => {
    const file = e.target?.files?.[0];
    importTextFromDialog(file).catch((err) => console.warn(err));
  });
  $("#custom-text-name")?.addEventListener("input", () => {
    scheduleCustomTextAutosave();
  });
  $("#custom-text-body")?.addEventListener("input", () => {
    // 对照面板开启时，改正文不再清掉意群；无面板时才清
    if ($("#custom-text-pairs-wrap")?.classList.contains("hidden") && pendingSrtGroups) {
      clearPendingSrtImport();
    }
  });
  $("#custom-text-pairs")?.addEventListener("input", (e) => {
    if (pairEditorSilent) return;
    const zh = e.target?.closest?.(".custom-text-pair-zh");
    const en = e.target?.closest?.(".custom-text-pair-en");
    if (zh) {
      if (e.isComposing) {
        commitPairsToPending();
        return;
      }
      commitPairsToPending();
      const idx = Number(zh.closest(".custom-text-pair")?.dataset?.pairIdx);
      if (Number.isFinite(idx)) scheduleLiveTranslateOnZhEdit(idx);
      return;
    }
    if (en) commitPairsToPending();
  });
  $("#custom-text-pairs")?.addEventListener("keydown", (e) => {
    handleCustomPairZhEditKey(e);
  });
  $("#custom-text-pairs")?.addEventListener("beforeinput", (e) => {
    handleCustomPairZhEditKey(e);
  });
  $("#custom-text-pairs")?.addEventListener("compositionend", (e) => {
    const zh = e.target?.closest?.(".custom-text-pair-zh");
    if (!zh || pairEditorSilent) return;
    commitPairsToPending();
    const idx = Number(zh.closest(".custom-text-pair")?.dataset?.pairIdx);
    if (Number.isFinite(idx)) scheduleLiveTranslateOnZhEdit(idx);
  });
}

function syncBankCacheQuestion(q) {
  if (!q) return;
  const num = Number(q.num ?? q.id);
  const keys = Object.keys(state.bankCache || {});
  for (const key of keys) {
    const list = state.bankCache[key];
    if (!Array.isArray(list)) continue;
    const idx = list.findIndex((x) => Number(x?.num ?? x?.id) === num);
    if (idx >= 0) list[idx] = q;
  }
}

function onSenseGroupsChanged(q) {
  if (!q) return;
  syncBankCacheQuestion(q);
  if (!isCustomBankCode(q.code || state.bankCode)) return;
  const en = String(q.en || "")
    .trim() || (Array.isArray(q.sense_groups) ? q.sense_groups.map((g) => String(g?.english || "").trim()).filter(Boolean).join("\n") : "");
  updateCustomText(q.num, {
    name: q.name,
    en,
    sense_groups: q.sense_groups,
  }).catch((err) => console.warn("persist merged sense groups", err));
}

async function boot() {
  // 尽早预热离线词典，意群进页即可标重音
  warmEnDict().catch(() => {});
  translationApi = createTranslation({
    state,
    $,
    toast,
    saveTranslationMemory,
    renderQuestion,
    syncDictationUI: () => {},
    setDictationOn: () => {},
    setPassageFocusOn: () => {},
    persistCurrentDictation: () => {},
    passageMarkKey,
    currentQuestion,
    ensureSenseGroupsVisible,
    ensureSensePageForSenseIdx,
    clampDictationTyped,
    autoAppendDictationExtras,
    isDictationAutoWord,
    normalizeDictationText,
    sameDictationChar,
    dictationCharLabel,
    dictationErrorHint,
    moveQuestion: (delta) => move(delta),
  });
  translationApi.bindTranslation();
  createScreenRecord({ $, toast });
  createSystemCamera({ $, toast });

  state.translation.on = true;
  $("#view-practice")?.classList.add("translation-on");
  $("#passage-wrap")?.classList.add("translation-on");
  $("#translation-panel")?.classList.remove("hidden");

  $("#btn-prev")?.addEventListener("click", () => move(-1));
  $("#btn-next")?.addEventListener("click", () => move(1));
  $("#bank-select")?.addEventListener("change", (e) => {
    fitBankSelectWidth();
    openBank(e.target.value).catch((err) => {
      console.warn(err);
      toast(err.message || "打开题库失败");
    });
  });
  window.addEventListener("resize", () => {
    fitBankSelectWidth();
    scheduleFitToolbarSwitchesScale();
  });
  // 字体加载后文字宽度可能变化
  try {
    document.fonts?.ready?.then?.(() => {
      fitBankSelectWidth();
      scheduleFitToolbarSwitchesScale();
    });
  } catch (_) {}
  scheduleFitToolbarSwitchesScale();
  if (typeof ResizeObserver !== "undefined") {
    const switchesHost = document.querySelector(".passage-toolbar-switches");
    if (switchesHost) {
      new ResizeObserver(() => scheduleFitToolbarSwitchesScale()).observe(switchesHost);
    }
    const toolbar = document.querySelector(".passage-toolbar");
    if (toolbar) {
      new ResizeObserver(() => scheduleFitToolbarSwitchesScale()).observe(toolbar);
    }
  }
  bindCustomTextUi();
  bindVoiceMemo({ $, toast });
  bindTranslateEngineUi();
  bindJumpUi();
  bindFullTextUi();
  bindWordbook({
    $,
    toast,
    speakWord: (word) => {
      enFullSpeech.speakOnce(word).catch((err) => console.warn(err));
    },
  });
  document.addEventListener("biyi-apple-speech-voice", (e) => {
    const d = e.detail || {};
    const name = String(d.voiceName || "").trim();
    if (!name) return;
    const quality = String(d.quality || "").trim();
    toast(quality ? `本机语音：${name}（${quality}）` : `本机语音：${name}`);
  });
  $("#btn-sense-fold")?.addEventListener("click", () => toggleSenseFold());
  syncSenseFoldUi();

  document.addEventListener("keydown", (e) => {
    if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && typeof t.matches === "function" && t.matches("input, textarea, select") && t.id !== "translation-input") {
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const cal = $("#translation-words-calendar");
      if (cal && !cal.classList.contains("hidden")) return;
      if (document.activeElement?.id === "translation-input") return;
      e.preventDefault();
      move(e.key === "ArrowLeft" ? -1 : 1);
    }
  });

  try {
    await ensureCustomTextsSeedMerged();
    state.catalog = await fetchJson("/data/catalog.json");
    await fillBankSelect();
    let lastBank = localStorage.getItem("biyi_last_bank") || "RA";
    let preferNum = null;
    try {
      const pos = JSON.parse(localStorage.getItem("biyi_practice_position") || "null");
      if (pos && typeof pos === "object") {
        if (pos.bank) lastBank = String(pos.bank);
        if (pos.num != null && Number.isFinite(Number(pos.num))) preferNum = Number(pos.num);
      }
    } catch (_) {}
    const codes = [...$("#bank-select").options].map((o) => o.value);
    const code = codes.includes(lastBank) ? lastBank : codes[0] || "RA";
    await openBank(code, preferNum);
    translationApi.setTranslationOn(true, { toastMsg: false, focus: true });
    savePracticePosition();
  } catch (err) {
    console.error(err);
    toast(err.message || "启动失败");
  }

  // 清掉 Keyboard body 模式可能残留的固定 height（会锁死 WKWebView 滑动）
  document.documentElement.style.height = "";
  document.body.style.height = "";

  // Capacitor Keyboard：强制允许 WebView 滚动（底部加长空白，用户自行上下滑避让）
  try {
    const { Keyboard } = window.Capacitor?.Plugins || {};
    Keyboard?.setScroll?.({ isDisabled: false });
  } catch (_) { /* ignore */ }

  // iOS 杀进程时 beforeunload 经常不触发，进后台就落盘
  const onLeave = () => checkpointPractice();
  window.addEventListener("beforeunload", onLeave);
  window.addEventListener("pagehide", onLeave);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") onLeave();
  });
}

boot();
