/** 练习页录屏：只录 App 页面（不调用系统录屏），按所选分辨率/帧率合成保存 */

const PREFS_KEY = "pte_screen_record_prefs";

const RES_PRESETS = {
  "720p": { label: "1280×720", width: 1280, height: 720, videoBits: 2_000_000 },
  "1080p": { label: "1920×1080", width: 1920, height: 1080, videoBits: 4_000_000 },
  "1080x1920": { label: "1080×1920", width: 1080, height: 1920, videoBits: 4_000_000 },
  "1440p": { label: "2560×1440", width: 2560, height: 1440, videoBits: 6_500_000 },
};

const FPS_PRESETS = [15, 24, 30, 60];

/** 旧版「画质」选项 → 分辨率（兼容本地已存 prefs） */
const LEGACY_QUALITY_TO_RES = {
  "720p30": "720p",
  "1080p30": "1080p",
  "1080p60": "1080p",
  portrait30: "1080x1920",
  "1440p30": "1440p",
};

/**
 * 按设备内存/核心数自适应帧率（与录像一致，用户不再手选）。
 * navigator.deviceMemory 单位 GiB；iOS 常拿不到，再看核心数，再兜底 30。
 */
function pickAdaptiveFps(resKey = "1080p") {
  const mem = Number(navigator.deviceMemory) || 0;
  const cores = Number(navigator.hardwareConcurrency) || 0;
  const heavy = resKey === "1080p" || resKey === "1080x1920" || resKey === "1440p";
  let fps = 30;
  if (mem >= 8 || cores >= 8) fps = 60;
  else if (mem >= 4 || cores >= 6) fps = 30;
  else if (mem >= 2 || cores >= 4) fps = 24;
  else if (mem > 0 || cores > 0) fps = 15;
  if (heavy && fps >= 60) fps = 30;
  else if (heavy && fps === 30 && mem > 0 && mem < 4) fps = 24;
  if (resKey === "1440p" && fps > 30) fps = 30;
  return FPS_PRESETS.includes(fps) ? fps : 30;
}

const EN_FONT_PRESETS = {
  mono: {
    label: "等宽",
    // iOS 优先 Menlo / SF Mono；桌面再落到 Consolas
    stack: `Menlo, "SF Mono", ui-monospace, Consolas, "Courier New", monospace`,
    loadFamily: "Menlo",
  },
  georgia: {
    label: "Georgia",
    stack: `Georgia, "Iowan Old Style", "Times New Roman", serif`,
    loadFamily: "Georgia",
  },
  times: {
    label: "Times",
    stack: `"Times New Roman", Times, "Noto Serif", serif`,
    loadFamily: "Times New Roman",
  },
  palatino: {
    label: "Palatino",
    // iOS 只有 Palatino，没有 Palatino Linotype
    stack: `Palatino, "Palatino Linotype", "Book Antiqua", "Iowan Old Style", serif`,
    loadFamily: "Palatino",
  },
  italic: {
    label: "Italic",
    stack: `Palatino, "Palatino Linotype", "Book Antiqua", Georgia, serif`,
    loadFamily: "Palatino",
    style: "italic",
  },
  garamond: {
    label: "Garamond",
    // iOS 近似：Iowan Old Style
    stack: `"Iowan Old Style", Garamond, Palatino, Georgia, serif`,
    loadFamily: "Iowan Old Style",
  },
  cambria: {
    label: "Cambria",
    // iOS 近似：Charter
    stack: `Charter, Cambria, Georgia, serif`,
    loadFamily: "Charter",
  },
  calibri: {
    label: "Calibri",
    stack: `"Helvetica Neue", Helvetica, Calibri, Arial, sans-serif`,
    loadFamily: "Helvetica Neue",
  },
  verdana: {
    label: "Verdana",
    stack: `Verdana, Geneva, Tahoma, sans-serif`,
    loadFamily: "Verdana",
  },
  arial: {
    label: "Arial",
    stack: `Arial, "Helvetica Neue", Helvetica, sans-serif`,
    loadFamily: "Arial",
  },
};

function qualityLabel(res, fps) {
  const dim = RES_PRESETS[res]?.label || "1920×1080";
  const f = Number(fps) || pickAdaptiveFps(res);
  return `${dim} · ${f}`;
}

const LEAD_FONT_PRESETS = {
  fzxingkai: {
    label: "方正行楷",
    stack: `"方正行楷简体", "FZXingKaiJian", "FZXingKai-S04S", "华文行楷", "STXingkai", serif`,
    loadFamily: "方正行楷简体",
  },
  nidemingzi: {
    label: "你的名字",
    stack: `"你的名字 我的心跳", "NiDeMingZi WoDeXinTiao", "华文行楷", "STXingkai", serif`,
    loadFamily: "你的名字 我的心跳",
  },
  kaiti: {
    label: "楷体",
    stack: `"Kaiti SC", "STKaiti", "KaiTi", "华文楷体", serif`,
    loadFamily: "Kaiti SC",
  },
  songti: {
    label: "宋体",
    stack: `"Songti SC", "STSong", "SimSun", "宋体", serif`,
    loadFamily: "Songti SC",
  },
  heiti: {
    label: "黑体",
    stack: `"Heiti SC", "STHeiti", "SimHei", "Microsoft YaHei", sans-serif`,
    loadFamily: "Heiti SC",
  },
  pingfang: {
    label: "苹方",
    stack: `"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`,
  },
  yuanti: {
    label: "圆体",
    stack: `"Yuanti SC", "STYuanti", "YouYuan", sans-serif`,
    loadFamily: "Yuanti SC",
  },
};

/** 中文字号统一默认「中」，不再给客户选 */
const LEAD_SIZE_PRESETS = {
  m: { label: "中", rem: "1.55rem", scale: 0.058, minScale: 0.036, maxScale: 0.072 },
};

const DEFAULT_LEAD_SIZE_KEY = "m";

function normalizeLeadSizeKey(_key) {
  return DEFAULT_LEAD_SIZE_KEY;
}
const DEFAULT_EN_WRAP_PX = 54;
const EN_WRAP_PX_MIN = 24;
const EN_WRAP_PX_MAX = 200;
const DEFAULT_IDLE_SKIP_SEC = 3;
const IDLE_SKIP_SEC_MIN = 0;
const IDLE_SKIP_SEC_MAX = 120;

function clampEnWrapPx(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return DEFAULT_EN_WRAP_PX;
  return Math.min(EN_WRAP_PX_MAX, Math.max(EN_WRAP_PX_MIN, v));
}

function clampIdleSkipSec(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return DEFAULT_IDLE_SKIP_SEC;
  const clamped = Math.min(IDLE_SKIP_SEC_MAX, Math.max(IDLE_SKIP_SEC_MIN, v));
  // 最小步进 0.5
  return Math.round(clamped * 2) / 2;
}

function loadPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || "null");
    if (!raw || typeof raw !== "object") {
      return {
        res: "1080p",
        fps: pickAdaptiveFps("1080p"),
        wordsBadge: true,
        leadFont: "fzxingkai",
        leadSize: DEFAULT_LEAD_SIZE_KEY,
        enFont: "mono",
        enWrapPx: DEFAULT_EN_WRAP_PX,
        idleSkipSec: DEFAULT_IDLE_SKIP_SEC,
      };
    }
    const res = RES_PRESETS[raw.res] ? raw.res : "1080p";
    // 帧率始终按设备自适应，不再沿用旧 prefs 里的手选值
    const fps = pickAdaptiveFps(res);
    const wordsBadge = raw.wordsBadge !== false;
    const leadFont = LEAD_FONT_PRESETS[raw.leadFont] ? raw.leadFont : "fzxingkai";
    const leadSize = normalizeLeadSizeKey(raw.leadSize);
    const enFont = EN_FONT_PRESETS[raw.enFont] ? raw.enFont : "mono";
    const enWrapPx = clampEnWrapPx(raw.enWrapPx ?? DEFAULT_EN_WRAP_PX);
    const idleSkipSec = clampIdleSkipSec(raw.idleSkipSec ?? DEFAULT_IDLE_SKIP_SEC);
    return { res, fps, wordsBadge, leadFont, leadSize, enFont, enWrapPx, idleSkipSec };
  } catch (_) {
    return {
      res: "1080p",
      fps: pickAdaptiveFps("1080p"),
      wordsBadge: true,
      leadFont: "fzxingkai",
      leadSize: DEFAULT_LEAD_SIZE_KEY,
      enFont: "mono",
      enWrapPx: DEFAULT_EN_WRAP_PX,
      idleSkipSec: DEFAULT_IDLE_SKIP_SEC,
    };
  }
}

function savePrefs(prefs) {
  try {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({
        res: prefs.res,
        fps: prefs.fps,
        wordsBadge: !!prefs.wordsBadge,
        leadFont: prefs.leadFont,
        leadSize: normalizeLeadSizeKey(prefs.leadSize),
        enFont: prefs.enFont,
        enWrapPx: clampEnWrapPx(prefs.enWrapPx),
        idleSkipSec: clampIdleSkipSec(prefs.idleSkipSec),
      })
    );
  } catch (_) {}
}

const DAILY_WORDS_KEY = "pte_translation_daily_words";

function todayKeyDash() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function readDailyWordCount() {
  const el = document.getElementById("translation-daily-count");
  if (el) {
    const n = Math.floor(Number(el.textContent));
    if (Number.isFinite(n) && n >= 0) return n;
  }
  try {
    const raw = JSON.parse(localStorage.getItem(DAILY_WORDS_KEY) || "null");
    const days = raw?.days && typeof raw.days === "object" ? raw.days : null;
    if (days) {
      const n = Math.floor(Number(days[todayKeyDash()] || 0));
      return Number.isFinite(n) && n > 0 ? n : 0;
    }
    if (raw?.date === todayKeyDash()) {
      const n = Math.floor(Number(raw.count || 0));
      return Number.isFinite(n) && n > 0 ? n : 0;
    }
  } catch (_) {}
  return 0;
}

function paintWordsBadge(ctx, cw, ch, fontStack = "sans-serif") {
  const text = String(readDailyWordCount());
  const fontSize = Math.max(36, Math.round(Math.min(cw, ch) * 0.04));
  const margin = Math.round(Math.min(cw, ch) * 0.028);
  ctx.save();
  ctx.font = `600 ${fontSize}px ${fontStack}`;
  ctx.fillStyle = "#1f6f5b";
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.fillText(text, cw - margin, margin);
  ctx.restore();
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  const chars = String(text || "").split("");
  let line = "";
  let yy = y;
  for (const ch of chars) {
    const test = line + ch;
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, yy);
      line = ch;
      yy += lineHeight;
    } else line = test;
  }
  if (line) ctx.fillText(line, x, yy);
  return yy + (line ? lineHeight : 0);
}

