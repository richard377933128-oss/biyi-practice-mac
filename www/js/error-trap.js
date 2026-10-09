/**
 * 全局错误兜底：捕获 JS 异常 / Promise 未处理拒绝 / 资源加载失败。
 * 在 app.js 第一个 import，越早起效越好。
 * 出错后右下角出现红点，点开可看最近错误并一键复制（真机排错用）。
 */

const MAX_ENTRIES = 50;
const entries = [];
let badgeEl = null;
let panelEl = null;

function pushEntry(type, msg, stack) {
  entries.push({
    at: new Date(),
    type,
    msg: String(msg || "").slice(0, 2000),
    stack: String(stack || "").slice(0, 4000),
  });
  if (entries.length > MAX_ENTRIES) entries.shift();
  showBadge();
}

function fmt(e) {
  const t = e.at.toTimeString().slice(0, 8);
  return `[${t}] ${e.type}\n${e.msg}${e.stack ? `\n${e.stack}` : ""}`;
}

function showBadge() {
  if (panelEl || badgeEl) return;
  badgeEl = document.createElement("button");
  badgeEl.type = "button";
  badgeEl.setAttribute("aria-label", `发现 ${entries.length} 个错误，点击查看`);
  badgeEl.style.cssText =
    "position:fixed;right:14px;bottom:14px;z-index:99999;width:22px;height:22px;" +
    "border-radius:50%;border:2px solid #fff;background:#e5484d;box-shadow:0 1px 6px rgba(0,0,0,.35);" +
    "cursor:pointer;padding:0;";
  badgeEl.addEventListener("click", openPanel);
  document.body.appendChild(badgeEl);
}

function openPanel() {
  if (panelEl) return;
  panelEl = document.createElement("div");
  panelEl.style.cssText =
    "position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.5);display:flex;" +
    "align-items:flex-end;justify-content:center;";
  const card = document.createElement("div");
  card.style.cssText =
    "background:#fff;color:#222;width:100%;max-width:560px;max-height:78vh;border-radius:14px 14px 0 0;" +
    "display:flex;flex-direction:column;overflow:hidden;font:13px/1.5 -apple-system,monospace;";
  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;gap:8px;padding:10px 12px;border-bottom:1px solid #eee;";
  const title = document.createElement("div");
  title.textContent = `最近错误（${entries.length}）`;
  title.style.cssText = "flex:1;font-weight:600;align-self:center;";
  const copyBtn = document.createElement("button");
  copyBtn.textContent = "全部复制";
  const clearBtn = document.createElement("button");
  clearBtn.textContent = "清空";
  const closeBtn = document.createElement("button");
  closeBtn.textContent = "关闭";
  for (const b of [copyBtn, clearBtn, closeBtn]) {
    b.style.cssText =
      "border:1px solid #ddd;background:#f6f6f6;border-radius:8px;padding:6px 10px;font-size:13px;";
  }
  const list = document.createElement("pre");
  list.style.cssText =
    "margin:0;padding:10px 12px;overflow:auto;white-space:pre-wrap;word-break:break-all;flex:1;";
  list.textContent = entries.slice().reverse().map(fmt).join("\n\n———\n\n") || "（暂无错误）";

  copyBtn.addEventListener("click", async () => {
    const text = entries.map(fmt).join("\n\n———\n\n");
    try {
      await navigator.clipboard.writeText(text);
      copyBtn.textContent = "已复制";
    } catch (_) {
      // 剪贴板 API 不可用时降级：选中全文让用户手动复制
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(list);
      sel.removeAllRanges();
      sel.addRange(range);
      copyBtn.textContent = "已全选";
    }
    setTimeout(() => (copyBtn.textContent = "全部复制"), 1500);
  });
  clearBtn.addEventListener("click", () => {
    entries.length = 0;
    closePanel();
  });
  closeBtn.addEventListener("click", closePanel);
  panelEl.addEventListener("click", (ev) => {
    if (ev.target === panelEl) closePanel();
  });

  bar.append(title, copyBtn, clearBtn, closeBtn);
  card.append(bar, list);
  panelEl.appendChild(card);
  document.body.appendChild(panelEl);
}

function closePanel() {
  panelEl?.remove();
  panelEl = null;
  badgeEl?.remove();
  badgeEl = null;
  if (entries.length) showBadge();
}

function install() {
  window.addEventListener("error", (ev) => {
    if (ev.message) pushEntry("JS 异常", `${ev.message}\n${ev.filename || ""}:${ev.lineno || ""}`, ev.error?.stack);
    else if (ev.target && ev.target !== window) pushEntry("资源加载失败", ev.target.src || ev.target.href || ev.target.tagName);
  });
  window.addEventListener("unhandledrejection", (ev) => {
    const r = ev.reason;
    pushEntry("Promise 未处理", r?.message || String(r), r?.stack);
  });
}

install();

// 调试钩子：诊断页或控制台可直接取用
window.__biyiErrors = entries;
