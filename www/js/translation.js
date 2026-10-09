
import { bindEnglishInputOnFocus } from "./ime-english.js?v=20261009vmclick";
import { createEdgeSpeech } from "./edge-tts.js?v=20261009vmclick";
import { annotateEnTapStress } from "./en-word-dict.js?v=20261009vmclick";

export function createTranslation({ state, $, toast, saveTranslationMemory, renderQuestion, syncDictationUI, setDictationOn, setPassageFocusOn, persistCurrentDictation, passageMarkKey, currentQuestion, ensureSenseGroupsVisible, clampDictationTyped, autoAppendDictationExtras, isDictationAutoWord, normalizeDictationText, sameDictationChar, dictationCharLabel, dictationErrorHint, moveQuestion }) {
  const speech = createEdgeSpeech();
  let groupWords = [];
  let answerGhostTarget = "";
  let answerStressToken = 0;
  /** 上次从意群 chip 同步过来的重音签名；变化时重拉，避免自己查词典猜重音 */
  let answerGhostStressSig = "";
  let answerStressFromChipBound = false;

  const TTS_PREF_KEY = "biyi_tts_on";
  const ANSWER_PREF_KEY = "biyi_answer_on";

  function readPref(key, fallback = true) {
    try {
      const v = localStorage.getItem(key);
      if (v === null || v === undefined) return fallback;
      return v === "1" || v === "true";
    } catch {
      return fallback;
    }
  }

  function writePref(key, on) {
    try {
      localStorage.setItem(key, on ? "1" : "0");
    } catch (_) {}
  }

  function isAnswerOn() {
    return readPref(ANSWER_PREF_KEY, false);
  }

  function setAnswerOn(on, { quiet = false } = {}) {
    const next = !!on;
    writePref(ANSWER_PREF_KEY, next);
    syncAnswerUi();
    if (!quiet) toast(next ? "已显示描红答案" : "已隐藏答案");
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

  function buildAnswerGhostWords(ghost, target) {
    const frag = document.createDocumentFragment();
    for (const part of tokenizeEnglishForTap(target)) {
      if (part.type === "word") {
        const el = document.createElement("span");
        el.className = "en-tap-word";
        el.textContent = part.text;
        el.dataset.word = part.text;
        frag.appendChild(el);
      } else {
        const sep = document.createElement("span");
        sep.className = "en-tap-sep";
        sep.dataset.raw = part.text;
        sep.textContent = part.text;
        frag.appendChild(sep);
      }
    }
    ghost.replaceChildren(frag);
  }

  function currentTranslationSenseIdx() {
    const groups = translationGroupsOf(currentQuestion());
    const item = groups[state.translation.idx];
    return item && Number.isFinite(item.idx) ? item.idx : -1;
  }

  function senseChipEnHost(senseIdx) {
    if (!Number.isFinite(senseIdx) || senseIdx < 0) return null;
    const chip = document.querySelector(`#sense-block .sense-chip[data-sense-idx="${senseIdx}"]`);
    return chip?.querySelector?.(".sense-en") || null;
  }

  function stressSigFromSenseEn(enHost) {
    if (!enHost) return "";
    return Array.from(enHost.querySelectorAll(".en-tap-word"))
      .map((el) => {
        const w = el.dataset.word || "";
        const hasMark = el.querySelector(":scope > .en-stress-mark") ? "1" : "0";
        const done = el.dataset.stress || "0";
        const syl = el.querySelector(":scope > .en-stress-syl")?.textContent || "";
        return `${w}:${done}:${hasMark}:${syl}`;
      })
      .join("|");
  }

  /** 把意群 chip 上已标好的重音结构拷到描红行（不查词典） */
  function applyStressFromSenseChip(ghost, senseIdx) {
    const enHost = senseChipEnHost(senseIdx);
    if (!ghost || !enHost) return false;
    const chipWords = Array.from(enHost.querySelectorAll(".en-tap-word"));
    const ghostWords = Array.from(ghost.querySelectorAll(".en-tap-word"));
    if (!chipWords.length || !ghostWords.length) return false;

    let matched = 0;
    for (let i = 0; i < ghostWords.length; i += 1) {
      const dst = ghostWords[i];
      const src =
        chipWords[i] &&
        String(chipWords[i].dataset.word || "").toLowerCase() === String(dst.dataset.word || "").toLowerCase()
          ? chipWords[i]
          : chipWords.find(
              (w) => String(w.dataset.word || "").toLowerCase() === String(dst.dataset.word || "").toLowerCase()
            );
      if (!src) continue;
      matched += 1;
      if (src.dataset.stress) dst.dataset.stress = src.dataset.stress;
      dst.classList.toggle("has-stress", src.classList.contains("has-stress"));
      const mark = src.querySelector(":scope > .en-stress-mark");
      const syl = src.querySelector(":scope > .en-stress-syl");
      const raw = dst.dataset.word || "";
      if (mark && syl) {
        const sylText = syl.textContent || "";
        const prefixLen = Math.max(0, raw.length - sylText.length);
        const prefix = raw.slice(0, prefixLen);
        dst.replaceChildren();
        if (prefix) dst.append(prefix);
        dst.appendChild(mark.cloneNode(true));
        const sylWrap = document.createElement("span");
        sylWrap.className = "en-stress-syl";
        sylWrap.textContent = sylText;
        dst.appendChild(sylWrap);
      } else {
        dst.replaceChildren();
        dst.textContent = raw;
      }
    }
    return matched > 0;
  }

  function appendProgressPieces(parent, raw, start, typedLen) {
    const doneLen = Math.max(0, Math.min(String(raw).length, typedLen - start));
    const done = String(raw).slice(0, doneLen);
    const rest = String(raw).slice(doneLen);
    if (done) {
      const d = document.createElement("span");
      d.className = "translation-answer-done";
      d.textContent = done;
      parent.appendChild(d);
    }
    if (rest) {
      const r = document.createElement("span");
      r.className = "translation-answer-rest";
      r.textContent = rest;
      parent.appendChild(r);
    }
  }

  function paintAnswerGhostProgress(ghost, typedLen) {
    if (!ghost) return;
    let pos = 0;
    for (const el of ghost.children) {
      if (el.classList.contains("en-tap-sep")) {
        const raw = el.dataset.raw ?? "";
        el.replaceChildren();
        appendProgressPieces(el, raw, pos, typedLen);
        pos += raw.length;
        continue;
      }
      if (!el.classList.contains("en-tap-word")) continue;
      const raw = el.dataset.word || "";
      const wordStart = pos;
      const wordEnd = wordStart + raw.length;
      el.classList.toggle("is-current", typedLen > wordStart && typedLen < wordEnd);
      el.classList.toggle("is-typed", typedLen >= wordEnd);
      el.classList.toggle("is-pending", typedLen <= wordStart);

      const mark = el.querySelector(":scope > .en-stress-mark");
      const syl = el.querySelector(":scope > .en-stress-syl");
      if (mark && syl) {
        const sylText = syl.textContent || "";
        const prefixLen = Math.max(0, raw.length - sylText.length);
        const prefix = raw.slice(0, prefixLen);
        el.replaceChildren();
        if (prefix) {
          const pre = document.createElement("span");
          pre.className = "en-stress-prefix";
          appendProgressPieces(pre, prefix, wordStart, typedLen);
          el.appendChild(pre);
        }
        mark.classList.toggle("is-untyped", typedLen < wordStart + prefixLen);
        el.appendChild(mark);
        const sylWrap = document.createElement("span");
        sylWrap.className = "en-stress-syl";
        appendProgressPieces(sylWrap, sylText, wordStart + prefixLen, typedLen);
        el.appendChild(sylWrap);
      } else {
        el.replaceChildren();
        appendProgressPieces(el, raw, wordStart, typedLen);
      }
      pos += raw.length;
    }
  }

  let stressShiftFontKey = "";

  /**
   * 叠层里的 ˈ 是零宽的，字形会从原点向右画，不挪就会压在重读音节首字母上。
   * 按当前字体实测 ˈ 墨迹中心，把它挪到「前后字母之间」。
   */
  function syncStressMarkShift(ghost) {
    if (!ghost) return;
    const cs = getComputedStyle(ghost);
    const key = `${cs.fontStyle}|${cs.fontFamily}`;
    if (key === stressShiftFontKey && ghost.style.getPropertyValue("--stress-shift")) return;
    try {
      const size = 100;
      const ctx = document.createElement("canvas").getContext("2d");
      ctx.font = `${cs.fontStyle === "italic" ? "italic " : ""}${size}px ${cs.fontFamily}`;
      const r = ctx.measureText("\u02c8");
      const inkL = -r.actualBoundingBoxLeft;
      const inkR = r.actualBoundingBoxRight;
      const mid = (inkL + inkR) / 2;
      if (Number.isFinite(mid)) {
        ghost.style.setProperty("--stress-shift", `${(-mid / size).toFixed(3)}em`);
        stressShiftFontKey = key;
      }
    } catch (_) {}
  }

  function syncAnswerUi() {
    const on = isAnswerOn();
    const toggle = $("#toggle-answer");
    const wrap = $("#translation-answer-wrap");
    const ghost = $("#translation-answer-ghost");
    if (toggle) {
      toggle.classList.toggle("is-on", on);
      toggle.setAttribute("aria-pressed", on ? "true" : "false");
    }
    if (wrap) wrap.classList.toggle("is-answer-on", on);
    if (!ghost) return;
    syncStressMarkShift(ghost);
    const target = String(state.translation.target || "");
    const typed = String(state.translation.typed || "");
    let n = 0;
    const limit = Math.min(typed.length, target.length);
    while (n < limit && typed[n] === target[n]) n += 1;
    if (!target) {
      answerGhostTarget = "";
      answerGhostStressSig = "";
      answerStressToken += 1;
      ghost.replaceChildren();
      wrap?.classList.remove("is-ghost-en");
      return;
    }
    wrap?.classList.add("is-ghost-en");
    const senseIdx = currentTranslationSenseIdx();
    const rebuilt = answerGhostTarget !== target;
    if (rebuilt) {
      answerGhostTarget = target;
      answerGhostStressSig = "";
      answerStressToken += 1;
      buildAnswerGhostWords(ghost, target);
    }
    const enHost = senseChipEnHost(senseIdx);
    const chipSig = stressSigFromSenseEn(enHost);
    if (enHost) {
      // 优先复用意群 chip 上已有的重音；chip 异步标完后会再触发一次 sync
      if (chipSig !== answerGhostStressSig) {
        applyStressFromSenseChip(ghost, senseIdx);
        answerGhostStressSig = chipSig;
        answerStressToken += 1; // 取消任何进行中的 fallback 词典标注
      }
    } else if (rebuilt) {
      // chip 尚未构建时才临时查词典；一旦 chip 就绪会覆盖为同一套标记
      const token = ++answerStressToken;
      annotateEnTapStress(ghost, {
        token,
        isStale: () => token !== answerStressToken,
      })
        .then(() => {
          if (token !== answerStressToken) return;
          const t = String(state.translation.target || "");
          const typedNow = String(state.translation.typed || "");
          let k = 0;
          const lim = Math.min(typedNow.length, t.length);
          while (k < lim && typedNow[k] === t[k]) k += 1;
          paintAnswerGhostProgress(ghost, k);
        })
        .catch((err) => console.warn(err));
    }
    paintAnswerGhostProgress(ghost, n);
  }

  function bindAnswerStressFromChip() {
    if (answerStressFromChipBound) return;
    answerStressFromChipBound = true;
    document.addEventListener("biyi-sense-stress-ready", () => {
      answerGhostStressSig = "";
      syncAnswerUi();
    });
  }

  function bindAnswerSwitch() {
    const toggle = $("#toggle-answer");
    if (!toggle || toggle.dataset.bound === "1") return;
    toggle.dataset.bound = "1";
    toggle.addEventListener("click", () => {
      setAnswerOn(!isAnswerOn());
    });
    bindAnswerStressFromChip();
    syncAnswerUi();
  }

  function isTtsEnabled() {
    return readPref(TTS_PREF_KEY, true);
  }

  /** 笔译「朗读」开关：只管开 / 关。声音种类统一在顶部「音色」里选 */
  function syncPrefToggles() {
    const toggle = $("#toggle-tts");
    if (!toggle) return;
    const on = isTtsEnabled();
    toggle.classList.toggle("is-on", on);
    toggle.setAttribute("aria-pressed", on ? "true" : "false");
  }

  function reprepareCurrentSpeech() {
    const target = String(state.translation?.target || "").trim();
    if (!target) {
      speech.release();
      return;
    }
    groupWords = prepareGroupSpeech(target);
  }

  function setTtsEnabled(on) {
    writePref(TTS_PREF_KEY, !!on);
    if (!on) {
      speech.release();
    } else {
      reprepareCurrentSpeech();
    }
    syncPrefToggles();
    renderTranslationStatus();
    toast(on ? "已开启朗读" : "已关闭朗读");
  }

  function bindTtsSwitch() {
    const toggle = $("#toggle-tts");
    if (!toggle || toggle.dataset.bound === "1") return;
    toggle.dataset.bound = "1";
    syncPrefToggles();
    toggle.addEventListener("click", () => setTtsEnabled(!isTtsEnabled()));
    // 在「全文朗读」里换了声音 / 引擎：笔译要按新声音重新备音
    document.addEventListener("biyi-tts-engine", () => {
      if (isTtsEnabled()) reprepareCurrentSpeech();
    });
  }

  function groupWordSpans(target) {
    const words = [];
    const re = /[A-Za-z]+(?:'[A-Za-z]+)?/g;
    let match;
    while ((match = re.exec(target))) {
      words.push({ word: match[0], end: match.index + match[0].length });
    }
    return words;
  }

  function prepareGroupSpeech(target) {
    const words = groupWordSpans(target);
    speech.prepare(target, words.map((item) => item.word));
    return words;
  }

  function speakNewlyCompleted(beforeLen, typed) {
    if (!isTtsEnabled()) return Promise.resolve();
    const fresh = groupWords.filter((item) => beforeLen < item.end && typed.length >= item.end);
    if (!fresh.length) return Promise.resolve();
    return speech.speakWords(fresh.map((item) => ({
      word: item.word,
      auto: isDictationAutoWord(item.word),
    })));
  }
  function translationGroupsOf(q) {
    const groups = Array.isArray(q?.sense_groups) ? q.sense_groups : [];
    return groups
      .map((sg, idx) => ({
        idx,
        chinese: String(sg?.chinese || "").trim(),
        english: normalizeDictationText(sg?.english || "", { asTarget: true }),
      }))
      .filter((g) => g.english);
  }
  
  function clearTranslationAdvance() {
    clearTimeout(state.translation.advanceTimer);
    state.translation.advanceTimer = 0;
  }

  function placeTranslationCaret(input = $("#translation-input")) {
    if (!input || input.disabled) return;
    const end = input.value.length;
    try { input.setSelectionRange(end, end); } catch (_) {}
  }

  function fitTranslationInputHeight() {
    const input = $("#translation-input");
    if (!input) return;
    input.style.height = "auto";
    const min = parseFloat(getComputedStyle(input).minHeight) || 0;
    const max = parseFloat(getComputedStyle(input).maxHeight) || Infinity;
    const next = Math.min(Math.max(input.scrollHeight, min), max);
    input.style.height = `${next}px`;
  }

  const DAILY_WORDS_KEY = "pte_translation_daily_words";
  let calYear = 0;
  let calMonth = 0; // 0-11
  let calSelectedKey = "";

  function todayKey() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function dateKeyFromParts(y, m0, day) {
    return `${y}-${String(m0 + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  function englishWordTokens(text) {
    return String(text || "").match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) || [];
  }

  /** 已写完的「手动」英文词数：自动填入的冠词/介词/连词等虚词不计；末尾半截词不计 */
  function completedEnglishWordCount(text) {
    const raw = String(text || "");
    let words = englishWordTokens(raw);
    if (!words.length) return 0;
    if (/[A-Za-z]$/.test(raw)) words = words.slice(0, -1);
    const auto = typeof isDictationAutoWord === "function" ? isDictationAutoWord : () => false;
    return words.reduce((n, w) => (auto(w) ? n : n + 1), 0);
  }

  function loadDailyWordMap() {
    try {
      const raw = JSON.parse(localStorage.getItem(DAILY_WORDS_KEY) || "null");
      if (!raw || typeof raw !== "object") return {};
      // 新格式：{ version: 2, days: { "YYYY-MM-DD": n } }
      if (raw.days && typeof raw.days === "object") {
        const days = {};
        Object.entries(raw.days).forEach(([k, v]) => {
          const n = Math.floor(Number(v));
          if (/^\d{4}-\d{2}-\d{2}$/.test(k) && Number.isFinite(n) && n > 0) days[k] = n;
        });
        return days;
      }
      // 旧格式：{ date, count }
      if (raw.date && /^\d{4}-\d{2}-\d{2}$/.test(raw.date)) {
        const n = Math.floor(Number(raw.count));
        if (Number.isFinite(n) && n > 0) return { [raw.date]: n };
      }
    } catch (_) {}
    return {};
  }

  function saveDailyWordMap(days) {
    try {
      localStorage.setItem(DAILY_WORDS_KEY, JSON.stringify({ version: 2, days: days || {} }));
    } catch (_) {}
  }

  function getDailyWordCount(date = todayKey()) {
    const n = Number(loadDailyWordMap()[date] || 0);
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  }

  function noteDailyWordsFromProgress(prevTyped, nextTyped) {
    const gained = completedEnglishWordCount(nextTyped) - completedEnglishWordCount(prevTyped);
    if (gained <= 0) return getDailyWordCount();
    const key = todayKey();
    const days = loadDailyWordMap();
    days[key] = (days[key] || 0) + gained;
    saveDailyWordMap(days);
    return days[key];
  }

  function formatCalMonthTitle(y, m0) {
    return `${y}年${m0 + 1}月`;
  }

  function formatCalDetail(dateKey) {
    if (!dateKey) return "点选日期查看当天词数";
    const count = getDailyWordCount(dateKey);
    const [y, m, d] = dateKey.split("-").map(Number);
    const isToday = dateKey === todayKey();
    const label = isToday ? "今天" : `${y}年${m}月${d}日`;
    if (!count) return `${label}：还没有输入记录`;
    return `${label}：${count} 词`;
  }

  function ensureCalCursor() {
    if (!calYear) {
      const now = new Date();
      calYear = now.getFullYear();
      calMonth = now.getMonth();
      calSelectedKey = todayKey();
    }
  }

  function shiftCalMonth(delta) {
    ensureCalCursor();
    const d = new Date(calYear, calMonth + delta, 1);
    calYear = d.getFullYear();
    calMonth = d.getMonth();
    renderWordsCalendar();
  }

  function renderDailyWordCount() {
    const el = $("#translation-daily-count");
    if (el) el.textContent = String(getDailyWordCount());
    const dialog = $("#translation-words-calendar");
    if (dialog && !dialog.classList.contains("hidden")) {
      renderWordsCalendar();
    }
  }

  function renderWordsCalendar() {
    ensureCalCursor();
    const monthEl = $("#translation-cal-month");
    const grid = $("#translation-cal-grid");
    const detail = $("#translation-cal-detail");
    if (monthEl) monthEl.textContent = formatCalMonthTitle(calYear, calMonth);
    if (!grid) return;

    const days = loadDailyWordMap();
    const firstDow = new Date(calYear, calMonth, 1).getDay();
    const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
    const today = todayKey();
    const frag = document.createDocumentFragment();

    for (let i = 0; i < firstDow; i += 1) {
      const empty = document.createElement("div");
      empty.className = "translation-cal-cell is-empty";
      empty.setAttribute("aria-hidden", "true");
      frag.appendChild(empty);
    }

    for (let day = 1; day <= daysInMonth; day += 1) {
      const key = dateKeyFromParts(calYear, calMonth, day);
      const count = Math.max(0, Math.floor(Number(days[key] || 0)));
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "translation-cal-cell";
      btn.dataset.date = key;
      if (key === today) btn.classList.add("is-today");
      if (key === calSelectedKey) btn.classList.add("is-selected");
      if (count > 0) btn.classList.add("is-hot");
      btn.setAttribute("aria-label", `${calMonth + 1}月${day}日 ${count} 词`);
      btn.innerHTML = `<span class="translation-cal-day">${day}</span><span class="translation-cal-count${count ? "" : " is-zero"}">${count || "·"}</span>`;
      frag.appendChild(btn);
    }

    grid.replaceChildren(frag);
    if (detail) detail.textContent = formatCalDetail(calSelectedKey || today);
  }

  function openWordsCalendar() {
    ensureCalCursor();
    const now = new Date();
    calYear = now.getFullYear();
    calMonth = now.getMonth();
    calSelectedKey = todayKey();
    renderWordsCalendar();
    renderDailyWordCount();
    $("#translation-words-calendar")?.classList.remove("hidden");
  }

  function closeWordsCalendar() {
    $("#translation-words-calendar")?.classList.add("hidden");
  }

  function monthTotalWords(y, m0, daysMap) {
    let total = 0;
    const daysInMonth = new Date(y, m0 + 1, 0).getDate();
    for (let day = 1; day <= daysInMonth; day += 1) {
      total += Math.max(0, Math.floor(Number(daysMap[dateKeyFromParts(y, m0, day)] || 0)));
    }
    return total;
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  function buildWordsShareCard() {
    ensureCalCursor();
    const daysMap = loadDailyWordMap();
    const today = todayKey();
    const todayCount = getDailyWordCount(today);
    const selected = calSelectedKey || today;
    const selectedCount = getDailyWordCount(selected);
    const monthSum = monthTotalWords(calYear, calMonth, daysMap);
    const W = 1080;
    const H = 1440;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法生成图片");

    const ink = "#10231c";
    const inkSoft = "#5b6f66";
    const accent = "#1f6f5b";
    const foam = "#f7f3ea";
    const card = "#fffdf8";
    const line = "rgba(16, 35, 28, 0.12)";

    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, "#efe6d4");
    bg.addColorStop(0.45, "#f7f3ea");
    bg.addColorStop(1, "#e4efe9");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // soft blobs
    ctx.fillStyle = "rgba(31, 111, 91, 0.08)";
    ctx.beginPath();
    ctx.arc(180, 220, 220, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(940, 1180, 260, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = inkSoft;
    ctx.font = "700 36px 'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif";
    ctx.fillText("笔译训练", 88, 110);

    ctx.fillStyle = ink;
    ctx.font = "800 64px 'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif";
    ctx.fillText("笔译词数打卡", 88, 190);

    // today hero card
    roundRectPath(ctx, 72, 240, W - 144, 280, 36);
    ctx.fillStyle = card;
    ctx.fill();
    ctx.strokeStyle = "rgba(31, 111, 91, 0.22)";
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.fillStyle = inkSoft;
    ctx.font = "700 34px 'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif";
    ctx.fillText("今日输入", 120, 330);

    ctx.fillStyle = accent;
    ctx.font = "800 140px 'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif";
    ctx.fillText(String(todayCount), 120, 460);
    const tw = ctx.measureText(String(todayCount)).width;
    ctx.font = "800 48px 'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif";
    ctx.fillText("词", 120 + tw + 18, 450);

    // month card
    roundRectPath(ctx, 72, 560, W - 144, 700, 36);
    ctx.fillStyle = card;
    ctx.fill();
    ctx.strokeStyle = line;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = ink;
    ctx.font = "800 42px 'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif";
    ctx.fillText(formatCalMonthTitle(calYear, calMonth), 120, 640);
    ctx.fillStyle = accent;
    ctx.font = "700 32px 'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(`本月合计 ${monthSum} 词`, W - 120, 640);
    ctx.textAlign = "left";

    const weekLabels = ["日", "一", "二", "三", "四", "五", "六"];
    const gridX = 120;
    const gridY = 690;
    const cellW = (W - 240) / 7;
    const cellH = 78;
    ctx.fillStyle = inkSoft;
    ctx.font = "700 26px 'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif";
    weekLabels.forEach((label, i) => {
      ctx.textAlign = "center";
      ctx.fillText(label, gridX + cellW * i + cellW / 2, gridY);
    });
    ctx.textAlign = "left";

    const firstDow = new Date(calYear, calMonth, 1).getDay();
    const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
    const maxCount = Math.max(
      1,
      ...Array.from({ length: daysInMonth }, (_, i) =>
        Math.max(0, Math.floor(Number(daysMap[dateKeyFromParts(calYear, calMonth, i + 1)] || 0)))
      )
    );

    for (let day = 1; day <= daysInMonth; day += 1) {
      const key = dateKeyFromParts(calYear, calMonth, day);
      const count = Math.max(0, Math.floor(Number(daysMap[key] || 0)));
      const idx = firstDow + day - 1;
      const col = idx % 7;
      const row = Math.floor(idx / 7);
      const x = gridX + col * cellW + 6;
      const y = gridY + 24 + row * cellH;
      const w = cellW - 12;
      const h = cellH - 10;
      const intensity = count ? 0.1 + (count / maxCount) * 0.42 : 0;
      roundRectPath(ctx, x, y, w, h, 16);
      ctx.fillStyle = count ? `rgba(31, 111, 91, ${intensity})` : "rgba(16, 35, 28, 0.03)";
      ctx.fill();
      if (key === today || key === selected) {
        ctx.strokeStyle = accent;
        ctx.lineWidth = key === selected ? 3 : 2;
        ctx.stroke();
      }
      ctx.fillStyle = ink;
      ctx.font = "700 24px 'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(String(day), x + w / 2, y + 30);
      ctx.fillStyle = count ? accent : inkSoft;
      ctx.font = "800 22px 'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif";
      ctx.fillText(count ? String(count) : "·", x + w / 2, y + 58);
    }
    ctx.textAlign = "left";

    const [sy, sm, sd] = selected.split("-").map(Number);
    const selectedLabel = selected === today ? "今天" : `${sy}年${sm}月${sd}日`;
    ctx.fillStyle = inkSoft;
    ctx.font = "700 30px 'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif";
    ctx.fillText(`${selectedLabel} · ${selectedCount} 词`, 120, 1310);

    ctx.fillStyle = inkSoft;
    ctx.font = "600 26px 'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif";
    ctx.fillText("用意群把句子装进耳朵里", 120, 1370);

    return canvas;
  }

  function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error("图片导出失败"));
        },
        "image/png",
        0.95
      );
    });
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const s = String(reader.result || "");
        const i = s.indexOf(",");
        resolve(i >= 0 ? s.slice(i + 1) : s);
      };
      reader.onerror = () => reject(reader.error || new Error("读取失败"));
      reader.readAsDataURL(blob);
    });
  }

  async function shareWordsCard() {
    const btn = $("#btn-translation-cal-share");
    if (btn) btn.disabled = true;
    try {
      const canvas = buildWordsShareCard();
      const blob = await canvasToBlob(canvas);
      const today = todayKey();
      const name = `biyi-words-${today}.png`;
      const file = new File([blob], name, { type: "image/png" });
      const Cap = window.Capacitor;
      const isNative = !!(Cap?.isNativePlatform && Cap.isNativePlatform());
      const Share = Cap?.Plugins?.Share;
      const FS = Cap?.Plugins?.Filesystem;

      if (isNative && FS?.writeFile && Share?.share) {
        const base64 = await blobToBase64(blob);
        const path = `pte-shares/${name}`;
        try {
          await FS.mkdir({ path: "pte-shares", directory: "CACHE", recursive: true });
        } catch (_) {}
        await FS.writeFile({ path, data: base64, directory: "CACHE" });
        const uriRes = await FS.getUri({ path, directory: "CACHE" });
        const uri = uriRes?.uri || "";
        if (!uri) throw new Error("无法准备分享文件");
        await Share.share({
          title: "笔译训练 · 笔译词数",
          text: `今日笔译 ${getDailyWordCount()} 词`,
          url: uri,
          dialogTitle: "分享词数打卡图",
        });
        toast("已打开系统分享");
        return;
      }

      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: "笔译训练 · 笔译词数",
          text: `今日笔译 ${getDailyWordCount()} 词`,
        });
        toast("已打开系统分享");
        return;
      }

      const a = document.createElement("a");
      const href = URL.createObjectURL(blob);
      a.href = href;
      a.download = name;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 1500);
      toast("已生成图片并开始下载");
    } catch (err) {
      const msg = String(err?.message || err || "");
      if (/AbortError|canceled|cancelled|分享已取消/i.test(msg)) return;
      console.warn(err);
      toast(msg || "分享失败");
    } finally {
      if (btn) btn.disabled = false;
    }
  }
  
  function persistCurrentTranslation() {
    const key = state.translation.questionKey;
    if (!key) return;
    if (!state.translationMemory) state.translationMemory = {};
    const saved = state.translationMemory[key] || { idx: 0, groups: {} };
    const groups = { ...(saved.groups || {}) };
    groups[String(state.translation.idx)] = {
      typed: state.translation.typed || "",
      misses: state.translation.misses || 0,
      done: !!state.translation.done,
      at: Date.now(),
    };
    const hasWork = Object.values(groups).some((g) => g && (g.typed || g.misses || g.done));
    if (!hasWork) {
      // 仍记下 idx，退出再进能回到同一意群
      state.translationMemory[key] = {
        idx: state.translation.idx,
        groups: {},
        at: Date.now(),
      };
      saveTranslationMemory();
      return;
    }
    state.translationMemory[key] = { idx: state.translation.idx, groups, at: Date.now() };
    saveTranslationMemory();
  }
  
  function loadTranslationGroup(q, idx) {
    const groups = translationGroupsOf(q);
    const safeIdx = groups.length ? Math.max(0, Math.min(idx, groups.length - 1)) : 0;
    const item = groups[safeIdx];
    const key = passageMarkKey(q);
    const saved = (key && state.translationMemory && state.translationMemory[key]) || null;
    const slot = saved?.groups?.[String(safeIdx)] || null;
    const target = item?.english || "";
    const savedTyped = String(slot?.typed || "");
    let typed = clampDictationTyped(savedTyped, target);
    if (state.translation.on && !typed) typed = autoAppendDictationExtras("", target);
    state.translation.idx = safeIdx;
    state.translation.target = target;
    state.translation.typed = typed;
    state.translation.misses = Number(slot?.misses) || 0;
    state.translation.done = !!target && typed === target;
    const input = $("#translation-input");
    if (input) {
      input.value = typed;
      placeTranslationCaret(input);
    }
    groupWords = prepareGroupSpeech(target);
    if (state.translation.on) speakNewlyCompleted(savedTyped.length, typed);
  }
  
  function restoreTranslationFor(q) {
    const groups = translationGroupsOf(q);
    const key = passageMarkKey(q);
    state.translation.questionKey = key;
    const saved = (key && state.translationMemory && state.translationMemory[key]) || null;
    let idx = Number(saved?.idx);
    if (!Number.isFinite(idx) || idx < 0) idx = 0;
    if (idx >= groups.length) idx = Math.max(0, groups.length - 1);
    const firstOpen = groups.findIndex((_, i) => !saved?.groups?.[String(i)]?.done);
    // 有未完成意群时，优先停在上次 idx（若仍未完成）；否则落到第一处未完成
    if (firstOpen >= 0) {
      const savedOpen = Number.isFinite(Number(saved?.idx)) && !saved?.groups?.[String(saved.idx)]?.done;
      idx = savedOpen ? Math.min(Math.max(0, Number(saved.idx)), groups.length - 1) : firstOpen;
      // 不允许跳过更早的未完成意群
      if (firstOpen < idx) idx = firstOpen;
    } else if (groups.length) {
      idx = groups.length - 1;
    }
    if (!groups.length) {
      state.translation.target = "";
      state.translation.typed = "";
      state.translation.done = false;
      state.translation.misses = 0;
      state.translation.idx = 0;
      state.translation.on = true;
      groupWords = [];
      speech.release();
      const input = $("#translation-input");
      if (input) {
        input.value = "";
        placeTranslationCaret(input);
      }
      return;
    }
    loadTranslationGroup(q, idx);
  }
  
  function setTranslationOn(_on, { toastMsg = false, focus = true } = {}) {
    // 笔译永远开启，不再提供关闭
    const q = currentQuestion();
    const groups = translationGroupsOf(q);
    if (!groups.length) {
      state.translation.on = true;
      syncTranslationUI();
      if (toastMsg) toast("本题没有可笔译的意群");
      return;
    }
    persistCurrentTranslation();
    clearTranslationAdvance();
    if (state.dictation.on) setDictationOn(false, { toastMsg: false, focus: false });
    if (state.passageFocus?.on && typeof setPassageFocusOn === "function") {
      setPassageFocusOn(false, { toastMsg: false });
    }
    state.translation.on = true;
    restoreTranslationFor(q);
    syncTranslationUI();
    if (toastMsg) toast("笔译已开启：按意群顺序把中文译成英文");
    if (focus) {
      setTimeout(() => $("#translation-input")?.focus(), 40);
    }
  }
  
  /**
   * 笔译的意群进度与上方「意群」阅读区互不联动：
   * 笔译跳转 / 前进不会翻动、标记上方意群页；上方翻页、点读也不影响笔译位置。
   */
  function syncTranslationChips() {
    // 清掉旧版本可能残留在上方意群卡片上的笔译标记
    document.querySelectorAll("#sense-block .sense-chip.trans-current, #sense-block .sense-chip.trans-done").forEach((chipEl) => {
      chipEl.classList.remove("trans-current", "trans-done");
    });
  }
  
  function measureLeadMaxLineWidth(lead) {
    const text = String(lead.textContent || "");
    if (!text.trim()) return 0;
    try {
      const range = document.createRange();
      range.selectNodeContents(lead);
      const raw = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5);
      if (!raw.length) return lead.scrollWidth || 0;
      const lines = [];
      for (const r of raw) {
        const last = lines[lines.length - 1];
        if (last && Math.abs(last.top - r.top) < 3) {
          last.left = Math.min(last.left, r.left);
          last.right = Math.max(last.right, r.right);
        } else {
          lines.push({ top: r.top, left: r.left, right: r.right });
        }
      }
      return Math.max(...lines.map((l) => l.right - l.left));
    } catch (_) {
      return lead.scrollWidth || 0;
    }
  }

  function remToPx(rem) {
    const rootFs = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    return Math.round(Number(rem) * rootFs);
  }

  function fitTranslationLeadSize() {
    const lead = $("#translation-lead");
    if (!lead) return;
    const text = String(lead.textContent || "").trim();

    if (lead.classList.contains("hidden") || !text) {
      lead.style.removeProperty("width");
      lead.style.removeProperty("max-width");
      lead.style.removeProperty("font-size");
      lead.style.removeProperty("white-space");
      return;
    }

    const parent = lead.parentElement || lead;
    const parentCs = getComputedStyle(parent);
    const parentPadX =
      (parseFloat(parentCs.paddingLeft) || 0) + (parseFloat(parentCs.paddingRight) || 0);
    const available = Math.max(0, Math.floor(parent.clientWidth - parentPadX));
    if (available < 40) return;

    const leadCs = getComputedStyle(lead);
    const padX = (parseFloat(leadCs.paddingLeft) || 0) + (parseFloat(leadCs.paddingRight) || 0);
    const innerMax = Math.max(20, available - padX);

    // 「中」号下限；有空就放大，到下限仍放不下再换行
    const minPx = remToPx(1.55);
    const chars = Math.max(1, [...text].length);
    const maxByFill = Math.floor(((innerMax - 2) / chars) * 1.35);
    const maxPx = Math.min(96, Math.max(minPx, maxByFill, Math.round(innerMax * 0.22)));

    const applySize = (px) => {
      lead.style.fontSize = `${px}px`;
    };
    const lineWidth = () => {
      void lead.offsetWidth;
      return measureLeadMaxLineWidth(lead) || lead.scrollWidth || 0;
    };

    lead.style.maxWidth = "none";
    lead.style.width = "max-content";
    lead.style.whiteSpace = "nowrap";

    const fitsAt = (px) => {
      applySize(px);
      return lineWidth() <= innerMax;
    };

    if (!fitsAt(minPx)) {
      applySize(minPx);
      lead.style.whiteSpace = "normal";
      lead.style.width = "100%";
      lead.style.maxWidth = "100%";
      void lead.offsetWidth;
      const maxLine = measureLeadMaxLineWidth(lead);
      if (!(maxLine > 0)) return;
      const nextW = Math.min(Math.ceil(maxLine + padX + 1), available);
      lead.style.width = `${Math.max(1, nextW)}px`;
      lead.style.marginLeft = "auto";
      lead.style.marginRight = "auto";
      return;
    }

    let lo = minPx;
    let hi = maxPx;
    let best = minPx;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (fitsAt(mid)) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    applySize(best);
    lead.style.whiteSpace = "nowrap";
    lead.style.width = "max-content";
    lead.style.maxWidth = "100%";
    lead.style.marginLeft = "auto";
    lead.style.marginRight = "auto";
  }

  function scheduleFitTranslationLeadSize() {
    cancelAnimationFrame(fitTranslationLeadSize._raf || 0);
    fitTranslationLeadSize._raf = requestAnimationFrame(() => {
      fitTranslationLeadSize();
      // 字体异步就绪后再量一次，避免行楷未加载时量偏小
      cancelAnimationFrame(fitTranslationLeadSize._raf2 || 0);
      fitTranslationLeadSize._raf2 = requestAnimationFrame(() => fitTranslationLeadSize());
    });
  }

  const TRANSLATION_COLLAPSE_KEY = "biyi_translation_collapsed";

  function isTranslationCollapsed() {
    try {
      return localStorage.getItem(TRANSLATION_COLLAPSE_KEY) === "1";
    } catch {
      return false;
    }
  }

  function syncTranslationFoldUi() {
    const wrap = $("#passage-wrap");
    const btn = $("#btn-translation-fold");
    const collapsed = isTranslationCollapsed();
    wrap?.classList.toggle("is-collapsed", collapsed);
    if (btn) {
      btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
      btn.title = collapsed ? "展开笔译" : "折叠笔译";
    }
  }

  function setTranslationCollapsed(collapsed) {
    try {
      localStorage.setItem(TRANSLATION_COLLAPSE_KEY, collapsed ? "1" : "0");
    } catch (_) {}
    syncTranslationFoldUi();
    if (!collapsed) scheduleFitTranslationLeadSize();
    try {
      document.dispatchEvent(new CustomEvent("biyi-fold-change"));
    } catch (_) {}
  }

  function toggleTranslationFold() {
    setTranslationCollapsed(!isTranslationCollapsed());
  }

  function renderTranslationStatus() {
    const panel = $("#translation-panel");
    const progress = $("#translation-progress");
    const hint = $("#translation-hint");
    const lead = $("#translation-lead");
    if (!panel || !progress || !hint) return;
    const groups = translationGroupsOf(currentQuestion());
    const n = groups.length;
    const i = Math.min(state.translation.idx, Math.max(0, n - 1));
    const target = state.translation.target || "";
    const typed = state.translation.typed || "";
    const zh = groups[i]?.chinese || "";
    const en = groups[i]?.english || target || "";
    const foldMeta = $("#translation-fold-meta");
    if (foldMeta) foldMeta.textContent = n ? `（${i + 1}/${n}）` : "";
    if (lead) {
      if (state.translation.on && zh) {
        lead.textContent = zh;
      } else {
        lead.replaceChildren();
      }
      lead.classList.toggle("hidden", !state.translation.on || !zh);
    }
    syncAnswerUi();
    const jumpBtn = $("#btn-translation-jump-idx");
    const totalEl = $("#translation-group-total");
    const charsEl = $("#translation-char-progress");
    if (jumpBtn && totalEl && charsEl) {
      jumpBtn.textContent = n ? String(i + 1) : "0";
      jumpBtn.disabled = !n || !state.translation.on;
      totalEl.textContent = String(n);
      charsEl.textContent = n ? `${typed.length} / ${target.length}` : "0 / 0";
    } else {
      progress.textContent = n ? `意群 ${i + 1} / ${n} · ${typed.length} / ${target.length}` : "0 / 0";
    }
    renderDailyWordCount();
    panel.classList.toggle("is-done", !!state.translation.done);
    const playBtn = $("#btn-translation-play");
    if (playBtn) playBtn.hidden = !state.translation.done || !isTtsEnabled();
    if (!n) {
      hint.textContent = "本题没有可笔译的意群";
    } else if (state.translation.done && groups.every((_, gi) => (gi === i ? true : !!state.translationMemory?.[state.translation.questionKey]?.groups?.[String(gi)]?.done))) {
      hint.textContent = "本题意群笔译全部完成";
    } else if (state.translation.done) {
      hint.textContent = "本段译对了，可再听一遍";
    } else if (typed.length === 0) {
      hint.textContent = "逐字校验中";
    } else {
      hint.textContent = "标点、空格和冠词/介词/连词等虚词会自动填入";
    }
    scheduleFitTranslationLeadSize();
  }
  
  function syncTranslationUI() {
    const panel = $("#translation-panel");
    const wrap = $("#passage-wrap");
    const view = $("#view-practice");
    state.translation.on = true;
    const on = true;
    if (wrap) wrap.classList.add("translation-on");
    if (view) view.classList.add("translation-on");
    if (panel) panel.classList.remove("hidden");
    if (on) {
      const input = $("#translation-input");
      if (input && input.value !== (state.translation.typed || "")) input.value = state.translation.typed || "";
      if (input) placeTranslationCaret(input);
      fitTranslationInputHeight();
    }
    syncTranslationChips();
    renderTranslationStatus();
    syncTranslationNavButtons();
  }
  
  function flashTranslationError(msg) {
    const panel = $("#translation-panel");
    const hint = $("#translation-hint");
    if (panel) {
      panel.classList.remove("is-error");
      void panel.offsetWidth;
      panel.classList.add("is-error");
    }
    if (hint) hint.textContent = msg || "写错了，请改对再继续";
    clearTimeout(state.translation.errorTimer);
    state.translation.errorTimer = setTimeout(() => {
      panel?.classList.remove("is-error");
      renderTranslationStatus();
    }, 900);
    toast(msg || "写错了，请改对再继续");
  }
  
  function maybeAdvanceTranslation(spoken) {
    const q = currentQuestion();
    const groups = translationGroupsOf(q);
    if (!state.translation.on || !state.translation.done || !groups.length) return;
    const idx = state.translation.idx;
    const key = state.translation.questionKey;
    const isLast = idx >= groups.length - 1;
    const ttsOn = isTtsEnabled();
    persistCurrentTranslation();
    renderTranslationStatus();
    syncTranslationChips();
    syncTranslationNavButtons();

    const finishAdvance = () => {
      if (!state.translation.on) return;
      if (state.translation.idx !== idx || state.translation.questionKey !== key) return;
      if (!isLast) {
        moveTranslationGroup(1);
        return;
      }
      // 连题：本题最后一意群完成后默认进入下一题
      if (typeof moveQuestion === "function") {
        const moved = moveQuestion(1);
        toast(moved ? "本题完成，进入下一题" : "本题意群笔译全部完成（已是最后一题）");
        return;
      }
      toast("本题意群笔译全部完成");
    };

    clearTranslationAdvance();
    if (ttsOn) {
      Promise.resolve(spoken).catch(() => {}).then(() => {
        if (!state.translation.on || !state.translation.done) return;
        if (state.translation.idx !== idx || state.translation.questionKey !== key) return;
        return speech.playAll();
      }).then(() => {
        finishAdvance();
      }).catch(() => {
        toast("整段暂时读不出来");
        finishAdvance();
      });
    } else {
      // 关朗读时稍等片刻，让最后一个字符落定后再切，避免「刚输完就跳」
      state.translation.advanceTimer = setTimeout(finishAdvance, 600);
    }

    if (!isLast) toast(`第 ${idx + 1} 段译对了`);
  }
  
  function commitTranslationProgress(text, { doneToast = true } = {}) {
    const target = state.translation.target || "";
    const input = $("#translation-input");
    const prevTyped = state.translation.typed || "";
    const next = autoAppendDictationExtras(text, target);
    if (!state.translation.questionKey) {
      state.translation.questionKey = passageMarkKey(currentQuestion());
    }
    const wasDone = !!state.translation.done;
    state.translation.typed = next;
    state.translation.done = !!target && next === target;
    if (input && input.value !== next) input.value = next;
    placeTranslationCaret(input);
    noteDailyWordsFromProgress(prevTyped, next);
    const justDone = state.translation.done && !wasDone;
    const spoken = speakNewlyCompleted(prevTyped.length, next);
    persistCurrentTranslation();
    renderTranslationStatus();
    syncTranslationChips();
    fitTranslationInputHeight();
    if (doneToast && justDone) maybeAdvanceTranslation(spoken);
    return spoken;
  }
  
  function applyTranslationValue(raw) {
    if (!state.translation.on) return;
    const target = state.translation.target || "";
    const next = normalizeDictationText(raw);
    const input = $("#translation-input");
    if (next.toLowerCase() === (state.translation.typed || "").toLowerCase()) {
      if (input && input.value !== state.translation.typed) input.value = state.translation.typed;
      placeTranslationCaret(input);
      fitTranslationInputHeight();
      return;
    }
    let i = 0;
    const limit = Math.min(next.length, target.length);
    while (i < limit && sameDictationChar(next[i], target[i])) i += 1;
    const ok = target.slice(0, i);
    const overflow = next.length > target.length;
    const mismatch = next.length > i;
    if (mismatch) {
      state.translation.misses = (state.translation.misses || 0) + 1;
      const expected = overflow ? "" : target[i] || "";
      const got = next[i] || "";
      if (state.translation.misses >= 3 && expected) {
        state.translation.misses = 0;
        const spoken = commitTranslationProgress(ok + expected, { doneToast: false });
        const label = dictationCharLabel(expected);
        toast(state.translation.done ? `已帮你填入「${label}」` : `连续写错 3 次，已帮你填入「${label}」`);
        if (state.translation.done) maybeAdvanceTranslation(spoken);
      } else {
        if (!state.translation.questionKey) {
          state.translation.questionKey = passageMarkKey(currentQuestion());
        }
        state.translation.typed = ok;
        state.translation.done = false;
        if (input && input.value !== ok) input.value = ok;
        placeTranslationCaret(input);
        persistCurrentTranslation();
        const left = 3 - state.translation.misses;
        flashTranslationError(`${dictationErrorHint(expected, got)} · 再错 ${left} 次会提示`);
      }
    } else {
      state.translation.misses = 0;
      commitTranslationProgress(ok);
    }
  }
  
  function onTranslationInput(e) {
    if (!state.translation.on) return;
    if (e.isComposing || e.inputType === "insertCompositionText") return;
    applyTranslationValue(e.target.value);
  }
  
  function translationUnlockedIndex(groups = translationGroupsOf(currentQuestion())) {
    const key = state.translation.questionKey || passageMarkKey(currentQuestion());
    const saved = state.translationMemory?.[key]?.groups || {};
    const firstOpen = groups.findIndex((_, i) => !(i === state.translation.idx ? state.translation.done : saved[String(i)]?.done));
    return firstOpen < 0 ? Math.max(0, groups.length - 1) : firstOpen;
  }

  function translationReachableIndex(groups = translationGroupsOf(currentQuestion())) {
    // 当前所在段始终可回看；向前仍受「第一处未完成」限制
    return Math.max(translationUnlockedIndex(groups), Number(state.translation.idx) || 0);
  }

  function moveTranslationGroup(delta) {
    if (!state.translation.on) return;
    const q = currentQuestion();
    const groups = translationGroupsOf(q);
    if (!groups.length) return;
    if (!state.translation.questionKey) {
      state.translation.questionKey = passageMarkKey(q);
    }
    const next = (Number(state.translation.idx) || 0) + delta;
    if (next < 0 || next >= groups.length) return;
    // 只拦截「跳到尚未解锁的后面」；回上一个始终允许
    if (delta > 0 && next > translationUnlockedIndex(groups)) {
      toast("请先完成前面的意群");
      return;
    }
    persistCurrentTranslation();
    clearTranslationAdvance();
    loadTranslationGroup(q, next);
    persistCurrentTranslation();
    syncTranslationUI();
    setTimeout(() => $("#translation-input")?.focus(), 40);
  }

  function syncTranslationNavButtons() {
    const prevBtn = $("#btn-translation-prev");
    const nextBtn = $("#btn-translation-next");
    if (!prevBtn && !nextBtn) return;
    const groups = translationGroupsOf(currentQuestion());
    const n = groups.length;
    const i = Number(state.translation.idx) || 0;
    const unlocked = n ? translationUnlockedIndex(groups) : -1;
    if (prevBtn) prevBtn.disabled = !state.translation.on || !n || i <= 0;
    if (nextBtn) nextBtn.disabled = !state.translation.on || !n || i >= n - 1 || i >= unlocked;
  }

  function jumpTranslationGroup(transIdx) {
    if (!state.translation.on) return;
    const q = currentQuestion();
    const groups = translationGroupsOf(q);
    const n = groups.length;
    if (!n) return;
    const next = Math.max(0, Math.min(n - 1, Number(transIdx) || 0));
    if (!state.translation.questionKey) {
      state.translation.questionKey = passageMarkKey(q);
    }
    if (next === (Number(state.translation.idx) || 0)) return;
    persistCurrentTranslation();
    clearTranslationAdvance();
    loadTranslationGroup(q, next);
    persistCurrentTranslation();
    syncTranslationUI();
    setTimeout(() => $("#translation-input")?.focus(), 40);
  }

  function closeTranslationJumpDialog() {
    const dialog = $("#translation-jump-dialog");
    dialog?.classList.add("hidden");
  }

  function openTranslationJumpDialog() {
    if (!state.translation.on) return;
    const groups = translationGroupsOf(currentQuestion());
    const n = groups.length;
    if (!n) {
      toast("本题没有可笔译的意群");
      return;
    }
    const dialog = $("#translation-jump-dialog");
    const input = $("#translation-jump-input");
    const desc = $("#translation-jump-desc");
    if (!dialog || !input) return;
    const cur = Math.min((Number(state.translation.idx) || 0) + 1, n);
    if (desc) desc.textContent = `输入 1–${n} 之间的序号`;
    input.min = "1";
    input.max = String(n);
    input.value = String(cur);
    dialog.classList.remove("hidden");
    setTimeout(() => {
      input.focus();
      input.select();
    }, 40);
  }

  function confirmTranslationJump() {
    const groups = translationGroupsOf(currentQuestion());
    const n = groups.length;
    if (!n) {
      closeTranslationJumpDialog();
      return;
    }
    const input = $("#translation-jump-input");
    const raw = Number(input?.value);
    if (!Number.isFinite(raw) || raw < 1 || raw > n) {
      toast(`请输入 1–${n} 的意群序号`);
      input?.focus();
      input?.select();
      return;
    }
    closeTranslationJumpDialog();
    jumpTranslationGroup(Math.floor(raw) - 1);
  }

  function trySelectTranslationGroup(senseIdx) {
    const q = currentQuestion();
    const groups = translationGroupsOf(q);
    const transIdx = groups.findIndex((g) => g.idx === senseIdx);
    if (transIdx < 0) {
      toast("这一段没有英文可译");
      return;
    }
    if (!state.translation.questionKey) {
      state.translation.questionKey = passageMarkKey(q);
    }
    const reachable = translationReachableIndex(groups);
    if (transIdx > reachable) {
      toast("请先完成前面的意群");
      return;
    }
    persistCurrentTranslation();
    clearTranslationAdvance();
    loadTranslationGroup(q, transIdx);
    persistCurrentTranslation();
    syncTranslationUI();
    $("#translation-input")?.focus();
  }
  
  function clearCurrentTranslation() {
    if (!state.translation.on) return;
    const target = state.translation.target || "";
    clearTranslationAdvance();
    const next = autoAppendDictationExtras("", target);
    state.translation.typed = next;
    state.translation.done = !!target && next === target;
    state.translation.misses = 0;
    const input = $("#translation-input");
    if (input) {
      input.value = next;
      placeTranslationCaret(input);
    }
    persistCurrentTranslation();
    syncTranslationUI();
    toast(next ? "已清除当前意群，保留自动填充词" : "已清除当前意群");
    setTimeout(() => input?.focus(), 40);
  }

  function clearAllTranslation() {
    if (!state.translation.on) return;
    const key = state.translation.questionKey;
    const fromIdx = state.translation.idx;
    clearTranslationAdvance();
    if (key && state.translationMemory?.[key]) {
      const saved = state.translationMemory[key];
      const groups = { ...(saved.groups || {}) };
      Object.keys(groups).forEach((k) => {
        if (Number(k) >= fromIdx) delete groups[k];
      });
      const hasWork = Object.values(groups).some((g) => g && (g.typed || g.misses || g.done));
      if (!hasWork) {
        delete state.translationMemory[key];
      } else {
        state.translationMemory[key] = { ...saved, groups, idx: fromIdx, at: Date.now() };
      }
      saveTranslationMemory();
    }
    const target = state.translation.target || "";
    const next = autoAppendDictationExtras("", target);
    state.translation.typed = next;
    state.translation.done = !!target && next === target;
    state.translation.misses = 0;
    const input = $("#translation-input");
    if (input) {
      input.value = next;
      placeTranslationCaret(input);
    }
    persistCurrentTranslation();
    syncTranslationUI();
    toast("已清除往后意群");
    setTimeout(() => input?.focus(), 40);
  }

  function bindTranslation() {
    const input = $("#translation-input");
    const clearCurrentBtn = $("#btn-translation-clear-current");
    const clearAllBtn = $("#btn-translation-clear-all");
    const prevBtn = $("#btn-translation-prev");
    const nextBtn = $("#btn-translation-next");
    const dailyBtn = $("#btn-translation-daily");
    const dailyStatsBtn = $("#btn-translation-daily-stats");
    const playBtn = $("#btn-translation-play");
    const calDialog = $("#translation-words-calendar");
    const calGrid = $("#translation-cal-grid");
    syncPrefToggles();
    syncTranslationFoldUi();
    $("#btn-translation-fold")?.addEventListener("click", () => toggleTranslationFold());
    bindTtsSwitch();
    bindAnswerSwitch();
    bindAnswerStressFromChip();
    clearCurrentBtn?.addEventListener("click", () => clearCurrentTranslation());
    clearAllBtn?.addEventListener("click", () => clearAllTranslation());
    $("#btn-translation-jump-idx")?.addEventListener("click", () => openTranslationJumpDialog());
    $("#btn-translation-jump-cancel")?.addEventListener("click", () => closeTranslationJumpDialog());
    $("#btn-translation-jump-confirm")?.addEventListener("click", () => confirmTranslationJump());
    $("#translation-jump-dialog")?.addEventListener("click", (e) => {
      if (e.target === e.currentTarget) closeTranslationJumpDialog();
    });
    $("#translation-jump-input")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        confirmTranslationJump();
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeTranslationJumpDialog();
      }
    });
    prevBtn?.addEventListener("click", () => moveTranslationGroup(-1));
    nextBtn?.addEventListener("click", () => moveTranslationGroup(1));
    playBtn?.addEventListener("click", () => {
      if (!isTtsEnabled()) {
        toast("朗读已关闭");
        return;
      }
      speech.playAll().catch(() => toast("整段暂时读不出来"));
    });
    dailyBtn?.addEventListener("click", () => openWordsCalendar());
    dailyStatsBtn?.addEventListener("click", () => openWordsCalendar());
    $("#btn-translation-cal-close")?.addEventListener("click", () => closeWordsCalendar());
    $("#btn-translation-cal-share")?.addEventListener("click", () => {
      shareWordsCard().catch((err) => console.warn(err));
    });
    $("#translation-cal-prev")?.addEventListener("click", () => shiftCalMonth(-1));
    $("#translation-cal-next")?.addEventListener("click", () => shiftCalMonth(1));
    calDialog?.addEventListener("click", (e) => {
      if (e.target === calDialog) closeWordsCalendar();
    });
    calGrid?.addEventListener("click", (e) => {
      const cell = e.target.closest(".translation-cal-cell[data-date]");
      if (!cell) return;
      calSelectedKey = cell.dataset.date || "";
      renderWordsCalendar();
    });
    input?.addEventListener("input", (e) => {
      fitTranslationInputHeight();
      onTranslationInput(e);
    });
    input?.addEventListener("scroll", () => {
      const ghost = $("#translation-answer-ghost");
      if (ghost && input) ghost.scrollTop = input.scrollTop;
    });
    input?.addEventListener("focus", () => {
      fitTranslationInputHeight();
      placeTranslationCaret(input);
    });
    input?.addEventListener("pointerup", () => {
      requestAnimationFrame(() => {
        if (!input || input.selectionStart !== input.selectionEnd) return;
        placeTranslationCaret(input);
      });
    });
    input?.addEventListener("keydown", (e) => {
      if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
      // 练习页禁止回车换行 / 拆分意群
      if (e.key === "Enter") {
        e.preventDefault();
        return;
      }
      if (e.key.length !== 1) return;
      placeTranslationCaret(input);
    });
    input?.addEventListener("beforeinput", (e) => {
      if (e.inputType === "insertParagraph" || e.inputType === "insertLineBreak") {
        e.preventDefault();
      }
    });
    window.addEventListener("resize", () => {
      if (state.translation.on) fitTranslationInputHeight();
      scheduleFitTranslationLeadSize();
    });
    document.addEventListener("biyi-practice-fonts", () => scheduleFitTranslationLeadSize());
    if (document.fonts?.ready) {
      document.fonts.ready.then(() => scheduleFitTranslationLeadSize()).catch(() => {});
    }
    const leadEl = $("#translation-lead");
    const wrapEl = $("#passage-wrap");
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => scheduleFitTranslationLeadSize());
      if (wrapEl) ro.observe(wrapEl);
      if (leadEl) ro.observe(leadEl);
    }
    fitTranslationInputHeight();
    scheduleFitTranslationLeadSize();
    input?.addEventListener("compositionend", (e) => applyTranslationValue(e.target.value));
    input?.addEventListener("paste", (e) => {
      e.preventDefault();
      const text = e.clipboardData?.getData("text") || "";
      applyTranslationValue((state.translation.typed || "") + text);
    });
    // 光标进入笔译框 → 切系统英文输入法；离开则还原
    bindEnglishInputOnFocus(input);
    // 实体键盘 ↑/↓ = 笔译意群切换（等同点 ▲/▼）
    document.addEventListener("keydown", (e) => {
      if (!state.translation.on) return;
      if (e.isComposing) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      const practice = $("#view-practice");
      if (practice?.classList.contains("hidden")) return;
      const t = e.target;
      if (t && typeof t.matches === "function" && t.matches("input, select, textarea") && t.id !== "translation-input") {
        return;
      }
      // 日历等弹层打开时不抢方向键
      const wordsCal = $("#translation-words-calendar");
      if (wordsCal && !wordsCal.classList.contains("hidden")) return;
      e.preventDefault();
      e.stopPropagation();
      moveTranslationGroup(e.key === "ArrowUp" ? -1 : 1);
    });
  }

  syncTranslationFoldUi();

  return {
    translationGroupsOf,
    clearTranslationAdvance,
    persistCurrentTranslation,
    loadTranslationGroup,
    restoreTranslationFor,
    setTranslationOn,
    syncTranslationChips,
    renderTranslationStatus,
    fitTranslationLeadSize,
    scheduleFitTranslationLeadSize,
    syncTranslationUI,
    flashTranslationError,
    maybeAdvanceTranslation,
    commitTranslationProgress,
    applyTranslationValue,
    onTranslationInput,
    trySelectTranslationGroup,
    moveTranslationGroup,
    jumpTranslationGroup,
    clearCurrentTranslation,
    clearAllTranslation,
    closeWordsCalendar,
    bindTranslation,
  };
}
