/** Edge 联网朗读 + 苹果本机 speechSynthesis。合成结果（联网）写入本机缓存。 */

import { archiveSpeechClip, loadSpeechBlob } from "./tts-cache.js?v=20261012dl";
import { ensureLockFonts, isLockStressOn, lockFontSpec, renderLockArtwork, splitForLockScreen } from "./lock-screen.js?v=20261012dl";

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const GEC_VERSION = "1-143.0.3650.75";
const VOICE = "en-US-EmmaMultilingualNeural";

/** 联网可选的声音（Edge 神经语音）。默认 Emma，缓存键与旧版一致 */
export const ONLINE_VOICES = [
  { id: "en-US-EmmaMultilingualNeural", label: "Emma · 美式女声（默认）" },
  { id: "en-US-AriaNeural", label: "Aria · 美式女声" },
  { id: "en-US-JennyNeural", label: "Jenny · 美式女声" },
  { id: "en-US-AvaMultilingualNeural", label: "Ava · 美式女声" },
  { id: "en-US-AndrewMultilingualNeural", label: "Andrew · 美式男声" },
  { id: "en-US-BrianMultilingualNeural", label: "Brian · 美式男声" },
  { id: "en-US-GuyNeural", label: "Guy · 美式男声" },
  { id: "en-US-ChristopherNeural", label: "Christopher · 美式男声" },
  { id: "en-GB-SoniaNeural", label: "Sonia · 英式女声" },
  { id: "en-GB-RyanNeural", label: "Ryan · 英式男声" },
  { id: "en-AU-NatashaNeural", label: "Natasha · 澳洲女声" },
];

const VOICE_PREF_KEY = "biyi_fulltext_voice_";

/** 用户选的声音（按引擎分别记）。「全文朗读」和「笔译」共用 */
export function getSavedVoice(engine = getTtsEngine()) {
  try {
    return localStorage.getItem(VOICE_PREF_KEY + engine) || "";
  } catch (_) {
    return "";
  }
}

export function setSavedVoice(id, engine = getTtsEngine()) {
  try {
    localStorage.setItem(VOICE_PREF_KEY + engine, id || "");
  } catch (_) {}
}

/** 音色列表里的「按顺序」：每读完一个意群换下一个声音，读完一圈再从头 */
export const ROTATE_VOICE = "__rotate__";

export function isRotateVoice(id) {
  return String(id || "").trim() === ROTATE_VOICE;
}

const rotateIndex = { online: 0, apple: 0 };
let cachedAppleVoiceIds = [];

export function rememberAppleVoices(voices) {
  cachedAppleVoiceIds = (Array.isArray(voices) ? voices : [])
    .map((v) => String(v?.id || v || "").trim())
    .filter(Boolean);
}

export function rotateVoicesOf(engine) {
  if ((engine === "apple" ? "apple" : "online") === "apple") return cachedAppleVoiceIds.slice();
  return ONLINE_VOICES.map((v) => v.id);
}

function rotateBucket(engine) {
  return engine === "apple" ? "apple" : "online";
}

export function getRotateIndex(engine) {
  const key = rotateBucket(engine);
  const n = Number(rotateIndex[key]) || 0;
  return n >= 0 ? Math.floor(n) : 0;
}

export function setRotateIndex(engine, i) {
  rotateIndex[rotateBucket(engine)] = Math.max(0, Math.floor(Number(i) || 0));
}

export function rotateVoiceAt(engine, offset) {
  const list = rotateVoicesOf(engine);
  if (!list.length) return "";
  const i = ((Number(offset) || 0) % list.length + list.length) % list.length;
  return list[i];
}

export function peekRotateVoice(engine) {
  const list = rotateVoicesOf(engine);
  if (!list.length) return "";
  return list[getRotateIndex(engine) % list.length];
}

export function advanceRotateVoice(engine) {
  const list = rotateVoicesOf(engine);
  if (!list.length) return "";
  const i = getRotateIndex(engine) % list.length;
  setRotateIndex(engine, (i + 1) % list.length);
  return list[i];
}

export function resolvePlayVoice(engine = getTtsEngine(), requested) {
  const id = requested == null || requested === "" ? getSavedVoice(engine) : requested;
  if (isRotateVoice(id)) return peekRotateVoice(engine);
  return id;
}

function onlineVoice(id) {
  const v = String(id || "").trim();
  return ONLINE_VOICES.some((o) => o.id === v) ? v : VOICE;
}

/** 联网朗读缓存键：默认声音沿用纯文本（旧缓存继续可用），其他声音带上声音名 */
export function voiceCacheKey(text, voice) {
  const v = onlineVoice(voice);
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return v === VOICE ? t : `${v}|${t}`;
}
const TTS_ENGINE_KEY = "biyi_tts_engine";
const AudioCtx = typeof window !== "undefined"
  ? (window.AudioContext || window.webkitAudioContext)
  : null;

function isIosCapacitor() {
  try {
    return String(globalThis.Capacitor?.getPlatform?.() || "").toLowerCase() === "ios";
  } catch {
    return false;
  }
}

/** @returns {'online'|'apple'} */
export function getTtsEngine() {
  try {
    const v = String(localStorage.getItem(TTS_ENGINE_KEY) || "").trim();
    if (v === "apple" || v === "online") return v;
  } catch (_) {}
  // iPhone 默认本机，避免联网 Edge 卡顿
  return isIosCapacitor() ? "apple" : "online";
}

/** @param {'online'|'apple'|string} engine */
export function setTtsEngine(engine) {
  const next = engine === "apple" ? "apple" : "online";
  try {
    localStorage.setItem(TTS_ENGINE_KEY, next);
  } catch (_) {}
  return next;
}

function edgeTimestamp() {
  const d = new Date();
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p = (n) => String(n).padStart(2, "0");
  return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${p(d.getUTCDate())} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`;
}

async function secMsGec() {
  const winEpoch = 11644473600;
  let ticks = Date.now() / 1000 + winEpoch;
  ticks -= ticks % 300;
  ticks = Math.round(ticks * 1e7);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${ticks}${TRUSTED_CLIENT_TOKEN}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function escapeXml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function ssml(text, voice) {
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${onlineVoice(voice)}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>${escapeXml(text)}</prosody></voice></speak>`;
}

function concatBytes(parts) {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function parseAudioFrame(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 2) return null;
  const headerLen = new DataView(buffer).getUint16(0);
  if (headerLen + 2 > buffer.byteLength) return null;
  const header = new TextDecoder().decode(new Uint8Array(buffer, 2, headerLen));
  if (!header.includes("Path:audio") || !header.includes("audio/mpeg")) return null;
  return new Uint8Array(buffer, 2 + headerLen);
}

export async function synthesizeHttp(text, signal, onProgress, voice) {
  const targets = [];
  if (location.protocol === "http:" || location.protocol === "https:") targets.push(`${location.origin}/tts`);
  if (!targets.includes("http://127.0.0.1:8767/tts")) targets.push("http://127.0.0.1:8767/tts");
  let last = new Error("tts failed");
  for (const url of targets) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voice: onlineVoice(voice) }),
        signal,
      });
      if (!res.ok) throw new Error(String(res.status));
      let blob;
      if (onProgress && res.body?.getReader) {
        // 流式读取，边收边上报进度（总量按文本长度估算，压在 95% 内）
        const total = Number(res.headers.get("content-length")) || 0;
        const est = total || Math.max(6000, String(text || "").length * EST_BYTES_PER_CHAR);
        const reader = res.body.getReader();
        const parts = [];
        let got = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value?.byteLength) {
            parts.push(value);
            got += value.byteLength;
            onProgress({ ratio: Math.min(0.95, got / est) });
          }
        }
        blob = new Blob(parts, { type: res.headers.get("content-type") || "audio/mpeg" });
      } else {
        blob = await res.blob();
      }
      if (!blob.size) throw new Error("empty");
      return blob;
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      last = err;
    }
  }
  throw last;
}

