#!/usr/bin/env node
/** 本地词典代理：绕过浏览器 CORS，供 web-dev / 调试用 */
import http from "http";
import { URL } from "url";

const PORT = Number(process.env.DICT_PROXY_PORT || 8768);

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
  if (!phonetic && !gloss) return null;
  return {
    word: String(wordObj?.["return-phrase"] || wordObj?.prototype || word || "").trim() || word,
    phonetic,
    gloss,
  };
}

async function lookup(word) {
  const targets = [
    `https://dict.youdao.com/jsonapi_s?doctype=json&jsonversion=4&q=${encodeURIComponent(word)}`,
    `https://dict.youdao.com/jsonapi?q=${encodeURIComponent(word)}`,
    `https://dict.youdao.com/suggest?num=1&ver=3.0&doctype=json&cache=false&le=en&q=${encodeURIComponent(word)}`,
  ];
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
      if (parsed) return { ok: true, ...parsed };
    } catch (err) {
      lastErr = String(err?.message || err);
    }
  }
  return { ok: false, error: lastErr || "lookup failed" };
}

const server = http.createServer(async (req, res) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  try {
    const u = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
    if (req.method === "GET" && (u.pathname === "/api/en-dict" || u.pathname === "/")) {
      const word = String(u.searchParams.get("q") || "")
        .trim()
        .replace(/^[^A-Za-z']+|[^A-Za-z']+$/g, "");
      if (!word) {
        res.writeHead(400, { ...cors, "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "empty" }));
        return;
      }
      const out = await lookup(word);
      res.writeHead(out.ok ? 200 : 502, {
        ...cors,
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=86400",
      });
      res.end(JSON.stringify(out));
      return;
    }
    res.writeHead(404, { ...cors, "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  } catch (err) {
    res.writeHead(500, { ...cors, "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`dict proxy  http://127.0.0.1:${PORT}/api/en-dict?q=hello`);
});
