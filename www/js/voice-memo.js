/** 顶栏录音：单击 开始 → 暂停 → 继续，双击完成，完成后下载到本机（交互同全文朗读）。 */

export function bindVoiceMemo({ $, toast }) {
  const btn = $("#btn-voice-memo");
  if (!btn || btn.dataset.bound === "1") return;
  btn.dataset.bound = "1";

  /** @type {"idle"|"recording"|"paused"} */
  let phase = "idle";
  let stream = null;
  let audioCtx = null;
  let sourceNode = null;
  let processor = null;
  let muteNode = null;
  /** @type {Float32Array[]} */
  let pcmChunks = [];
  let sampleRate = 48000;
  let startedAt = 0;
  let elapsed = 0;
  let timer = 0;
  let lamePromise = null;

  const labelEl = () => btn.querySelector("[data-voice-memo-label]");
  const timerEl = () => btn.querySelector("[data-voice-memo-timer]");

  function fmt(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, "0")}`;
  }

  function currentMs() {
    if (phase !== "recording") return elapsed;
    return elapsed + (Date.now() - startedAt);
  }

  function tick() {
    const time = timerEl();
    if (time) time.textContent = fmt(currentMs());
  }

  function render() {
    const label = labelEl();
    const time = timerEl();
    btn.classList.toggle("is-recording", phase === "recording");
    btn.classList.toggle("is-paused", phase === "paused");
    if (phase === "idle") {
      if (label) label.textContent = "录音";
      btn.title = "开始录音（录音中单击暂停/继续，双击完成）";
      if (time) {
        time.hidden = true;
        time.textContent = "0:00";
      }
      return;
    }
    if (label) label.textContent = phase === "recording" ? "暂停" : "继续";
    btn.title = "单击暂停/继续，双击完成录音";
    if (time) time.hidden = false;
    tick();
  }

  function startClock() {
    startedAt = Date.now();
    clearInterval(timer);
    timer = setInterval(tick, 250);
    tick();
  }

  function freezeClock() {
    if (phase === "recording") elapsed += Date.now() - startedAt;
    clearInterval(timer);
    timer = 0;
    tick();
  }

  function loadLame() {
    if (globalThis.lamejs?.Mp3Encoder) return Promise.resolve(globalThis.lamejs);
    if (lamePromise) return lamePromise;
    lamePromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = new URL("./vendor/lame.min.js", import.meta.url).href;
      script.onload = () => {
        if (globalThis.lamejs?.Mp3Encoder) resolve(globalThis.lamejs);
        else reject(new Error("lame"));
      };
      script.onerror = () => reject(new Error("lame"));
      document.head.appendChild(script);
    }).catch((err) => {
      lamePromise = null;
      throw err;
    });
    return lamePromise;
  }

  function stopStream() {
    try {
      processor?.disconnect();
      sourceNode?.disconnect();
      muteNode?.disconnect();
    } catch (_) {}
    processor = null;
    sourceNode = null;
    muteNode = null;
    try {
      audioCtx?.close();
    } catch (_) {}
    audioCtx = null;
    try {
      stream?.getTracks?.().forEach((t) => t.stop());
    } catch (_) {}
    stream = null;
  }

  function reset() {
    clearInterval(timer);
    timer = 0;
    stopStream();
    pcmChunks = [];
    elapsed = 0;
    phase = "idle";
    render();
  }

  /** 线性重采样（续录时设备采样率变了才用到） */
  function resampleLinear(input, from, to) {
    if (from === to) return new Float32Array(input);
    const ratio = from / to;
    const n = Math.max(1, Math.round(input.length / ratio));
    const out = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      const pos = i * ratio;
      const i0 = Math.floor(pos);
      const i1 = Math.min(input.length - 1, i0 + 1);
      const f = pos - i0;
      out[i] = input[i0] * (1 - f) + input[i1] * f;
    }
    return out;
  }

  /**
   * 打开麦克风并开始采集。
   * keepRate=true 用于续录：沿用首段采样率，保证拼接后的 MP3 不跑调。
   */
  async function openCapture({ keepRate = false } = {}) {
    try {
      // 关掉回声消除 / 降噪 / 自动增益：iOS 上开着会进入语音通话处理，
      // 同时朗读意群时会出现电流声；这里是纯录音，不需要
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      });
    } catch (_) {
      toast("没有麦克风权限");
      return false;
    }
    try {
      try {
        audioCtx = keepRate ? new AudioContext({ sampleRate }) : new AudioContext();
      } catch (_) {
        audioCtx = new AudioContext();
      }
      const ctxRate = audioCtx.sampleRate || 48000;
      if (!keepRate) sampleRate = ctxRate;
      sourceNode = audioCtx.createMediaStreamSource(stream);
      processor = audioCtx.createScriptProcessor(4096, 1, 1);
      muteNode = audioCtx.createGain();
      muteNode.gain.value = 0;
      processor.onaudioprocess = (e) => {
        if (phase !== "recording") return;
        const input = e.inputBuffer.getChannelData(0);
        pcmChunks.push(resampleLinear(input, ctxRate, sampleRate));
      };
      sourceNode.connect(processor);
      processor.connect(muteNode);
      muteNode.connect(audioCtx.destination);
      if (audioCtx.state === "suspended") await audioCtx.resume();
      return true;
    } catch (_) {
      stopStream();
      toast("无法开始录音");
      return false;
    }
  }

  async function start() {
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === "undefined") {
      toast("当前环境不能录音");
      return;
    }
    try {
      await loadLame();
    } catch (_) {
      toast("MP3 编码器加载失败");
      return;
    }
    pcmChunks = [];
    if (!(await openCapture())) return; // 失败原因已在 openCapture 内提示
    elapsed = 0;
    phase = "recording";
    render();
    startClock();
  }

  function pause() {
    if (phase !== "recording") return;
    freezeClock();
    phase = "paused";
    render();
  }

  /** 切后台 / 锁屏 / 退出：自动暂停，并释放麦克风（已录内容保留，回来点「继续」接着录） */
  let autoPaused = false;
  function autoPauseOnLeave() {
    if (phase !== "recording") return;
    pause();
    stopStream();
    autoPaused = true;
  }

  let resuming = false;
  async function resume() {
    if (phase !== "paused" || resuming) return;
    if (!stream) {
      // 自动暂停时已释放麦克风：重新打开，沿用首段采样率
      resuming = true;
      const ok = await openCapture({ keepRate: true });
      resuming = false;
      if (!ok) {
        toast("无法恢复录音，可点「完成」保存已录部分");
        return;
      }
    }
    autoPaused = false;
    phase = "recording";
    render();
    startClock();
  }

  function articleTitle() {
    const titleEl = document.querySelector("#q-name .q-title-text");
    const fromTitle = titleEl?.textContent?.replace(/\s+/g, " ").trim() || "";
    const raw = fromTitle || document.querySelector("#q-name")?.textContent?.replace(/\s+/g, " ").trim() || "";
    const title = (fromTitle ? raw : raw.replace(/^#\s*\d+\s*/, "").trim()) || "录音";
    return title
      .replace(/[\/\\:*?"<>|\n\r\t]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 72) || "录音";
  }

  function filename() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${articleTitle()}-${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.mp3`;
  }

  function floatToI16(samples) {
    const out = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i += 1) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  function encodeMp3(chunks, rate) {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const pcm = new Int16Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      pcm.set(floatToI16(chunk), offset);
      offset += chunk.length;
    }
    const encoder = new globalThis.lamejs.Mp3Encoder(1, rate, 128);
    const blocks = [];
    const step = 1152;
    for (let i = 0; i < pcm.length; i += step) {
      const buf = encoder.encodeBuffer(pcm.subarray(i, i + step));
      if (buf.length) blocks.push(buf);
    }
    const end = encoder.flush();
    if (end.length) blocks.push(end);
    return new Blob(blocks, { type: "audio/mpeg" });
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function isNativeApp() {
    const Cap = globalThis.Capacitor;
    return !!(Cap?.isNativePlatform && Cap.isNativePlatform());
  }

  function isCancel(err) {
    return err?.name === "AbortError" || /AbortError|cancel/i.test(String(err?.message || err || ""));
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error || new Error("read"));
      reader.onload = () => {
        const s = String(reader.result || "");
        resolve(s.slice(s.indexOf(",") + 1));
      };
      reader.readAsDataURL(blob);
    });
  }

  /** 桌面 / 浏览器：弹出系统「另存为」，让用户选位置。必须在点击手势内调用。 */
  async function pickSaveHandle(name) {
    if (isNativeApp() || typeof globalThis.showSaveFilePicker !== "function") return null;
    try {
      return await globalThis.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: "MP3 音频", accept: { "audio/mpeg": [".mp3"] } }],
      });
    } catch (err) {
      if (isCancel(err)) throw err;
      return null; // 其他原因不可用：回退为普通下载
    }
  }

  /** iPhone：写入缓存后拉起系统分享面板，可选「存储到文件」指定文件夹 */
  async function saveNative(blob, name) {
    const Cap = globalThis.Capacitor;
    const FS = Cap?.Plugins?.Filesystem;
    const Share = Cap?.Plugins?.Share;
    if (!FS?.writeFile || !Share?.share) return false;
    const data = await blobToBase64(blob);
    const dir = "voice-memos";
    try {
      await FS.mkdir({ path: dir, directory: "CACHE", recursive: true });
    } catch (_) {}
    const path = `${dir}/${name}`;
    await FS.writeFile({ path, data, directory: "CACHE" });
    const res = await FS.getUri({ path, directory: "CACHE" });
    const uri = res?.uri || "";
    if (!uri) throw new Error("无法准备录音文件");
    await Share.share({ title: name, url: uri, dialogTitle: "选择保存位置" });
    return true;
  }

  let saving = false;

  async function finish() {
    if (phase === "idle" || saving) return;
    // 先暂停计时/采集，避免弹窗期间继续录
    if (phase === "recording") pause();
    const name = filename();

    // 桌面端：先让用户选位置；取消则保留录音，不丢数据
    let handle = null;
    try {
      handle = await pickSaveHandle(name);
    } catch (_) {
      toast("已取消，录音仍保留，可继续录或再点「完成」");
      return;
    }

    const samples = pcmChunks.slice();
    const rate = sampleRate;
    reset();
    if (!samples.length) {
      toast("没有录到声音");
      return;
    }
    saving = true;
    try {
      const blob = encodeMp3(samples, rate);
      if (!blob.size) {
        toast("没有录到声音");
        return;
      }
      let done = false;
      if (handle) {
        try {
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
          toast(`录音已保存：${handle.name || name}`);
          done = true;
        } catch (err) {
          if (isCancel(err)) throw err;
          // 部分环境（内置调试浏览器等）给了句柄却不允许写入：回退为普通下载
          console.warn("save handle write failed, fallback to download", err);
          // 选位置时系统已先建了一个空文件，写入失败要清掉，免得留下 0 字节垃圾
          try {
            await handle.remove?.();
          } catch (_) {}
        }
      }
      if (done) {
        // 已保存
      } else if (!handle && isNativeApp() && (await saveNative(blob, name))) {
        toast("请在分享面板选择「存储到文件」");
      } else {
        download(blob, name);
        toast("录音已保存为 MP3");
      }
    } catch (err) {
      if (isCancel(err)) {
        toast("已取消保存");
      } else {
        console.warn(err);
        toast("保存 MP3 失败");
      }
    } finally {
      saving = false;
    }
  }

  // 单击暂停/继续（延迟执行以区分双击），双击完成
  const DBLCLICK_MS = 260;
  let clickTimer = 0;
  btn.addEventListener("click", () => {
    if (phase === "idle") {
      start().catch((err) => console.warn(err));
      return;
    }
    if (clickTimer) {
      clearTimeout(clickTimer);
      clickTimer = 0;
      finish();
      return;
    }
    clickTimer = setTimeout(() => {
      clickTimer = 0;
      if (phase === "recording") pause();
      else if (phase === "paused") resume();
    }, DBLCLICK_MS);
  });

  // 切后台、锁屏、退出应用时自动暂停录音
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      autoPauseOnLeave();
    } else if (autoPaused && phase === "paused") {
      toast("录音已自动暂停，点「继续」接着录");
    }
  });
  window.addEventListener("pagehide", autoPauseOnLeave);
  document.addEventListener("freeze", autoPauseOnLeave);

  render();
}
