/**
 * 悬浮窗摄像头录像。
 * 录像核心复用 PTE voice-recite：清晰度档 + 摄像头真实宽高合成（横竖自适应）+ iOS 音轨保活。
 */

const PREFS = {
  pos: "biyi_camera_float_pos",
  size: "biyi_camera_float_size",
  facing: "biyi_camera_facing",
  res: "biyi_camera_res_v4",
};

/** 默认按本机最高清晰度要画面（ideal 1080p）；系统会落到设备实际支持的最高档 */
const QUALITY_BEST = {
  label: "1080p",
  width: 1920,
  height: 1080,
  maxW: 1920,
  maxH: 1080,
  fps: 30,
  videoBits: 2500000,
};

function isAppleWebKit() {
  const ua = String(navigator.userAgent || "");
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  if (/AppleWebKit/i.test(ua) && !/Chrome|Chromium|Edg|Electron/i.test(ua)) return true;
  return false;
}

function fmt(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

function readPref(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

function writePref(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch (_) {}
}

/** 与 PTE pickVideoMime 一致 */
function pickVideoMime() {
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return "";
  const apple = isAppleWebKit();
  const list = apple
    ? [
        "video/mp4;codecs=avc1.42001E,mp4a.40.2",
        "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
        "video/mp4;codecs=avc1,mp4a.40.2",
        "video/mp4",
      ]
    : [
        "video/webm;codecs=vp9,opus",
        "video/webm;codecs=vp8,opus",
        "video/webm",
        "video/mp4",
      ];
  return list.find((t) => MediaRecorder.isTypeSupported(t)) || "";
}

function pickMp4Mime() {
  return pickVideoMime();
}

function pickAnyMime() {
  return pickVideoMime();
}

/** 练习页当前题名，形如「#1 Lincoln」 */
function readQuestionTitle() {
  const root = document.querySelector("#q-name");
  if (!root) return "";
  const num = root.querySelector(".practice-num-jump")?.textContent?.replace(/\s+/g, " ").trim() || "";
  const title = root.querySelector(".q-title-text")?.textContent?.replace(/\s+/g, " ").trim() || "";
  if (num && title) return `${num} ${title}`;
  if (num) return num;
  if (title) return title;
  return root.textContent?.replace(/\s+/g, " ").trim() || "";
}

function sanitizeFileName(s) {
  return (
    String(s || "")
      .replace(/[\/\\:*?"<>|\n\r\t]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "笔译录像"
  );
}

/** 左上角烧录题名（与 PTE 一致：轻字重纯文字，录制时实时画上） */
function drawTitleBurn(ctx, text, canvasW, canvasH) {
  const label = String(text || "").trim();
  if (!label || !ctx) return;
  const pad = Math.max(8, Math.round(Math.min(canvasW, canvasH) * 0.03));
  const fontSize = Math.max(14, Math.round(Math.min(canvasW, canvasH) * 0.055));
  ctx.save();
  ctx.font = `300 ${fontSize}px -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif`;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.fillStyle = "#ffffff";
  ctx.fillText(label, pad, pad, canvasW - pad * 2);
  ctx.restore();
}

/** 把片段用 canvas 重编码成 MP4（可带音轨；可选左上角烧录题名） */
async function remuxToMp4(srcBlob, { width, height, fps, videoBits, burnTitle = "" } = {}) {
  const mp4Mime = pickMp4Mime() || "video/mp4";
  const video = document.createElement("video");
  video.playsInline = true;
  video.muted = true;
  video.src = URL.createObjectURL(srcBlob);
  await new Promise((resolve, reject) => {
    const ok = () => {
      video.removeEventListener("loadedmetadata", ok);
      video.removeEventListener("error", bad);
      resolve();
    };
    const bad = () => {
      video.removeEventListener("loadedmetadata", ok);
      video.removeEventListener("error", bad);
      reject(new Error("video load fail"));
    };
    video.addEventListener("loadedmetadata", ok);
    video.addEventListener("error", bad);
    video.load();
  });

  const canvas = document.createElement("canvas");
  // 跟 PTE 一样：优先用片源真实尺寸，不硬套横/竖
  canvas.width = Math.max(16, video.videoWidth || width || 1280);
  canvas.height = Math.max(16, video.videoHeight || height || 720);
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("canvas unavailable");
  const title = String(burnTitle || "").trim();

  const canvasStream = canvas.captureStream(Math.max(1, Number(fps) || 24));
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = audioCtx.createMediaElementSource(video);
    const dest = audioCtx.createMediaStreamDestination();
    src.connect(dest);
    dest.stream.getAudioTracks().forEach((t) => canvasStream.addTrack(t));
  } catch (_) {}

  const opts = { videoBitsPerSecond: videoBits || 1_500_000, mimeType: mp4Mime };
  let recorder;
  try {
    recorder = new MediaRecorder(canvasStream, opts);
  } catch (_) {
    try {
      recorder = new MediaRecorder(canvasStream, { videoBitsPerSecond: opts.videoBitsPerSecond, mimeType: "video/mp4" });
    } catch (err2) {
      recorder = new MediaRecorder(canvasStream, { videoBitsPerSecond: opts.videoBitsPerSecond });
    }
  }

  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data?.size) chunks.push(e.data);
  };
  const stopped = new Promise((resolve) => {
    recorder.onstop = () => resolve();
  });
  recorder.start(400);
  video.currentTime = 0;
  try {
    await video.play();
  } catch (err) {
    recorder.stop();
    canvasStream.getTracks().forEach((t) => t.stop());
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
        if (title) drawTitleBurn(ctx, title, canvas.width, canvas.height);
      } catch (_) {}
      raf = requestAnimationFrame(tick);
    };
    video.addEventListener(
      "ended",
      () => {
        if (raf) cancelAnimationFrame(raf);
        resolve();
      },
      { once: true }
    );
    raf = requestAnimationFrame(tick);
  });

  try {
    video.pause();
  } catch (_) {}
  try {
    if (recorder.state !== "inactive") recorder.stop();
  } catch (_) {}
  canvasStream.getTracks().forEach((t) => t.stop());
  await stopped;
  try {
    URL.revokeObjectURL(video.src);
  } catch (_) {}

  if (!chunks.length) throw new Error("mp4 remux empty");
  const type = /mp4/i.test(recorder.mimeType || "") ? recorder.mimeType : "video/mp4";
  return new Blob(chunks, { type });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result || "");
      const i = s.indexOf(",");
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    reader.onerror = () => reject(reader.error || new Error("read fail"));
    reader.readAsDataURL(blob);
  });
}

