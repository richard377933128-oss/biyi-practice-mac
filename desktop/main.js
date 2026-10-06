const { app, BrowserWindow, shell, Menu, ipcMain } = require("electron");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile, spawn } = require("child_process");
const net = require("net");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const PORT = 28767;

let mainWindow = null;
let staticServer = null;
let savedInputSourceId = null;
let imeChild = null;

function parseYoudaoDict(data, word) {
  const ec = data?.ec;
  let wordObj = null;
  if (Array.isArray(ec?.word)) wordObj = ec.word[0];
  else if (ec?.word && typeof ec.word === "object") wordObj = ec.word;

  const us = String(wordObj?.usphone || "").trim();
  const uk = String(wordObj?.ukphone || "").trim();
  let phonetic = "";
  if (us && uk && us !== uk) phonetic = `美 ${us}  英 ${uk}`;
  else phonetic = us || uk;

  if (!phonetic) {
    const simple = data?.simple?.word;
    const sw = Array.isArray(simple) ? simple[0] : simple;
    const sus = String(sw?.usphone || "").trim();
    const suk = String(sw?.ukphone || "").trim();
    if (sus && suk && sus !== suk) phonetic = `美 ${sus}  英 ${suk}`;
    else phonetic = sus || suk;
  }

  const glossParts = [];
  for (const item of wordObj?.trs || []) {
    if (!item || typeof item !== "object") continue;
    if (typeof item.tran === "string" && item.tran.trim()) {
      const pos = String(item.pos || "").trim();
      glossParts.push(pos ? `${pos} ${item.tran.trim()}` : item.tran.trim());
      continue;
    }
    for (const tr of item.tr || []) {
      const i = tr?.l?.i;
      if (Array.isArray(i)) {
        const s = i.filter((x) => typeof x === "string").join("").trim();
        if (s) glossParts.push(s);
      } else if (typeof i === "string" && i.trim()) {
        glossParts.push(i.trim());
      }
    }
  }
  let gloss = glossParts.join("；");
  if (!gloss) {
    const explain = data?.data?.entries?.[0]?.explain;
    if (explain) gloss = String(explain).trim();
  }
  if (!gloss) {
    const web = data?.web_trans?.["web-translation"];
    const first = Array.isArray(web) ? web[0] : null;
    const tran = first?.trans?.[0]?.value;
    if (tran) gloss = String(tran).trim();
  }
  if (!phonetic && !gloss) return null;
  return {
    word: String(wordObj?.["return-phrase"] || wordObj?.prototype || word || "").trim() || word,
    phonetic,
    gloss,
  };
}

function winImeScriptPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, "ime-win.py");
  return path.join(__dirname, "scripts", "ime-win.py");
}

function startWinImeServer() {
  if (process.platform !== "win32") return Promise.resolve(false);
  imeChild = spawn("python", [winImeScriptPath(), "--listen", "8765"], {
    windowsHide: true,
    stdio: "ignore",
  });
  imeChild.on("error", () => {});
  return new Promise((resolve) => {
    const deadline = Date.now() + 2500;
    const wait = () => {
      const socket = net.connect(8765, "127.0.0.1");
      const finish = (ok) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(ok);
      };
      socket.once("connect", () => finish(true));
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(wait, 40);
      });
    };
    wait();
  });
}

function postWinIme(pathname) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: 8765,
        path: pathname,
        method: "POST",
        timeout: 1500,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
          } catch (_) {
            resolve({ ok: false });
          }
        });
      }
    );
    req.on("error", () => resolve({ ok: false }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false });
    });
    req.end();
  });
}

function imeScriptPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, "ime.py");
  return path.join(__dirname, "scripts", "ime.py");
}

function runIme(...args) {
  return execFileAsync("python3", [imeScriptPath(), ...args], {
    timeout: 2500,
    maxBuffer: 64 * 1024,
  }).then(({ stdout }) => String(stdout || "").trim());
}

function isEnglishInputId(id) {
  const s = String(id || "");
  if (!s) return false;
  if (/^com\.apple\.keylayout\.(ABC|US|British|Australian|Canadian|Irish|USInternational)/.test(s)) {
    return true;
  }
  return s.startsWith("com.apple.keylayout.") && !/Pinyin|Chinese|SCIM/i.test(s);
}

