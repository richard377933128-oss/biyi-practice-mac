/** 悬浮窗摄像头录像。点「录像」先选分辨率/帧率；保存为 MP4。不改动录屏。 */

const PREFS = {
  pos: "biyi_camera_float_pos",
  size: "biyi_camera_float_size",
  facing: "biyi_camera_facing",
  res: "biyi_camera_res",
  fps: "biyi_camera_fps",
};

const RES_PRESETS = {
  "480p": { label: "640×480", w: 640, h: 480, bits: 900_000 },
  "720p": { label: "1280×720", w: 1280, h: 720, bits: 2_500_000 },
  "1080p": { label: "1920×1080", w: 1920, h: 1080, bits: 5_000_000 },
};

const FPS_PRESETS = [15, 24, 30];

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

function pickMp4Mime() {
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return "";
  const list = [
    "video/mp4;codecs=avc1.42001E,mp4a.40.2",
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4;codecs=avc1.4D401F,mp4a.40.2",
    "video/mp4;codecs=avc1,mp4a.40.2",
    "video/mp4;codecs=h264,aac",
    "video/mp4",
  ];
  return list.find((t) => MediaRecorder.isTypeSupported(t)) || "";
}

function pickAnyMime() {
  return (
    pickMp4Mime() ||
    (typeof MediaRecorder !== "undefined" &&
      MediaRecorder.isTypeSupported &&
      (["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((t) =>
        MediaRecorder.isTypeSupported(t)
      ) ||
        "")) ||
    ""
  );
}