/** 英文按词换行，避免把 coffee 拆成 c / offee */
function wrapTextSmart(ctx, text, x, y, maxWidth, lineHeight) {
  const raw = String(text || "");
  if (!raw) return y;
  // 含空格：按词；纯中文等：仍按字
  if (/\s/.test(raw)) {
    const words = raw.split(/(\s+)/);
    let line = "";
    let yy = y;
    for (const part of words) {
      const test = line + part;
      if (line && ctx.measureText(test).width > maxWidth) {
        ctx.fillText(line.replace(/\s+$/, ""), x, yy);
        yy += lineHeight;
        line = /^\s+$/.test(part) ? "" : part;
      } else line = test;
    }
    if (line.trim()) ctx.fillText(line.replace(/\s+$/, ""), x, yy);
    return yy + (line.trim() ? lineHeight : 0);
  }
  return wrapText(ctx, raw, x, y, maxWidth, lineHeight);
}

/** 单行最大字号：整段文字必须落在一行内 */
function fitSingleLineSize(ctx, text, maxWidth, fontFamily, weight, minSize, maxSize) {
  const t = String(text || "");
  if (!t) return Math.round((minSize + maxSize) / 2);
  let lo = minSize;
  let hi = maxSize;
  let best = minSize;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    ctx.font = `${weight} ${mid}px ${fontFamily}`;
    if (ctx.measureText(t).width <= maxWidth) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/**
 * 中文：永远单行（再小也不折行）
 * 英文：优先单行；若单行字号会低于临界点 enWrapPx，则保持临界字号并允许按词换行
 */
function fitLeadTypedSizes(
  ctx,
  cw,
  ch,
  lead,
  typed,
  leadFontStack,
  enWrapPx,
  enFontStack,
  enFontWeight = "500",
  leadSizeKey = DEFAULT_LEAD_SIZE_KEY
) {
  const preset = LEAD_SIZE_PRESETS[normalizeLeadSizeKey(leadSizeKey)] || LEAD_SIZE_PRESETS.m;
  const short = Math.min(cw, ch);
  const marginX = Math.round(cw * 0.045);
  const maxW = cw - marginX * 2;
  const titleSize = Math.max(32, Math.round(short * 0.036));
  const minSize = Math.max(28, Math.round(short * preset.minScale));
  const maxSize = Math.max(minSize + 4, Math.round(short * preset.maxScale));
  const criticalSize = clampEnWrapPx(enWrapPx);
  const enStack = enFontStack || EN_FONT_PRESETS.mono.stack;
  const enWeight = enFontWeight || "500";

  const leadText = String(lead || "").trim();
  const typedText = String(typed || "").trim();

  let bodySize = Math.round(short * preset.scale);
  let typedSize = Math.round(bodySize * 0.92);
  let typedWrap = false;

  if (leadText) {
    // 中文可略低于档位下限，也要单行塞下
    const zhFloor = Math.max(22, Math.round(short * 0.026));
    bodySize = fitSingleLineSize(ctx, leadText, maxW, leadFontStack, "500", zhFloor, maxSize);
  }

  if (typedText) {
    const oneLine = fitSingleLineSize(ctx, typedText, maxW, enStack, enWeight, Math.min(minSize, criticalSize), maxSize);
    ctx.font = `${enWeight} ${oneLine}px ${enStack}`;
    const fitsOne = ctx.measureText(typedText).width <= maxW;
    if (fitsOne && oneLine >= criticalSize) {
      typedSize = oneLine;
      typedWrap = false;
    } else if (fitsOne && oneLine < criticalSize) {
      // 单行只能很小 → 改用临界字号换行
      typedSize = criticalSize;
      typedWrap = true;
    } else {
      // 连最小单行都放不下
      typedSize = criticalSize;
      typedWrap = true;
    }
  } else if (leadText) {
    typedSize = Math.max(minSize, Math.round(bodySize * 0.9));
  }

  return {
    bodySize,
    typedSize,
    typedWrap,
    lineHeight: Math.round(bodySize * 1.35),
    typedLineHeight: Math.round(typedSize * 1.35),
    titleSize,
    marginX,
    maxW,
    enStack,
    enWeight,
  };
}

/** 轻量合成：只画练习要点，避免整页 DOM/SVG 克隆导致长录卡顿 */
function paintLiteAppFrame(ctx, cw, ch, opts = {}) {
  const {
    wordsBadge = true,
    leadFont = "fzxingkai",
    leadSize = DEFAULT_LEAD_SIZE_KEY,
    enFont = "mono",
    enWrapPx = DEFAULT_EN_WRAP_PX,
  } = opts;
  ctx.fillStyle = "#f4f1ea";
  ctx.fillRect(0, 0, cw, ch);

  const fontPreset = LEAD_FONT_PRESETS[leadFont] || LEAD_FONT_PRESETS.fzxingkai;
  const leadFontStack = fontPreset.stack;
  const enPreset = EN_FONT_PRESETS[enFont] || EN_FONT_PRESETS.mono;
  const enFontStack = enPreset.stack;
  const enFontWeight = enPreset.style === "italic" ? "italic 500" : "500";

  const qName = document.querySelector("#q-name")?.textContent?.replace(/\s+/g, " ").trim() || "";
  const leadEl = document.querySelector("#translation-lead");
  const lead = (leadEl?.textContent || "").trim();
  const typed = document.querySelector("#translation-input")?.value || "";
  const passage = document.querySelector("#passage")?.textContent?.replace(/\s+/g, " ").trim() || "";
  const zh = document.querySelector("#zh-text")?.textContent?.trim() || "";

  const fitLead = lead || (!typed ? zh : "");
  const fitTyped = typed || (lead ? "" : passage.slice(0, 160));
  const fitted = fitLeadTypedSizes(
    ctx,
    cw,
    ch,
    fitLead,
    fitTyped,
    leadFontStack,
    enWrapPx,
    enFontStack,
    enFontWeight,
    leadSize
  );
  const { bodySize, typedSize, typedWrap, lineHeight, typedLineHeight, titleSize, marginX, maxW, enStack, enWeight } = fitted;
  const marginTop = Math.round(ch * 0.04);

  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.font = `600 ${titleSize}px sans-serif`;
  ctx.fillStyle = "#1f6f5b";
  ctx.fillText("PTE终结者 · 每日记录", marginX, marginTop);

  let y = marginTop + titleSize + Math.round(titleSize * 0.75);

  if (qName) {
    const metaSize = Math.max(24, Math.round(Math.min(bodySize, typedSize) * 0.42));
    ctx.fillStyle = "rgba(34, 34, 34, 0.55)";
    ctx.font = `500 ${metaSize}px sans-serif`;
    // 题号允许换行无关紧要；正文中文不换行
    y = wrapText(ctx, qName, marginX, y, maxW, Math.round(metaSize * 1.25));
    y += Math.round(metaSize * 0.35);
  }

  if (lead || typed) {
    if (lead) {
      ctx.fillStyle = "#000000";
      ctx.font = `500 ${bodySize}px ${leadFontStack}`;
      // 中文：强制单行
      ctx.fillText(lead, marginX, y);
      y += lineHeight + Math.round(bodySize * 0.18);
    }
    ctx.font = `${enWeight} ${typedSize}px ${enStack}`;
    if (typed) {
      ctx.fillStyle = "#222";
      if (typedWrap) wrapTextSmart(ctx, typed, marginX, y, maxW, typedLineHeight);
      else ctx.fillText(typed, marginX, y);
    } else {
      ctx.fillStyle = "#000000";
      ctx.fillText("...", marginX, y);
    }
  } else {
    if (zh) {
      ctx.fillStyle = "#000000";
      ctx.font = `500 ${bodySize}px ${leadFontStack}`;
      ctx.fillText(zh, marginX, y);
      y += lineHeight + Math.round(bodySize * 0.2);
    }
    if (passage) {
      ctx.fillStyle = "#222";
      ctx.font = `${enWeight} ${typedSize}px ${enStack}`;
      const clip = passage.length > 600 ? `${passage.slice(0, 600)}…` : passage;
      if (typedWrap) wrapTextSmart(ctx, clip, marginX, y, maxW, typedLineHeight);
      else if (ctx.measureText(clip).width <= maxW) ctx.fillText(clip, marginX, y);
      else wrapTextSmart(ctx, clip, marginX, y, maxW, typedLineHeight);
    }
  }

  if (wordsBadge) paintWordsBadge(ctx, cw, ch, leadFontStack);
}

function pickMime() {
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return "";
  // 只要 MP4（H.264 + AAC），不要 webm
  const list = [
    "video/mp4;codecs=avc1.42001E,mp4a.40.2",
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4;codecs=avc1.4D401F,mp4a.40.2",
    "video/mp4;codecs=avc1,mp4a.40.2",
    "video/mp4;codecs=h264,aac",
    "video/mp4",
  ];
  return list.find((t) => MediaRecorder.isTypeSupported(t)) || "video/mp4";
}

function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function blobToBase64(blob, { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (e) => {
      if (!onProgress || !e.lengthComputable || !e.total) return;
      try {
        onProgress(Math.min(1, e.loaded / e.total));
      } catch (_) {}
    };
    reader.onload = () => {
      try {
        onProgress?.(1);
      } catch (_) {}
      const s = String(reader.result || "");
      const i = s.indexOf(",");
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    reader.onerror = () => reject(reader.error || new Error("read fail"));
    reader.readAsDataURL(blob);
  });
}

/** iOS 上 FileReader.onprogress 经常不回调，按块读再拼 base64，才能显示真实进度 */
async function blobToBase64WithProgress(blob, { onProgress, chunkSize = 256 * 1024 } = {}) {
  const size = Math.max(1, Number(blob?.size) || 1);
  const bytes = new Uint8Array(size);
  let offset = 0;
  while (offset < size) {
    const end = Math.min(size, offset + chunkSize);
    const part = await blob.slice(offset, end).arrayBuffer();
    bytes.set(new Uint8Array(part), offset);
    offset = end;
    onProgress?.(Math.min(0.72, (offset / size) * 0.72));
    await yieldUI();
  }
  onProgress?.(0.74);
  await yieldUI();

  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  const total = bytes.length;
  const yieldEvery = Math.max(3 * 512, Math.floor(total / 50) * 3 || 3);
  for (let i = 0; i < total; i += 3) {
    const a = bytes[i];
    const b = i + 1 < total ? bytes[i + 1] : 0;
    const c = i + 2 < total ? bytes[i + 2] : 0;
    const triple = (a << 16) | (b << 8) | c;
    const pad = i + 1 >= total ? 2 : i + 2 >= total ? 1 : 0;
    out += alphabet[(triple >> 18) & 63];
    out += alphabet[(triple >> 12) & 63];
    out += pad === 2 ? "=" : alphabet[(triple >> 6) & 63];
    out += pad >= 1 ? "=" : alphabet[triple & 63];
    if (i > 0 && i % yieldEvery < 3) {
      onProgress?.(0.74 + Math.min(0.26, ((i + 3) / total) * 0.26));
      await yieldUI();
    }
  }
  onProgress?.(1);
  return out;
}

function yieldUI() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });
}

const DRAFT_DB = "pte-screen-record";
const DRAFT_STORE = "draft";
const DRAFT_KEY = "current";

function openDraftDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("no idb"));
      return;
    }
    const req = indexedDB.open(DRAFT_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DRAFT_STORE)) db.createObjectStore(DRAFT_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("idb open fail"));
  });
}

function idbPutDraft(payload) {
  return openDraftDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(DRAFT_STORE, "readwrite");
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error("idb put fail"));
        tx.objectStore(DRAFT_STORE).put(payload, DRAFT_KEY);
      })
  );
}

