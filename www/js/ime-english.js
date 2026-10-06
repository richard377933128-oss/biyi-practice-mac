/** 笔译框聚焦时切到英文输入，离开后还原。Mac 走本地代理/Electron；iPhone 走原生插件。 */

const IME_ENDPOINTS = {
  english: "http://127.0.0.1:8765/__pte/ime-english",
  restore: "http://127.0.0.1:8765/__pte/ime-restore",
};

function desktopApi() {
  return typeof window !== "undefined" ? window.pteDesktop : null;
}

function capacitorIme() {
  try {
    return window.Capacitor?.Plugins?.ImeEnglish || null;
  } catch (_) {
    return null;
  }
}

function preferLatinAttrs(el) {
  if (!el) return;
  el.setAttribute("lang", "en");
  el.setAttribute("inputmode", "latin");
  el.setAttribute("autocapitalize", "off");
  el.setAttribute("autocomplete", "off");
  el.setAttribute("autocorrect", "off");
  el.setAttribute("spellcheck", "false");
}

export function selectEnglishInputMethod() {
  preferLatinAttrs(document.getElementById("translation-input"));
  const desk = desktopApi();
  if (desk?.selectEnglishInput) {
    return Promise.resolve(desk.selectEnglishInput()).catch(() => {});
  }
  const plugin = capacitorIme();
  if (plugin?.selectEnglish) {
    return Promise.resolve(plugin.selectEnglish()).catch(() => {});
  }
  return fetch(IME_ENDPOINTS.english, { method: "POST", mode: "cors" }).catch(() => {});
}

export function restoreInputMethod() {
  const desk = desktopApi();
  if (desk?.restoreInputMethod) {
    return Promise.resolve(desk.restoreInputMethod()).catch(() => {});
  }
  const plugin = capacitorIme();
  if (plugin?.restore) {
    return Promise.resolve(plugin.restore()).catch(() => {});
  }
  return fetch(IME_ENDPOINTS.restore, { method: "POST", mode: "cors" }).catch(() => {});
}

export function bindEnglishInputOnFocus(el) {
  if (!el || el.dataset.pteImeBound === "1") return;
  el.dataset.pteImeBound = "1";
  preferLatinAttrs(el);
  const toEnglish = () => {
    selectEnglishInputMethod();
  };
  el.addEventListener("pointerdown", toEnglish);
  el.addEventListener("focus", toEnglish);
  el.addEventListener("blur", () => {
    restoreInputMethod();
  });
}
