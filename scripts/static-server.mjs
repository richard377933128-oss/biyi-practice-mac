/**
 * 极简静态文件服务器（替代 Python http.server）。
 *
 * 为什么不用 Python 的：它用 HTTP/1.0，不支持 Range 头，
 * Chromium 收到 .gz 响应时会嗅探成下载并直接 abort。
 *
 * 用法：node scripts/static-server.mjs [port] [--bind 127.0.0.1] [--root ./www]
 */

import fs from "fs";
import http from "http";
import path from "path";
import zlib from "zlib";
import { fileURLToPath } from "url";

const DICT_PROXY_TARGET = "http://127.0.0.1:8768";
const TTS_PROXY_TARGET = "http://127.0.0.1:8767";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, "..", "www");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".mp3": "audio/mpeg",
  ".wasm": "application/wasm",
  ".gz": "application/gzip",
};

function proxyRequest(req, res, target) {
  try {
    const u = new URL(target);
    const proxy = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: req.method,
      headers: { ...req.headers, host: u.host },
    }, (upstream) => {
      // 加 CORS 头，让远程（如 iPhone）也能访问
      res.writeHead(upstream.statusCode, {
        ...upstream.headers,
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      upstream.pipe(res);
    });
    proxy.on("error", (e) => {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("proxy error: " + e.message);
    });
    req.pipe(proxy);
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("proxy failed: " + e.message);
  }
}

function main() {
  const args = process.argv.slice(2);
  let port = 8766;
  let bind = "127.0.0.1";
  let root = DEFAULT_ROOT;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--bind") { bind = args[++i]; continue; }
    if (args[i] === "--root" || args[i] === "--directory") { root = args[++i]; continue; }
    // 未加 -- 的裸参数视为 port
    if (!args[i].startsWith("--")) { port = Number(args[i]); }
  }

  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    console.error(`static-server: root 目录不存在: ${root}`);
    process.exit(1);
  }

  const server = http.createServer((req, res) => {
    const fullUrl = req.url || "/";
    let urlPath = decodeURIComponent(fullUrl.split("?")[0]);
    if (urlPath === "/") urlPath = "/index.html";

    // === API 代理 ===
    if (urlPath.startsWith("/api/")) {
      return proxyRequest(req, res, DICT_PROXY_TARGET + fullUrl);
    }
    if (urlPath.startsWith("/tts-cache")) {
      return proxyRequest(req, res, TTS_PROXY_TARGET + fullUrl);
    }
    const filePath = path.resolve(root, "." + urlPath);

    // 防目录穿越
    if (!filePath.startsWith(root + path.sep) && filePath !== root) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    if (!stat.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME[ext] || "application/octet-stream";
    const acceptRanges = "bytes";
    const lastModified = stat.mtime.toUTCString();

    // If-Modified-Since → 304 Not Modified
    const ims = req.headers["if-modified-since"];
    if (ims) {
      const imsTime = Date.parse(ims);
      if (!isNaN(imsTime) && imsTime >= stat.mtimeMs) {
        res.writeHead(304, {
          "Last-Modified": lastModified,
          "Cache-Control": "public, max-age=10",
        });
        res.end();
        return;
      }
    }

    const isJsonGz = filePath.endsWith(".json.gz");
    const wantsRange = !!(req.headers.range && /^bytes=(\d*)-(\d*)$/.test(req.headers.range));

    const commonHeaders = {
      "Content-Type": contentType,
      "Last-Modified": lastModified,
      "Accept-Ranges": acceptRanges,
      // .json.gz 词典分片会被自动解压成 application/json，
      // 如果浏览器缓存了旧服务器（Python http.server）返回的原始 gzip，
      // 前端 res.json() 会拿到 gzip magic bytes 而崩掉。强制 no-store 避开。
      "Cache-Control": isJsonGz ? "no-store" : "public, max-age=10",
    };

    const range = req.headers.range;
    if (wantsRange) {
      const m = range.match(/^bytes=(\d*)-(\d*)$/);
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Number(m[2]) : stat.size - 1;
      if (start >= stat.size || end >= stat.size || start > end) {
        res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        ...commonHeaders,
        "Content-Length": end - start + 1,
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else if (isJsonGz) {
      // .json.gz 完整请求 → 自动解压成 application/json 返回
      // 避免前端 DecompressionStream 在 Chromium 里触发 abort
      try {
        const raw = fs.readFileSync(filePath);
        const decompressed = zlib.gunzipSync(raw);
        res.writeHead(200, {
          ...commonHeaders,
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": decompressed.length,
        });
        res.end(decompressed);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("gunzip error: " + err.message);
      }
    } else {
      res.writeHead(200, {
        ...commonHeaders,
        "Content-Length": stat.size,
      });
      fs.createReadStream(filePath).pipe(res);
    }
  });

  server.listen(port, bind, () => {
    console.log(`static-server http://${bind}:${port}  root=${root}`);
  });
}

main();