export function createSystemCamera({ $, toast }) {
  const btn = $("[data-system-camera]");
  const floatEl = $("[data-camera-float]");
  const liveEl = $("[data-camera-live]");
  const playbackEl = $("[data-camera-playback]");
  const previewEl = $("[data-camera-preview]");
  const playerEl = $("[data-camera-player]");
  const timerEl = $("[data-camera-timer]");
  const btnTimerEl = btn?.querySelector?.("[data-camera-btn-timer]") || null;
  const finishBtn = $("[data-camera-finish]");
  const closeBtn = $("[data-camera-close]");
  const facingBtn = $("[data-camera-facing]");
  const minimizeBtn = $("[data-camera-minimize]");
  const playBtn = $("[data-camera-play]");
  const saveBtn = $("[data-camera-save]");
  const rerecordBtn = $("[data-camera-rerecord]");
  const tipEl = $("[data-camera-tip]");
  const resizeHandle = $("[data-camera-resize]");
  if (!btn || !floatEl || !liveEl) {
    return { open: () => {}, stop: () => {} };
  }
  if (floatEl.parentElement !== document.body) document.body.appendChild(floatEl);

  let facing = readPref(PREFS.facing, "user") === "environment" ? "environment" : "user";
  /** @type {{ w: number, h: number } | null} */
  let lastComposeSize = null;
  let audioCtx = null;
  let audioKeepalive = null;

  function getQuality() {
    return QUALITY_BEST;
  }

  function beginRecord() {
    startRecord().catch((err) => {
      console.warn(err);
      const msg = String(err?.message || err || "");
      if (/NotAllowed|Permission|denied/i.test(msg)) toast("请允许使用摄像头和麦克风");
      else if (/NotFound|DevicesNotFound/i.test(msg)) toast("没有找到摄像头");
      else toast(msg || "无法开始录像");
    });
  }

  function teardownAudioKeepalive() {
    try {
      audioKeepalive?.disconnect?.();
    } catch (_) {}
    audioKeepalive = null;
    const ctx = audioCtx;
    audioCtx = null;
    if (ctx) {
      try {
        ctx.close();
      } catch (_) {}
    }
  }

  /** iOS 长录时音轨易空转：与 PTE 一样用静音 AudioContext 拉住麦克风链 */
  function setupAudioKeepalive(mediaStream) {
    teardownAudioKeepalive();
    if (!mediaStream) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      const ctx = new AC();
      const src = ctx.createMediaStreamSource(mediaStream);
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(gain);
      if (ctx.state === "suspended") {
        const resume = () => ctx.resume().catch(() => {});
        resume();
        document.addEventListener("touchend", resume, { once: true });
      }
      audioCtx = ctx;
      audioKeepalive = gain;
    } catch (_) {}
  }

  let stream = null;
  let recorder = null;
  let chunks = [];
  let blob = null;
  let objectUrl = null;
  let recording = false;
  let startedAt = 0;
  let timerId = 0;
  let mime = "";
  let drag = null;
  let resize = null;
  let remuxing = false;
  /** 本段录像对应的题名（烧录 + 文件名） */
  let sessionTitle = "";
  /** 录制时是否已实时烧录（结束不必再整片重编码） */
  let titleBurned = false;
  let composeStream = null;
  let composeRaf = 0;
  let composeTimer = 0;
  /** 录像中双击屏幕结束：上一击时间与位置 */
  let lastTapAt = 0;
  let lastTapX = 0;
  let lastTapY = 0;
  let tapDownX = 0;
  let tapDownY = 0;
  let tapDownAt = 0;
  const badgeEl = floatEl.querySelector(".camera-float-badge");

  /** 固定小窗宽度（与当前满意尺寸一致），不允许拖角缩放 */
  const FIXED_FLOAT_W = 366;

  function applyFloatWidth(_width, { keepPlace = true } = {}) {
    const maxW = Math.max(120, window.innerWidth - 24);
    const w = Math.min(FIXED_FLOAT_W, maxW);
    floatEl.style.width = `${w}px`;
    if (keepPlace && floatEl.classList.contains("is-placed") && !floatEl.hidden) {
      placeFloat(parseFloat(floatEl.style.left) || 0, parseFloat(floatEl.style.top) || 0);
    }
    return w;
  }

  function restoreFloatWidth() {
    applyFloatWidth(FIXED_FLOAT_W, { keepPlace: false });
  }

  function setTip(msg) {
    if (tipEl) tipEl.textContent = msg || tipEl.getAttribute("data-default-tip") || "";
  }

  function syncBtn() {
    btn.classList.toggle("is-recording", recording);
    btn.title = recording ? "结束录像" : "开始悬浮录像";
    const label = btn.querySelector("[data-camera-btn-label]");
    if (label) label.textContent = "录像";
    if (btnTimerEl) {
      btnTimerEl.hidden = !recording;
      if (!recording) btnTimerEl.textContent = "0:00";
    }
  }

  function setTimerText(sec) {
    const t = fmt(sec);
    if (timerEl) timerEl.textContent = t;
    if (btnTimerEl) btnTimerEl.textContent = t;
  }

  function stopTimer() {
    clearInterval(timerId);
    timerId = 0;
  }

  function startTimer() {
    stopTimer();
    startedAt = Date.now();
    setTimerText(0);
    timerId = setInterval(() => setTimerText((Date.now() - startedAt) / 1000), 250);
  }

  function revokeUrl() {
    if (!objectUrl) return;
    try {
      URL.revokeObjectURL(objectUrl);
    } catch (_) {}
    objectUrl = null;
  }

  function setLiveBadge(text) {
    if (!badgeEl) return;
    const t = String(text || "").trim();
    badgeEl.textContent = t || "录像中";
  }

  function teardownComposer() {
    if (composeRaf) {
      try {
        cancelAnimationFrame(composeRaf);
      } catch (_) {}
      composeRaf = 0;
    }
    if (composeTimer) {
      clearInterval(composeTimer);
      composeTimer = 0;
    }
    const composed = composeStream;
    composeStream = null;
    if (composed) {
      try {
        composed.getTracks().forEach((t) => t.stop());
      } catch (_) {}
    }
  }

  function setPreviewWarming(on) {
    previewEl?.classList.toggle("is-warming", !!on);
  }

  /** 比例由 CSS 固定 9:16；这里只清掉可能残留的旧 inline */
  function syncLiveAspect() {
    if (liveEl) liveEl.style.aspectRatio = "";
    if (playbackEl) playbackEl.style.aspectRatio = "";
  }

  function clearLiveAspect() {
    syncLiveAspect();
  }

  function stopTracks() {
    teardownComposer();
    teardownAudioKeepalive();
    stream?.getTracks?.().forEach((t) => {
      try {
        t.stop();
      } catch (_) {}
    });
    stream = null;
    liveEl.srcObject = null;
    setPreviewWarming(false);
    clearLiveAspect();
    setLiveBadge("录像中");
  }

  /** 等摄像头真实宽高稳定，避免开录瞬间黑边 / 比例乱跳 */
  async function waitLiveVideoReady({ minStableMs = 240, timeoutMs = 4500 } = {}) {
    const start = Date.now();
    let lastW = 0;
    let lastH = 0;
    let stableSince = 0;
    while (Date.now() - start < timeoutMs) {
      const w = liveEl.videoWidth || 0;
      const h = liveEl.videoHeight || 0;
      if (w > 16 && h > 16) {
        if (w === lastW && h === lastH) {
          if (!stableSince) stableSince = Date.now();
          if (Date.now() - stableSince >= minStableMs) return { w, h };
        } else {
          lastW = w;
          lastH = h;
          stableSince = Date.now();
          syncLiveAspect();
        }
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    const w = liveEl.videoWidth || 0;
    const h = liveEl.videoHeight || 0;
    if (w > 16 && h > 16) {
      syncLiveAspect();
      return { w, h };
    }
    return null;
  }

  /**
   * 与 PTE _setupComposer 一致：画布用摄像头真实 videoWidth/Height，横竖随设备自适应。
   */
  async function setupComposer(camStream, label) {
    teardownComposer();
    if (!camStream || !liveEl) return null;
    const ready = await waitLiveVideoReady();
    if (!ready) return null;

    const w = liveEl.videoWidth;
    const h = liveEl.videoHeight;
    if (!(w > 16 && h > 16)) return null;

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return null;
    lastComposeSize = { w, h };
    syncLiveAspect();

    const q = getQuality();
    const drawFps = Math.max(8, Math.min(24, Number(q.fps) || 12));
    const draw = () => {
      try {
        ctx.drawImage(liveEl, 0, 0, w, h);
        drawTitleBurn(ctx, label, w, h);
      } catch (_) {}
    };
    draw();
    const loop = () => {
      draw();
      composeRaf = requestAnimationFrame(loop);
    };
    composeRaf = requestAnimationFrame(loop);
    composeTimer = setInterval(draw, Math.round(1000 / drawFps));

    let canvasStream = null;
    try {
      canvasStream =
        typeof canvas.captureStream === "function"
          ? canvas.captureStream(drawFps)
          : typeof canvas.mozCaptureStream === "function"
            ? canvas.mozCaptureStream(drawFps)
            : null;
    } catch (_) {
      canvasStream = null;
    }
    if (!canvasStream?.getVideoTracks?.().length) {
      teardownComposer();
      return null;
    }
    const composed = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...camStream.getAudioTracks(),
    ]);
    composeStream = composed;
    return composed;
  }

  function showPreviewMode() {
    if (previewEl) previewEl.hidden = false;
    if (playerEl) playerEl.hidden = true;
    if (finishBtn) finishBtn.disabled = !recording;
    if (playBtn) playBtn.disabled = true;
    if (saveBtn) saveBtn.disabled = true;
  }

  function showPlayerMode() {
    setPreviewWarming(false);
    if (previewEl) previewEl.hidden = true;
    if (playerEl) playerEl.hidden = false;
    if (finishBtn) finishBtn.disabled = true;
    if (playBtn) playBtn.disabled = !blob;
    if (saveBtn) saveBtn.disabled = !blob || remuxing;
  }

  function placeFloat(left, top) {
    const rect = floatEl.getBoundingClientRect();
    const maxL = Math.max(8, window.innerWidth - rect.width - 8);
    const maxT = Math.max(8, window.innerHeight - rect.height - 8);
    const l = Math.min(maxL, Math.max(8, left));
    const t = Math.min(maxT, Math.max(8, top));
    floatEl.style.left = `${l}px`;
    floatEl.style.top = `${t}px`;
    floatEl.style.right = "auto";
    floatEl.style.bottom = "auto";
    floatEl.style.transform = "none";
    floatEl.classList.add("is-placed");
    writePref(PREFS.pos, JSON.stringify({ left: l, top: t }));
  }

  function syncMinimizedUi() {
    const on = floatEl.classList.contains("is-minimized");
    if (minimizeBtn) {
      minimizeBtn.textContent = on ? "展开" : "收起";
      minimizeBtn.title = on ? "展开录像画面" : "收起悬浮窗，不挡字幕";
      minimizeBtn.setAttribute("aria-pressed", on ? "true" : "false");
    }
    if (resizeHandle) resizeHandle.hidden = on;
  }

  function setMinimized(on) {
    const next = !!on;
    const was = floatEl.classList.contains("is-minimized");
    floatEl.classList.toggle("is-minimized", next);
    syncMinimizedUi();
    if (was === next) return;
    // 高度变化后钳制在视口内
    if (floatEl.classList.contains("is-placed") && !floatEl.hidden) {
      placeFloat(parseFloat(floatEl.style.left) || 0, parseFloat(floatEl.style.top) || 0);
    }
    if (!next) restoreFloatWidth();
  }

  function toggleMinimized() {
    setMinimized(!floatEl.classList.contains("is-minimized"));
  }

  function ensureFloatVisible() {
    floatEl.hidden = false;
    setMinimized(false);
    restoreFloatWidth();
    try {
      const raw = JSON.parse(readPref(PREFS.pos, "null"));
      if (raw && typeof raw.left === "number" && typeof raw.top === "number") {
        placeFloat(raw.left, raw.top);
        return;
      }
    } catch (_) {}
    const w = floatEl.offsetWidth || 220;
    placeFloat(window.innerWidth - w - 20, 96);
  }

  function hideFloat() {
    floatEl.hidden = true;
    floatEl.classList.remove("is-dragging", "is-resizing", "is-minimized");
    syncMinimizedUi();
    drag = null;
    resize = null;
  }

  async function openStream() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("当前环境不支持摄像头");
    const q = getQuality();
    // ideal 拉到最高；设备不支持时由浏览器落到本机实际最高档
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: false,
          autoGainControl: true,
          channelCount: 1,
        },
        video: {
          facingMode: { ideal: facing },
          width: { ideal: q.width },
          height: { ideal: q.height },
          frameRate: { ideal: q.fps, max: 60 },
        },
      });
    } catch (_) {
      return navigator.mediaDevices.getUserMedia({
        audio: true,
        video: { facingMode: facing },
      });
    }
  }

  function buildVideoFileName() {
    return `${sanitizeFileName(sessionTitle || readQuestionTitle())}.mp4`;
  }

  /** 仅当未实时烧录且格式不是 MP4 时，才走慢路径重编码 */
  async function remuxIfNeeded(srcBlob, { burn = false } = {}) {
    const q = getQuality();
    const size = lastComposeSize || { w: q.width, h: q.height };
    const title = sessionTitle || readQuestionTitle() || "笔译录像";
    sessionTitle = title;
    const out = await remuxToMp4(srcBlob, {
      width: size.w,
      height: size.h,
      fps: q.fps,
      videoBits: q.videoBits,
      burnTitle: burn ? title : "",
    });
    if (burn) titleBurned = true;
    return out;
  }

  async function startRecord() {
    if (recording) return;
    document.dispatchEvent(new CustomEvent("pte-voice-record-start", { bubbles: true }));

    blob = null;
    chunks = [];
    sessionTitle = readQuestionTitle() || "笔译录像";
    titleBurned = false;
    lastComposeSize = null;
    revokeUrl();
    if (playbackEl) {
      playbackEl.removeAttribute("src");
      playbackEl.load?.();
    }

    const q = getQuality();
    stream = await openStream();
    setupAudioKeepalive(stream);
    liveEl.srcObject = stream;
    liveEl.muted = true;
    liveEl.playsInline = true;
    liveEl.classList.toggle("is-front", facing === "user");
    try {
      await liveEl.play();
    } catch (_) {}

    showPreviewMode();
    setPreviewWarming(true);
    ensureFloatVisible();
    setLiveBadge(sessionTitle);
    setTip("正在打开摄像头…");

    const readySize = await waitLiveVideoReady();
    setPreviewWarming(false);
    if (readySize) lastComposeSize = readySize;
    syncLiveAspect();

    let recordStream = stream;
    try {
      const composed = await setupComposer(stream, sessionTitle);
      if (composed) {
        recordStream = composed;
        titleBurned = true;
      }
    } catch (err) {
      console.warn(err);
    }

    const apple = isAppleWebKit();
    mime = pickVideoMime();
    const opts = {};
    if (mime) opts.mimeType = mime;
    if (!apple) {
      opts.videoBitsPerSecond = q.videoBits;
      opts.audioBitsPerSecond = 128000;
    } else {
      opts.videoBitsPerSecond = Math.max(q.videoBits, 400000);
      opts.audioBitsPerSecond = 128000;
    }
    try {
      recorder = new MediaRecorder(recordStream, opts);
    } catch (_) {
      try {
        recorder = mime
          ? new MediaRecorder(recordStream, { mimeType: mime })
          : new MediaRecorder(recordStream);
      } catch {
        recorder = new MediaRecorder(recordStream);
      }
    }
    mime = recorder.mimeType || mime || "video/mp4";
    chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data?.size) chunks.push(e.data);
    };
    try {
      recorder.start(1000);
    } catch (_) {
      recorder.start();
    }
    recording = true;
    startTimer();
    syncBtn();
    setTip("");
  }

  function finishRecord() {
    return new Promise((resolve) => {
      if (!recorder || recorder.state === "inactive") {
        recording = false;
        stopTimer();
        syncBtn();
        resolve(null);
        return;
      }
      recorder.onstop = async () => {
        recording = false;
        lastTapAt = 0;
        stopTimer();
        syncBtn();
        let out = new Blob(chunks, { type: mime || "video/mp4" });
        chunks = [];
        stopTracks();
        if (!sessionTitle) sessionTitle = readQuestionTitle() || "笔译录像";

        // 实时烧录成功：直出，不再整片重编码（与 PTE 一致）
        // 仅当格式不是 MP4，或实时烧录失败时才走慢路径
        const needFormat = !/mp4|avc1|h264/i.test(out.type || mime || "");
        if (needFormat || !titleBurned) {
          remuxing = true;
          setTip(needFormat ? "正在转成 MP4…" : `正在补烧「${sessionTitle}」…`);
          showPlayerMode();
          try {
            out = await remuxIfNeeded(out, { burn: !titleBurned });
            mime = out.type || "video/mp4";
          } catch (err) {
            console.warn(err);
            if (needFormat) toast("MP4 转换失败，将按原格式保存");
            else toast("题名烧录失败，可仍保存原片");
          } finally {
            remuxing = false;
          }
        } else {
          mime = /mp4/i.test(out.type) ? out.type : "video/mp4";
          out = new Blob([out], { type: "video/mp4" });
        }

        blob = out;
        revokeUrl();
        objectUrl = URL.createObjectURL(blob);
        if (playbackEl) {
          playbackEl.src = objectUrl;
          playbackEl.load?.();
        }
        showPlayerMode();
        setTip(titleBurned ? `录像完成 · 「${sessionTitle}」` : "录像完成 · 可播放或保存为 MP4");
        toast(titleBurned ? `录像完成（${sessionTitle}）` : "录像完成");
        resolve(blob);
      };
      try {
        try {
          if (recorder.state === "recording") recorder.requestData();
        } catch (_) {}
        recorder.stop();
      } catch (_) {
        recording = false;
        stopTimer();
        syncBtn();
        stopTracks();
        resolve(null);
      }
    });
  }

  async function closeAll() {
    if (recording) {
      try {
        await finishRecord();
      } catch (_) {}
    }
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch (_) {}
    }
    recorder = null;
    recording = false;
    remuxing = false;
    sessionTitle = "";
    titleBurned = false;
    stopTimer();
    stopTracks();
    revokeUrl();
    blob = null;
    if (playbackEl) {
      playbackEl.pause?.();
      playbackEl.removeAttribute("src");
    }
    hideFloat();
    syncBtn();
    setTimerText(0);
    setTip("");
  }

  async function rerecord() {
    await closeAll();
    beginRecord();
  }

  async function togglePlay() {
    if (!playbackEl || !blob) return;
    if (playbackEl.paused) {
      try {
        await playbackEl.play();
        if (playBtn) playBtn.textContent = "暂停";
      } catch (_) {
        toast("暂时播不了");
      }
    } else {
      playbackEl.pause();
      if (playBtn) playBtn.textContent = "播放";
    }
  }

  async function saveLocal() {
    if (!blob) {
      toast("还没有可保存的录像");
      return;
    }
    if (remuxing) {
      toast("正在转换 MP4，请稍候");
      return;
    }
    let out = blob;
    const needFormat = !/mp4|avc1|h264/i.test(out.type || "");
    if (needFormat || !titleBurned) {
      remuxing = true;
      setTip(needFormat ? "正在转成 MP4…" : `正在补烧「${sessionTitle || readQuestionTitle() || "题名"}」…`);
      try {
        out = await remuxIfNeeded(out, { burn: !titleBurned });
        blob = out;
        mime = out.type || "video/mp4";
        revokeUrl();
        objectUrl = URL.createObjectURL(blob);
        if (playbackEl) playbackEl.src = objectUrl;
      } catch (err) {
        remuxing = false;
        toast(err?.message || "转 MP4 / 烧录失败");
        return;
      } finally {
        remuxing = false;
      }
    }

    const name = buildVideoFileName();
    const Cap = window.Capacitor;
    const isNative = !!(Cap?.isNativePlatform && Cap.isNativePlatform());
    const FS = Cap?.Plugins?.Filesystem;
    const Media = Cap?.Plugins?.Media;
    setTip(`正在保存「${name}」…`);
    try {
      if (isNative && FS?.writeFile) {
        const base64 = await blobToBase64(out);
        try {
          await FS.mkdir({ path: "pte-videos", directory: "DOCUMENTS", recursive: true });
        } catch (_) {}
        const path = `pte-videos/${name}`;
        await FS.writeFile({ path, data: base64, directory: "DOCUMENTS" });
        let album = false;
        if (Media?.saveVideo) {
          try {
            const uriRes = await FS.getUri({ path, directory: "DOCUMENTS" });
            await Media.saveVideo({
              path: uriRes?.uri || path,
              fileName: name.replace(/\.mp4$/i, ""),
            });
            album = true;
          } catch (_) {}
        }
        toast(album ? `已保存到相册：${name}` : `已保存到 App 文件：${name}`);
        setTip(album ? `已保存到相册：${name}` : `已保存：${name}`);
        return;
      }
      const a = document.createElement("a");
      a.href = objectUrl || URL.createObjectURL(out);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast(`已开始下载：${name}`);
      setTip(`已触发下载：${name}`);
    } catch (err) {
      toast(err?.message || "保存失败");
      setTip("保存失败");
    }
  }

  async function toggleFacing() {
    facing = facing === "user" ? "environment" : "user";
    writePref(PREFS.facing, facing);
    if (facingBtn) facingBtn.textContent = facing === "user" ? "前置" : "后置";
    if (!recording) {
      toast(facing === "user" ? "已切到前置" : "已切到后置");
      return;
    }
    await finishRecord();
    await startRecord();
  }

  async function onToggleClick() {
    if (recording) {
      await finishRecord();
      return;
    }
    if (blob && !floatEl.hidden) {
      await closeAll();
      return;
    }
    beginRecord();
  }

  function onPointerDown(e) {
    if (e.button != null && e.button !== 0) return;
    if (e.target.closest("button, input, video, a, select, textarea, [data-camera-resize]")) return;
    const rect = floatEl.getBoundingClientRect();
    drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, pid: e.pointerId };
    floatEl.classList.add("is-dragging");
    try {
      floatEl.setPointerCapture(e.pointerId);
    } catch (_) {}
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!drag || drag.pid !== e.pointerId) return;
    placeFloat(e.clientX - drag.dx, e.clientY - drag.dy);
  }

  function onPointerUp(e) {
    if (!drag || drag.pid !== e.pointerId) return;
    drag = null;
    floatEl.classList.remove("is-dragging");
    try {
      floatEl.releasePointerCapture(e.pointerId);
    } catch (_) {}
  }

  btn.addEventListener("click", () => onToggleClick().catch((err) => console.warn(err)));
  finishBtn?.addEventListener("click", () => finishRecord().catch((err) => console.warn(err)));
  closeBtn?.addEventListener("click", () => closeAll().catch((err) => console.warn(err)));
  facingBtn?.addEventListener("click", () => toggleFacing().catch((err) => console.warn(err)));
  minimizeBtn?.addEventListener("click", () => toggleMinimized());
  playBtn?.addEventListener("click", () => togglePlay().catch((err) => console.warn(err)));
  saveBtn?.addEventListener("click", () => saveLocal().catch((err) => console.warn(err)));
  rerecordBtn?.addEventListener("click", () => rerecord().catch((err) => console.warn(err)));
  playbackEl?.addEventListener("ended", () => {
    if (playBtn) playBtn.textContent = "播放";
  });
  playbackEl?.addEventListener("pause", () => {
    if (playBtn && playbackEl.paused) playBtn.textContent = "播放";
  });
  playbackEl?.addEventListener("play", () => {
    if (playBtn) playBtn.textContent = "暂停";
  });

  function onDocTapDown(e) {
    if (!recording || remuxing) return;
    if (e.pointerType === "mouse" && e.button != null && e.button !== 0) return;
    tapDownX = e.clientX;
    tapDownY = e.clientY;
    tapDownAt = Date.now();
  }

  function onDocTapUp(e) {
    if (!recording || remuxing) return;
    if (e.pointerType === "mouse" && e.button != null && e.button !== 0) return;
    if (e.target?.closest?.("button, input, a, select, textarea, label, [data-camera-resize], .app-dialog")) {
      lastTapAt = 0;
      return;
    }
    const moved = Math.hypot(e.clientX - tapDownX, e.clientY - tapDownY);
    if (moved > 22 || Date.now() - tapDownAt > 480) {
      lastTapAt = 0;
      return;
    }
    const now = Date.now();
    const gap = now - lastTapAt;
    const dist = Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY);
    if (gap > 0 && gap < 360 && dist < 56) {
      lastTapAt = 0;
      drag = null;
      floatEl.classList.remove("is-dragging");
      finishRecord().catch((err) => console.warn(err));
      return;
    }
    lastTapAt = now;
    lastTapX = e.clientX;
    lastTapY = e.clientY;
  }

  floatEl.addEventListener("pointerdown", onPointerDown);
  floatEl.addEventListener("pointermove", onPointerMove);
  floatEl.addEventListener("pointerup", onPointerUp);
  floatEl.addEventListener("pointercancel", onPointerUp);
  document.addEventListener("pointerdown", onDocTapDown, true);
  document.addEventListener("pointerup", onDocTapUp, true);
  window.addEventListener("resize", () => {
    if (floatEl.hidden) return;
    restoreFloatWidth();
    applyFloatWidth(floatEl.getBoundingClientRect().width || 240, { persist: false });
    if (!floatEl.classList.contains("is-placed")) return;
    placeFloat(parseFloat(floatEl.style.left) || 0, parseFloat(floatEl.style.top) || 0);
  });

  if (facingBtn) facingBtn.textContent = facing === "user" ? "前置" : "后置";
  restoreFloatWidth();
  syncBtn();
  setTip("");

  return { open: () => beginRecord(), stop: () => closeAll() };
}
