/** 批量后台合成音频：按题目区间静默走 loadSpeechBlob，自动缓存。 */

import { loadSpeechBlob, readSpeechClip } from "./tts-cache.js?v=20261012dl";
import { synthesizeHttp, synthesizeEdgeSpeech, voiceCacheKey, getSavedVoice } from "./edge-tts.js?v=20261012dl";

/** iPhone / Capacitor 环境检测 */
const IS_IOS_CAPACITOR =
  typeof window !== "undefined" &&
  (typeof window.Capacitor !== "undefined" ||
    /iPhone|iPad|iPod/i.test(window.navigator?.userAgent || ""));

/** 简单并发闸门 */
function limitConcurrent(max) {
  let active = 0;
  const queue = [];
  const pump = () => {
    while (active < max && queue.length) {
      active += 1;
      const job = queue.shift();
      Promise.resolve(job()).finally(() => {
        active -= 1;
        pump();
      });
    }
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push(() => Promise.resolve(fn()).then(resolve, reject));
      pump();
    });
}

/**
 * 后台静默合成音频（不播放，只进缓存）。
 * @param {object} opts
 * @param {Array}  opts.questions - 完整题目数组（含 en/sense_groups）
 * @param {number} opts.start    - 起始编号（1-based）
 * @param {number} opts.end      - 结束编号（1-based，包含）
 * @param {string} opts.voice    - 声音 ID
 * @param {'full'|'sense'|'both'} opts.mode - 下载模式：整段 / 意群 / 都下
 * @param {(info: object)=>void} [opts.onProgress] - 进度回调
 * @param {()=>boolean}          [opts.shouldStop] - 外部轮询是否停止
 * @returns {Promise<{ok:number, fail:number, skip:number}>}
 */
export async function batchDownloadSpeech({
  questions,
  start,
  end,
  voice,
  mode = "full",
  onProgress,
  shouldStop,
}) {
  const ctrl = new AbortController();
  // 外部 shouldStop → 立即 abort 所有正在进行的 HTTP 请求
  const stopPoll = setInterval(() => {
    if (shouldStop?.() && !ctrl.signal.aborted) ctrl.abort();
  }, 80);
  const checkStop = () => ctrl.signal.aborted;
  const throttle = limitConcurrent(2);
  let ok = 0;
  let fail = 0;
  let skip = 0;

  const byNum = new Map();
  questions.forEach((q, idx) => {
    const n = Number(q.num);
    if (!Number.isNaN(n)) byNum.set(n, { q, idx });
  });

  const targets = [];
  for (let n = start; n <= end; n += 1) {
    const found = byNum.get(n);
    if (found) targets.push({ q: found.q, num: n });
  }
  if (!targets.length) { clearInterval(stopPoll); return { ok: 0, fail: 0, skip: 0 }; }

  const totalOps = targets.length;
  const synthFn = IS_IOS_CAPACITOR ? synthesizeEdgeSpeech : synthesizeHttp;

  /** 合成单段文本（带 3 次重试），返回 Blob | null */
  async function trySynthOne(text) {
    const key = voiceCacheKey(text, voice);
    // 预检缓存
    const cached = await readSpeechClip(key);
    if (cached) return { blob: cached, from: "cache" };
    let blob = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (checkStop()) return { blob: null, from: null };
      try {
        blob = await throttle(() => {
          if (checkStop()) return Promise.reject(new DOMException("cancelled", "AbortError"));
          return loadSpeechBlob(
            key,
            () => synthFn(text, ctrl.signal, undefined, voice),
          );
        });
        if (blob) break;
      } catch (err) {
        if (err?.name === "AbortError") return { blob: null, from: null };
      }
      if (attempt < 2) await new Promise((r) => setTimeout(r, 400));
    }
    return blob ? { blob, from: "synth" } : { blob: null, from: null };
  }

  // 第一轮：遍历所有题目，收集失败的
  const failedTexts = [];

  async function oneItem({ q, num }, i) {
    if (checkStop()) return;
    const texts = collectTexts(q, mode);
    if (!texts.length) {
      skip += 1;
      onProgress?.({ current: i + 1, total: totalOps, num, ok, fail, skip, phase: "empty" });
      return;
    }
    for (const text of texts) {
      if (checkStop()) return;
      const { blob, from } = await trySynthOne(text);
      if (from === "cache") skip += 1;
      else if (blob) ok += 1;
      else { fail += 1; failedTexts.push({ text, num }); }
    }
    onProgress?.({
      current: i + 1, total: totalOps, num, ok, fail, skip, phase: "item",
    });
  }

  onProgress?.({ current: 0, total: totalOps, num: start, ok: 0, fail: 0, skip: 0, phase: "start" });
  await Promise.allSettled(targets.map((t, i) => oneItem(t, i)));
  if (ctrl.signal.aborted) { clearInterval(stopPoll); return { ok, fail, skip, cancelled: true }; }

  // 第二轮：统一重试所有失败的
  if (failedTexts.length) {
    onProgress?.({
      current: totalOps, total: totalOps, num: end, ok, fail, skip,
      phase: "retry", retryTotal: failedTexts.length, retryDone: 0,
    });
    // 给网络一个喘息
    await new Promise((r) => setTimeout(r, 800));
    let retryDone = 0;
    const stillFailed = [];
    for (const { text, num } of failedTexts) {
      if (checkStop()) break;
      const { blob, from } = await trySynthOne(text);
      retryDone += 1;
      if (from === "cache") { skip += 1; fail -= 1; }
      else if (blob) { ok += 1; fail -= 1; }
      else stillFailed.push({ text, num });
      onProgress?.({
        current: totalOps, total: totalOps, num, ok, fail, skip,
        phase: "retry", retryTotal: failedTexts.length, retryDone,
      });
    }
    failedTexts.length = 0;
    failedTexts.push(...stillFailed);
  }

  clearInterval(stopPoll);
  onProgress?.({ current: totalOps, total: totalOps, num: end, ok, fail, skip, phase: "done" });
  return { ok, fail, skip, cancelled: false };
}