/** 把非 MP4 片段用 canvas 重编码成 MP4（并带上音轨若可） */
async function remuxToMp4(srcBlob, { width, height, fps, videoBits } = {}) {
  const mp4Mime = pickMp4Mime() || "video/mp4";
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(16, width || 1280);
  canvas.height = Math.max(16, height || 720);
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("canvas unavailable");

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

  const canvasStream = canvas.captureStream(Math.max(1, Number(fps) || 30));
  // 尽量附带原音轨
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = audioCtx.createMediaElementSource(video);
    const dest = audioCtx.createMediaStreamDestination();
    src.connect(dest);
    dest.stream.getAudioTracks().forEach((t) => canvasStream.addTrack(t));
  } catch (_) {}

  const opts = { videoBitsPerSecond: videoBits || 2_500_000, mimeType: mp4Mime };
  let recorder;
  try {
    recorder = new MediaRecorder(canvasStream, opts);
  } catch (_) {
    try {
      recorder = new MediaRecorder(canvasStream, { videoBitsPerSecond: opts.videoBitsPerSecond, mimeType: "video/mp4" });
    } catch (err2) {
      try {
        recorder = new MediaRecorder(canvasStream, { videoBitsPerSecond: opts.videoBitsPerSecond });
      } catch (err3) {
        throw err3;
      }
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
  const setupDialog = $("#camera-setup-dialog");
  const setupRes = $("#camera-setup-res");
  const setupFps = $("#camera-setup-fps");
  const setupCancel = $("#btn-camera-setup-cancel");
  const setupStart = $("#btn-camera-setup-confirm");

  if (!btn || !floatEl || !liveEl) {
    return { open: () => {}, stop: () => {} };
  }
  if (floatEl.parentElement !== document.body) document.body.appendChild(floatEl);

  let facing = readPref(PREFS.facing, "user") === "environment" ? "environment" : "user";
  let resKey = RES_PRESETS[readPref(PREFS.res, "720p")] ? readPref(PREFS.res, "720p") : "720p";
  let fps = Number(readPref(PREFS.fps, "30"));
  if (!FPS_PRESETS.includes(fps)) fps = 30;

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

  const MIN_FLOAT_W = 160;
  function maxFloatW() {
    return Math.min(560, Math.max(MIN_FLOAT_W, window.innerWidth - 24));
  }

  function applyFloatWidth(width, { persist = true, keepPlace = true } = {}) {
    const w = Math.min(maxFloatW(), Math.max(MIN_FLOAT_W, Math.round(Number(width) || 240)));
    floatEl.style.width = `${w}px`;
    if (persist) writePref(PREFS.size, String(w));
    if (keepPlace && floatEl.classList.contains("is-placed") && !floatEl.hidden) {
      placeFloat(parseFloat(floatEl.style.left) || 0, parseFloat(floatEl.style.top) || 0);
    }
    return w;
  }

  function restoreFloatWidth() {
    const raw = Number(readPref(PREFS.size, ""));
    if (Number.isFinite(raw) && raw >= MIN_FLOAT_W) applyFloatWidth(raw, { persist: false, keepPlace: false });
  }

  function setTip(msg) {
    if (tipEl) tipEl.textContent = msg || tipEl.getAttribute("data-default-tip") || "";
  }

  function syncBtn() {
    btn.classList.toggle("is-recording", recording);
    btn.setAttribute("aria-pressed", recording ? "true" : "false");
    btn.setAttribute("aria-label", recording ? "结束录像" : "开始悬浮录像");
    btn.title = recording ? "结束录像" : "开始悬浮录像";
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

  function stopTracks() {
    stream?.getTracks?.().forEach((t) => {
      try {
        t.stop();
      } catch (_) {}
    });
    stream = null;
    liveEl.srcObject = null;
  }

  function showPreviewMode() {
    if (previewEl) previewEl.hidden = false;
    if (playerEl) playerEl.hidden = true;
    if (finishBtn) finishBtn.disabled = !recording;
    if (playBtn) playBtn.disabled = true;
    if (saveBtn) saveBtn.disabled = true;
  }

  function showPlayerMode() {
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

  function openSetupDialog() {
    if (!setupDialog) {
      startRecord().catch((err) => console.warn(err));
      return;
    }
    if (setupRes) setupRes.value = resKey;
    if (setupFps) setupFps.value = String(fps);
    setupDialog.classList.remove("hidden");
  }

  function closeSetupDialog() {
    setupDialog?.classList.add("hidden");
  }

  function confirmSetup() {
    const nextRes = setupRes?.value || resKey;
    const nextFps = Number(setupFps?.value || fps);
    resKey = RES_PRESETS[nextRes] ? nextRes : "720p";
    fps = FPS_PRESETS.includes(nextFps) ? nextFps : 30;
    writePref(PREFS.res, resKey);
    writePref(PREFS.fps, fps);
    closeSetupDialog();
    startRecord().catch((err) => {
      console.warn(err);
      const msg = String(err?.message || err || "");
      if (/NotAllowed|Permission|denied/i.test(msg)) toast("请允许使用摄像头和麦克风");
      else if (/NotFound|DevicesNotFound/i.test(msg)) toast("没有找到摄像头");
      else toast(msg || "无法开始录像");
    });
  }

  async function openStream() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("当前环境不支持摄像头");
    const q = RES_PRESETS[resKey] || RES_PRESETS["720p"];
    const video = {
      facingMode: { ideal: facing },
      width: { ideal: q.w },
      height: { ideal: q.h },
      frameRate: { ideal: fps, max: fps },
    };
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: true, video });
    } catch (_) {
      return navigator.mediaDevices.getUserMedia({
        audio: true,
        video: { facingMode: facing, frameRate: { ideal: fps } },
      });
    }
  }

  async function startRecord() {
    if (recording) return;
    document.dispatchEvent(new CustomEvent("pte-voice-record-start", { bubbles: true }));

    blob = null;
    chunks = [];
    revokeUrl();
    if (playbackEl) {
      playbackEl.removeAttribute("src");
      playbackEl.load?.();
    }

    const q = RES_PRESETS[resKey] || RES_PRESETS["720p"];
    stream = await openStream();
    liveEl.srcObject = stream;
    liveEl.muted = true;
    liveEl.playsInline = true;
    liveEl.classList.toggle("is-front", facing === "user");
    try {
      await liveEl.play();
    } catch (_) {}

    mime = pickMp4Mime() || pickAnyMime();
    const opts = {
      videoBitsPerSecond: q.bits,
    };
    if (mime) opts.mimeType = mime;
    try {
      recorder = new MediaRecorder(stream, opts);
    } catch (_) {
      try {
        recorder = new MediaRecorder(stream, { videoBitsPerSecond: q.bits, mimeType: "video/mp4" });
      } catch {
        recorder = new MediaRecorder(stream);
      }
    }
    mime = recorder.mimeType || mime || "video/mp4";
    chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data?.size) chunks.push(e.data);
    };
    recorder.start(1000);
    recording = true;
    startTimer();
    syncBtn();
    showPreviewMode();
    ensureFloatVisible();
    setTip(`录像中 · ${q.label} · ${fps}fps · 点「完成」结束`);
    toast(`已开始录像（${q.label} · ${fps}fps）`);
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
        stopTimer();
        syncBtn();
        let out = new Blob(chunks, { type: mime || "video/mp4" });
        chunks = [];
        stopTracks();

        // 强制落成 MP4：若录出来不是 mp4，则重编码
        if (!/mp4|avc1|h264/i.test(out.type || mime || "")) {
          remuxing = true;
          setTip("正在转成 MP4…");
          showPlayerMode();
          try {
            const q = RES_PRESETS[resKey] || RES_PRESETS["720p"];
            out = await remuxToMp4(out, { width: q.w, height: q.h, fps, videoBits: q.bits });
            mime = out.type || "video/mp4";
            toast("已转为 MP4");
          } catch (err) {
            console.warn(err);
            toast("MP4 转换失败，将按原格式保存");
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
        setTip("录像完成 · 可播放或保存为 MP4");
        toast("录像完成");
        resolve(blob);
      };
      try {
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
    stopTimer();
    stopTracks();
    revokeUrl();
    blob = null;
    if (playbackEl) {
      playbackEl.pause?.();
      playbackEl.removeAttribute("src");
    }
    hideFloat();
    closeSetupDialog();
    syncBtn();
    setTimerText(0);
    setTip("");
  }

  async function rerecord() {
    await closeAll();
    openSetupDialog();
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
    if (!/mp4|avc1|h264/i.test(out.type || "")) {
      remuxing = true;
      setTip("正在转成 MP4…");
      try {
        const q = RES_PRESETS[resKey] || RES_PRESETS["720p"];
        out = await remuxToMp4(out, { width: q.w, height: q.h, fps, videoBits: q.bits });
        blob = out;
        revokeUrl();
        objectUrl = URL.createObjectURL(blob);
        if (playbackEl) playbackEl.src = objectUrl;
      } catch (err) {
        remuxing = false;
        toast(err?.message || "转 MP4 失败");
        return;
      } finally {
        remuxing = false;
      }
    }

    const name = `笔译录像_${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.mp4`;
    const Cap = window.Capacitor;
    const isNative = !!(Cap?.isNativePlatform && Cap.isNativePlatform());
    const FS = Cap?.Plugins?.Filesystem;
    const Media = Cap?.Plugins?.Media;
    setTip("正在保存 MP4…");
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
        toast(album ? "MP4 已保存到相册" : "MP4 已保存到 App 文件（pte-videos）");
        setTip(album ? "已保存到相册" : "已保存到本地");
        return;
      }
      const a = document.createElement("a");
      a.href = objectUrl || URL.createObjectURL(out);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast("已开始下载 MP4");
      setTip("已触发 MP4 下载");
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
    openSetupDialog();
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
    if (resize && resize.pid === e.pointerId) {
      const next = resize.startW + (e.clientX - resize.startX);
      applyFloatWidth(next, { persist: false });
      e.preventDefault();
      return;
    }
    if (!drag || drag.pid !== e.pointerId) return;
    placeFloat(e.clientX - drag.dx, e.clientY - drag.dy);
  }

  function onPointerUp(e) {
    if (resize && resize.pid === e.pointerId) {
      const w = applyFloatWidth(floatEl.getBoundingClientRect().width);
      resize = null;
      floatEl.classList.remove("is-resizing");
      try {
        resizeHandle?.releasePointerCapture?.(e.pointerId);
      } catch (_) {}
      setTip(`画面 ${w}px · 可再拖右下角缩放`);
      return;
    }
    if (!drag || drag.pid !== e.pointerId) return;
    drag = null;
    floatEl.classList.remove("is-dragging");
    try {
      floatEl.releasePointerCapture(e.pointerId);
    } catch (_) {}
  }

  function onResizeDown(e) {
    if (e.button != null && e.button !== 0) return;
    if (floatEl.classList.contains("is-minimized")) return;
    e.stopPropagation();
    e.preventDefault();
    const rect = floatEl.getBoundingClientRect();
    resize = { startX: e.clientX, startW: rect.width, pid: e.pointerId };
    drag = null;
    floatEl.classList.add("is-resizing");
    floatEl.classList.remove("is-dragging");
    try {
      resizeHandle.setPointerCapture(e.pointerId);
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
  setupCancel?.addEventListener("click", () => closeSetupDialog());
  setupStart?.addEventListener("click", () => confirmSetup());
  setupDialog?.addEventListener("click", (e) => {
    if (e.target === setupDialog) closeSetupDialog();
  });
  playbackEl?.addEventListener("ended", () => {
    if (playBtn) playBtn.textContent = "播放";
  });
  playbackEl?.addEventListener("pause", () => {
    if (playBtn && playbackEl.paused) playBtn.textContent = "播放";
  });
  playbackEl?.addEventListener("play", () => {
    if (playBtn) playBtn.textContent = "暂停";
  });

  floatEl.addEventListener("pointerdown", onPointerDown);
  floatEl.addEventListener("pointermove", onPointerMove);
  floatEl.addEventListener("pointerup", onPointerUp);
  floatEl.addEventListener("pointercancel", onPointerUp);
  resizeHandle?.addEventListener("pointerdown", onResizeDown);
  resizeHandle?.addEventListener("pointermove", onPointerMove);
  resizeHandle?.addEventListener("pointerup", onPointerUp);
  resizeHandle?.addEventListener("pointercancel", onPointerUp);
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

  return { open: () => openSetupDialog(), stop: () => closeAll() };
}
