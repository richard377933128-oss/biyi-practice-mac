/** 中英互译：统一走 translate-engine（在线 / 本地多模型） */
export {
  translateEnToZh,
  translateZhToEn,
  translateEnLinesToZh,
  translateZhLinesToEn,
  translateText,
  translateLines,
  polishAndTranslateZhLinesViaDeepSeek,
  loadTranslatePrefs,
  saveTranslatePrefs,
  LOCAL_TRANSLATE_MODELS,
  getLocalModel,
  warmupLocalModel,
  probeLocalModelReady,
  bindTranslateEngineUi,
  syncTranslateEngineUi,
} from "./translate-engine.js?v=20261012dl";