function idbGetDraft() {
  return openDraftDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(DRAFT_STORE, "readonly");
        const req = tx.objectStore(DRAFT_STORE).get(DRAFT_KEY);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error || new Error("idb get fail"));
      })
  );
}

function idbClearDraft() {
  return openDraftDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(DRAFT_STORE, "readwrite");
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error("idb clear fail"));
        tx.objectStore(DRAFT_STORE).delete(DRAFT_KEY);
      })
  );
}

async function blobsToBuffers(blobs) {
  const out = [];
  for (const b of blobs) {
    if (!b) continue;
    try {
      out.push(await (b instanceof Blob ? b.arrayBuffer() : new Blob([b]).arrayBuffer()));
    } catch (_) {}
  }
  return out;
}

/** 多段独立 MediaRecorder 产物无法直接拼接，经 canvas 重编码成一段 MP4 */
async function remuxVideoSegments(
  segments,
  { width, height, fps, videoBits, mime = "video/mp4", onProgress, force = false } = {}
) {
  const list = (segments || []).filter((b) => b && b.size > 0);
  if (!list.length) return null;
  // force：单段也重编码，确保系统相册能导入（原始 MediaRecorder 碎片常被 Photos 拒收）
  if (list.length === 1 && !force) {
    onProgress?.(1);
    return list[0];
  }

  const canvas = document.createElement("canvas");
  canvas.width = width || 1920;
  canvas.height = height || 1080;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("no canvas");

  const stream = canvas.captureStream(Math.max(1, Number(fps) || 30));
  const video = document.createElement("video");
  video.playsInline = true;
  video.setAttribute("playsinline", "");
  video.setAttribute("webkit-playsinline", "");
  video.muted = true;
  const opts = { videoBitsPerSecond: videoBits || 4_000_000 };
  if (mime) opts.mimeType = mime;
  let recorder;
  try {
    recorder = new MediaRecorder(stream, opts);
  } catch (_) {
    recorder = new MediaRecorder(stream, { videoBitsPerSecond: opts.videoBitsPerSecond });
  }

  const outChunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) outChunks.push(e.data);
  };
  const stopped = new Promise((resolve) => {
    recorder.onstop = () => resolve();
  });
  recorder.start(400);

  const total = list.length;
  let lastReport = 0;

  try {
    for (let i = 0; i < list.length; i++) {
      const blob = list[i];
      const url = URL.createObjectURL(blob);
      try {
        video.src = url;
        await new Promise((resolve, reject) => {
          const onMeta = () => {
            video.removeEventListener("loadedmetadata", onMeta);
            video.removeEventListener("error", onErr);
            resolve();
          };
          const onErr = () => {
            video.removeEventListener("loadedmetadata", onMeta);
            video.removeEventListener("error", onErr);
            reject(new Error("segment load fail"));
          };
          video.addEventListener("loadedmetadata", onMeta);
          video.addEventListener("error", onErr);
          video.load();
        });
        video.currentTime = 0;
        try {
          await video.play();
        } catch (err) {
          throw err;
        }
        await new Promise((resolve) => {
          let raf = 0;
          const tick = () => {
            if (video.ended || video.paused) {
              if (raf) cancelAnimationFrame(raf);
              resolve();
              return;
            }
            try {
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            } catch (_) {}
            const dur = Number(video.duration);
            const t = Number(video.currentTime);
            if (onProgress && Number.isFinite(dur) && dur > 0) {
              const p = (i + Math.min(1, Math.max(0, t / dur))) / total;
              if (p - lastReport >= 0.02 || p >= 0.99) {
                lastReport = p;
                try {
                  onProgress(p);
                } catch (_) {}
              }
            }
            raf = requestAnimationFrame(tick);
          };
          const onEnded = () => {
            video.removeEventListener("ended", onEnded);
            if (raf) cancelAnimationFrame(raf);
            resolve();
          };
          video.addEventListener("ended", onEnded);
          raf = requestAnimationFrame(tick);
        });
        try {
          video.pause();
        } catch (_) {}
        onProgress?.((i + 1) / total);
      } finally {
        try {
          URL.revokeObjectURL(url);
        } catch (_) {}
        video.removeAttribute("src");
        try {
          video.load();
        } catch (_) {}
      }
    }
  } finally {
    try {
      if (recorder.state !== "inactive") recorder.stop();
    } catch (_) {}
    try {
      stream.getTracks().forEach((t) => t.stop());
    } catch (_) {}
  }

  await stopped;
  if (!outChunks.length) throw new Error("remux empty");
  onProgress?.(1);
  return new Blob(outChunks, { type: "video/mp4" });
}

