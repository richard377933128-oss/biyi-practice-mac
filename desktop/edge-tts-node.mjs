/** Node 侧 Edge 朗读。供本机代理和桌面端使用，浏览器拿不到 Edge 的请求头。 */

import crypto from "crypto";
import fs from "fs";
import http from "http";
import path from "path";
import tls from "tls";
import { fileURLToPath } from "url";

const CACHE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cache", "tts");

export function normalizeSpeechText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function clipFilePath(text) {
  const spoken = normalizeSpeechText(text);
  if (!spoken) return "";
  const hash = crypto.createHash("sha256").update(spoken).digest("hex");
  return path.join(CACHE_DIR, `${hash}.mp3`);
}

export function readClipFile(text) {
  const file = clipFilePath(text);
  if (!file) return null;
  try {
    if (!fs.existsSync(file)) return null;
    const audio = fs.readFileSync(file);
    return audio.length ? audio : null;
  } catch (_) {
    return null;
  }
}

export function writeClipFile(text, audio) {
  const file = clipFilePath(text);
  if (!file || !audio?.length) return false;
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, audio);
  fs.renameSync(tmp, file);
  return true;
}

const TRUSTED = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const GEC_VERSION = "1-143.0.3650.75";
const VOICE = "en-US-EmmaMultilingualNeural";
const EDGE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0";

function secMsGec() {
  const winEpoch = 11644473600;
  let ticks = Date.now() / 1000 + winEpoch;
  ticks -= ticks % 300;
  ticks = Math.round(ticks * 1e7);
  return crypto.createHash("sha256").update(`${ticks}${TRUSTED}`).digest("hex").toUpperCase();
}

function edgeTimestamp() {
  const d = new Date();
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p = (n) => String(n).padStart(2, "0");
  return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${p(d.getUTCDate())} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`;
}

function escapeXml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function maskPayload(text) {
  const payload = Buffer.isBuffer(text) ? text : Buffer.from(String(text));
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i % 4];
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, 0x80 | payload.length]);
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  }
  return Buffer.concat([header, mask, masked]);
}

function takeFrames(state) {
  const out = [];
  while (state.buf.length >= 2) {
    const b0 = state.buf[0];
    const b1 = state.buf[1];
    let len = b1 & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (state.buf.length < 4) return out;
      len = state.buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (state.buf.length < 10) return out;
      const big = state.buf.readBigUInt64BE(2);
      len = Number(big);
      offset = 10;
    }
    const masked = (b1 & 0x80) !== 0;
    const maskLen = masked ? 4 : 0;
    if (state.buf.length < offset + maskLen + len) return out;
    let payload = state.buf.subarray(offset + maskLen, offset + maskLen + len);
    if (masked) {
      const mask = state.buf.subarray(offset, offset + 4);
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    } else {
      payload = Buffer.from(payload);
    }
    state.buf = state.buf.subarray(offset + maskLen + len);
    const opcode = b0 & 0x0f;
    if (opcode === 0) {
      state.frag = state.frag ? Buffer.concat([state.frag, payload]) : payload;
      if (b0 & 0x80) {
        out.push({ opcode: state.fragOp || 2, payload: state.frag });
        state.frag = null;
      }
    } else if (opcode === 1 || opcode === 2) {
      if (b0 & 0x80) out.push({ opcode, payload });
      else {
        state.fragOp = opcode;
        state.frag = payload;
      }
    } else if (opcode === 8) {
      out.push({ opcode, payload });
    } else if (opcode === 9) {
      state.pong = payload;
    }
  }
  return out;
}

function audioFromFrame(payload) {
  if (payload.length < 2) return null;
  const headerLen = payload.readUInt16BE(0);
  if (headerLen + 2 > payload.length) return null;
  const header = payload.subarray(2, 2 + headerLen).toString("utf8");
  if (!header.includes("Path:audio") || !header.includes("audio/mpeg")) return null;
  return payload.subarray(2 + headerLen);
}

/** 只放行形如 en-US-XxxNeural 的声音名，防止拼进 SSML 的注入 */
export function safeVoice(voice) {
  const v = String(voice || "").trim();
  return /^[a-z]{2}-[A-Z]{2}-[A-Za-z0-9]+Neural$/.test(v) ? v : VOICE;
}

/** 非默认声音的缓存键带上声音名（与网页端 voiceCacheKey 一致） */
export function voiceKey(text, voice) {
  const v = safeVoice(voice);
  return v === VOICE ? text : `${v}|${text}`;
}

export function synthesize(text, voice) {
  const spoken = String(text || "").replace(/\s+/g, " ").trim();
  if (!spoken) return Promise.reject(new Error("empty"));
  const id = crypto.randomBytes(16).toString("hex");
  const url = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED}&ConnectionId=${id}&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=${GEC_VERSION}`;
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = tls.connect(443, u.hostname, { servername: u.hostname });
    const state = { buf: Buffer.alloc(0), frag: null, fragOp: 2, pong: null };
    const audio = [];
    let upgraded = false;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error("timeout")), 20000);
    socket.on("error", (err) => fail(err));
    socket.on("secureConnect", () => {
      const key = crypto.randomBytes(16).toString("base64");
      socket.write(
        [
          `GET ${u.pathname}${u.search} HTTP/1.1`,
          `Host: ${u.hostname}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Version: 13",
          `Sec-WebSocket-Key: ${key}`,
          "Origin: chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
          `User-Agent: ${EDGE_UA}`,
          "Pragma: no-cache",
          "Cache-Control: no-cache",
          "",
          "",
        ].join("\r\n")
      );
    });
    socket.on("data", (data) => {
      if (!upgraded) {
        state.buf = Buffer.concat([state.buf, data]);
        const split = state.buf.indexOf("\r\n\r\n");
        if (split < 0) return;
        const head = state.buf.subarray(0, split).toString("utf8");
        state.buf = state.buf.subarray(split + 4);
        if (!/^HTTP\/1\.1 101/.test(head)) {
          fail(new Error(head.split("\r\n")[0] || "handshake"));
          return;
        }
        upgraded = true;
        const ts = edgeTimestamp();
        const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${safeVoice(voice)}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>${escapeXml(spoken)}</prosody></voice></speak>`;
        socket.write(maskPayload(
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
        ));
        socket.write(maskPayload(
          `X-RequestId:${crypto.randomBytes(16).toString("hex")}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}Z\r\nPath:ssml\r\n\r\n${ssml}`
        ));
      } else {
        state.buf = Buffer.concat([state.buf, data]);
      }
      if (!upgraded) return;
      if (state.pong) {
        // server ping is rare; ignore
        state.pong = null;
      }
      for (const frame of takeFrames(state)) {
        if (frame.opcode === 1) {
          const textMsg = frame.payload.toString("utf8");
          if (textMsg.includes("Path:turn.end")) {
            clearTimeout(timer);
            settled = true;
            socket.destroy();
            if (!audio.length) fail(new Error("no audio"));
            else resolve(Buffer.concat(audio));
          }
        } else if (frame.opcode === 2) {
          const piece = audioFromFrame(frame.payload);
          if (piece?.length) audio.push(piece);
        } else if (frame.opcode === 8) {
          fail(new Error("closed"));
        }
      }
    });
  });
}

