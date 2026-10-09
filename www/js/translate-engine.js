/**
 * 翻译引擎路由：
 * 1) 在线（MyMemory → Google gtx）；记住上次所选引擎
 * 2) DeepSeek API（需填写 API Key）
 * 3) 在线过慢时询问是否切本地
 * 4) 本地可切换多个内置 Transformers.js 模型
 */

const PREFS_KEY = "biyi_translate_engine_prefs";
const SLOW_THRESHOLD_MS = 3500;
const SLOW_ASK_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL = "deepseek-chat";

/** @typedef {'online'|'deepseek'|'local'} TranslateMode */

/**
 * 内置本地模型目录（相对 www/models/）。
 * hubDir 对应 Hugging Face Xenova 仓库名。
 */
export const LOCAL_TRANSLATE_MODELS = [
  {
    id: "nllb-600m",
    label: "NLLB-200 600M",
    desc: "多语通用，中英本地翻译",
    hubDir: "Xenova/nllb-200-distilled-600M",
    kind: "nllb",
    srcZh: "zho_Hans",
    tgtEn: "eng_Latn",
    srcEn: "eng_Latn",
    tgtZh: "zho_Hans",
  },
];

function cleanText(raw) {
  return String(raw || "")
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .trim();
}

function normalizeMode(raw) {
  if (raw === "local" || raw === "deepseek" || raw === "online") return raw;
  return "online";
}

function defaultPrefs() {
  return {
    mode: /** @type {TranslateMode} */ ("online"),
    localModelId: "nllb-600m",
    deepseekApiKey: "",
    deepseekModel: DEEPSEEK_MODEL,
    autoAskLocal: true,
    lastSlowAskAt: 0,
    slowThresholdMs: SLOW_THRESHOLD_MS,
  };
}

export function loadTranslatePrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || "null");
    if (!raw || typeof raw !== "object") return defaultPrefs();
    const base = defaultPrefs();
    const mode = normalizeMode(raw.mode);
    const localModelId = LOCAL_TRANSLATE_MODELS.some((m) => m.id === raw.localModelId)
      ? raw.localModelId
      : base.localModelId;
    return {
      ...base,
      mode,
      localModelId,
      deepseekApiKey: String(raw.deepseekApiKey || "").trim(),
      deepseekModel: String(raw.deepseekModel || "").trim() || DEEPSEEK_MODEL,
      autoAskLocal: raw.autoAskLocal !== false,
      lastSlowAskAt: Number(raw.lastSlowAskAt) || 0,
      slowThresholdMs: Math.max(1500, Number(raw.slowThresholdMs) || SLOW_THRESHOLD_MS),
    };
  } catch {
    return defaultPrefs();
  }
}

export function saveTranslatePrefs(patch) {
  const next = { ...loadTranslatePrefs(), ...(patch || {}) };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(next));
  } catch (_) {}
  document.dispatchEvent(new CustomEvent("biyi-translate-prefs", { detail: next }));
  return next;
}

export function getLocalModel(id) {
  return LOCAL_TRANSLATE_MODELS.find((m) => m.id === (id || loadTranslatePrefs().localModelId)) || LOCAL_TRANSLATE_MODELS[0];
}

const MYMEMORY_CONTACT_EMAIL = "377933128@qq.com";