/** 48kbps mp3 ≈ 6000 B/s，朗读约 15 字符/秒 → 每字符约 400 字节，用来估算进度 */
const EST_BYTES_PER_CHAR = 400;

function synthesizeDirect(text, signal, onProgress, voice) {
  const spoken = String(text || "").replace(/\s+/g, " ").trim();
  if (!spoken) return Promise.reject(new Error("empty"));
  const estTotal = Math.max(6000, spoken.length * EST_BYTES_PER_CHAR);
  let received = 0;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      fn(value);
    };
    const fail = (err) => finish(reject, err);
    const ok = (value) => finish(resolve, value);
    const onAbort = () => {
      try { ws.close(); } catch (_) {}
      fail(new DOMException("aborted", "AbortError"));
    };
    if (signal?.aborted) {
      fail(new DOMException("aborted", "AbortError"));
      return;
    }
    let ws;
    const chunks = [];
    const timer = setTimeout(() => {
      try { ws?.close(); } catch (_) {}
      fail(new Error("timeout"));
    }, 20000);
    secMsGec().then((gec) => {
      if (signal?.aborted) {
        clearTimeout(timer);
        fail(new DOMException("aborted", "AbortError"));
        return;
      }
      const id = crypto.randomUUID().replace(/-/g, "");
      const url = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&ConnectionId=${id}&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=${GEC_VERSION}`;
      ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      signal?.addEventListener("abort", onAbort, { once: true });
      ws.addEventListener("open", () => {
        const ts = edgeTimestamp();
        ws.send(
          `X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${JSON.stringify({
            context: {
              synthesis: {
                audio: {
                  metadataoptions: { sentenceBoundaryEnabled: "false", wordBoundaryEnabled: "false" },
                  outputFormat: "audio-24khz-48kbitrate-mono-mp3",
                },
              },
            },
          })}`
        );
        const req = crypto.randomUUID().replace(/-/g, "");
        ws.send(`X-RequestId:${req}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}Z\r\nPath:ssml\r\n\r\n${ssml(spoken, voice)}`);
      });
      ws.addEventListener("message", (ev) => {
        if (typeof ev.data === "string") {
          if (ev.data.includes("Path:turn.end")) {
            clearTimeout(timer);
            try { ws.close(); } catch (_) {}
            if (!chunks.length) fail(new Error("no audio"));
            else ok(new Blob([concatBytes(chunks)], { type: "audio/mpeg" }));
          }
          return;
        }
        const frame = parseAudioFrame(ev.data);
        if (frame?.byteLength) {
          chunks.push(frame);
          received += frame.byteLength;
          // 总量只能估算：压在 95% 以内，真正完成时再到 100%
          onProgress?.({ ratio: Math.min(0.95, received / estTotal) });
        }
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        fail(new Error("tts failed"));
      });
      ws.addEventListener("close", () => {
        clearTimeout(timer);
        if (!settled) fail(new Error("closed"));
      });
    }).catch((err) => {
      clearTimeout(timer);
      fail(err);
    });
  });
}

export function synthesizeEdgeSpeech(text, signal, onProgress, voice) {
  return synthesizeDirect(text, signal, onProgress, voice).catch((err) => {
    if (signal?.aborted || err?.name === "AbortError") throw err;
    // 直连失败，改走本机代理；代理也是流式的，同样上报进度
    onProgress?.({ ratio: 0 });
    return synthesizeHttp(text, signal, onProgress, voice);
  });
}

function limitConcurrent(max) {
  let active = 0;
  const queue = [];
  const pump = () => {
    while (active < max && queue.length) {
      active += 1;
      const job = queue.shift();
      job().finally(() => {
        active -= 1;
        pump();
      });
    }
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push(() => fn().then(resolve, reject));
    pump();
  });
}

const WORD_GAP = 0.04;
const AUTO_GAP = 0.22;
const AUTO_RATE = 0.9;

function speechBounds(buffer) {
  const data = buffer.getChannelData(0);
  const rate = buffer.sampleRate;
  const win = Math.max(1, Math.floor(rate * 0.008));
  const thresh = 0.012;
  let first = -1;
  let last = -1;
  for (let i = 0; i + win <= data.length; i += win) {
    let peak = 0;
    for (let j = 0; j < win; j++) {
      const v = Math.abs(data[i + j]);
      if (v > peak) peak = v;
    }
    if (peak >= thresh) {
      if (first < 0) first = i;
      last = i + win;
    }
  }
  if (first < 0 || last <= first) return { start: 0, end: buffer.duration };
  const pad = Math.floor(rate * 0.02);
  return {
    start: Math.max(0, first - pad) / rate,
    end: Math.min(data.length, last + pad) / rate,
  };
}

function pickEnglishVoice(voiceURI = "") {
  try {
    const voices = window.speechSynthesis?.getVoices?.() || [];
    if (voiceURI) {
      const chosen = voices.find((v) => v.voiceURI === voiceURI);
      if (chosen) return chosen;
    }
    const en = voices.filter((v) => /^en(-|_)/i.test(String(v.lang || "")));
    if (!en.length) return null;
    const score = (v) => {
      let s = 0;
      const n = String(v.name || "");
      const lang = String(v.lang || "");
      // Compact/Eloquence 发闷断气，务必降权
      if (/compact|eloquence/i.test(n)) s -= 100;
      if (/premium/i.test(n)) s += 90;
      if (/enhanced|neural|siri|quality|super/i.test(n)) s += 70;
      if (/Samantha|Ava|Zoe|Allison|Susan|Karen|Moira|Daniel|Aaron|Nicky|Evan|Serena|Martha/i.test(n)) {
        s += 25;
      }
      if (/en-US/i.test(lang)) s += 12;
      else if (/en-GB|en-AU|en-IE/i.test(lang)) s += 6;
      if (v.localService) s += 8;
      if (v.default) s += 2;
      return s;
    };
    return [...en].sort((a, b) => score(b) - score(a))[0] || null;
  } catch (_) {
    return null;
  }
}

function appleSpeechPlugin() {
  try {
    const Cap = globalThis.Capacitor;
    if (!Cap?.isNativePlatform?.()) return null;
    if (Cap.Plugins?.AppleSpeech) return Cap.Plugins.AppleSpeech;
    if (typeof Cap.registerPlugin === "function") {
      return Cap.registerPlugin("AppleSpeech");
    }
  } catch (_) {}
  return null;
}

let screenKeepOn = false;
let wakeSentinel = null;
let wakeBound = false;

function bindWakeVisibility() {
  if (wakeBound || typeof document === "undefined") return;
  wakeBound = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && screenKeepOn) keepScreenOn(true);
  });
}

/** 全文朗读期间不要自动锁屏 / 息屏（回到前台会再要一次） */
function keepScreenOn(on) {
  screenKeepOn = !!on;
  bindWakeVisibility();
  const plugin = appleSpeechPlugin();
  if (plugin?.setIdleTimer) {
    Promise.resolve(plugin.setIdleTimer({ disabled: screenKeepOn })).catch(() => {});
  }
  Promise.resolve()
    .then(async () => {
      try {
        if (screenKeepOn && navigator.wakeLock?.request) {
          if (wakeSentinel) return;
          wakeSentinel = await navigator.wakeLock.request("screen");
          wakeSentinel.addEventListener?.("release", () => {
            wakeSentinel = null;
          });
        } else if (!screenKeepOn && wakeSentinel) {
          await wakeSentinel.release();
          wakeSentinel = null;
        }
      } catch (_) {}
    })
    .catch(() => {});
}

function stopAppleSpeechNative() {
  const plugin = appleSpeechPlugin();
  if (!plugin?.stop) return Promise.resolve();
  return Promise.resolve(plugin.stop()).catch(() => {});
}

/** 朗读 promise 永不 resolve 是「界面卡死、之后全都没声」的头号来源：一律给超时兜底 */
function withSpeechTimeout(promise, text, label) {
  const ms = Math.min(120000, 10000 + String(text || "").length * 250);
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label || "speech"}-timeout`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

let lastAppleVoiceKey = "";

function announceAppleSystemVoice(info) {
  if (!info || typeof info !== "object") return;
  const key = `${info.voiceId || ""}|${info.voiceName || ""}|${info.quality || ""}`;
  if (!key || key === "|" || key === lastAppleVoiceKey) return;
  lastAppleVoiceKey = key;
  try {
    console.info("[AppleSpeech] system voice", info);
  } catch (_) {}
  try {
    document.dispatchEvent(new CustomEvent("biyi-apple-speech-voice", { detail: { ...info } }));
  } catch (_) {}
}

/** 本机朗读：每次先实时查系统当前英文语音，再用该语音读；失败/超时自动停掉重试一次，再回退 web */
async function playLocalAppleSpeech(text, mine, getSession, { rate = 0.92, voiceId = "" } = {}) {
  const spoken = String(text || "").replace(/\s+/g, " ").trim();
  if (!spoken) return;
  if (getSession && getSession() !== mine) return;
  const plugin = appleSpeechPlugin();
  if (plugin?.speak) {
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (getSession && getSession() !== mine) return;
      try {
        if (attempt === 0 && typeof plugin.currentVoice === "function") {
          // 朗读前实时问系统：当前默认英文语音是谁
          const live = await plugin.currentVoice();
          if (getSession && getSession() !== mine) return;
          announceAppleSystemVoice(live);
        }
        const res = await withSpeechTimeout(plugin.speak({ text: spoken, rate, voiceId }), spoken, "apple-speak");
        if (getSession && getSession() !== mine) return;
        announceAppleSystemVoice(res);
        return;
      } catch (err) {
        lastErr = err;
        console.warn(`AppleSpeech native attempt ${attempt + 1} failed`, err);
        // 停掉卡死的原生任务：原生侧会把旧合成器作废，重试时换新实例开口
        await stopAppleSpeechNative();
      }
    }
    console.warn("AppleSpeech native failed twice, fallback web", lastErr);
  }
  await playSpeechSynthesis(spoken, mine, getSession, { rate, voiceId });
}