function sendAudio(res, audio) {
  res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": audio.length });
  res.end(audio);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("error", reject);
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (_) {
        resolve({});
      }
    });
  });
}

function listen(port) {
  const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    const urlPath = (req.url || "").split("?")[0];
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "GET" && urlPath === "/tts-cache") {
      const text = new URL(req.url || "/", "http://127.0.0.1").searchParams.get("text") || "";
      const audio = readClipFile(text);
      if (!audio) {
        res.writeHead(404);
        res.end();
        return;
      }
      sendAudio(res, audio);
      return;
    }
    if (req.method === "POST" && urlPath === "/tts-cache") {
      readJsonBody(req).then((body) => {
        const text = normalizeSpeechText(body.text);
        const audio = Buffer.from(String(body.audioBase64 || ""), "base64");
        if (!text || !audio.length) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false }));
          return;
        }
        try {
          writeClipFile(text, audio);
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true, bytes: audio.length }));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(String(err?.message || err));
        }
      }).catch((err) => {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(String(err?.message || err));
      });
      return;
    }
    if (req.method !== "POST" || urlPath !== "/tts") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    readJsonBody(req).then((body) => {
      const text = body.text || "";
      const key = voiceKey(text, body.voice);
      const cached = readClipFile(key);
      if (cached) {
        sendAudio(res, cached);
        return;
      }
      synthesize(text, body.voice).then((audio) => {
        try { writeClipFile(key, audio); } catch (_) {}
        sendAudio(res, audio);
      }).catch((err) => {
        res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(String(err?.message || err));
      });
    }).catch((err) => {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(String(err?.message || err));
    });
  });
  server.listen(port, "127.0.0.1");
  return server;
}

const listenArg = process.argv.indexOf("--listen");
if (listenArg >= 0) {
  const port = Number(process.argv[listenArg + 1]) || 8767;
  listen(port);
  console.log(`edge-tts proxy http://127.0.0.1:${port}/tts`);
}

if (process.argv.includes("--once")) {
  const text = process.argv[process.argv.indexOf("--once") + 1] || "hello";
  synthesize(text).then((buf) => {
    console.log("bytes", buf.length);
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