async function selectEnglishInput() {
  if (process.platform === "win32") return postWinIme("/__pte/ime-english");
  if (process.platform !== "darwin") return { ok: false };
  try {
    const cur = await runIme("current");
    if (!isEnglishInputId(cur) && !savedInputSourceId) savedInputSourceId = cur;
    const chosen = await runIme("select-english");
    return { ok: isEnglishInputId(chosen) || isEnglishInputId(await runIme("current")), id: chosen };
  } catch (err) {
    console.warn("selectEnglishInput", err);
    return { ok: false, error: String(err?.message || err) };
  }
}

async function restoreInputMethod() {
  if (process.platform === "win32") return postWinIme("/__pte/ime-restore");
  if (process.platform !== "darwin") return { ok: false };
  const prev = savedInputSourceId;
  savedInputSourceId = null;
  if (!prev) return { ok: true, skipped: true };
  try {
    await runIme("select", prev);
    return { ok: true, id: prev };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

async function openSystemCamera() {
  if (process.platform === "darwin") {
    try {
      const raw = await runIme("open-camera");
      try {
        return JSON.parse(raw || "{}");
      } catch (_) {
        return { ok: false, error: raw || "parse fail" };
      }
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }
  // 其他平台：尽量打开系统相机应用
  const candidates =
    process.platform === "win32"
      ? ["microsoft.windows.camera:"]
      : [];
  for (const target of candidates) {
    try {
      await shell.openExternal(target);
      return { ok: true, app: target };
    } catch (_) {}
  }
  return { ok: false, reason: "unsupported-platform" };
}

function wwwRoot() {
  if (app.isPackaged) return path.join(process.resourcesPath, "www");
  return path.join(__dirname, "..", "www");
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".ttf": "font/ttf",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
  };
  return map[ext] || "application/octet-stream";
}

function startStaticServer(root) {
  const rootReal = fs.realpathSync(root);
  let banksReal = "";
  let fontsReal = "";
  try {
    banksReal = fs.realpathSync(path.join(root, "data", "banks"));
  } catch (_) {}
  try {
    fontsReal = fs.realpathSync(path.join(root, "fonts"));
  } catch (_) {}

  function allowed(filePath) {
    const real = fs.realpathSync(filePath);
    if (real === rootReal || real.startsWith(rootReal + path.sep)) return real;
    if (banksReal && (real === banksReal || real.startsWith(banksReal + path.sep))) return real;
    if (fontsReal && (real === fontsReal || real.startsWith(fontsReal + path.sep))) return real;
    return null;
  }

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
    let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    if (req.method === "OPTIONS" && (urlPath === "/tts" || urlPath === "/tts-cache")) {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }
    if (req.method === "GET" && urlPath === "/tts-cache") {
      const text = new URL(req.url || "/", "http://127.0.0.1").searchParams.get("text") || "";
      import("./edge-tts-node.mjs")
        .then(({ readClipFile }) => {
          const audio = readClipFile(text);
          if (!audio) {
            res.writeHead(404, { "Access-Control-Allow-Origin": "*" });
            res.end();
            return;
          }
          res.writeHead(200, {
            "Content-Type": "audio/mpeg",
            "Content-Length": audio.length,
            "Access-Control-Allow-Origin": "*",
          });
          res.end(audio);
        })
        .catch(() => {
          res.writeHead(404, { "Access-Control-Allow-Origin": "*" });
          res.end();
        });
      return;
    }
    if (req.method === "POST" && urlPath === "/tts-cache") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch (_) {}
        import("./edge-tts-node.mjs")
          .then(({ writeClipFile }) => {
            const audio = Buffer.from(String(body.audioBase64 || ""), "base64");
            const ok = writeClipFile(body.text || "", audio);
            res.writeHead(ok ? 200 : 400, {
              "Content-Type": "application/json; charset=utf-8",
              "Access-Control-Allow-Origin": "*",
            });
            res.end(JSON.stringify({ ok, bytes: ok ? audio.length : 0 }));
          })
          .catch((err) => {
            res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" });
            res.end(String(err?.message || err));
          });
      });
      return;
    }
    if (req.method === "POST" && urlPath === "/tts") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        let text = "";
        let voice = "";
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          text = body.text || "";
          voice = body.voice || "";
        } catch (_) {
          text = "";
        }
        import("./edge-tts-node.mjs")
          .then(({ synthesize, readClipFile, writeClipFile, voiceKey }) => {
            const key = voiceKey(text, voice);
            const cached = readClipFile(key);
            if (cached) return cached;
            return synthesize(text, voice).then((audio) => {
              try { writeClipFile(key, audio); } catch (_) {}
              return audio;
            });
          })
          .then((audio) => {
            res.writeHead(200, {
              "Content-Type": "audio/mpeg",
              "Content-Length": audio.length,
              "Access-Control-Allow-Origin": "*",
            });
            res.end(audio);
          })
          .catch((err) => {
            res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
            res.end(String(err?.message || err));
          });
      });
      return;
    }
    if (req.method === "GET" && urlPath === "/api/en-dict") {
      const q = new URL(req.url || "/", "http://127.0.0.1").searchParams.get("q") || "";
      const word = String(q).trim().replace(/^[^A-Za-z']+|[^A-Za-z']+$/g, "");
      if (!word) {
        res.writeHead(400, {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({ ok: false, error: "empty" }));
        return;
      }
      const targets = [
        `https://dict.youdao.com/jsonapi_s?doctype=json&jsonversion=4&q=${encodeURIComponent(word)}`,
        `https://dict.youdao.com/jsonapi?q=${encodeURIComponent(word)}`,
        `https://dict.youdao.com/suggest?num=1&ver=3.0&doctype=json&cache=false&le=en&q=${encodeURIComponent(word)}`,
      ];
      (async () => {
        let lastErr = "";
        for (const target of targets) {
          try {
            const upstream = await fetch(target, {
              headers: {
                Accept: "application/json",
                "User-Agent":
                  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
              },
            });
            if (!upstream.ok) {
              lastErr = `http ${upstream.status}`;
              continue;
            }
            const data = await upstream.json();
            const parsed = parseYoudaoDict(data, word);
            if (parsed) {
              res.writeHead(200, {
                "Content-Type": "application/json; charset=utf-8",
                "Access-Control-Allow-Origin": "*",
                "Cache-Control": "public, max-age=86400",
              });
              res.end(JSON.stringify({ ok: true, ...parsed }));
              return;
            }
          } catch (err) {
            lastErr = String(err?.message || err);
          }
        }
        res.writeHead(502, {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({ ok: false, error: lastErr || "lookup failed" }));
      })();
      return;
    }
      if (urlPath === "/") urlPath = "/index.html";
      const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
      let filePath = path.join(root, safe);
      let realPath = null;
      try {
        if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
          filePath = path.join(filePath, "index.html");
        }
        realPath = allowed(filePath);
      } catch (_) {
        realPath = null;
      }
      if (!realPath) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      fs.readFile(realPath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        res.writeHead(200, { "Content-Type": contentType(realPath) });
        res.end(data);
      });
    });
    server.listen(PORT, "127.0.0.1", () => resolve(server));
    server.on("error", reject);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 820,
    minWidth: 720,
    minHeight: 560,
    title: "笔译训练",
    backgroundColor: "#f3efe4",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadURL(`http://127.0.0.1:${PORT}/`);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.session.on("will-download", (_event, item) => {
    const name = item.getFilename() || "download.bin";
    const target = path.join(app.getPath("downloads"), name);
    if (/\.mp3$/i.test(name)) {
      // 录音：不设保存路径，Electron 会弹出系统「另存为」让用户选位置
      item.setSaveDialogOptions({ defaultPath: target, title: "保存录音" });
      return;
    }
    item.setSavePath(target);
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  ipcMain.handle("ime-select-english", () => selectEnglishInput());
  ipcMain.handle("ime-restore", () => restoreInputMethod());
  ipcMain.handle("open-system-camera", () => openSystemCamera());

  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    const root = wwwRoot();
    if (!fs.existsSync(path.join(root, "index.html"))) {
      console.error("www not found:", root);
      app.quit();
      return;
    }
    staticServer = await startStaticServer(root);
    await startWinImeServer();
    if (process.platform === "darwin") {
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: app.name,
            submenu: [{ role: "about" }, { type: "separator" }, { role: "quit" }],
          },
          {
            label: "编辑",
            submenu: [
              { role: "undo" },
              { role: "redo" },
              { type: "separator" },
              { role: "cut" },
              { role: "copy" },
              { role: "paste" },
              { role: "pasteAndMatchStyle" },
              { role: "selectAll" },
            ],
          },
        ])
      );
    } else {
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: "编辑",
            submenu: [
              { role: "undo" },
              { role: "redo" },
              { type: "separator" },
              { role: "cut" },
              { role: "copy" },
              { role: "paste" },
              { role: "selectAll" },
            ],
          },
        ])
      );
    }
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", () => {
    if (staticServer) staticServer.close();
    if (imeChild && !imeChild.killed) imeChild.kill();
  });
}