function ensureVoicesReady() {
  if (!window.speechSynthesis) return Promise.resolve([]);
  try {
    const now = window.speechSynthesis.getVoices?.() || [];
    if (now.length) return Promise.resolve(now);
  } catch (_) {}
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        window.speechSynthesis.removeEventListener("voiceschanged", finish);
      } catch (_) {}
      try {
        resolve(window.speechSynthesis.getVoices?.() || []);
      } catch (_) {
        resolve([]);
      }
    };
    try {
      window.speechSynthesis.addEventListener("voiceschanged", finish);
    } catch (_) {}
    try {
      window.speechSynthesis.getVoices?.();
    } catch (_) {}
    setTimeout(finish, 900);
  });
}

function playSpeechSynthesis(text, mine, getSession, { rate = 0.92, voiceId = "" } = {}) {
  const spoken = String(text || "").replace(/\s+/g, " ").trim();
  if (!spoken || !window.speechSynthesis) return Promise.reject(new Error("no speechSynthesis"));
  return ensureVoicesReady().then(
    () =>
      new Promise((resolve, reject) => {
        try {
          window.speechSynthesis.cancel();
        } catch (_) {}
        const utter = new SpeechSynthesisUtterance(spoken);
        utter.lang = "en-US";
        utter.rate = rate;
        const voice = pickEnglishVoice(voiceId);
        if (voice) {
          utter.voice = voice;
          if (voice.lang) utter.lang = voice.lang;
        }
        let settled = false;
        let timer = null;
        const done = (ok, err) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (ok) resolve();
          else reject(err || new Error("speechSynthesis"));
        };
        utter.onend = () => done(true);
        utter.onerror = () => done(false, new Error("speechSynthesis"));
        // iOS WKWebView 上 onend/onerror 可能永不触发：超时取消并放行，避免界面卡死
        timer = setTimeout(() => {
          try { window.speechSynthesis.cancel(); } catch (_) {}
          done(false, new Error("speechSynthesis-timeout"));
        }, Math.min(120000, 8000 + spoken.length * 200));
        if (getSession && getSession() !== mine) {
          done(true);
          return;
        }
        window.speechSynthesis.speak(utter);
      })
  );
}