export function createScreenRecord({ $ = (sel) => document.querySelector(sel), toast = () => {} } = {}) {
  const prefs = loadPrefs();
  const state = {
    recording: false,
    paused: false,
    composed: false,
    saving: false,
    res: prefs.res,
    fps: prefs.fps,
    wordsBadge: prefs.wordsBadge !== false,
    leadFont: prefs.leadFont || "fzxingkai",
    leadSize: normalizeLeadSizeKey(prefs.leadSize),
    enFont: EN_FONT_PRESETS[prefs.enFont] ? prefs.enFont : "mono",
    enWrapPx: clampEnWrapPx(prefs.enWrapPx ?? DEFAULT_EN_WRAP_PX),
    idleSkipSec: clampIdleSkipSec(prefs.idleSkipSec ?? DEFAULT_IDLE_SKIP_SEC),
    composeStream: null,
    recorder: null,
    chunks: [],
    /** 跨会话追加时，已封存的完整片段（各自可独立播放） */
    sealedSegments: [],
    blob: null,
    url: null,
    canvas: null,
    drawTimer: 0,
    startedAt: 0,
    elapsedMs: 0,
    segmentStartedAt: 0,
    tickTimer: 0,
    mime: "",
    dirty: true,
    drawing: false,
    _litePainted: false,
    mo: null,
    firstArticle: "",
    lastArticle: "",
    /** 空闲时 MediaRecorder.pause，成片跳过无操作时段 */
    idlePaused: false,
    idleTimer: 0,
    lastActivityAt: 0,
  };

  const ui = {
    toggle: $("[data-screen-record]"),
    timer: $("[data-screen-record-timer]"),
    qualityEl: $("[data-screen-quality]"),
    floatEl: $("[data-screen-record-float]"),
    floatTimer: $("[data-screen-record-float-timer]"),
    floatMeta: $("[data-screen-record-float-meta]"),
    btnResume: $("[data-screen-record-resume]"),
    btnSave: $("[data-screen-record-save]"),
    btnDiscard: $("[data-screen-record-discard]"),
    tip: $("[data-screen-record-tip]"),
    progressEl: $("[data-screen-record-progress]"),
    progressLabel: $("[data-screen-record-progress-label]"),
    progressTrack: $("[data-screen-record-progress-track]"),
    progressFill: $("[data-screen-record-progress-fill]"),
    progressPct: $("[data-screen-record-progress-pct]"),
    wordsBadgeEl: $("[data-screen-words-badge]"),
    leadFontEl: $("[data-screen-lead-font]"),
    enFontEl: $("[data-screen-en-font]"),
    enWrapEl: $("[data-screen-en-wrap]"),
    idleSkipEl: $("[data-screen-idle-skip]"),
    setupDialog: $("#screen-setup-dialog"),
    setupCancel: $("#btn-screen-setup-cancel"),
    setupConfirm: $("#btn-screen-setup-confirm"),
  };

  function setTip(msg) {
    if (ui.tip) ui.tip.textContent = msg || "";
  }

  function syncOpts() {
    if (ui.qualityEl) {
      const key = RES_PRESETS[state.res]
        ? state.res
        : LEGACY_QUALITY_TO_RES[ui.qualityEl.value] || "1080p";
      ui.qualityEl.value = RES_PRESETS[key] ? key : "1080p";
    }
    if (ui.wordsBadgeEl) ui.wordsBadgeEl.value = state.wordsBadge ? "1" : "0";
    if (ui.leadFontEl) {
      ui.leadFontEl.value = state.leadFont;
      ui.leadFontEl._syncFontPick?.();
    }
    if (ui.enFontEl) {
      ui.enFontEl.value = state.enFont;
      ui.enFontEl._syncFontPick?.();
    }
    if (ui.enWrapEl) ui.enWrapEl.value = String(clampEnWrapPx(state.enWrapPx));
    if (ui.idleSkipEl) ui.idleSkipEl.value = formatIdleSkipValue(state.idleSkipSec);
    applyPracticeFonts();
  }

  /** 练习页意群中文 / 英文跟随下方字体选择 */
  function applyPracticeFonts() {
    const lead = LEAD_FONT_PRESETS[state.leadFont] || LEAD_FONT_PRESETS.fzxingkai;
    const size = LEAD_SIZE_PRESETS[normalizeLeadSizeKey(state.leadSize)] || LEAD_SIZE_PRESETS.m;
    const en = EN_FONT_PRESETS[state.enFont] || EN_FONT_PRESETS.mono;
    const root = document.documentElement;
    const enStyle = en.style === "italic" ? "italic" : "normal";
    root.style.setProperty("--practice-lead-font", lead.stack);
    root.style.setProperty("--practice-lead-size", size.rem);
    root.style.setProperty("--practice-en-font", en.stack);
    root.style.setProperty("--practice-en-font-style", enStyle);
    root.dataset.practiceEnFont = state.enFont;
    root.dataset.practiceLeadFont = state.leadFont;
    // iOS WKWebView：button 经常不继承父级 font-family/CSS 变量，直接写到节点
    const enNodes = document.querySelectorAll(
      "#sense-block .sense-en, #sense-block .sense-en .en-tap-word, #sense-block .sense-en .en-tap-sep, " +
        "#en-full-block, #en-full-block .en-tap-word, #en-full-block .en-tap-sep"
    );
    enNodes.forEach((el) => {
      el.style.fontFamily = en.stack;
      el.style.fontStyle = enStyle;
    });
    document.querySelectorAll("#sense-block .sense-zh").forEach((el) => {
      el.style.fontFamily = lead.stack;
    });
    document.dispatchEvent(new Event("biyi-practice-fonts"));
  }

  function readOpts() {
    if (ui.qualityEl) {
      const raw = ui.qualityEl.value;
      const res = RES_PRESETS[raw]
        ? raw
        : LEGACY_QUALITY_TO_RES[raw] || state.res || "1080p";
      state.res = RES_PRESETS[res] ? res : "1080p";
      state.fps = pickAdaptiveFps(state.res);
    }
    if (ui.wordsBadgeEl) state.wordsBadge = ui.wordsBadgeEl.value !== "0";
    if (ui.leadFontEl && LEAD_FONT_PRESETS[ui.leadFontEl.value]) state.leadFont = ui.leadFontEl.value;
    state.leadSize = DEFAULT_LEAD_SIZE_KEY;
    if (ui.enFontEl && EN_FONT_PRESETS[ui.enFontEl.value]) state.enFont = ui.enFontEl.value;
    if (ui.enWrapEl) state.enWrapPx = clampEnWrapPx(ui.enWrapEl.value);
    if (ui.idleSkipEl) state.idleSkipSec = clampIdleSkipSec(ui.idleSkipEl.value);
    savePrefs(state);
  }

  function setOptsDisabled(on) {
    if (ui.qualityEl) ui.qualityEl.disabled = !!on;
    // 字体、英文换行临界录中也可改，立刻反映到成片
  }

  function liveElapsedSec() {
    let ms = state.elapsedMs || 0;
    // 空闲跳过时 segmentStartedAt=0，计时冻结；有输入 resume 后再累加
    if (state.recording && !state.idlePaused && state.segmentStartedAt) {
      ms += Date.now() - state.segmentStartedAt;
    }
    return Math.max(0, ms / 1000);
  }

  function syncToggle() {
    const on = state.recording;
    const paused = state.paused;
    if (ui.toggle) {
      ui.toggle.classList.toggle("is-recording", on && !state.idlePaused);
      ui.toggle.classList.toggle("is-paused", (paused && !on) || state.idlePaused);
      ui.toggle.setAttribute("aria-pressed", on || paused ? "true" : "false");
      const label = ui.toggle.querySelector("[data-screen-record-label]");
      if (on && state.idlePaused) {
        if (label) label.textContent = "暂停";
        ui.toggle.setAttribute("aria-label", "自动暂停中");
        ui.toggle.title = "自动暂停中（计时已停）；再输入会继续";
      } else if (on) {
        if (label) label.textContent = "暂停";
        ui.toggle.setAttribute("aria-label", "暂停录屏");
        ui.toggle.title = "暂停录屏（会悬浮保留）";
      } else if (paused) {
        if (label) label.textContent = "继续";
        ui.toggle.setAttribute("aria-label", "继续录屏");
        ui.toggle.title = "继续录屏";
      } else {
        if (label) label.textContent = "录屏";
        ui.toggle.setAttribute("aria-label", "开始录屏");
        ui.toggle.title = "开始录屏";
      }
    }
    if (ui.timer) {
      const show = on || paused;
      ui.timer.hidden = !show;
      if (!show) ui.timer.textContent = "0:00";
      else ui.timer.textContent = fmtTime(liveElapsedSec());
    }
  }

  function hasDraftData() {
    return !!(state.blob || state.chunks.length || state.sealedSegments.length);
  }

  /** 半成品数据在但未标 paused 时，补回暂停态，避免「删不了也存不了」 */
  function healOrphanDraft() {
    if (state.recording || state.saving || state.composed || state.paused) return false;
    if (!hasDraftData()) return false;
    state.paused = true;
    setOptsDisabled(true);
    return true;
  }

  function mountFloatOnBody() {
    if (!ui.floatEl || !document.body) return;
    if (ui.floatEl.parentElement !== document.body) {
      document.body.appendChild(ui.floatEl);
    }
  }

  function syncFloat() {
    if (!ui.floatEl) return;
    mountFloatOnBody();
    healOrphanDraft();
    const show = state.paused || state.composed || state.saving;
    ui.floatEl.hidden = !show;
    ui.floatEl.classList.toggle("is-paused", !!state.paused && !state.saving);
    ui.floatEl.classList.toggle("is-composed", !!state.composed && !state.saving);
    ui.floatEl.classList.toggle("is-saving", !!state.saving);
    if (ui.floatTimer) ui.floatTimer.textContent = fmtTime(liveElapsedSec());
    if (ui.floatMeta) {
      const segN = Math.max(
        1,
        state.sealedSegments.filter((b) => b && b.size > 0).length + (state.chunks.length ? 1 : 0)
      );
      if (state.saving) ui.floatMeta.textContent = "正在保存到本地";
      else ui.floatMeta.textContent = `${qualityLabel(state.res, state.fps)} · 第${segN}段`;
    }
    if (ui.btnResume) {
      ui.btnResume.hidden = !state.paused || state.composed || state.saving;
    }
    if (ui.btnSave) {
      ui.btnSave.hidden = !(state.paused || state.composed) || state.saving;
      ui.btnSave.disabled = state.saving || (state.composed && !state.blob);
    }
    if (ui.btnDiscard) ui.btnDiscard.disabled = state.saving || state.recording;
    if (ui.progressEl) ui.progressEl.hidden = !state.saving;
  }

  function setSaveProgress(pct, label) {
    const n = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
    if (ui.progressFill) ui.progressFill.style.width = `${n}%`;
    if (ui.progressPct) ui.progressPct.textContent = `${n}%`;
    if (ui.progressTrack) ui.progressTrack.setAttribute("aria-valuenow", String(n));
    if (label && ui.progressLabel) ui.progressLabel.textContent = label;
    if (ui.floatMeta && state.saving) ui.floatMeta.textContent = label || "正在保存到本地";
  }

  async function beginSaveProgress(label = "正在保存到本地…") {
    state.saving = true;
    mountFloatOnBody();
    if (ui.floatEl) {
      ui.floatEl.hidden = false;
      ui.floatEl.classList.add("is-saving");
    }
    if (ui.progressEl) ui.progressEl.hidden = false;
    setSaveProgress(2, label);
    syncFloat();
    await yieldUI();
  }

  function endSaveProgress() {
    state.saving = false;
    if (ui.progressEl) ui.progressEl.hidden = true;
    if (ui.floatEl) ui.floatEl.classList.remove("is-saving");
    setSaveProgress(0, "正在保存到本地…");
    syncFloat();
  }

  function tick() {
    const t = fmtTime(liveElapsedSec());
    if (ui.timer && (state.recording || state.paused)) ui.timer.textContent = t;
    if (ui.floatTimer && (state.paused || state.composed)) ui.floatTimer.textContent = t;
  }

  function liveElapsedForPersist() {
    let ms = state.elapsedMs || 0;
    if (state.recording && !state.idlePaused && state.segmentStartedAt) {
      ms += Date.now() - state.segmentStartedAt;
    }
    return Math.max(0, ms);
  }

  function clearDraw() {
    if (state.drawTimer) {
      clearInterval(state.drawTimer);
      state.drawTimer = 0;
    }
  }

  function clearTick() {
    if (state.tickTimer) {
      clearInterval(state.tickTimer);
      state.tickTimer = 0;
    }
  }

  async function ensureNamedFont(family, style = "") {
    if (!family || !document.fonts?.load) return;
    try {
      const face = style ? `${style} ` : "";
      await document.fonts.load(`${face}500 64px "${family}"`);
      await document.fonts.ready;
    } catch (_) {}
  }

  async function ensureLeadFontLoaded(fontKey = state.leadFont) {
    const preset = LEAD_FONT_PRESETS[fontKey] || LEAD_FONT_PRESETS.fzxingkai;
    const family = preset.loadFamily || (preset.stack.match(/"([^"]+)"/) || [])[1];
    await ensureNamedFont(family);
  }

  async function ensureEnFontLoaded(fontKey = state.enFont) {
    const preset = EN_FONT_PRESETS[fontKey] || EN_FONT_PRESETS.mono;
    const family = preset.loadFamily || (preset.stack.match(/"([^"]+)"/) || [])[1];
    if (!family || !document.fonts?.load) return;
    const style = preset.style === "italic" ? "italic " : "";
    try {
      await document.fonts.load(`${style}500 64px "${family}"`);
      await document.fonts.ready;
    } catch (_) {}
  }

  function stopTracks(stream) {
    try {
      stream?.getTracks?.().forEach((t) => {
        try {
          t.stop();
        } catch (_) {}
      });
    } catch (_) {}
  }

  function clearBlob() {
    if (state.url) {
      try {
        URL.revokeObjectURL(state.url);
      } catch (_) {}
    }
    state.url = null;
    state.blob = null;
    state.chunks = [];
    state.sealedSegments = [];
  }

  function sealCurrentChunks() {
    if (!state.chunks.length) return;
    const type = state.mime || "video/mp4";
    try {
      state.sealedSegments.push(new Blob(state.chunks, { type }));
    } catch (_) {}
    state.chunks = [];
  }

  function collectSegmentBlobs() {
    const type = state.mime || "video/mp4";
    const list = state.sealedSegments.filter((b) => b && b.size > 0);
    if (state.chunks.length) {
      try {
        list.push(new Blob(state.chunks, { type }));
      } catch (_) {}
    }
    return list;
  }

  let persistTimer = 0;
  let persisting = false;

  async function clearPersistedDraft() {
    try {
      await idbClearDraft();
    } catch (_) {}
  }

  async function persistDraft() {
    if (persisting) return;
    const hasChunks = state.chunks.length > 0;
    const hasSealed = state.sealedSegments.some((b) => b && b.size > 0);
    const hasBlob = !!(state.blob && state.blob.size);
    if (!hasChunks && !hasSealed && !hasBlob) {
      await clearPersistedDraft();
      return;
    }
    if (!state.recording && !state.paused && !state.composed) {
      await clearPersistedDraft();
      return;
    }
    persisting = true;
    try {
      let buffers = await blobsToBuffers(state.chunks);
      if (!buffers.length && !hasSealed && hasBlob) {
        buffers = await blobsToBuffers([state.blob]);
      }
      const sealed = await blobsToBuffers(state.sealedSegments);
      if (!buffers.length && !sealed.length) return;
      await idbPutDraft({
        v: 2,
        savedAt: Date.now(),
        mime: state.mime || "video/mp4",
        res: state.res,
        fps: state.fps,
        elapsedMs: liveElapsedForPersist(),
        firstArticle: state.firstArticle || "",
        lastArticle: state.lastArticle || "",
        composed: !!state.composed,
        chunks: buffers,
        sealed,
      });
    } catch (err) {
      console.warn("persist screen draft", err);
    } finally {
      persisting = false;
    }
  }

  function schedulePersistDraft() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistDraft().catch(() => {});
    }, 1800);
  }

  async function restorePersistedDraft() {
    let raw;
    try {
      raw = await idbGetDraft();
    } catch (_) {
      return false;
    }
    if (!raw) return false;
    const mime = raw.mime || "video/mp4";
    const chunkBufs = Array.isArray(raw.chunks) ? raw.chunks : [];
    const sealedBufs = Array.isArray(raw.sealed) ? raw.sealed : [];
    if (!chunkBufs.length && !sealedBufs.length) return false;
    state.chunks = chunkBufs.map((buf) => new Blob([buf], { type: mime }));
    state.sealedSegments = sealedBufs.map((buf) => new Blob([buf], { type: mime }));
    state.mime = mime;
    if (RES_PRESETS[raw.res]) state.res = raw.res;
    if (FPS_PRESETS.includes(Number(raw.fps))) state.fps = Number(raw.fps);
    state.elapsedMs = Math.max(0, Number(raw.elapsedMs) || 0);
    state.segmentStartedAt = 0;
    state.firstArticle = raw.firstArticle || "";
    state.lastArticle = raw.lastArticle || "";
    state.recording = false;
    state.saving = false;
    state.recorder = null;
    state.composeStream = null;
    state.canvas = null;
    if (raw.composed) {
      state.composed = true;
      state.paused = true;
      sealCurrentChunks();
      const segs = (state.sealedSegments || []).filter((b) => b && b.size > 0);
      state.blob = segs[segs.length - 1] || null;
      if (state.url) {
        try {
          URL.revokeObjectURL(state.url);
        } catch (_) {}
      }
      state.url = state.blob ? URL.createObjectURL(state.blob) : null;
    } else {
      state.composed = false;
      state.paused = true;
      clearBlobKeepChunks();
    }
    syncOpts();
    setOptsDisabled(true);
    syncToggle();
    syncFloat();
    setTip(
      state.composed
        ? "已恢复上次成品，可「保存」到本地或「删除」"
        : "已恢复上次半成品：可「继续」（每继续一次多一段）或直接「保存」按段导出"
    );
    toast(state.composed ? "已恢复上次录屏成品" : "已恢复上次录屏半成品");
    return true;
  }

  function clearBlobKeepChunks() {
    if (state.url) {
      try {
        URL.revokeObjectURL(state.url);
      } catch (_) {}
    }
    state.url = null;
    state.blob = null;
  }

  async function flushRecorderData() {
    const rec = state.recorder;
    if (!rec || rec.state === "inactive") return;
    try {
      rec.requestData?.();
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 120));
  }

  async function checkpointOnLeave() {
    try {
      if (state.recording) {
        await flushRecorderData();
        // 退到后台时硬收束，避免录到黑帧且便于落盘
        await pauseRecord({ silent: true });
      } else if (state.paused || state.composed) {
        await persistDraft();
      }
    } catch (err) {
      console.warn("checkpoint screen draft", err);
    }
  }

  function idleSkipMs() {
    return clampIdleSkipSec(state.idleSkipSec) * 1000;
  }

  function idleSkipLabel() {
    const sec = clampIdleSkipSec(state.idleSkipSec);
    if (sec <= 0) return "已关闭自动暂停";
    const text = Number.isInteger(sec) ? String(sec) : sec.toFixed(1);
    return `${text}s 无操作自动暂停`;
  }

  function formatIdleSkipValue(sec) {
    const n = clampIdleSkipSec(sec);
    return Number.isInteger(n) ? String(n) : n.toFixed(1);
  }

  function clearIdleTimer() {
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = 0;
    }
  }

  function leaveIdleSkip() {
    if (!state.idlePaused) return;
    state.idlePaused = false;
    const rec = state.recorder;
    if (state.recording && !state.paused && rec && rec.state === "paused") {
      state.dirty = true;
      try {
        drawFrame();
      } catch (_) {}
      try {
        rec.resume();
      } catch (err) {
        console.warn("idle resume", err);
      }
      state.segmentStartedAt = Date.now();
      setTip(`正在录制（${qualityLabel(state.res, state.fps)}）· ${idleSkipLabel()}`);
      syncToggle();
      tick();
    }
  }

  async function enterIdleSkip() {
    if (!state.recording || state.paused || state.saving || state.idlePaused) return;
    if (idleSkipMs() <= 0) return;
    const rec = state.recorder;
    if (!rec || rec.state !== "recording" || typeof rec.pause !== "function") return;
    if (state.segmentStartedAt) {
      state.elapsedMs += Date.now() - state.segmentStartedAt;
      state.segmentStartedAt = 0;
    }
    if (!state.recording || state.paused || rec.state !== "recording") return;
    try {
      rec.pause();
    } catch (err) {
      console.warn("idle pause", err);
      return;
    }
    state.idlePaused = true;
    setTip(`自动暂停中（画面与计时已停）· 再输入会自动继续`);
    syncToggle();
    tick();
  }

  function armIdleSkip() {
    clearIdleTimer();
    if (!state.recording || state.paused || state.saving) return;
    const ms = idleSkipMs();
    if (ms <= 0) return;
    state.idleTimer = setTimeout(() => {
      state.idleTimer = 0;
      enterIdleSkip();
    }, ms);
  }

  function bumpActivity() {
    state.lastActivityAt = Date.now();
    if (state.idlePaused) leaveIdleSkip();
    armIdleSkip();
  }

  function markDirty() {
    state.dirty = true;
    noteArticleTitle();
    if (state.recording && !state.paused) bumpActivity();
  }

  function onIdleActivityEvent() {
    if (state.recording && !state.paused && !state.saving) bumpActivity();
  }

  function bindIdleActivityListeners() {
    document.addEventListener("pointerdown", onIdleActivityEvent, true);
    document.addEventListener("keydown", onIdleActivityEvent, true);
    document.addEventListener("input", onIdleActivityEvent, true);
  }

  function unbindIdleActivityListeners() {
    document.removeEventListener("pointerdown", onIdleActivityEvent, true);
    document.removeEventListener("keydown", onIdleActivityEvent, true);
    document.removeEventListener("input", onIdleActivityEvent, true);
  }

  function sanitizeArticleTitle(s) {
    return String(s || "")
      .replace(/[\/\\:\*\?"<>|\n\r\t]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 72);
  }

  function readArticleTitle() {
    const titleEl = document.querySelector("#q-name .q-title-text");
    const fromTitle = titleEl?.textContent?.replace(/\s+/g, " ").trim() || "";
    if (fromTitle) return fromTitle;
    const raw = document.querySelector("#q-name")?.textContent?.replace(/\s+/g, " ").trim() || "";
    return raw.replace(/^#\s*\d+\s*/, "").trim() || raw;
  }

  function noteArticleTitle() {
    if (!state.recording && !state.paused && !state.composed) return;
    const t = sanitizeArticleTitle(readArticleTitle());
    if (!t) return;
    if (!state.firstArticle) state.firstArticle = t;
    state.lastArticle = t;
  }

  function isIdleNoiseNode(node) {
    let el = node;
    if (!el) return true;
    if (el.nodeType === 3) el = el.parentElement;
    if (!el || el.nodeType !== 1) return true;
    return !!el.closest(
      "[data-screen-record-timer], [data-screen-record-tip], [data-screen-record-float], .screen-record-float, .screen-opts, .hint-line, .voice-record-icon-timer, [data-camera-float], .camera-float"
    );
  }

  function onCaptureMutations(mutations) {
    for (const m of mutations) {
      if (!isIdleNoiseNode(m.target)) {
        markDirty();
        return;
      }
      if (m.addedNodes) {
        for (const n of m.addedNodes) {
          if (!isIdleNoiseNode(n)) {
            markDirty();
            return;
          }
        }
      }
      if (m.removedNodes) {
        for (const n of m.removedNodes) {
          if (!isIdleNoiseNode(n)) {
            markDirty();
            return;
          }
        }
      }
    }
  }

  function bindCaptureWatchers() {
    try {
      state.mo?.disconnect();
    } catch (_) {}
    // 只盯练习区；计时器/提示文案每 250ms 会变，必须忽略，否则空闲跳过永远触发不了
    const roots = [
      document.getElementById("translation-panel"),
      document.getElementById("translation-lead"),
      document.getElementById("translation-progress"),
      document.getElementById("translation-daily-count"),
      document.getElementById("passage"),
      document.getElementById("zh-text"),
      document.getElementById("q-name"),
    ].filter(Boolean);
    if (roots.length && typeof MutationObserver !== "undefined") {
      state.mo = new MutationObserver(onCaptureMutations);
      for (const root of roots) {
        try {
          state.mo.observe(root, {
            subtree: true,
            childList: true,
            characterData: true,
            attributes: false,
          });
        } catch (_) {}
      }
    }
    document.addEventListener("input", markDirty, true);
  }

  function unbindCaptureWatchers() {
    try {
      state.mo?.disconnect();
    } catch (_) {}
    state.mo = null;
    document.removeEventListener("input", markDirty, true);
  }

  function paintIntervalMs() {
    // 和 captureStream 同频。静止时也要按这个间隔送帧，否则成片比计时短
    const fps = Math.max(1, Number(state.fps) || 30);
    return Math.max(16, Math.round(1000 / fps));
  }

  function startPaintLoop() {
    clearDraw();
    state.dirty = true;
    ensureLeadFontLoaded().then(() => {
      state.dirty = true;
      drawFrame();
    });
    drawFrame();
    state.drawTimer = setInterval(() => drawFrame(), paintIntervalMs());
  }

  function setRecordingClass(on) {
    document.documentElement.classList.toggle("pte-screen-recording", !!on);
    document.body?.classList.toggle("pte-screen-recording", !!on);
  }

  function drawFrame() {
    if (!state.recording || !state.canvas || state.drawing) return;
    // 空闲跳过时 recorder 已 pause，无需继续往成片里堆静止帧
    if (state.idlePaused) return;
    const canvas = state.canvas;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;
    state.drawing = true;
    try {
      if (state.dirty || !state._litePainted) {
        paintLiteAppFrame(ctx, canvas.width, canvas.height, {
          wordsBadge: state.wordsBadge,
          leadFont: state.leadFont,
          leadSize: state.leadSize,
          enFont: state.enFont,
          enWrapPx: state.enWrapPx,
        });
        state.dirty = false;
        state._litePainted = true;
      } else {
        // 画面没变也画一像素，captureStream 才会继续出帧，静止时间才进成片
        ctx.fillStyle = "#f4f1ea";
        ctx.fillRect(0, 0, 1, 1);
      }
    } finally {
      state.drawing = false;
    }
  }

  async function startRecord() {
    if (state.recording || state.saving) return;
    if (healOrphanDraft()) {
      syncToggle();
      syncFloat();
      toast("有未保存半成品，请先「保存」或「删除」");
      setTip("悬浮条可「继续 / 保存 / 删除」");
      return;
    }
    if (state.paused) {
      await resumeRecord();
      return;
    }
    if (state.composed || hasDraftData()) {
      syncFloat();
      toast("请先保存或删除当前半成品");
      setTip("底部悬浮条可「保存」或「删除」后再开新录屏");
      return;
    }
    await beginCaptureSession({ continueSession: false });
  }

  /** 创建画布 + MediaRecorder 并开始录；continueSession 时保留已录时长/篇名/封存片段 */
  async function beginCaptureSession({ continueSession = false } = {}) {
    if (typeof MediaRecorder === "undefined") {
      setTip("当前环境不支持录屏编码");
      toast("不支持录屏");
      return false;
    }

    readOpts();
    state.fps = pickAdaptiveFps(state.res);
    const preset = RES_PRESETS[state.res] || RES_PRESETS["1080p"];
    const fps = state.fps;

    try {
      document.dispatchEvent(new CustomEvent("pte-screen-record-start"));
    } catch (_) {}

    if (!continueSession) {
      clearBlob();
      await clearPersistedDraft();
      state.elapsedMs = 0;
      state.firstArticle = "";
      state.lastArticle = "";
    }

    toast(continueSession ? "正在继续录制…" : "正在开始录制 App 页面…");
    setTip("准备中…");

    const canvas = document.createElement("canvas");
    canvas.width = preset.width;
    canvas.height = preset.height;
    const composeStream = canvas.captureStream(fps);

    const mime = pickMime();
    state.mime = mime.startsWith("video/mp4") ? mime : "video/mp4";

    let recorder;
    const tryMake = (type) => {
      const opts = { videoBitsPerSecond: preset.videoBits };
      if (type) opts.mimeType = type;
      return new MediaRecorder(composeStream, opts);
    };
    try {
      recorder = tryMake(state.mime);
    } catch (_) {
      try {
        recorder = tryMake("video/mp4");
      } catch (err2) {
        console.warn(err2);
        stopTracks(composeStream);
        setTip("当前环境不支持 MP4 录制，请用 Safari 打开");
        toast("需要支持 MP4 的浏览器（建议 Safari）");
        return false;
      }
    }

    const actualMime = String(recorder.mimeType || state.mime || "");
    if (actualMime && !/mp4|avc1|h264/i.test(actualMime) && /webm/i.test(actualMime)) {
      try {
        recorder.stop();
      } catch (_) {}
      stopTracks(composeStream);
      setTip("当前浏览器只能录 WebM，已取消。请用 Safari 录制 MP4");
      toast("请用 Safari 录制 MP4");
      return false;
    }
    state.mime = actualMime.includes("mp4") ? actualMime : "video/mp4";

    state.canvas = canvas;
    state.composeStream = composeStream;
    state.recorder = recorder;
    state.chunks = [];
    state.dirty = true;
    state._litePainted = false;
    state.paused = false;
    state.composed = false;
    state.recording = true;
    state.startedAt = Date.now();
    state.segmentStartedAt = Date.now();
    noteArticleTitle();
    setRecordingClass(true);
    setOptsDisabled(true);
    syncToggle();
    syncFloat();
    setTip(
      continueSession
        ? `已继续录制（${qualityLabel(state.res, state.fps)}）· ${idleSkipLabel()}`
        : `正在录制 MP4（${qualityLabel(state.res, state.fps)}）· ${idleSkipLabel()}`
    );
    toast(continueSession ? "已继续录屏" : "MP4 录屏已开始");

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        state.chunks.push(e.data);
        schedulePersistDraft();
      }
    };
    recorder.onerror = (e) => {
      console.warn("screen MediaRecorder error", e?.error || e);
      if (state.recording || state.paused) setTip("录屏出错，可暂停后删除重录");
    };

    try {
      recorder.start(1000);
    } catch (err) {
      console.warn(err);
      await cleanupStreams();
      state.recording = false;
      if (!continueSession) setOptsDisabled(false);
      else {
        state.paused = true;
        setOptsDisabled(true);
      }
      syncToggle();
      syncFloat();
      setTip("无法开始录屏");
      toast("无法开始录屏");
      return false;
    }

    bindCaptureWatchers();
    bindIdleActivityListeners();
    startPaintLoop();
    clearTick();
    tick();
    state.tickTimer = setInterval(tick, 250);
    schedulePersistDraft();
    bumpActivity();
    return true;
  }

  function pauseCaptureLoops() {
    clearIdleTimer();
    state.idlePaused = false;
    clearDraw();
    clearTick();
    unbindCaptureWatchers();
    unbindIdleActivityListeners();
    setRecordingClass(false);
  }

  function resumeCaptureLoops() {
    setRecordingClass(true);
    noteArticleTitle();
    bindCaptureWatchers();
    bindIdleActivityListeners();
    startPaintLoop();
    clearTick();
    tick();
    state.tickTimer = setInterval(tick, 250);
    bumpActivity();
  }

  async function cleanupStreams() {
    clearIdleTimer();
    state.idlePaused = false;
    pauseCaptureLoops();
    stopTracks(state.composeStream);
    state.composeStream = null;
    state.canvas = null;
    state.recorder = null;
    state._litePainted = false;
  }

  /** 正式 stop MediaRecorder，等最后一块 data 进 chunks（相册需要完整收尾的 MP4） */
  async function stopRecorderFully() {
    const rec = state.recorder;
    if (!rec || rec.state === "inactive") return;
    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) state.chunks.push(e.data);
      };
      rec.onstop = () => {
        // onstop 后偶发还有最后一包，稍等再结束
        setTimeout(done, 80);
      };
      try {
        rec.requestData?.();
      } catch (_) {}
      try {
        if (rec.state === "recording" || rec.state === "paused") rec.stop();
        else done();
      } catch (_) {
        done();
      }
      setTimeout(done, 2500);
    });
  }

  async function pauseRecord({ silent = false } = {}) {
    if (!state.recording || state.saving) return;
    clearIdleTimer();
    // 空闲跳过时 recorder 已是 paused，先并入已录时长再正式 stop
    if (state.idlePaused) {
      state.idlePaused = false;
    } else if (state.segmentStartedAt) {
      state.elapsedMs += Date.now() - state.segmentStartedAt;
      state.segmentStartedAt = 0;
    }
    try {
      // 正式 stop 收尾完整 MP4；按段直存相册，不做慢速合并
      await stopRecorderFully();
    } catch (err) {
      console.warn(err);
      if (!silent) toast("暂停失败");
      return;
    }
    sealCurrentChunks();
    await cleanupStreams();
    state.recording = false;
    state.paused = true;
    state.composed = false;
    setOptsDisabled(true);
    syncToggle();
    syncFloat();
    await persistDraft();
    const segN = state.sealedSegments.filter((b) => b && b.size > 0).length;
    if (!silent) {
      setTip(
        segN > 1
          ? `已暂停（${segN} 段）；「继续」开新段，保存时按段直存相册`
          : "已暂停；「继续」开新段，保存时按段直存相册（不转码）"
      );
      toast(segN > 1 ? `已暂停（已有 ${segN} 段）` : "已暂停");
    } else {
      setTip("已收束存本地（应用进入后台）");
    }
  }

  async function resumeRecord() {
    if (!state.paused || state.composed || state.saving) return;
    // 暂停时已 stop 并封段，继续一律新开一段（直出完整 MP4，保存按段导出）
    if (state.recorder) {
      try {
        await stopRecorderFully();
      } catch (_) {}
      sealCurrentChunks();
      await cleanupStreams();
    } else {
      sealCurrentChunks();
    }
    await persistDraft();
    const n = state.sealedSegments.filter((b) => b && b.size > 0).length + 1;
    toast(`已开新段（将保存为 ${n} 段文件）`);
    await beginCaptureSession({ continueSession: true });
  }

  function assembleBlobFromChunks() {
    const type = "video/mp4";
    const segs = collectSegmentBlobs();
    if (!segs.length) return null;
    const blob = segs.length === 1 ? segs[0] : new Blob(segs, { type });
    if (state.url) {
      try {
        URL.revokeObjectURL(state.url);
      } catch (_) {}
    }
    state.blob = blob;
    state.mime = "video/mp4";
    state.url = URL.createObjectURL(blob);
    return blob;
  }

  async function assembleFinalBlob({ remuxIfNeeded = true, onProgress } = {}) {
    const segs = collectSegmentBlobs();
    if (!segs.length) return null;
    let blob;
    if (segs.length === 1 || !remuxIfNeeded) {
      onProgress?.(0.35);
      blob = segs.length === 1 ? segs[0] : new Blob(segs, { type: "video/mp4" });
      onProgress?.(0.55);
    } else {
      const preset = RES_PRESETS[state.res] || RES_PRESETS["1080p"];
      blob = await remuxVideoSegments(segs, {
        width: preset.width,
        height: preset.height,
        fps: state.fps,
        videoBits: preset.videoBits,
        mime: state.mime || "video/mp4",
        onProgress: (p) => onProgress?.(0.15 + Math.min(1, p) * 0.4),
      });
    }
    if (!blob) return null;
    if (state.url) {
      try {
        URL.revokeObjectURL(state.url);
      } catch (_) {}
    }
    state.blob = blob;
    state.mime = "video/mp4";
    state.url = URL.createObjectURL(blob);
    // 合成后收成一段，便于再次落盘
    state.sealedSegments = [blob];
    state.chunks = [];
    onProgress?.(0.58);
    return blob;
  }

  /** 收束录制：每段 stop 收尾的完整 MP4；不合并、默认不转码 */
  async function finalizeSegmentsForSave({ onProgress } = {}) {
    onProgress?.(0.05);
    if (state.recording) {
      await pauseRecord({ silent: true });
    } else if (state.recorder && state.recorder.state !== "inactive") {
      try {
        await stopRecorderFully();
      } catch (_) {}
      sealCurrentChunks();
      await cleanupStreams();
    } else {
      sealCurrentChunks();
    }
    onProgress?.(0.2);
    const segs = (state.sealedSegments || []).filter((b) => b && b.size > 64);
    if (!segs.length) return [];
    state.sealedSegments = segs;
    state.chunks = [];
    state.blob = segs[segs.length - 1] || null;
    if (state.url) {
      try {
        URL.revokeObjectURL(state.url);
      } catch (_) {}
    }
    state.url = state.blob ? URL.createObjectURL(state.blob) : null;
    state.mime = "video/mp4";
    state.composed = true;
    state.paused = true;
    state.recording = false;
    onProgress?.(0.28);
    return segs;
  }

  /** @deprecated 兼容；保存流程改走 finalizeSegmentsForSave，不再拼接 */
  function composeMp4({ silent = false, onProgress } = {}) {
    if (state.saving && !silent) return Promise.resolve();
    return finalizeSegmentsForSave({ onProgress }).then((segs) => {
      const blob = segs[segs.length - 1] || null;
      if (!silent) {
        setOptsDisabled(false);
        syncToggle();
        syncFloat();
        if (blob) {
          const n = segs.length;
          setTip(n > 1 ? `已就绪 ${n} 段，点「保存」将分别导出` : "已就绪，点「保存」导出到本地");
          toast(n > 1 ? `共 ${n} 段，将分别保存` : "已就绪，点「保存」导出到本地");
          persistDraft().catch(() => {});
        } else {
          setTip("没有录到内容");
          toast("没有录到内容");
          state.composed = false;
          clearPersistedDraft().catch(() => {});
        }
      }
      return blob;
    });
  }

  async function discardDraft() {
    if (state.saving) return;
    if (state.recording) {
      // 先停再丢
      try {
        if (state.recorder && state.recorder.state !== "inactive") {
          await new Promise((resolve) => {
            const rec = state.recorder;
            rec.onstop = () => resolve();
            try {
              rec.stop();
            } catch (_) {
              resolve();
            }
            setTimeout(resolve, 800);
          });
        }
      } catch (_) {}
    } else if (state.paused && state.recorder && state.recorder.state !== "inactive") {
      await new Promise((resolve) => {
        const rec = state.recorder;
        rec.onstop = () => resolve();
        try {
          rec.stop();
        } catch (_) {
          resolve();
        }
        setTimeout(resolve, 800);
      });
    }
    await cleanupStreams();
    clearBlob();
    state.chunks = [];
    state.sealedSegments = [];
    state.recording = false;
    state.paused = false;
    state.composed = false;
    state.elapsedMs = 0;
    state.segmentStartedAt = 0;
    state.firstArticle = "";
    state.lastArticle = "";
    setOptsDisabled(false);
    syncToggle();
    syncFloat();
    resetFloatPos();
    await clearPersistedDraft();
    setTip("点「录屏」先选选项再开始；再点暂停 → 悬浮条「保存」到本地");
    toast("已删除半成品");
  }

  /** @deprecated 兼容旧调用：改为暂停保留半成品 */
  function stopRecord() {
    return pauseRecord();
  }

  function openSetupDialog() {
    syncOpts();
    if (!ui.setupDialog) {
      startRecord().catch((err) => console.warn(err));
      return;
    }
    ui.setupDialog.classList.remove("hidden");
  }

  function closeSetupDialog() {
    ui.setupDialog?.classList.add("hidden");
  }

  function confirmSetup() {
    readOpts();
    closeSetupDialog();
    startRecord().catch((err) => {
      console.warn(err);
      toast(err?.message || "无法开始录屏");
    });
  }

  async function toggle() {
    if (state.saving) return;
    if (healOrphanDraft()) {
      syncToggle();
      syncFloat();
    }
    if (state.recording) {
      await pauseRecord();
      return;
    }
    if (state.paused) {
      // 暂停时再点开关：提示看悬浮条，避免误触继续
      syncFloat();
      toast("已暂停：可保存 / 继续 / 删除");
      setTip("「保存」按段直存相册；「继续」会新开一段");
      return;
    }
    if (state.composed) {
      toast("请先保存或删除当前成品");
      syncFloat();
    } else openSetupDialog();
  }

  function fileName() {
    noteArticleTitle();
    const a = state.firstArticle || sanitizeArticleTitle(readArticleTitle()) || "笔译";
    const b = state.lastArticle || a;
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    const date = `${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
    return `${a}~${b}-${date}.mp4`;
  }

  function openSavedVideo(blob, mime) {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    let host = document.querySelector("[data-screen-record-preview]");
    if (!host) {
      host = document.createElement("div");
      host.setAttribute("data-screen-record-preview", "");
      host.style.cssText =
        "position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:1.25rem;";
      host.addEventListener("click", (e) => {
        if (e.target === host) {
          try {
            URL.revokeObjectURL(url);
          } catch (_) {}
          host.remove();
        }
      });
      document.body.appendChild(host);
    } else {
      host.replaceChildren();
      host.hidden = false;
    }
    const video = document.createElement("video");
    video.src = url;
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    if (mime) video.type = mime;
    video.style.cssText = "max-width:min(960px,96vw);max-height:86vh;border-radius:12px;background:#000;box-shadow:0 12px 40px rgba(0,0,0,.45);";
    host.appendChild(video);
    try {
      video.play?.();
    } catch (_) {}
  }

  function triggerDownload(blob, name) {
    const dlUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = dlUrl;
    a.download = name;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => {
      try {
        URL.revokeObjectURL(dlUrl);
      } catch (_) {}
    }, 60_000);
  }

  /** 大视频不能一次 writeFile 整段 base64（Cap 桥接易截断 → Unable to save file），按块 append */
  async function writeBlobChunked(FS, blob, path, directory, onProgress) {
    const total = Math.max(1, Number(blob?.size) || 0);
    if (!total) throw new Error("空视频，无法写入");
    const CHUNK = 160 * 1024;
    let offset = 0;
    let first = true;
    while (offset < total) {
      const end = Math.min(total, offset + CHUNK);
      let b64 = await blobToBase64(blob.slice(offset, end));
      b64 = String(b64 || "").replace(/\s+/g, "");
      if (!b64) throw new Error("视频编码失败");
      if (first) {
        await FS.writeFile({ path, data: b64, directory, recursive: true });
        first = false;
      } else {
        await FS.appendFile({ path, data: b64, directory });
      }
      offset = end;
      onProgress?.(Math.min(0.95, offset / total));
      await yieldUI();
    }
    onProgress?.(1);
    const uriRes = await FS.getUri({ path, directory });
    const uri = uriRes?.uri || "";
    if (!uri) throw new Error("无法取得文件路径");
    return { uri, directory, path };
  }

  async function writeSegmentToDocuments(FS, blob, path, onProgress) {
    const dirs = ["CACHE", "DOCUMENTS"];
    let lastErr = null;
    for (const directory of dirs) {
      try {
        if (directory === "DOCUMENTS") {
          try {
            await FS.mkdir({ path: "pte-videos", directory: "DOCUMENTS", recursive: true });
          } catch (_) {}
        }
        return await writeBlobChunked(FS, blob, path, directory, onProgress);
      } catch (err) {
        lastErr = err;
        console.warn("writeBlobChunked", directory, err);
      }
    }
    throw lastErr || new Error("Unable to save file");
  }

  async function saveBlobToAlbum(Media, FS, blob, partName, { onProgress, allowRemux = true } = {}) {
    const path = `pte-videos/${partName}`;
    let current = blob;
    let lastErr = null;
    let lastUri = "";

    const trySave = async (label) => {
      onProgress?.(label);
      const written = await writeSegmentToDocuments(FS, current, path, (p) => {
        onProgress?.(`写入本地 ${Math.round((Number(p) || 0) * 100)}%`);
      });
      lastUri = written.uri;
      if (!Media?.saveVideo) throw new Error("Media 插件不可用");

      try {
        await Media.saveVideo({ path: written.uri, fileName: partName.replace(/\.mp4$/i, "") });
        return true;
      } catch (err) {
        lastErr = err;
        console.warn("saveVideo uri", err);
      }

      try {
        const Share = window.Capacitor?.Plugins?.Share;
        if (Share?.share) {
          await Share.share({
            title: partName,
            url: written.uri,
            dialogTitle: "保存录屏",
          });
          return true;
        }
      } catch (err) {
        lastErr = err;
        console.warn("Share.share", err);
      }
      return false;
    };

    try {
      if (await trySave("正在写入…")) return { ok: true, blob: current, uri: lastUri };
    } catch (err) {
      lastErr = err;
      console.warn("trySave", err);
    }

    if (allowRemux) {
      onProgress?.("正在转码以便相册识别…");
      const preset = RES_PRESETS[state.res] || RES_PRESETS["1080p"];
      try {
        const remuxed = await remuxVideoSegments([current], {
          width: preset.width,
          height: preset.height,
          fps: state.fps,
          videoBits: Math.min(preset.videoBits, 2_500_000),
          mime: "video/mp4",
          force: true,
          onProgress: (p) => onProgress?.(`转码中 ${Math.round((Number(p) || 0) * 100)}%`),
        });
        if (remuxed && remuxed.size > 64) {
          current = remuxed;
          if (await trySave("转码完成，再次保存…")) return { ok: true, blob: current, uri: lastUri };
        }
      } catch (err) {
        lastErr = err;
        console.warn("remux", err);
      }
    }

    const msg = String(lastErr?.message || lastErr || "保存失败");
    return { ok: false, blob: current, error: msg, uri: lastUri };
  }

  async function saveLocal() {
    if (state.saving) return;
    if (state.recording) {
      toast("请先暂停录屏再保存");
      setTip("请先暂停，再点「保存」");
      return;
    }
    if (!state.blob && !(state.paused || state.chunks.length || state.sealedSegments.length)) {
      toast("没有可保存的内容");
      setTip("请先录屏，暂停后再点「保存」");
      syncFloat();
      return;
    }

    const report = async (pct, label) => {
      setSaveProgress(pct, label);
      setTip(label);
      await yieldUI();
    };

    try {
      await beginSaveProgress("正在保存…");
      await report(8, "正在收束录制…");
      const segs = await finalizeSegmentsForSave({
        onProgress: (p) => setSaveProgress(8 + Math.min(1, Number(p) || 0) * 12, "正在收束录制…"),
      });
      if (!segs.length) {
        toast("没有可保存的内容");
        setTip("请先录屏，暂停后再点「保存」");
        return;
      }

      const Cap = window.Capacitor;
      const FS = Cap?.Plugins?.Filesystem;
      const Media = Cap?.Plugins?.Media;
      const isNative = !!(Cap?.isNativePlatform && Cap.isNativePlatform());
      const mime = "video/mp4";
      const total = segs.length;
      const named = fileName();
      const base = named.replace(/\.mp4$/i, "");
      const label = base;

      if (isNative && FS?.writeFile) {
        let savedAlbum = 0;
        const albumFail = [];
        const outSegs = [];

        for (let i = 0; i < total; i++) {
          const partName = total <= 1 ? `${base}.mp4` : `${base}-${i + 1}of${total}.mp4`;
          const basePct = 22 + (i / total) * 70;
          await report(
            basePct,
            total > 1 ? `正在保存第 ${i + 1}/${total} 段…` : "正在保存到相册…"
          );

          const result = await saveBlobToAlbum(Media, FS, segs[i], partName, {
            allowRemux: true,
            onProgress: (msg) => {
              setSaveProgress(basePct + 35 / total, msg || "保存中…");
              setTip(msg || "保存中…");
            },
          });
          outSegs.push(result.blob || segs[i]);
          if (result.ok) {
            savedAlbum += 1;
          } else {
            albumFail.push({
              n: i + 1,
              err: result.error || "未知错误",
            });
          }
        }

        await report(100, "保存完成");
        if (outSegs.length) openSavedVideo(outSegs[outSegs.length - 1], mime);

        if (savedAlbum === total) {
          setTip(total > 1 ? `已保存 ${total} 段到相册：${label}` : `已保存到相册：${label}`);
          toast(total > 1 ? `已保存 ${total} 段到相册` : "已保存到相册");
          await clearAfterSave();
        } else if (savedAlbum > 0) {
          const detail = albumFail.map((f) => `#${f.n}`).join("、");
          setTip(`已保存 ${savedAlbum}/${total} 段到相册；失败 ${detail}。半成品仍保留，可再点「保存」重试`);
          toast(`部分成功：${savedAlbum}/${total} 段进相册`);
          state.sealedSegments = outSegs;
          state.blob = outSegs[outSegs.length - 1] || null;
          state.paused = true;
          state.composed = true;
          syncFloat();
          persistDraft().catch(() => {});
        } else {
          const err0 = albumFail[0]?.err || "相册写入失败";
          const denied = /Access to photos|not allowed|权限|denied/i.test(err0);
          setTip(
            denied
              ? "相册权限未开：请到 设置 → 笔译训练 → 照片 → 选「添加照片」后再点保存"
              : `相册未写入（${err0}）。半成品仍在，可再点「保存」。也可在「文件 → 笔译训练 → pte-videos」查看副本`
          );
          toast(denied ? "请先允许写入相册" : "相册保存失败，可重试");
          state.sealedSegments = outSegs;
          state.blob = outSegs[outSegs.length - 1] || null;
          state.paused = true;
          state.composed = true;
          syncFloat();
          persistDraft().catch(() => {});
        }
        return;
      }

      for (let i = 0; i < total; i++) {
        const partName = total <= 1 ? `${base}.mp4` : `${base}-${i + 1}of${total}.mp4`;
        await report(30 + ((i + 1) / total) * 60, total > 1 ? `正在下载第 ${i + 1}/${total} 段` : "正在触发下载…");
        triggerDownload(segs[i], partName);
        await new Promise((r) => setTimeout(r, 280));
      }
      openSavedVideo(segs[segs.length - 1], mime);
      await report(100, "保存完成");
      setTip(total > 1 ? `已触发 ${total} 段下载` : `已保存到下载`);
      toast(total > 1 ? `已导出 ${total} 段` : "已保存到本地");
      await clearAfterSave();
    } catch (err) {
      const msg = String(err?.message || err);
      if (/AbortError|canceled|cancelled/i.test(msg)) setTip("已取消保存");
      else {
        console.warn(err);
        setTip(msg || "保存失败，请再试一次");
        toast("保存失败");
      }
      state.paused = true;
      state.composed = !!state.blob || state.sealedSegments.length > 0;
      setOptsDisabled(true);
      syncToggle();
      syncFloat();
    } finally {
      endSaveProgress();
    }
  }

  async function clearAfterSave() {
    clearBlob();
    state.chunks = [];
    state.sealedSegments = [];
    state.composed = false;
    state.paused = false;
    state.elapsedMs = 0;
    state.firstArticle = "";
    state.lastArticle = "";
    if (ui.floatEl) ui.floatEl.hidden = true;
    resetFloatPos();
    setOptsDisabled(false);
    syncToggle();
    await clearPersistedDraft();
    setTip("点「录屏」先选选项再开始；再点暂停 → 悬浮条「保存」到本地");
  }

  function clampFloatPos(left, top, width, height) {
    const pad = 8;
    const maxL = Math.max(pad, window.innerWidth - width - pad);
    const maxT = Math.max(pad, window.innerHeight - height - pad);
    return {
      left: Math.min(maxL, Math.max(pad, left)),
      top: Math.min(maxT, Math.max(pad, top)),
    };
  }

  function resetFloatPos() {
    if (!ui.floatEl) return;
    ui.floatEl.classList.remove("is-placed", "is-dragging");
    ui.floatEl.style.left = "";
    ui.floatEl.style.top = "";
    ui.floatEl.style.right = "";
    ui.floatEl.style.bottom = "";
    ui.floatEl.style.transform = "";
  }

  function bindFloatDrag() {
    const el = ui.floatEl;
    if (!el || el.dataset.dragBound === "1") return;
    el.dataset.dragBound = "1";
    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let origL = 0;
    let origT = 0;
    let pointerId = null;

    const endDrag = (e) => {
      if (!dragging) return;
      if (pointerId != null && e.pointerId != null && e.pointerId !== pointerId) return;
      dragging = false;
      el.classList.remove("is-dragging");
      try {
        if (pointerId != null) el.releasePointerCapture(pointerId);
      } catch (_) {
        /* ignore */
      }
      pointerId = null;
    };

    el.addEventListener("pointerdown", (e) => {
      if (e.button != null && e.button !== 0) return;
      if (e.target.closest("button, a, input, select, textarea")) return;
      const rect = el.getBoundingClientRect();
      dragging = true;
      moved = false;
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      origL = rect.left;
      origT = rect.top;
      el.classList.add("is-dragging", "is-placed");
      el.style.left = `${rect.left}px`;
      el.style.top = `${rect.top}px`;
      el.style.right = "auto";
      el.style.bottom = "auto";
      el.style.transform = "none";
      try {
        el.setPointerCapture(e.pointerId);
      } catch (_) {
        /* ignore */
      }
      e.preventDefault();
    });

    el.addEventListener("pointermove", (e) => {
      if (!dragging || (pointerId != null && e.pointerId !== pointerId)) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!moved && dx * dx + dy * dy < 9) return;
      moved = true;
      const rect = el.getBoundingClientRect();
      const next = clampFloatPos(origL + dx, origT + dy, rect.width, rect.height);
      el.style.left = `${next.left}px`;
      el.style.top = `${next.top}px`;
    });

    el.addEventListener("pointerup", endDrag);
    el.addEventListener("pointercancel", endDrag);
  }

  function mountFontPreview(select, presets, ariaLabel, { prefix = "" } = {}) {
    if (!select || select._syncFontPick) return;
    const fallback = presets[select.value] || Object.values(presets)[0];
    const pick = document.createElement("div");
    pick.className = "font-pick";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-ghost btn-compact font-pick-btn";
    btn.setAttribute("aria-haspopup", "listbox");
    btn.setAttribute("aria-label", ariaLabel);
    btn.title = ariaLabel;
    const menu = document.createElement("div");
    menu.className = "font-pick-menu";
    menu.hidden = true;
    menu.setAttribute("role", "listbox");
    for (const opt of [...select.options]) {
      const preset = presets[opt.value];
      const item = document.createElement("button");
      item.type = "button";
      item.className = "font-pick-item";
      item.setAttribute("role", "option");
      item.dataset.value = opt.value;
      item.textContent = opt.textContent;
      if (preset?.stack) item.style.setProperty("--pick-font", preset.stack);
      if (preset?.style === "italic") item.style.setProperty("--pick-style", "italic");
      item.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (select.value !== opt.value) {
          select.value = opt.value;
          select.dispatchEvent(new Event("change", { bubbles: true }));
        }
        menu.hidden = true;
        syncBtn();
      });
      menu.appendChild(item);
    }
    function syncBtn() {
      const preset = presets[select.value] || fallback;
      const name = select.selectedOptions[0]?.textContent || preset?.label || "";
      btn.textContent = prefix ? `${prefix}·${name}` : name;
      if (preset?.stack) btn.style.setProperty("--pick-font", preset.stack);
      if (preset?.style === "italic") btn.style.setProperty("--pick-style", "italic");
      else btn.style.removeProperty("--pick-style");
      for (const item of menu.children) {
        item.setAttribute("aria-selected", item.dataset.value === select.value ? "true" : "false");
      }
    }
    let placing = false;
    function placeMenu(allowScroll = true) {
      menu.style.maxHeight = "none";
      menu.hidden = false;
      const gap = 4;
      const margin = 12;
      let rect = btn.getBoundingClientRect();
      const menuHeight = menu.offsetHeight;
      const spaceBelow = window.innerHeight - rect.bottom - gap - margin;
      if (allowScroll && spaceBelow < menuHeight) {
        const need = Math.ceil(menuHeight - spaceBelow);
        placing = true;
        const scroller = document.scrollingElement || document.documentElement;
        const room = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
        if (room < need) document.body.style.paddingBottom = `${need - room + 8}px`;
        window.scrollBy(0, need);
        placing = false;
        rect = btn.getBoundingClientRect();
      }
      const top = rect.bottom + gap;
      const avail = window.innerHeight - top - margin;
      if (menu.offsetHeight > avail) menu.style.maxHeight = `${Math.max(140, Math.floor(avail))}px`;
      const menuWidth = menu.offsetWidth;
      let left = rect.left;
      if (left + menuWidth > window.innerWidth - margin) {
        left = Math.max(margin, window.innerWidth - margin - menuWidth);
      }
      menu.style.left = `${Math.round(left)}px`;
      menu.style.top = `${Math.round(top)}px`;
      menu.style.minWidth = "";
    }
    function closeMenu() {
      if (placing) return;
      menu.hidden = true;
      if (![...document.querySelectorAll(".font-pick-menu")].some((el) => !el.hidden)) {
        document.body.style.paddingBottom = "";
      }
    }
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const willOpen = menu.hidden;
      document.querySelectorAll(".font-pick-menu").forEach((el) => {
        el.hidden = true;
      });
      if (!willOpen) {
        document.body.style.paddingBottom = "";
        return;
      }
      placeMenu();
      for (const preset of Object.values(presets)) {
        if (preset.loadFamily) ensureNamedFont(preset.loadFamily, preset.style === "italic" ? "italic" : "");
      }
    });
    document.addEventListener("pointerdown", (e) => {
      if (!pick.contains(e.target) && !menu.contains(e.target)) closeMenu();
    });
    window.addEventListener("scroll", () => {
      if (placing || menu.hidden) return;
      placeMenu(false);
    }, true);
    window.addEventListener("resize", closeMenu);
    select.classList.add("font-pick-native");
    select._syncFontPick = syncBtn;
    pick.append(btn);
    select.after(pick);
    document.body.append(menu);
    syncBtn();
  }

  function bind() {
    syncOpts();
    mountFloatOnBody();
    bindFloatDrag();
    setTip("点「录屏」先选选项再开始；再点暂停 → 悬浮条「保存」到本地");
    ensureLeadFontLoaded();
    ensureEnFontLoaded();
    applyPracticeFonts();
    ui.toggle?.addEventListener("click", () => toggle());
    ui.setupCancel?.addEventListener("click", () => closeSetupDialog());
    ui.setupConfirm?.addEventListener("click", () => confirmSetup());
    ui.setupDialog?.addEventListener("click", (e) => {
      if (e.target === e.currentTarget) closeSetupDialog();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (!ui.setupDialog || ui.setupDialog.classList.contains("hidden")) return;
      e.preventDefault();
      closeSetupDialog();
    });
    ui.btnResume?.addEventListener("click", () => resumeRecord());
    ui.btnSave?.addEventListener("click", () => saveLocal());
    ui.btnDiscard?.addEventListener("click", () => discardDraft());
    ui.qualityEl?.addEventListener("change", () => {
      readOpts();
      syncFloat();
    });
    ui.wordsBadgeEl?.addEventListener("change", () => {
      readOpts();
      state.dirty = true;
      syncFloat();
    });
    ui.leadFontEl?.addEventListener("change", () => {
      readOpts();
      state.dirty = true;
      applyPracticeFonts();
      ensureLeadFontLoaded().then(() => {
        state.dirty = true;
        applyPracticeFonts();
        if (state.recording) drawFrame();
      });
      syncFloat();
    });
    ui.enFontEl?.addEventListener("change", () => {
      readOpts();
      syncOpts();
      state.dirty = true;
      applyPracticeFonts();
      ensureEnFontLoaded().then(() => {
        state.dirty = true;
        applyPracticeFonts();
        if (state.recording) drawFrame();
      });
      syncFloat();
    });
    const onEnWrapChange = () => {
      readOpts();
      if (ui.enWrapEl) ui.enWrapEl.value = String(state.enWrapPx);
      state.dirty = true;
      if (state.recording) drawFrame();
      syncFloat();
    };
    ui.enWrapEl?.addEventListener("change", onEnWrapChange);
    ui.enWrapEl?.addEventListener("input", onEnWrapChange);
    const onIdleSkipChange = () => {
      readOpts();
      if (ui.idleSkipEl) ui.idleSkipEl.value = formatIdleSkipValue(state.idleSkipSec);
      if (state.recording && !state.paused) {
        if (state.idleSkipSec <= 0) {
          clearIdleTimer();
          if (state.idlePaused) leaveIdleSkip();
        } else {
          armIdleSkip();
        }
        if (!state.idlePaused) {
          setTip(`正在录制（${qualityLabel(state.res, state.fps)}）· ${idleSkipLabel()}`);
        }
      }
    };
    ui.idleSkipEl?.addEventListener("change", onIdleSkipChange);
    ui.idleSkipEl?.addEventListener("input", onIdleSkipChange);
    document.addEventListener("pte-voice-record-start", () => {
      if (state.recording) pauseRecord();
    });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") checkpointOnLeave();
    });
    window.addEventListener("pagehide", () => {
      checkpointOnLeave();
    });

    mountFontPreview(ui.leadFontEl, LEAD_FONT_PRESETS, "中文字体");
    mountFontPreview(ui.enFontEl, EN_FONT_PRESETS, "英文字体");

    restorePersistedDraft().catch((err) => console.warn("restore screen draft", err));
  }

  bind();

  return {
    startRecord,
    stopRecord,
    pauseRecord,
    resumeRecord,
    composeMp4,
    discardDraft,
    toggle,
    saveLocal,
    get recording() {
      return state.recording;
    },
    get paused() {
      return state.paused;
    },
  };
}
