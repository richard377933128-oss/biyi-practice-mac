/** 笔译逐字校验 / 虚词自动填入（自原默写引擎抽出） */

const AUTO_WORDS = new Set([
  "a", "an", "the",
  "and", "or", "but", "nor", "yet", "so", "both", "either", "neither", "not", "only",
  "that", "which", "who", "whom", "whose", "what", "when", "where", "why", "how",
  "if", "unless", "until", "while", "whereas", "whether", "because", "although",
  "though", "since", "after", "before", "than", "as",
  "of", "for", "to", "in", "on", "at", "by", "with", "from", "into", "onto", "upon",
  "about", "above", "across", "against", "along", "among", "around", "behind", "below",
  "beneath", "beside", "between", "beyond", "during", "except", "inside", "near", "over",
  "through", "throughout", "toward", "towards", "under", "underneath", "unto", "via",
  "within", "without", "per", "plus", "versus", "amid", "amidst", "amongst", "besides",
  "concerning", "despite", "including", "regarding",
  "is", "am", "are", "was", "were", "be", "been", "being",
  "do", "does", "did", "have", "has", "had",
  "will", "would", "shall", "should", "can", "could", "may", "might", "must",
  "i", "me", "my", "mine", "you", "your", "yours", "he", "him", "his",
  "she", "her", "hers", "it", "its", "we", "us", "our", "ours",
  "they", "them", "their", "theirs", "this", "these", "those",
  "some", "any", "no", "every", "each", "all", "few", "many", "much", "more", "most",
  "other", "another", "such",
  "i'm", "i've", "i'd", "i'll", "you're", "you've", "you'd", "you'll",
  "he's", "he'd", "he'll", "she's", "she'd", "she'll",
  "it's", "it'd", "it'll", "we're", "we've", "we'd", "we'll",
  "they're", "they've", "they'd", "they'll",
  "that's", "that'd", "that'll", "there's", "there'd", "there'll",
  "here's", "where's", "what's", "who's", "who'll", "who'd", "how's", "let's",
  "don't", "doesn't", "didn't", "can't", "couldn't", "won't", "wouldn't", "shouldn't",
  "isn't", "aren't", "wasn't", "weren't", "hasn't", "haven't", "hadn't", "mustn't", "ain't",
]);

export function normalizeDictationText(s, { asTarget = false } = {}) {
  let out = String(s || "")
    .replace(/\u00a0/g, " ")
    .replace(/[\u2018\u2019\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201F\u2033]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^\s+/, "");
  if (asTarget) out = out.replace(/\s+$/, "");
  return out;
}

export function sameDictationChar(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

export function dictationCharLabel(ch) {
  if (!ch) return "";
  if (/\s/.test(ch)) return "空格";
  return ch;
}

export function dictationErrorHint(expected, got) {
  if (!expected) return "已经写完了，不要再加字";
  if (/\s/.test(expected)) return "这里需要空格";
  if (/[^A-Za-z0-9]/.test(expected)) return "这里是标点，写错了";
  return "写错了，请改对再继续";
}

function wordKey(word) {
  return String(word || "")
    .toLowerCase()
    .replace(/\u2019/g, "'");
}

function isAutoChar(ch) {
  return !!ch && !/[A-Za-z0-9]/.test(ch);
}

function isWordStart(text, index) {
  if (index <= 0) return true;
  return !/[A-Za-z]/.test(text[index - 1]);
}

function nextWord(target, start) {
  let i = start;
  if (!/[A-Za-z]/.test(target[i] || "")) return { word: "", end: start };
  while (i < target.length) {
    const ch = target[i];
    if (/[A-Za-z]/.test(ch)) {
      i += 1;
      continue;
    }
    if ((ch === "'" || ch === "\u2019") && i + 1 < target.length && /[A-Za-z]/.test(target[i + 1])) {
      i += 1;
      continue;
    }
    break;
  }
  return { word: target.slice(start, i), end: i };
}

export function autoAppendDictationExtras(text, target, { fillFunctionWords = true } = {}) {
  if (!target) return text || "";
  let out = text || "";
  while (out.length < target.length) {
    const ch = target[out.length];
    if (isAutoChar(ch)) {
      out += ch;
      continue;
    }
    if (fillFunctionWords && /[A-Za-z]/.test(ch)) {
      let start = out.length;
      while (start > 0 && /[A-Za-z'\u2019]/.test(target[start - 1])) start -= 1;
      if (!isWordStart(target, start)) break;
      const { word, end } = nextWord(target, start);
      if (word && AUTO_WORDS.has(wordKey(word))) {
        out = target.slice(0, end);
        continue;
      }
    }
    break;
  }
  return out;
}

export function isDictationAutoWord(word) {
  const w = wordKey(word);
  return !!w && AUTO_WORDS.has(w);
}

export function clampDictationTyped(typed, target) {
  const src = normalizeDictationText(typed || "");
  if (!target) return "";
  let i = 0;
  const limit = Math.min(src.length, target.length);
  while (i < limit && sameDictationChar(src[i], target[i])) i += 1;
  return autoAppendDictationExtras(target.slice(0, i), target, { fillFunctionWords: !!src });
}