export function createEdgeSpeech() {
  let ctrl = new AbortController();
  let urls = [];
  let wordJobs = new Map();
  let fullJob = null;
  let passageText = "";
  let player = null;
  let session = 0;
  let audioCtx = null;
  let sources = [];
  let unlocked = false;

  let finishPlay = null;
  let asidePlayer = null;
  let asideUrl = "";
  let asideToken = 0;

  function stopAside() {
    asideToken += 1;
    if (asidePlayer) {
      try {
        asidePlayer.onended = null;
        asidePlayer.onerror = null;
        asidePlayer.pause();
        asidePlayer.removeAttribute("src");
      } catch (_) {}
      asidePlayer = null;
    }
    if (asideUrl) {
      try { URL.revokeObjectURL(asideUrl); } catch (_) {}
      asideUrl = "";
    }
    const plugin = appleSpeechPlugin();
    if (plugin?.stopAside) Promise.resolve(plugin.stopAside()).catch(() => {});
  }

  function playAsideBlob(blob, token) {
    return new Promise((resolve) => {
      if (token !== asideToken || !blob) {
        resolve();
        return;
      }
      const url = URL.createObjectURL(blob);
      asideUrl = url;
      const a = new Audio();
      asidePlayer = a;
      a.src = url;
      const done = () => {
        if (asidePlayer === a) asidePlayer = null;
        try { URL.revokeObjectURL(url); } catch (_) {}
        if (asideUrl === url) asideUrl = "";
        resolve();
      };
      a.onended = done;
      a.onerror = done;
      a.play().catch(() => done());
    });
  }

  function playSpeechSynthesisAside(text, voiceId) {
    const spoken = String(text || "").trim();
    if (!spoken || !window.speechSynthesis) return Promise.resolve();
    return new Promise((resolve) => {
      const utter = new SpeechSynthesisUtterance(spoken);
      utter.lang = "en-US";
      utter.rate = 0.92;
      const voice = pickEnglishVoice(voiceId);
      if (voice) {
        utter.voice = voice;
        if (voice.lang) utter.lang = voice.lang;
      }
      let settled = false;
      let timer = null;
      const done = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve();
      };
      utter.onend = done;
      utter.onerror = done;
      timer = setTimeout(() => {
        try { window.speechSynthesis.cancel(); } catch (_) {}
        done();
      }, Math.min(60000, 6000 + spoken.length * 200));
      try {
        window.speechSynthesis.speak(utter);
      } catch (_) {
        done();
      }
    });
  }

  // ---- 暂停 / 继续（全文朗读点一下暂停、再点继续） ----
  let paused = false;
  let pausedParts = [];
  let nativeQueue = false;
  let resumeWaiters = [];

  function emitPause() {
    try {
      document.dispatchEvent(new CustomEvent("biyi-speech-pause", { detail: { paused } }));
    } catch (_) {}
  }

  /** 暂停中就一直等；继续或停止时放行。播放前 / 句间调用 */
  function waitIfPaused() {
    return paused ? new Promise((resolve) => resumeWaiters.push(resolve)) : Promise.resolve();
  }

  function flushResumeWaiters() {
    const list = resumeWaiters;
    resumeWaiters = [];
    for (const fn of list) fn();
  }

  function isPaused() {
    return paused;
  }

  function pausePlayback() {
    if (paused) return true;
    paused = true;
    pausedParts = [];
    const plugin = appleSpeechPlugin();
    if (plugin?.pause && (nativeQueue || getTtsEngine() === "apple")) {
      Promise.resolve(plugin.pause()).catch(() => {});
      pausedParts.push("native");
    }
    if (player?.getAttribute?.("src") && !player.paused && !player.ended) {
      player.pause();
      pausedParts.push("player");
    }
    if (audioCtx && audioCtx.state === "running" && sources.length) {
      Promise.resolve(audioCtx.suspend()).catch(() => {});
      pausedParts.push("ctx");
    }
    try {
      const synth = window.speechSynthesis;
      if (synth?.speaking && !synth.paused) {
        synth.pause();
        pausedParts.push("synth");
      }
    } catch (_) {}
    emitPause();
    return true;
  }

  function resumePlayback() {
    if (!paused) return false;
    paused = false;
    const parts = pausedParts;
    pausedParts = [];
    if (parts.includes("native")) {
      const plugin = appleSpeechPlugin();
      if (plugin?.resume) Promise.resolve(plugin.resume()).catch(() => {});
    }
    if (parts.includes("player")) player?.play?.().catch(() => {});
    if (parts.includes("ctx")) Promise.resolve(audioCtx?.resume?.()).catch(() => {});
    if (parts.includes("synth")) {
      try { window.speechSynthesis?.resume?.(); } catch (_) {}
    }
    flushResumeWaiters();
    emitPause();
    return true;
  }

  /** 停止 / 换成别的朗读时：丢弃暂停状态，并把被挂起的底层放开 */
  function clearPause() {
    if (!paused) return;
    paused = false;
    pausedParts = [];
    try { audioCtx?.resume?.().catch(() => {}); } catch (_) {}
    try { window.speechSynthesis?.resume?.(); } catch (_) {}
    flushResumeWaiters();
    emitPause();
  }

  function audioContext() {
    if (!AudioCtx) throw new Error("no AudioContext");
    if (!audioCtx || audioCtx.state === "closed") audioCtx = new AudioCtx();
    return audioCtx;
  }

  function unlockAudio() {
    if (unlocked) {
      try { return audioContext().resume().catch(() => {}); } catch (_) { return Promise.resolve(); }
    }
    unlocked = true;
    try {
      const ctx = audioContext();
      return ctx.resume().catch(() => {}).then(() => {
        try {
          const buf = ctx.createBuffer(1, 1, 22050);
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.connect(ctx.destination);
          src.start(0);
        } catch (_) {}
      });
    } catch (_) {
      return Promise.resolve();
    }
  }

  if (typeof document !== "undefined") {
    const once = () => {
      unlockAudio();
      document.removeEventListener("touchstart", once, true);
      document.removeEventListener("pointerdown", once, true);
      document.removeEventListener("keydown", once, true);
    };
    document.addEventListener("touchstart", once, true);
    document.addEventListener("pointerdown", once, true);
    document.addEventListener("keydown", once, true);
    try { window.speechSynthesis?.getVoices?.(); } catch (_) {}
  }

  function connectAudible(node) {
    node.connect(node.context.destination);
  }

  async function decodeBlob(blob) {
    const ctx = audioContext();
    const ab = await blob.arrayBuffer();
    // iOS decodeAudioData 会 detach buffer，必须传拷贝
    const copy = ab.slice(0);
    return ctx.decodeAudioData(copy);
  }

  function stopSources() {
    for (const src of sources) {
      try { src.onended = null; src.stop(); } catch (_) {}
    }
    sources = [];
  }

  function stopPlayer() {
    if (!player) return;
    player.onended = null;
    player.onerror = null;
    player.pause();
    player.removeAttribute("src");
    try { player.load(); } catch (_) {}
  }

  function stopSpeechSynthesis() {
    try { window.speechSynthesis?.cancel?.(); } catch (_) {}
    stopAppleSpeechNative();
  }

  function haltAudio() {
    stopAside();
    clearPause();
    const done = finishPlay;
    finishPlay = null;
    stopSources();
    stopPlayer();
    stopSpeechSynthesis();
    done?.();
  }

  function stop() {
    session += 1;
    haltAudio();
  }

  function release() {
    ctrl.abort();
    ctrl = new AbortController();
    stop();
    for (const url of urls) {
      try { URL.revokeObjectURL(url); } catch (_) {}
    }
    urls = [];
    wordJobs = new Map();
    fullJob = null;
    passageText = "";
  }

  function keep(blob) {
    const url = URL.createObjectURL(blob);
    urls.push(url);
    return url;
  }

  function prepare(passage, words) {
    release();
    passageText = String(passage || "").replace(/\s+/g, " ").trim();
    // 本机朗读：不预拉 Edge，立刻可说
    if (getTtsEngine() === "apple") {
      ensureVoicesReady().catch(() => {});
      return;
    }
    const signal = ctrl.signal;
    const run = limitConcurrent(3);
    const savedOnline = getSavedVoice("online");
    const voiceId = (isRotateVoice(savedOnline) ? peekRotateVoice("online") : savedOnline) || undefined;
    const unique = [];
    const seen = new Set();
    for (const word of words) {
      const key = String(word || "").toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      unique.push(word);
    }
    for (const word of unique) {
      const key = word.toLowerCase();
      wordJobs.set(key, run(async () => {
        const blob = await loadSpeechBlob(voiceCacheKey(word, voiceId), () => synthesizeEdgeSpeech(word, undefined, undefined, voiceId));
        if (signal.aborted || !blob) return null;
        try {
          const buffer = await decodeBlob(blob);
          if (signal.aborted) return null;
          const { start, end } = speechBounds(buffer);
          return { buffer, start, end, text: word };
        } catch (_) {
          if (signal.aborted) return null;
          return { url: keep(blob), text: word };
        }
      }));
    }
    const line = passageText;
    if (line) {
      fullJob = run(async () => {
        const blob = await loadSpeechBlob(voiceCacheKey(line, voiceId), () => synthesizeEdgeSpeech(line, undefined, undefined, voiceId));
        if (signal.aborted || !blob) return null;
        const url = keep(blob);
        try {
          const buffer = await decodeBlob(blob);
          return { url, buffer, text: line };
        } catch (_) {
          return { url, buffer: null, text: line };
        }
      });
    }
  }

  function playBuffer(buffer, mine) {
    const ctx = audioContext();
    return unlockAudio().then(() => ctx.resume()).then(() => waitIfPaused()).then(() => new Promise((resolve) => {
      if (mine !== session || !buffer) {
        resolve();
        return;
      }
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      connectAudible(src);
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        if (finishPlay === done) finishPlay = null;
        resolve();
      };
      finishPlay = done;
      src.onended = done;
      try { src.start(ctx.currentTime + 0.01); } catch (_) { done(); }
      sources.push(src);
      if (mine !== session) done();
    }));
  }

  async function play(url, mine) {
    await unlockAudio();
    await waitIfPaused();
    if (mine !== session) return;
    if (!player) {
      player = new Audio();
      player.setAttribute("playsinline", "");
      player.setAttribute("webkit-playsinline", "");
      player.playsInline = true;
      player.preload = "auto";
    }
    player.pause();
    player.src = url;
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        if (finishPlay === done) finishPlay = null;
        resolve();
      };
      finishPlay = done;
      player.onended = done;
      player.onerror = done;
      player.play().catch(done);
      if (mine !== session) done();
    });
  }

  function playClips(clips, mine) {
    const buffered = clips.filter((clip) => clip?.buffer);
    const ctx = audioContext();
    return unlockAudio().then(() => ctx.resume()).then(() => waitIfPaused()).then(() => new Promise((resolve) => {
      if (mine !== session || !buffered.length) {
        resolve();
        return;
      }
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        if (finishPlay === done) finishPlay = null;
        stopSources();
        resolve();
      };
      finishPlay = done;
      let when = ctx.currentTime + 0.01;
      let last = null;
      buffered.forEach((clip, i) => {
        const src = ctx.createBufferSource();
        src.buffer = clip.buffer;
        connectAudible(src);
        const rate = clip.auto ? AUTO_RATE : 1;
        src.playbackRate.value = rate;
        let dur = Math.max(0.04, clip.end - clip.start);
        if (clip.auto) dur = Math.min(clip.buffer.duration - clip.start, dur + 0.05);
        src.start(when, clip.start, dur);
        sources.push(src);
        const next = buffered[i + 1];
        const gap = clip.auto || next?.auto ? AUTO_GAP : WORD_GAP;
        when += dur / rate + gap;
        last = src;
      });
      if (!last) {
        done();
        return;
      }
      last.onended = () => {
        if (mine === session) done();
      };
    }));
  }

  async function speakWords(words) {
    session += 1;
    const mine = session;
    haltAudio();
    if (getTtsEngine() === "apple") {
      // 整段连读，避免逐词念导致「上气不接下气」
      const text = words
        .map((item) => (typeof item === "string" ? item : item?.word))
        .map((w) => String(w || "").trim())
        .filter(Boolean)
        .join(" ");
      if (!text) return;
      try {
        await playLocalAppleSpeech(text, mine, () => session, { rate: 0.92, voiceId: resolvePlayVoice("apple") });
      } catch (_) {}
      return;
    }
    await unlockAudio();
    const clips = [];
    for (const item of words) {
      if (mine !== session) return;
      const word = typeof item === "string" ? item : item?.word;
      const auto = typeof item === "string" ? false : !!item?.auto;
      const job = wordJobs.get(String(word || "").toLowerCase());
      if (!job) continue;
      let clip = null;
      try { clip = await job; } catch (_) { clip = null; }
      if (mine !== session) return;
      if (clip) clips.push({ ...clip, auto });
    }
    if (mine !== session) return;
    if (!clips.length) {
      const text = words.map((item) => (typeof item === "string" ? item : item?.word)).filter(Boolean).join(" ");
      if (text) await playSpeechSynthesis(text, mine, () => session);
      return;
    }
    const buffered = clips.filter((clip) => clip.buffer);
    if (buffered.length) {
      await playClips(buffered, mine);
      return;
    }
    for (const clip of clips) {
      if (!clip.url) continue;
      if (mine !== session) return;
      await play(clip.url, mine);
    }
  }

  async function playAll() {
    session += 1;
    const mine = session;
    haltAudio();
    const line = passageText;
    if (getTtsEngine() === "apple") {
      if (!line) throw new Error("empty");
      await playLocalAppleSpeech(line, mine, () => session, { rate: 0.92, voiceId: resolvePlayVoice("apple") });
      if (mine === session && isRotateVoice(getSavedVoice("apple"))) advanceRotateVoice("apple");
      return;
    }
    await unlockAudio();
    if (!fullJob && !line) throw new Error("empty");
    try {
      const ready = fullJob ? await fullJob : null;
      if (mine !== session) return;
      const url = typeof ready === "string" ? ready : ready?.url;
      const buffer = ready && typeof ready === "object" ? ready.buffer : null;
      if (buffer) {
        await playBuffer(buffer, mine);
        if (mine === session && isRotateVoice(getSavedVoice("online"))) advanceRotateVoice("online");
        return;
      }
      if (url) {
        await play(url, mine);
        if (mine === session && isRotateVoice(getSavedVoice("online"))) advanceRotateVoice("online");
        return;
      }
      throw new Error("empty");
    } catch (err) {
      if (mine !== session) return;
      if (!line) throw err;
      await playSpeechSynthesis(line, mine, () => session);
    }
  }

  /**
   * 点单词 / 短插播：先暂停当前全文，用旁路读完，不结束全文进程。
   * @returns {Promise<{didPause:boolean}>}
   */
  async function speakAside(text, opts = {}) {
    const spoken = String(text || "").replace(/\s+/g, " ").trim();
    if (!spoken) return { didPause: false };
    stopAside();
    const token = asideToken;
    const engine = opts?.engine || getTtsEngine();
    const requested = opts?.voice ?? getSavedVoice(engine);
    const voice = isRotateVoice(requested) ? peekRotateVoice(engine) : requested;
    let didPause = false;
    const busy =
      nativeQueue ||
      (player && !player.paused && !player.ended) ||
      sources.length > 0 ||
      !!window.speechSynthesis?.speaking;
    if (!paused && (opts?.hold || busy)) {
      pausePlayback();
      didPause = true;
    }
    try {
      if (engine === "apple") {
        const plugin = appleSpeechPlugin();
        if (plugin?.speakAside) {
          try {
            await withSpeechTimeout(plugin.speakAside({ text: spoken, rate: 0.92, voiceId: voice || "" }), spoken, "apple-aside");
          } catch (err) {
            console.warn("apple aside failed", err);
            // 卡死的旁路停掉，原生侧会把旧合成器作废；下次点读用新实例
            try { await plugin.stopAside?.(); } catch (_) {}
          }
          return { didPause };
        }
        await playSpeechSynthesisAside(spoken, voice);
        return { didPause };
      }
      await unlockAudio();
      const blob = await loadSpeechBlob(
        voiceCacheKey(spoken, voice),
        (report) => synthesizeEdgeSpeech(spoken, undefined, report, voice),
        { onProgress: opts?.onProgress }
      );
      if (token !== asideToken) return { didPause };
      await playAsideBlob(blob, token);
      return { didPause };
    } catch (_) {
      return { didPause };
    }
  }

  /**
   * 按当前朗读引擎即读一段文本（不依赖 prepare）。
   * 用于英文全文点读 / 全文朗读；会打断当前播放。
   */
  async function speakOnce(text, opts = {}) {
    session += 1;
    const mine = session;
    haltAudio();
    const spoken = String(text || "").replace(/\s+/g, " ").trim();
    if (!spoken) return;
    // 试听别的引擎的声音时可以指定 engine；平时用当前引擎和用户选的声音
    const engine = opts?.engine || getTtsEngine();
    const requested = opts?.voice ?? getSavedVoice(engine);
    const rotating = isRotateVoice(requested);
    const voice = rotating ? peekRotateVoice(engine) : requested;
    if (engine === "apple") {
      await playLocalAppleSpeech(spoken, mine, () => session, { rate: 0.92, voiceId: voice || "" });
      if (mine === session && rotating && opts?.rotateSense) advanceRotateVoice(engine);
      return;
    }
    await unlockAudio();
    const blob = await loadSpeechBlob(
      voiceCacheKey(spoken, voice),
      (report) => synthesizeEdgeSpeech(spoken, undefined, report, voice),
      { onProgress: opts?.onProgress }
    );
    if (mine !== session || !blob) return;
    try {
      const buffer = await decodeBlob(blob);
      if (mine !== session) return;
      await playBuffer(buffer, mine);
    } catch (_) {
      if (mine !== session) return;
      await play(keep(blob), mine);
    }
    if (mine === session && rotating && opts?.rotateSense) advanceRotateVoice(engine);
    // 永久保存已在 loadSpeechBlob 合成完成时立刻做完，不再等播放结束
  }

  function stopPlayback() {
    stop();
  }

  function floatToInt16(samples) {
    const out = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i += 1) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  function encodeWav(pcm, rate) {
    const buf = new ArrayBuffer(44 + pcm.length * 2);
    const v = new DataView(buf);
    const str = (off, s) => {
      for (let i = 0; i < s.length; i += 1) v.setUint8(off + i, s.charCodeAt(i));
    };
    str(0, "RIFF");
    v.setUint32(4, 36 + pcm.length * 2, true);
    str(8, "WAVE");
    str(12, "fmt ");
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); // PCM
    v.setUint16(22, 1, true); // mono
    v.setUint32(24, rate, true);
    v.setUint32(28, rate * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    str(36, "data");
    v.setUint32(40, pcm.length * 2, true);
    new Int16Array(buf, 44).set(pcm);
    return new Blob([buf], { type: "audio/wav" });
  }

  /**
   * 联网朗读的多行连续播放（手机 App，锁屏 / 切后台也要读完）。
   * 不能逐句「下载→播→再下载」：锁屏后网页脚本在句间空档会被系统挂起。
   * 做法：把全文分块（首块很小，尽快开口；后续每块约 20 行），每块把各行音频
   * 拼成一整段 WAV 交给系统音频播放器连续播；播当前块的同时在后台预备后面几块，
   * 块与块之间无缝衔接。音频一直在播，系统就不会挂起 App。
   */
  async function speakLinesOnline(list, opts = {}) {
    session += 1;
    const mine = session;
    haltAudio();
    await unlockAudio();
    await ensureLockFonts();
    if (mine !== session) return { ok: true, cancelled: true };
    keepScreenOn(true);

    const FIRST_CHUNK = 6;
    const CHUNK = 20;
    const AHEAD = 2; // 播放时最多提前预备几块
    const total = list.length;
    const pauseMs = opts.pauseMs ?? 420;
    // 从全文中间某一句开始读时：显示的序号仍按全文计
    const off = Math.max(0, Number(opts.offset) || 0);
    const grand = Number(opts.grandTotal) || total + off;

    /** @type {{from:number,to:number}[]} */
    const chunks = [];
    for (let from = 0; from < total; ) {
      const size = chunks.length === 0 ? FIRST_CHUNK : CHUNK;
      chunks.push({ from, to: Math.min(total, from + size) });
      from += size;
    }

    const run = limitConcurrent(3);
    const alive = () => mine === session;

    /** 备齐一块：取各行音频 → 解码 → 拼成一整段 WAV */
    async function prepareChunk(ci) {
      const { from, to } = chunks[ci];
      let done = 0;
      const jobs = [];
      for (let i = from; i < to; i += 1) {
        const line = list[i];
        jobs.push(
          run(async () => {
            if (!alive()) return null;
            try {
              const voice = Array.isArray(opts.voiceIds) && opts.voiceIds[i] ? opts.voiceIds[i] : opts.voice;
              return await loadSpeechBlob(voiceCacheKey(line, voice), (report) => synthesizeEdgeSpeech(line, undefined, report, voice));
            } catch (err) {
              console.warn("online tts line failed", err);
              return null;
            } finally {
              done += 1;
              if (ci === 0 && alive()) opts.onPrepare?.(done, to - from);
            }
          })
        );
      }
      // 逐行解码并立刻转 16 位，避免同时占用大量 Float32 内存
      const segments = [];
      const starts = [];
      let rate = 0;
      let frames = 0;
      for (let k = 0; k < jobs.length; k += 1) {
        const blob = await jobs[k];
        if (!alive()) return null;
        if (!blob) continue;
        let buffer;
        try {
          buffer = await decodeBlob(blob);
        } catch (err) {
          console.warn("online tts decode failed", err);
          continue;
        }
        if (!alive()) return null;
        if (!rate) rate = buffer.sampleRate;
        starts.push({ line: from + k + 1, at: frames / rate });
        const pcm = floatToInt16(buffer.getChannelData(0));
        segments.push(pcm);
        frames += pcm.length;
        // 行间停顿；全文最后一行不加
        if (from + k < total - 1) {
          const gap = Math.round((rate * pauseMs) / 1000);
          segments.push(new Int16Array(gap));
          frames += gap;
        }
      }
      if (!segments.length || !rate) return { empty: true, from, to };
      const all = new Int16Array(frames);
      let off = 0;
      for (const seg of segments) {
        all.set(seg, off);
        off += seg.length;
      }
      return { url: keep(encodeWav(all, rate)), starts, from, to };
    }

    // 流水线：始终保持「当前块 + 后面 AHEAD 块」在备
    const ready = new Map();
    const ensure = (ci) => {
      if (ci < chunks.length && !ready.has(ci)) ready.set(ci, prepareChunk(ci));
    };
    ensure(0);

    // 锁屏播放控制
    const ms = typeof navigator !== "undefined" ? navigator.mediaSession : null;
    const setHandler = (name, fn) => {
      try {
        ms?.setActionHandler(name, fn);
      } catch (_) {}
    };
    // 锁屏界面同步显示正在读的这句英文：整句拆到标题+副标题两行，并画成封面图（点开可看全）
    let shownLine = 0;
    // 封面图提前画好：切句时只换一下引用，不在切换那一刻现画（现画会卡一下、导致闪）
    const artCache = new Map();
    const artFor = (line) => {
      const stress = isLockStressOn() ? 1 : 0;
      const key = `${line}:${stress}`;
      if (artCache.has(key)) return artCache.get(key);
      const text = list[line - 1] || "";
      if (!text) return "";
      const label = `${opts.title || "全文朗读"} · ${line + off}/${grand}`;
      const rich = stress && Array.isArray(opts.rich) ? opts.rich[line - 1] : null;
      const zh = (Array.isArray(opts.subs) ? opts.subs[line - 1] : "") || "";
      const art = renderLockArtwork(text, label, zh, rich);
      artCache.set(key, art);
      return art;
    };
    const warmArt = (from) => {
      const stress = isLockStressOn() ? 1 : 0;
      [from + 1, from + 2].forEach((ln, k) => {
        if (ln > list.length || artCache.has(`${ln}:${stress}`)) return;
        setTimeout(() => {
          if (alive() && !artCache.has(`${ln}:${isLockStressOn() ? 1 : 0}`)) artFor(ln);
        }, 120 + k * 250);
      });
      for (const key of artCache.keys()) {
        const n = Number(String(key).split(":")[0]);
        if (n < from - 1) artCache.delete(key);
      }
    };
    const lockMeta = (line) => {
      const label = `${opts.title || "全文朗读"} · ${line + off}/${grand}`;
      const text = list[line - 1] || "";
      const rich = Array.isArray(opts.rich) ? opts.rich[line - 1] : null;
      // 底部标题 / 副标题只放纯文字（不带重音标记）；重音只画在大卡片上
      const { title, artist } = splitForLockScreen(text);
      const meta = { title: title || opts.title || "全文朗读", artist: artist || label, album: label };
      const zh = (Array.isArray(opts.subs) ? opts.subs[line - 1] : "") || "";
      const art = text ? artFor(line) : "";
      if (art) meta.artwork = [{ src: art, sizes: "any", type: "image/jpeg" }];
      return meta;
    };
    const pushLine = (line) => {
      const meta = lockMeta(line);
      if (ms && typeof MediaMetadata !== "undefined") {
        try {
          ms.metadata = new MediaMetadata(meta);
        } catch (_) {}
      }
    };
    const showLine = (line) => {
      if (line === shownLine) return;
      shownLine = line;
      pushLine(line);
      warmArt(line);
    };
    pushLine(1);
    shownLine = 1;
    warmArt(1);
    if (ms && typeof MediaMetadata !== "undefined") {
      setHandler("play", () => {
        if (paused) resumePlayback();
        else player?.play?.().catch(() => {});
      });
      setHandler("pause", () => pausePlayback());
      setHandler("stop", () => {
        stop();
        opts.onStopped?.();
      });
    }

    let curStarts = [];
    let lastReported = 0;
    // 前台时按播放进度更新「朗读 i/n」
    const poll = setInterval(() => {
      if (!player || !alive() || !curStarts.length) return;
      const t = player.currentTime || 0;
      let cur = curStarts[0].line;
      // 提前 0.25 秒换卡：句与句之间本来有一小段停顿，换卡落在停顿里，和下一句开口基本同步
      for (const s of curStarts) if (t + 0.25 >= s.at) cur = s.line;
      showLine(cur);
      if (cur !== lastReported) {
        lastReported = cur;
        opts.onLine?.(cur + off, grand);
      }
    }, 120);

    let played = 0;
    try {
      for (let ci = 0; ci < chunks.length; ci += 1) {
        if (!alive()) break;
        for (let k = 1; k <= AHEAD; k += 1) ensure(ci + k);
        const chunk = await ready.get(ci);
        ready.delete(ci);
        if (!alive()) break;
        if (!chunk || chunk.empty) continue; // 这一块全失败：跳过
        curStarts = chunk.starts;
        await play(chunk.url, mine);
        played += 1;
        try {
          URL.revokeObjectURL(chunk.url);
        } catch (_) {}
      }
    } finally {
      keepScreenOn(false);
      clearInterval(poll);
      if (ms) {
        setHandler("play", null);
        setHandler("pause", null);
        setHandler("stop", null);
        try {
          ms.metadata = null;
        } catch (_) {}
      }
    }
    if (alive() && !played) throw new Error("联网朗读失败，请检查网络");
    return { ok: true, cancelled: !alive() };
  }

  let prefetchToken = 0;

  /** 取消正在进行的「下载全文音频」 */
  function cancelPrefetch() {
    prefetchToken += 1;
  }

  /**
   * 把多行联网朗读音频提前下载并永久存到本机（已在本机的直接跳过）。
   * 之后全文朗读 / 意群朗读都直接用本地音频，锁屏、离线也能连续播。
   * @returns {Promise<{total:number,done:number,failed:number,cancelled:boolean,offline:boolean}>}
   */
  async function prefetchLines(lines, opts = {}) {
    const requested = opts.voice ?? (getSavedVoice("online") || undefined);
    const rotating = isRotateVoice(requested);
    const seen = new Set();
    const list = [];
    for (const raw of Array.isArray(lines) ? lines : []) {
      const line = String(raw || "").replace(/\s+/g, " ").trim();
      if (!line || seen.has(line)) continue;
      seen.add(line);
      list.push(line);
    }
    const total = list.length;
    const mine = ++prefetchToken;
    const run = limitConcurrent(opts.concurrency || 3);
    let done = 0;
    let failed = 0;
    let offline = false;
    const alive = () => mine === prefetchToken;
    await Promise.all(
      list.map((line, i) =>
        run(async () => {
          if (!alive()) return;
          const voice = rotating ? rotateVoiceAt("online", i) : requested;
          try {
            await loadSpeechBlob(voiceCacheKey(line, voice), (report) => synthesizeEdgeSpeech(line, undefined, report, voice));
          } catch (_) {
            failed += 1;
            // 开头连续失败 = 基本没网，别把剩下的几百行都空等一遍
            if (failed >= 8 && failed === done + 1) {
              offline = true;
              prefetchToken += 1;
            }
          }
          done += 1;
          if (alive()) opts.onProgress?.({ done, total, failed });
        })
      )
    );
    return { total, done, failed, cancelled: !alive() && !offline, offline };
  }

  /**
   * 多行连续朗读（全文朗读），锁屏 / 切后台也能读完：
   * - iPhone 本机引擎：整段一次性交给原生排队朗读，并接入锁屏播放控制；
   * - 联网引擎：先备齐音频、拼成一整段再播（见 speakLinesOnline）。
   * 不支持时返回 null，由调用方退回逐行朗读。
   * @returns {Promise<{ok?:boolean,cancelled?:boolean}|null>}
   */
  async function speakLines(lines, opts = {}) {
    const engine = getTtsEngine();
    const requested = opts.voice ?? (getSavedVoice(engine) || undefined);
    const rotating = isRotateVoice(requested);
    if (rotating && engine === "apple") {
      if (!cachedAppleVoiceIds.length) {
        try {
          const groups = await listVoiceGroups();
          rememberAppleVoices(groups.apple);
        } catch (_) {}
      }
      setRotateIndex("apple", 0);
    }
    if (rotating && engine !== "apple") setRotateIndex("online", 0);
    // 每句英文对应的中文（锁屏上英中对照用），与英文行一一对齐
    const rawLines = Array.isArray(lines) ? lines : [];
    const subs = [];
    const richList = [];
    const list = [];
    rawLines.forEach((l, i) => {
      const t = String(l || "").replace(/\s+/g, " ").trim();
      if (!t) return;
      list.push(t);
      subs.push(String(opts.subs?.[i] || "").replace(/\s+/g, " ").trim());
      richList.push(opts.rich?.[i] || null);
    });
    const voiceIds = rotating ? list.map((_, i) => rotateVoiceAt(engine, i)) : [];
    opts = {
      ...opts,
      subs,
      rich: richList,
      voice: rotating ? voiceIds[0] || "" : requested,
      voiceIds,
    };
    if (!list.length) return { ok: true, empty: true };
    if (getTtsEngine() !== "apple") {
      // 只有手机 App 需要「锁屏也读完」；桌面/网页保持逐句边取边读，开始更快
      const native = !!globalThis.Capacitor?.isNativePlatform?.();
      return native ? speakLinesOnline(list, opts) : null;
    }
    const plugin = appleSpeechPlugin();
    if (!plugin?.speakQueue) return null;

    session += 1;
    const mine = session;
    haltAudio();
    keepScreenOn(true);
    const off = Math.max(0, Number(opts.offset) || 0);
    const grand = Number(opts.grandTotal) || list.length + off;
    const handles = [];
    try {
      await ensureLockFonts();
      // 本机排队朗读时，锁屏封面也画英中双语（与联网 speakLinesOnline 一致）
      const artCache = new Map();
      const pushAppleLock = (lineNo) => {
        if (mine !== session || !plugin?.updateNowPlaying) return;
        const idx = Math.max(0, (Number(lineNo) || 1) - 1);
        const text = list[idx] || "";
        if (!text) return;
        const label = `${opts.title || "全文朗读"} · ${idx + 1 + off}/${grand}`;
        const zh = (Array.isArray(opts.subs) ? opts.subs[idx] : "") || "";
        const rich = isLockStressOn() && Array.isArray(opts.rich) ? opts.rich[idx] : null;
        const stress = isLockStressOn() ? 1 : 0;
        const key = `${idx}:${stress}`;
        let art = artCache.get(key);
        if (art == null) {
          art = renderLockArtwork(text, label, zh, rich) || "";
          artCache.set(key, art);
        }
        const { title, artist } = splitForLockScreen(text);
        plugin.updateNowPlaying({
          title: title || opts.title || "全文朗读",
          artist: artist || label,
          album: label,
          artwork: art,
        }).catch(() => {});
      };
      if (typeof plugin.addListener === "function") {
        handles.push(
          await plugin.addListener("queueProgress", (d) => {
            const i = Number(d?.index) || 0;
            opts.onLine?.(i + off, grand);
            pushAppleLock(i);
          })
        );
      }
      if (typeof opts.onStopped === "function" && typeof plugin.addListener === "function") {
        handles.push(await plugin.addListener("queueStopped", () => opts.onStopped()));
      }
      if (typeof opts.onLooped === "function" && typeof plugin.addListener === "function") {
        // 原生单篇循环：每重排一轮通知一次，界面把进度重置回第一句
        handles.push(await plugin.addListener("queueLooped", () => opts.onLooped()));
      }
      if (typeof plugin.addListener === "function") {
        // 锁屏界面 / 耳机暂停、继续：同步网页里的状态
        handles.push(
          await plugin.addListener("queueState", (d) => {
            const now = !!d?.paused;
            if (now === paused) return;
            paused = now;
            pausedParts = now ? ["native"] : [];
            if (!now) flushResumeWaiters();
            emitPause();
          })
        );
      }
      nativeQueue = true;
      // 先刷第一句封面，再开口，锁屏不会空白一截
      pushAppleLock(1);
      // loop=true 时原生在最后一句读完自行重排下一轮（promise 直到停止才 resolve，
      // 避免每轮 stop→重排队的抖动截断下一轮第一句）；否则一轮读完即 resolve
      return await plugin.speakQueue({
        lines: list,
        pauseMs: opts.pauseMs ?? 420,
        rate: 0.92,
        title: opts.title || "全文朗读",
        offset: off,
        grandTotal: grand,
        voiceId: opts.voice || "",
        voiceIds: Array.isArray(opts.voiceIds) ? opts.voiceIds : [],
        loop: opts.loop === true,
      });
    } finally {
      keepScreenOn(false);
      nativeQueue = false;
      clearPause();
      for (const h of handles) {
        try {
          await h?.remove?.();
        } catch (_) {}
      }
    }
  }

  /** 可选的朗读声音：联网=Edge 神经语音；iPhone 本机=系统已安装的英文声音；电脑本机=系统英文声音 */
  async function listVoices() {
    if (getTtsEngine() !== "apple") {
      return { engine: "online", voices: ONLINE_VOICES.map((v) => ({ ...v })), defaultId: VOICE };
    }
    const plugin = appleSpeechPlugin();
    if (plugin?.listVoices) {
      try {
        const res = await plugin.listVoices();
        const q = { premium: "高品质", enhanced: "增强" };
        const voices = (res?.voices || []).map((v) => ({
          id: v.id,
          label: `${v.name} · ${v.lang}${q[v.quality] ? ` · ${q[v.quality]}` : ""}${v.isSystemDefault ? "（系统默认）" : ""}`,
        }));
        rememberAppleVoices(voices);
        return { engine: "apple", voices, defaultId: res?.current?.voiceId || voices[0]?.id || "" };
      } catch (_) {}
    }
    const web = await ensureVoicesReady();
    const voices = web
      .filter((v) => /^en(-|_)/i.test(String(v.lang || "")))
      .map((v) => ({ id: v.voiceURI, label: `${v.name} · ${v.lang}` }));
    const best = pickEnglishVoice();
    rememberAppleVoices(voices);
    return { engine: "apple", voices, defaultId: best?.voiceURI || voices[0]?.id || "" };
  }

  /** 联网 + 本机两组声音，一起放进一个列表里选 */
  async function listVoiceGroups() {
    const online = ONLINE_VOICES.map((v) => ({ ...v }));
    let apple = [];
    let appleDefault = "";
    const plugin = appleSpeechPlugin();
    if (plugin?.listVoices) {
      try {
        const res = await plugin.listVoices();
        const q = { premium: "高品质", enhanced: "增强" };
        apple = (res?.voices || []).map((v) => ({
          id: v.id,
          label: `${v.name} · ${v.lang}${q[v.quality] ? ` · ${q[v.quality]}` : ""}${v.isSystemDefault ? "（系统默认）" : ""}`,
        }));
        appleDefault = res?.current?.voiceId || apple[0]?.id || "";
      } catch (_) {}
    } else {
      const web = await ensureVoicesReady();
      apple = web
        .filter((v) => /^en(-|_)/i.test(String(v.lang || "")))
        .map((v) => ({ id: v.voiceURI, label: `${v.name} · ${v.lang}` }));
      appleDefault = pickEnglishVoice()?.voiceURI || apple[0]?.id || "";
    }
    rememberAppleVoices(apple);
    return { online, onlineDefault: VOICE, apple, appleDefault };
  }

  return {
    listVoiceGroups,
    listVoices,
    prepare,
    release,
    speakWords,
    playAll,
    speakOnce,
    speakAside,
    speakLines,
    prefetchLines,
    cancelPrefetch,
    stopPlayback,
    pausePlayback,
    resumePlayback,
    isPaused,
    waitIfPaused,
    unlockAudio,
    getTtsEngine,
    setTtsEngine,
  };
}