function collectTexts(q, mode) {
  const out = [];
  const full = String(q?.en || q?.full || "").trim();
  const groups = Array.isArray(q?.sense_groups) ? q.sense_groups : [];
  if (mode === "full" || mode === "both") {
    if (full) out.push(full);
  }
  if ((mode === "sense" || mode === "both") && groups.length) {
    for (const g of groups) {
      const t = String(g?.english || "").trim();
      if (t && t !== full) out.push(t);
    }
  }
  return out;
}

/** 底部毛玻璃进度卡片：tap 任意位置 = 取消 */
let hideTimer = null;
let boundOnCancel = null;

function ensureBadgeListener() {
  const el = document.getElementById("audio-dl-badge");
  if (!el || el.__bound) return;
  const fire = (e) => {
    e?.preventDefault?.();
    boundOnCancel?.();
    hideDownloadBadge();
  };
  el.addEventListener("click", fire);
  el.addEventListener("touchstart", fire, { passive: false });
  el.__bound = true;
}

export function showDownloadBadge({ title, onCancel }) {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  ensureBadgeListener();
  boundOnCancel = onCancel || null;
  const el = document.getElementById("audio-dl-badge");
  if (!el) return;
  el.querySelector("#audio-dl-title").textContent = title || "后台下载中";
  el.querySelector("#audio-dl-body").textContent = "";
  el.querySelector("#audio-dl-bar-inner").style.width = "0%";
  // 滑入动画
  requestAnimationFrame(() => { el.style.transform = "translateY(0)"; });
}

export function updateDownloadBadge(info) {
  const el = document.getElementById("audio-dl-badge");
  if (!el) return;
  const body = el.querySelector("#audio-dl-body");
  const bar = el.querySelector("#audio-dl-bar-inner");
  if (!body) return;
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  const { current, total, num, ok, fail, skip, phase, retryTotal, retryDone } = info || {};
  if (phase === "done") {
    const parts = [`✅${ok}`];
    if (skip) parts.push(`⏭️${skip}`);
    if (fail) parts.push(`❌${fail}`);
    body.textContent = parts.join(" ");
    bar.style.width = "100%";
    hideTimer = setTimeout(hideDownloadBadge, 2000);
  } else if (phase === "retry") {
    body.textContent = `🔄 重试 ${retryDone}/${retryTotal} · ❌${fail}`;
    bar.style.width = `${((current + retryDone) / (total + retryTotal)) * 100}%`;
  } else if (phase === "start") {
    body.textContent = `共 ${total} 题`;
    bar.style.width = "0%";
  } else {
    const pct = total ? Math.round((current / total) * 100) : 0;
    const parts = [`${pct}%`];
    if (skip) parts.push(`⏭️${skip}`);
    if (fail) parts.push(`❌${fail}`);
    body.textContent = parts.join(" · ");
    bar.style.width = `${pct}%`;
  }
}

export function hideDownloadBadge() {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  const el = document.getElementById("audio-dl-badge");
  if (el) el.style.transform = "translateY(120%)";
}

export function getDefaultDownloadVoice() {
  return getSavedVoice("online") || "en-US-EmmaMultilingualNeural";
}
