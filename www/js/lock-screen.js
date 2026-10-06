/**
 * 锁屏「正在播放」卡片显示整句英文。
 * 卡片的标题 / 副标题都只有一行，放不下的会被系统截断，所以：
 * - 把句子按单词拆到「标题 + 副标题」两行；
 * - 同时把整句画成一张封面图（点开锁屏播放器能看到大图，整句完整可读）。
 */

const DEFAULT_EN_STACK = 'Georgia, "Times New Roman", serif';
const DEFAULT_ZH_STACK = '-apple-system, "PingFang SC", "Heiti SC", sans-serif';

/** 锁屏卡片的中英文字体：直接取练习页「中文字体 / 英文字体」当前选择 */
export function lockFontSpec() {
  let en = "";
  let style = "normal";
  let zh = "";
  try {
    const cs = getComputedStyle(document.documentElement);
    en = (cs.getPropertyValue("--practice-en-font") || "").trim();
    style = (cs.getPropertyValue("--practice-en-font-style") || "normal").trim() || "normal";
    zh = (cs.getPropertyValue("--practice-lead-font") || "").trim();
  } catch (_) {}
  return {
    enStack: en || DEFAULT_EN_STACK,
    enItalic: style === "italic",
    zhStack: zh || DEFAULT_ZH_STACK,
  };
}

/** 画封面前确保自定义字体（行楷等）已加载，否则画布会先用备用字体 */
export async function ensureLockFonts() {
  if (typeof document === "undefined" || !document.fonts?.load) return;
  const { enStack, zhStack } = lockFontSpec();
  const first = (stack) =>
    String(stack)
      .split(",")[0]
      .trim();
  try {
    await Promise.race([
      Promise.all([
        document.fonts.load(`24px ${first(zhStack)}`, "中文测试"),
        document.fonts.load(`24px ${first(enStack)}`, "Abc"),
      ]),
      new Promise((r) => setTimeout(r, 1500)),
    ]);
  } catch (_) {}
}

const TITLE_MAX = 28;
const ARTIST_MAX = 34;