async function translateViaMyMemoryPair(text, langpair) {
  const params = new URLSearchParams({ q: text, langpair });
  const email = String(MYMEMORY_CONTACT_EMAIL || "").trim();
  if (email) params.set("de", email);
  const url = `https://api.mymemory.translated.net/get?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`mymemory ${res.status}`);
  const data = await res.json();
  const out = cleanText(data?.responseData?.translatedText);
  if (!out || /MYMEMORY WARNING/i.test(out)) throw new Error("mymemory empty");
  return out;
}

async function translateViaGoogleGtxPair(text, sl, tl) {
  const url =
    `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&dt=t&q=` +
    encodeURIComponent(text);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`gtx ${res.status}`);
  const data = await res.json();
  const parts = Array.isArray(data?.[0]) ? data[0] : [];
  const out = cleanText(parts.map((row) => row?.[0] || "").join(""));
  if (!out) throw new Error("gtx empty");
  return out;
}

async function translateOnline(text, direction) {
  const src = cleanText(text);
  if (!src) return "";
  if (direction === "zh-en") {
    try {
      return await translateViaMyMemoryPair(src, "zh-CN|en");
    } catch (_) {
      return translateViaGoogleGtxPair(src, "zh-CN", "en");
    }
  }
  try {
    return await translateViaMyMemoryPair(src, "en|zh-CN");
  } catch (_) {
    return translateViaGoogleGtxPair(src, "en", "zh-CN");
  }
}

function deepseekApiKey() {
  return String(loadTranslatePrefs().deepseekApiKey || "").trim();
}

/**
 * DeepSeek Chat Completions：只输出译文。
 * @param {string} text
 * @param {'zh-en'|'en-zh'} direction
 */
async function translateViaDeepSeek(text, direction) {
  const src = cleanText(text);
  if (!src) return "";
  const toEn = direction === "zh-en";
  const system = toEn
    ? "You are a professional Chinese editor and English translator. First silently correct any Chinese typos or wrong characters using context, then translate into natural English. Output only the English translation, with no quotes, labels, or explanation."
    : "You are a professional translator. Translate the user's English text into natural Simplified Chinese. Output only the Chinese translation, with no quotes, labels, or explanation.";
  const out = await deepseekChatCompletions(
    [
      { role: "system", content: system },
      { role: "user", content: src },
    ],
    { temperature: 0.2 }
  );
  if (!out) throw new Error("DeepSeek 返回为空");
  return out.replace(/^["「『]|["」』]$/g, "").trim();
}

async function deepseekChatCompletions(messages, { temperature = 0.2 } = {}) {
  const apiKey = deepseekApiKey();
  if (!apiKey) throw new Error("请先填写 DeepSeek API Key");
  const prefs = loadTranslatePrefs();
  const model = String(prefs.deepseekModel || DEEPSEEK_MODEL).trim() || DEEPSEEK_MODEL;
  const res = await fetch(DEEPSEEK_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature,
      stream: false,
      messages,
    }),
  });
  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    data = null;
  }
  if (!res.ok) {
    const msg =
      cleanText(data?.error?.message || data?.message || "") ||
      `DeepSeek HTTP ${res.status}`;
    throw new Error(msg);
  }
  return cleanText(data?.choices?.[0]?.message?.content || "");
}

function parseDeepseekJsonArray(raw) {
  let s = String(raw || "").trim();
  if (!s) throw new Error("DeepSeek 返回为空");
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  let data;
  try {
    data = JSON.parse(s);
  } catch {
    throw new Error("DeepSeek 返回不是有效 JSON");
  }
  if (!Array.isArray(data)) throw new Error("DeepSeek 返回格式错误");
  return data;
}

const DEEPSEEK_POLISH_BATCH = 20;

/**
 * DeepSeek：整篇语境下校对中文错别字，并译成英文。
 * @param {string[]} zhLines
 * @param {(done:number,total:number)=>void} [onProgress]
 * @returns {Promise<{chinese:string,english:string}[]>}
 */
export async function polishAndTranslateZhLinesViaDeepSeek(zhLines, onProgress) {
  const lines = (Array.isArray(zhLines) ? zhLines : []).map((z) => cleanText(z));
  const out = lines.map((zh) => ({ chinese: zh, english: "" }));
  const workIdx = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]) workIdx.push(i);
  }
  if (!workIdx.length) return out;

  const system =
    "You are an expert Chinese copy-editor and English translator for spoken video commentary. " +
    "For EACH numbered Chinese line: (1) Fix typos, wrong characters, and subtitle errors while keeping spoken tone and the same sense-group boundary—do not merge or split lines. " +
    "(2) Use surrounding context to disambiguate names, slang, and irony. " +
    "(3) Translate into natural conversational English that fits the whole piece. " +
    'Return ONLY a JSON array like [{"n":1,"zh":"corrected Chinese","en":"English"},...]. ' +
    "n must match the input numbers. No markdown, no commentary.";

  const total = workIdx.length;
  let finished = 0;

  for (let b = 0; b < workIdx.length; b += DEEPSEEK_POLISH_BATCH) {
    const batchIdx = workIdx.slice(b, b + DEEPSEEK_POLISH_BATCH);
    const firstGlobal = batchIdx[0];
    const lastGlobal = batchIdx[batchIdx.length - 1];
    const before = lines
      .slice(Math.max(0, firstGlobal - 4), firstGlobal)
      .filter(Boolean)
      .join("\n");
    const after = lines
      .slice(lastGlobal + 1, lastGlobal + 5)
      .filter(Boolean)
      .join("\n");
    const numbered = batchIdx.map((gi, j) => `${j + 1}. ${lines[gi]}`).join("\n");
    const user =
      `Context only (do not translate these lines):\n` +
      `Before:\n${before || "(none)"}\n\nAfter:\n${after || "(none)"}\n\n` +
      `Process these numbered Chinese lines (correct zh + contextual en). JSON only:\n${numbered}`;

    let arr = [];
    try {
      const content = await deepseekChatCompletions(
        [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        { temperature: 0.25 }
      );
      arr = parseDeepseekJsonArray(content);
    } catch (err) {
      // 整批失败：逐条回退（仍走带纠错提示的单句译英）
      console.warn("DeepSeek batch polish failed, fallback line-by-line", err);
      for (const gi of batchIdx) {
        try {
          const en = await translateViaDeepSeek(lines[gi], "zh-en");
          out[gi] = { chinese: lines[gi], english: en };
        } catch (e2) {
          console.warn(e2);
        }
        finished += 1;
        onProgress?.(finished, total);
      }
      continue;
    }

    const byN = new Map();
    for (const item of arr) {
      const n = Number(item?.n ?? item?.i ?? item?.index);
      if (!Number.isFinite(n) || n < 1 || n > batchIdx.length) continue;
      byN.set(n, item);
    }
    for (let j = 0; j < batchIdx.length; j += 1) {
      const gi = batchIdx[j];
      const item = byN.get(j + 1);
      let zh = cleanText(item?.zh || item?.chinese || "");
      let en = cleanText(item?.en || item?.english || "");
      if (!zh) zh = lines[gi];
      if (!en) {
        try {
          en = await translateViaDeepSeek(zh, "zh-en");
        } catch (_) {
          en = "";
        }
      }
      out[gi] = { chinese: zh, english: en };
      finished += 1;
      onProgress?.(finished, total);
    }
  }
  return out;
}

/** @type {Map<string, Promise<any>>} */
const pipelineCache = new Map();
let transformersMod = null;
let transformersReady = null;
let sessionSkipSlowAsk = false;
let pendingSlowAsk = null;

function modelsBaseUrl() {
  // Capacitor / 相对路径：www/models/
  try {
    return new URL("../models/", import.meta.url).href;
  } catch {
    return "./models/";
  }
}

function wasmBaseUrl() {
  try {
    return new URL("./vendor/transformers/", import.meta.url).href;
  } catch {
    return "./js/vendor/transformers/";
  }
}

function isIosNativeApp() {
  try {
    const cap = globalThis.Capacitor;
    if (!cap?.isNativePlatform?.()) return false;
    const p = String(cap.getPlatform?.() || "").toLowerCase();
    return p === "ios";
  } catch {
    return false;
  }
}

function appleTranslatePlugin() {
  try {
    const Cap = globalThis.Capacitor;
    if (!Cap) return null;
    if (Cap.Plugins?.AppleTranslate) return Cap.Plugins.AppleTranslate;
    // Capacitor 3+：按名注册代理，走原生 bridge
    if (typeof Cap.registerPlugin === "function") {
      return Cap.registerPlugin("AppleTranslate");
    }
    return null;
  } catch {
    return null;
  }
}

async function translateViaApple(text, direction) {
  const plugin = appleTranslatePlugin();
  if (!plugin?.translate) {
    throw new Error("系统翻译插件不可用（未注册到 Capacitor）");
  }
  const res = await plugin.translate({ text, direction });
  return cleanText(res?.text || "");
}

async function prepareAppleTranslate(direction = "zh-en") {
  const plugin = appleTranslatePlugin();
  if (!plugin?.prepare) throw new Error("系统翻译插件不可用（未注册到 Capacitor）");
  const source = direction === "en-zh" ? "en" : "zh-Hans";
  const target = direction === "en-zh" ? "zh-Hans" : "en";
  const res = await plugin.prepare({ source, target });
  if (res && res.ok === false) throw new Error(res.reason || "系统翻译准备失败");
  return { label: "系统翻译（Apple）", source, target };
}

async function loadTransformers() {
  if (isIosNativeApp()) {
    throw new Error("iPhone 无法加载 NLLB（内存不足会被系统杀掉）。本地翻译请用系统翻译");
  }
  if (transformersMod) return transformersMod;
  if (!transformersReady) {
    transformersReady = (async () => {
      // 使用自包含 bundle（内联 onnxruntime），避免 WKWebView 无法解析裸模块名
      const mod = await import(`./vendor/transformers/transformers.bundle.js?v=20261009vmclick`);
      const { env } = mod;
      env.allowLocalModels = true;
      env.allowRemoteModels = false;
      env.useBrowserCache = false;
      env.localModelPath = modelsBaseUrl();
      if (env.backends?.onnx?.wasm) {
        env.backends.onnx.wasm.wasmPaths = wasmBaseUrl();
        // iPhone WKWebView：单线程更稳
        env.backends.onnx.wasm.numThreads = 1;
      }
      transformersMod = mod;
      return mod;
    })();
  }
  return transformersReady;
}

async function getPipeline(hubDir) {
  const key = String(hubDir || "");
  if (!key) throw new Error("未指定本地模型");
  if (!pipelineCache.has(key)) {
    pipelineCache.set(
      key,
      (async () => {
        const { pipeline } = await loadTransformers();
        return pipeline("translation", key, { local_files_only: true });
      })()
    );
  }
  try {
    return await pipelineCache.get(key);
  } catch (err) {
    pipelineCache.delete(key);
    throw err;
  }
}

function pickTranslationText(out) {
  if (Array.isArray(out) && out[0]?.translation_text) return cleanText(out[0].translation_text);
  if (out?.translation_text) return cleanText(out.translation_text);
  return cleanText(out);
}

async function translateLocal(text, direction) {
  const src = cleanText(text);
  if (!src) return "";
  // iPhone：NLLB WASM 约需 3GB，会被系统杀掉 → 改用系统 Translation
  if (isIosNativeApp()) {
    return translateViaApple(src, direction);
  }
  const model = getLocalModel();
  try {
    if (model.kind === "opus-pair") {
      const hub = direction === "zh-en" ? model.hubZhEn : model.hubEnZh;
      const pipe = await getPipeline(hub);
      return pickTranslationText(await pipe(src));
    }
    const pipe = await getPipeline(model.hubDir);
    const opts =
      direction === "zh-en"
        ? { src_lang: model.srcZh, tgt_lang: model.tgtEn }
        : { src_lang: model.srcEn, tgt_lang: model.tgtZh };
    return pickTranslationText(await pipe(src, opts));
  } catch (err) {
    const msg = String(err?.message || err || "");
    if (/fetch|404|Not Found|Failed to fetch|local_files_only|no such file/i.test(msg)) {
      throw new Error(`本地模型未就绪（${model.label}）。请先运行 scripts/fetch-translate-models.sh`);
    }
    throw err;
  }
}

function openSlowAskDialog(latencyMs) {
  if (pendingSlowAsk) return pendingSlowAsk;
  pendingSlowAsk = new Promise((resolve) => {
    const dialog = document.getElementById("translate-slow-dialog");
    const desc = document.getElementById("translate-slow-desc");
    const btnStay = document.getElementById("btn-translate-slow-stay");
    const btnSwitch = document.getElementById("btn-translate-slow-switch");
    const btnNever = document.getElementById("btn-translate-slow-never");
    if (!dialog || !btnStay || !btnSwitch) {
      pendingSlowAsk = null;
      resolve("stay");
      return;
    }
    if (desc) {
      desc.textContent = `在线翻译约 ${Math.round(latencyMs / 100) / 10} 秒/条，偏慢。是否切换到本地模型继续？本地首次加载会稍慢，之后离线可用。`;
    }
    dialog.classList.remove("hidden");
    const finish = (choice) => {
      dialog.classList.add("hidden");
      btnStay.removeEventListener("click", onStay);
      btnSwitch.removeEventListener("click", onSwitch);
      btnNever?.removeEventListener("click", onNever);
      pendingSlowAsk = null;
      resolve(choice);
    };
    const onStay = () => {
      sessionSkipSlowAsk = true;
      saveTranslatePrefs({ lastSlowAskAt: Date.now() });
      finish("stay");
    };
    const onSwitch = () => {
      saveTranslatePrefs({ mode: "local", lastSlowAskAt: Date.now() });
      finish("switch");
    };
    const onNever = () => {
      sessionSkipSlowAsk = true;
      saveTranslatePrefs({ autoAskLocal: false, lastSlowAskAt: Date.now() });
      finish("never");
    };
    btnStay.addEventListener("click", onStay);
    btnSwitch.addEventListener("click", onSwitch);
    btnNever?.addEventListener("click", onNever);
  });
  return pendingSlowAsk;
}

async function maybeAskSwitchLocal(latencyMs) {
  const prefs = loadTranslatePrefs();
  if (prefs.mode !== "online") return false;
  if (!prefs.autoAskLocal || sessionSkipSlowAsk) return false;
  if (latencyMs < (prefs.slowThresholdMs || SLOW_THRESHOLD_MS)) return false;
  // 冷却期内不重复弹（本会话点过「继续在线」也会跳过）
  if (Date.now() - (prefs.lastSlowAskAt || 0) < SLOW_ASK_COOLDOWN_MS) return false;
  const choice = await openSlowAskDialog(latencyMs);
  return choice === "switch";
}

/**
 * @param {string} text
 * @param {'zh-en'|'en-zh'} direction
 * @param {{skipSlowAsk?:boolean, forceLocal?:boolean, forceMode?:'online'|'deepseek'|'local'}} [opts]
 */
export async function translateText(text, direction, opts = {}) {
  const src = cleanText(text);
  if (!src) return "";
  let prefs = loadTranslatePrefs();
  const forceLocal = !!(opts.forceLocal || opts.forceMode === "local");
  const forceOnline = opts.forceMode === "online";
  const forceDeepseek = opts.forceMode === "deepseek";
  const useDeepseek = forceDeepseek || (!forceLocal && !forceOnline && prefs.mode === "deepseek");

  if (forceLocal || (!forceOnline && !forceDeepseek && prefs.mode === "local")) {
    return translateLocal(src, direction);
  }

  if (useDeepseek) {
    return translateViaDeepSeek(src, direction);
  }

  const t0 = performance.now();
  try {
    const out = await translateOnline(src, direction);
    const ms = performance.now() - t0;
    if (!opts.skipSlowAsk && !forceOnline) {
      const switched = await maybeAskSwitchLocal(ms);
      if (switched) {
        syncTranslateEngineUi();
      }
    }
    return out;
  } catch (err) {
    const ms = performance.now() - t0;
    if (!opts.skipSlowAsk && !forceOnline) {
      const switched = await maybeAskSwitchLocal(Math.max(ms, prefs.slowThresholdMs || SLOW_THRESHOLD_MS));
      if (switched) {
        syncTranslateEngineUi();
        return translateLocal(src, direction);
      }
    }
    throw err;
  }
}

export async function translateEnToZh(text, opts) {
  return translateText(text, "en-zh", opts);
}

export async function translateZhToEn(text, opts) {
  return translateText(text, "zh-en", opts);
}

/**
 * @param {string[]} lines
 * @param {'zh-en'|'en-zh'} direction
 * @param {(done:number,total:number,meta?:object)=>void} [onProgress]
 */
export async function translateLines(lines, direction, onProgress) {
  const list = (lines || []).map((s) => cleanText(s));
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    const line = list[i];
    const prefs = loadTranslatePrefs();
    const t0 = performance.now();
    let translated = "";
    if (line) {
      translated = await translateText(line, direction, { skipSlowAsk: false });
    }
    const ms = performance.now() - t0;
    out.push(translated);
    if (typeof onProgress === "function") {
      onProgress(i + 1, list.length, { ms, mode: loadTranslatePrefs().mode, modelId: prefs.localModelId });
    }
  }
  return out;
}

export async function translateEnLinesToZh(lines, onProgress) {
  return translateLines(lines, "en-zh", onProgress);
}

export async function translateZhLinesToEn(lines, onProgress) {
  return translateLines(lines, "zh-en", onProgress);
}

/** 预热当前本地模型（用户切到本地时调用） */
export async function warmupLocalModel(modelId) {
  const prefs = saveTranslatePrefs(modelId ? { localModelId: modelId, mode: "local" } : { mode: "local" });
  if (isIosNativeApp()) {
    await prepareAppleTranslate("zh-en");
    await prepareAppleTranslate("en-zh");
    return { id: "apple", label: "系统翻译（Apple）" };
  }
  const model = getLocalModel(prefs.localModelId);
  if (model.kind === "opus-pair") {
    await getPipeline(model.hubZhEn);
    await getPipeline(model.hubEnZh);
  } else {
    await getPipeline(model.hubDir);
  }
  return model;
}

export async function probeLocalModelReady(modelId) {
  if (isIosNativeApp()) {
    const plugin = appleTranslatePlugin();
    if (!plugin?.isAvailable) return false;
    try {
      const res = await plugin.isAvailable();
      return !!res?.ok;
    } catch {
      return false;
    }
  }
  const model = getLocalModel(modelId);
  const hubs =
    model.kind === "opus-pair" ? [model.hubZhEn, model.hubEnZh] : [model.hubDir];
  for (const hub of hubs) {
    const url = new URL(`${hub}/config.json`, modelsBaseUrl());
    const res = await fetch(url.href, { method: "GET", cache: "no-store" });
    if (!res.ok) return false;
  }
  return true;
}

export function syncTranslateEngineUi() {
  const prefs = loadTranslatePrefs();
  const modeEl = document.getElementById("translate-engine-mode");
  const modelEl = document.getElementById("translate-engine-model");
  const statusEl = document.getElementById("translate-engine-status");
  const modelWrap = document.getElementById("translate-engine-model-wrap");
  const keyWrap = document.getElementById("translate-deepseek-key-wrap");
  const keyEl = document.getElementById("translate-deepseek-key");
  const btnRetrans = document.getElementById("btn-retranslate-en");
  if (modeEl) modeEl.value = prefs.mode;
  if (modelEl) {
    if (!modelEl.options.length) {
      for (const m of LOCAL_TRANSLATE_MODELS) {
        const opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = m.label;
        modelEl.appendChild(opt);
      }
    }
    modelEl.value = prefs.localModelId;
  }
  if (modelWrap) modelWrap.classList.add("hidden");
  if (keyWrap) keyWrap.classList.toggle("hidden", prefs.mode !== "deepseek");
  if (keyEl && document.activeElement !== keyEl) {
    keyEl.value = prefs.deepseekApiKey || "";
  }
  if (btnRetrans) {
    if (prefs.mode === "deepseek") {
      btnRetrans.textContent = "校对译英";
      btnRetrans.title = "DeepSeek：只校对并译有改动的意群，未改动的保持不动";
    } else {
      btnRetrans.textContent = "译英";
      btnRetrans.title = "只把有改动的意群按当前引擎译英，未改动的保持不动";
    }
  }
  if (statusEl) {
    if (prefs.mode === "online") statusEl.textContent = "当前：在线（MyMemory → Google）";
    else if (prefs.mode === "deepseek") {
      statusEl.textContent = prefs.deepseekApiKey
        ? `当前：DeepSeek（${prefs.deepseekModel || DEEPSEEK_MODEL}）`
        : "当前：DeepSeek（请填写 API Key）";
    } else if (isIosNativeApp()) statusEl.textContent = "当前：本地 · 系统翻译（Apple）";
    else statusEl.textContent = `当前：本地 · ${getLocalModel(prefs.localModelId).label}`;
  }
}

export function bindTranslateEngineUi() {
  syncTranslateEngineUi();
  const modeEl = document.getElementById("translate-engine-mode");
  const modelEl = document.getElementById("translate-engine-model");
  const keyEl = document.getElementById("translate-deepseek-key");

  modeEl?.addEventListener("change", () => {
    const mode = normalizeMode(modeEl.value);
    saveTranslatePrefs({ mode });
    syncTranslateEngineUi();
    // 本地引擎在首次真正翻译时再准备（系统翻译 / NLLB），不单独预热
  });

  modelEl?.addEventListener("change", () => {
    if (isIosNativeApp()) return;
    saveTranslatePrefs({ localModelId: modelEl.value, mode: "local" });
    syncTranslateEngineUi();
  });

  const saveKey = () => {
    saveTranslatePrefs({
      deepseekApiKey: String(keyEl?.value || "").trim(),
      mode: "deepseek",
    });
    syncTranslateEngineUi();
  };
  keyEl?.addEventListener("change", saveKey);
  keyEl?.addEventListener("blur", saveKey);

  document.addEventListener("biyi-translate-prefs", () => syncTranslateEngineUi());
}
