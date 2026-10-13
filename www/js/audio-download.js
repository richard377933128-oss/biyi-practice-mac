/** 批量后台合成音频：按题目区间静默走 loadSpeechBlob，自动缓存。 */

import { loadSpeechBlob } from "./tts-cache.js?v=20261012dl";
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

  async function oneItem({ q, num }, i) {
    if (checkStop()) return;
    const texts = collectTexts(q, mode);
    if (!texts.length) {
      skip += 1;
      onProgress?.({ current: i + 1, total: totalOps, num, ok, fail, skip, phase: "empty" });
      return;
    }
    let itemOk = 0, itemFail = 0;
    for (const text of texts) {
      if (checkStop()) return;
      let blob = null;
      // iPhone/Capacitor 走 WSS 直连；网页版走 8767 HTTP 代理（更稳定）
      const synthFn = IS_IOS_CAPACITOR ? synthesizeEdgeSpeech : synthesizeHttp;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (checkStop()) return;
        try {
          blob = await throttle(() => {
            if (checkStop()) return Promise.reject(new DOMException("cancelled", "AbortError"));
            return loadSpeechBlob(
              voiceCacheKey(text, voice),
              () => synthFn(text, ctrl.signal, undefined, voice),
            );
          });
          if (blob) break;
        } catch (err) {
          if (err?.name === "AbortError") return;
        }
        // 短暂退避后重试
        if (attempt < 2) await new Promise((r) => setTimeout(r, 400));
      }
      if (blob) itemOk += 1;
      else itemFail += 1;
    }
    ok += itemOk;
    fail += itemFail;
    onProgress?.({
      current: i + 1,
      total: totalOps,
      num,
      ok,
      fail,
      skip,
      phase: "item",
    });
  }

  onProgress?.({ current: 0, total: totalOps, num: start, ok: 0, fail: 0, skip: 0, phase: "start" });
  await Promise.allSettled(targets.map((t, i) => oneItem(t, i)));
  clearInterval(stopPoll);
  if (ctrl.signal.aborted) {
    // 用户取消：隐藏徽章并静默退出，不走 done phase
    return { ok, fail, skip, cancelled: true };
  }
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

/** 显示一个小的可关闭进度徽章（DOM 已在 index.html 静态写好） */
let hideTimer = null;
let boundOnCancel = null;

function ensureBadgeListeners() {
  // 只绑定一次：静态 DOM 元素，原生 addEventListener，Capacitor iOS 可靠
  const btn = document.getElementById("audio-dl-cancel");
  if (btn && !btn.__bound) {
    const fire = () => {
      boundOnCancel?.();
      hideDownloadBadge();
    };
    btn.addEventListener("click", fire);
    btn.addEventListener("touchstart", (e) => { e.preventDefault(); fire(); }, { passive: false });
    btn.__bound = true;
  }
}

export function showDownloadBadge({ title, onCancel }) {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  ensureBadgeListeners();
  boundOnCancel = onCancel || null;
  const el = document.getElementById("audio-dl-badge");
  if (!el) return;
  el.hidden = false;
  el.querySelector("#audio-dl-title").textContent = title || "后台下载中";
}

export function updateDownloadBadge(info) {
  const el = document.getElementById("audio-dl-badge");
  if (!el) return;
  const body = el.querySelector("#audio-dl-body");
  if (!body) return;
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  const { current, total, num, ok, fail, skip, phase } = info || {};
  const pct = total ? Math.round((current / total) * 100) : 0;
  if (phase === "done") {
    body.textContent = `✅ 完成：合成 ${ok}，失败 ${fail}${skip ? `，跳过 ${skip}` : ""}`;
    hideTimer = setTimeout(hideDownloadBadge, 1400);
  } else if (phase === "start") {
    body.textContent = `准备中…共 ${total} 题`;
  } else {
    body.textContent = `${current}/${total} · ${pct}% · ✅${ok} ❌${fail}`;
  }
}

export function hideDownloadBadge() {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  const el = document.getElementById("audio-dl-badge");
  if (el) el.hidden = true;
}

export function getDefaultDownloadVoice() {
  return getSavedVoice("online") || "en-US-EmmaMultilingualNeural";
}