/** 按单词把一句话拆成两行（标题 / 副标题），尽量不截断 */
export function splitForLockScreen(text) {
  const words = String(text || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  let title = "";
  let i = 0;
  for (; i < words.length; i += 1) {
    const next = title ? `${title} ${words[i]}` : words[i];
    if (title && next.length > TITLE_MAX) break;
    title = next;
  }
  let artist = words.slice(i).join(" ");
  if (artist.length > ARTIST_MAX) {
    const cut = artist.slice(0, ARTIST_MAX - 1);
    const at = cut.lastIndexOf(" ");
    artist = `${(at > 8 ? cut.slice(0, at) : cut).trimEnd()}…`;
  }
  return { title, artist };
}

/** 把「带重音标记的片段」排成多行：片段 {t, b}，b=true 为重音音节（加粗） */
function layoutRich(ctx, segs, maxWidth, fontFor, tighten = 0) {
  // 先拆成单词（每个单词是 [{c,b}] 的字符数组）
  const words = [];
  let cur = [];
  for (const seg of segs) {
    for (const ch of Array.from(String(seg.t || ""))) {
      if (/\s/.test(ch)) {
        if (cur.length) words.push(cur);
        cur = [];
      } else {
        cur.push({ c: ch, b: !!seg.b });
      }
    }
  }
  if (cur.length) words.push(cur);

  const runsOf = (w) => {
    const runs = [];
    for (const ch of w) {
      const last = runs[runs.length - 1];
      if (last && last.b === ch.b) last.t += ch.c;
      else runs.push({ t: ch.c, b: ch.b });
    }
    return runs;
  };
  const widthOf = (runs) =>
    runs.reduce((sum, r) => {
      ctx.font = fontFor(r.b);
      // ˈ 字形两侧留白大：前后各收紧一点（与意群卡片一致，约 0.11em）
      const marks = r.b ? (r.t.match(/ˈ/g) || []).length : 0;
      return sum + ctx.measureText(r.t).width - marks * 2 * tighten;
    }, 0);
  ctx.font = fontFor(false);
  const space = ctx.measureText(" ").width;

  const lines = [];
  let line = [];
  let lineW = 0;
  for (const w of words) {
    const runs = runsOf(w);
    const ww = widthOf(runs);
    if (line.length && lineW + space + ww > maxWidth) {
      lines.push(line);
      line = [];
      lineW = 0;
    }
    lineW += (line.length ? space : 0) + ww;
    line.push(runs);
  }
  if (line.length) lines.push(line);
  return { lines, space };
}

function drawRichLines(ctx, layout, x, y, lineH, fontFor, markColor, tighten = 0) {
  layout.lines.forEach((words, li) => {
    let px = x;
    words.forEach((runs, wi) => {
      if (wi > 0) px += layout.space;
      for (const r of runs) {
        ctx.font = fontFor(r.b);
        // 重音符号 ˈ 用浅绿色标出
        const at = r.b ? r.t.indexOf("ˈ") : -1;
        if (at >= 0) {
          const before = r.t.slice(0, at);
          const rest = r.t.slice(at + 1);
          if (before) {
            ctx.fillText(before, px, y + li * lineH);
            px += ctx.measureText(before).width;
          }
          px -= tighten;
          ctx.fillStyle = markColor;
          ctx.fillText("ˈ", px, y + li * lineH);
          px += ctx.measureText("ˈ").width - tighten;
          ctx.fillStyle = "#ffffff";
          if (rest) {
            ctx.fillText(rest, px, y + li * lineH);
            px += ctx.measureText(rest).width;
          }
        } else {
          ctx.fillText(r.t, px, y + li * lineH);
          px += ctx.measureText(r.t).width;
        }
      }
    });
  });
}

function wrapChars(ctx, text, maxWidth) {
  const lines = [];
  let line = "";
  for (const ch of Array.from(String(text))) {
    if (line && ctx.measureText(line + ch).width > maxWidth) {
      lines.push(line);
      line = ch;
    } else {
      line += ch;
    }
  }
  if (line) lines.push(line);
  return lines;
}

const LOCK_STRESS_KEY = "biyi_lock_stress";
const LOCK_BG = "#17352e";
const LOCK_SIZE = 512;
let lockCanvas = null;
let lockCtx = null;
let lockPx = 0;

/** 锁屏卡片要不要画重音标记（默认开） */
export function isLockStressOn() {
  try {
    return localStorage.getItem(LOCK_STRESS_KEY) !== "0";
  } catch (_) {
    return true;
  }
}

export function setLockStressOn(on) {
  try {
    localStorage.setItem(LOCK_STRESS_KEY, on ? "1" : "0");
  } catch (_) {}
}

function lockSurface() {
  const dpr = Math.max(1, Math.min(4, Number(globalThis.devicePixelRatio) || 1));
  const screenW = Math.min(globalThis.screen?.width || 0, globalThis.screen?.height || 0) || 390;
  const px = Math.min(1536, Math.max(512, Math.round(screenW * dpr)));
  if (lockCanvas && lockCtx && lockPx === px) return { canvas: lockCanvas, ctx: lockCtx, px };
  const canvas = document.createElement("canvas");
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return null;
  lockCanvas = canvas;
  lockCtx = ctx;
  lockPx = px;
  return { canvas, ctx, px };
}

/** 同一张深绿底只建一次；每次只把文字区用底色盖住再写新字 */
export function renderLockArtwork(text, label = "", zh = "", rich = null) {
  try {
    const size = LOCK_SIZE;
    const surf = lockSurface();
    if (!surf) return "";
    const { canvas, ctx, px } = surf;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = LOCK_BG;
    // 多铺一圈：不透明画布默认是白的，差 1px 没涂满换图缩放时四周就会闪白
    ctx.fillRect(-4, -4, px + 8, px + 8);
    ctx.setTransform(px / size, 0, 0, px / size, 0, 0);
    ctx.fillStyle = LOCK_BG;
    ctx.fillRect(-8, -8, size + 16, size + 16);

    const pad = 32;
    const boxW = size - pad * 2;
    const boxH = size - pad * 2 - 40;
    const spoken = String(text || "").replace(/\s+/g, " ").trim();
    const spec = lockFontSpec();
    const segs = isLockStressOn() && Array.isArray(rich) && rich.length ? rich : [{ t: spoken, b: false }];
    let fs = 54;
    const fontFor = (_bold) => `${spec.enItalic ? "italic " : ""}${fs}px ${spec.enStack}`; // 重音音节不加粗，只保留 ˈ 标记
    const zhText = String(zh || "").replace(/\s+/g, " ").trim();
    const GAP = zhText ? 18 : 0;
    const zhFont = (z) => `${z}px ${spec.zhStack}`;
    let layout = { lines: [], space: 0 };
    let zfs = 0;
    let zhLines = [];
    for (; fs >= 18; fs -= 2) {
      layout = layoutRich(ctx, segs, boxW, fontFor, fs * 0.11);
      zfs = Math.max(16, Math.round(fs * 0.78));
      if (zhText) {
        ctx.font = zhFont(zfs);
        zhLines = wrapChars(ctx, zhText, boxW);
      }
      const h = layout.lines.length * fs * 1.28 + (zhText ? GAP + zhLines.length * zfs * 1.4 : 0);
      if (h <= boxH) break;
    }
    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "top";
    drawRichLines(ctx, layout, pad, pad, fs * 1.28, fontFor, "#8fe3c8", fs * 0.11);
    if (zhText) {
      const y0 = pad + layout.lines.length * fs * 1.28 + GAP;
      ctx.fillStyle = "rgba(255,255,255,0.72)";
      ctx.font = zhFont(zfs);
      zhLines.forEach((ln, i) => ctx.fillText(ln, pad, y0 + i * zfs * 1.4));
    }

    if (label) {
      ctx.fillStyle = "rgba(255,255,255,0.6)";
      ctx.font = '26px -apple-system, "PingFang SC", sans-serif';
      ctx.fillText(label, pad, size - pad - 20);
    }
    // JPEG 没有透明通道，锁屏切换封面时边缘不会闪白；高质量下文字依然清晰
    return canvas.toDataURL("image/jpeg", 0.97);
  } catch (_) {
    return "";
  }
}
