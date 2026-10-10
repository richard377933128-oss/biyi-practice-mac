/**
 * 动宾短语（VO phrase）抽取
 *
 * 从文章英文里抽出「动词 + 宾语」搭配，宾语收敛到中心词：
 *   Modern buildings have to achieve certain performance requirements,
 *   at least to satisfy those of building codes,
 *   to provide a safe, healthy, and comfortable environment.
 *   However, these conditioned environments demand resources in energy and materials, ...
 * →
 *   achieve requirements / satisfy those / provide environment / demand resources
 *
 * 词性判断优先用内置离线词典（ECDICT 分片，释义里带 vt./vi./n. 等标注），
 * 词典缺词时退回少量功能词表 + 形态规则。
 */

/* ----------------------------- 功能词表 ----------------------------- */

// 助动词 / 情态动词（不作为动宾短语的主动词）
const AUX_MODAL = new Set([
  "am", "is", "are", "was", "were", "be", "been", "being",
  "do", "does", "did", "done", "doing",
  "will", "would", "shall", "should", "can", "could", "may", "might",
  "must", "ought",
]);
const HAVE_AUX = new Set(["have", "has", "had", "having"]);

// 限定词（后接名词中心词，出现于动词前时说明该词是名词而非动词）
const DETERMINERS = new Set([
  "a", "an", "the", "this", "that", "these", "those",
  "my", "your", "his", "her", "its", "our", "their",
  "some", "any", "no", "every", "each", "either", "neither",
  "both", "all", "many", "much", "few", "little", "several",
  "such", "another", "other", "what", "which", "whose",
  "half", "enough", "most",
]);

// 可作宾语中心词的代词（无名词时也可独立作中心词，如 "satisfy those"）
const PRONOUN_HEADS = new Set([
  "me", "you", "him", "her", "it", "us", "them",
  "this", "that", "these", "those", "one", "ones",
  "someone", "something", "anyone", "anything", "everyone", "everything",
  "nobody", "nothing", "myself", "yourself", "himself", "herself", "itself",
  "ourselves", "yourselves", "themselves", "all", "some", "many", "most",
  "few", "both", "none", "each", "either", "neither", "others", "another",
]);

// 介词：宾语名词短语在此结束（后续介词短语视为后置修饰）
const PREPOSITIONS = new Set([
  "about", "above", "across", "after", "against", "along", "among", "amongst",
  "amid", "around", "as", "at", "before", "behind", "below", "beneath",
  "beside", "between", "beyond", "by", "despite", "down", "during", "except",
  "for", "from", "in", "inside", "into", "like", "near", "of", "off", "on",
  "onto", "out", "outside", "over", "past", "per", "since", "through",
  "throughout", "till", "to", "toward", "towards", "under", "underneath",
  "until", "up", "upon", "with", "within", "without", "via", "than",
]);

// 从属连词 / 关系词：遇到即视为新分句，宾语结束
const SUBORDINATORS = new Set([
  "which", "who", "whom", "whose", "where", "when", "why",
  "because", "although", "though", "while", "whereas", "if", "unless",
  "since", "until", "till", "before", "after", "whether", "whenever",
  "wherever", "however", "therefore", "thus", "hence", "so", "yet", "but",
]);

// 关系代词（一定结束宾语）
const RELATIVE = new Set(["which", "who", "whom", "whose"]);

// 关系/疑问代词：虽在 DETERMINERS 里，但常作主语，其后紧接谓语（which convinced him）
const SUBJECT_PRONOUNS = new Set(["which", "what", "that", "whose", "who", "whom"]);

// 并列连词：名词短语/动词短语内部出现，不结束宾语
const COORDINATORS = new Set(["and", "or", "nor"]);

// 不能作宾语中心词的词（物主限定词、程度/频率副词等）
// 限定词：不能当名词短语的中心词。
// 注意 "her" 不在此列——它既是物主限定词（her work）又是宾格代词（test her），
// 放进这里会让 "to test her" 这类动宾整个抽不出来。限定词用法改由 isDetUse() 按后接词判断。
const NOT_HEAD = new Set([
  "my", "your", "his", "its", "our", "their", "whose",
  "yes", "no", "not", "so", "too", "very", "just", "only", "also",
  "even", "still", "yet", "there", "here", "then", "now", "as",
  "more", "most", "less", "least", "quite", "rather", "almost", "nearly",
  "always", "often", "sometimes", "never", "ever", "again", "once", "twice",
  "soon", "later", "already", "finally", "perhaps", "maybe", "probably",
  "certainly", "indeed", "instead", "otherwise", "meanwhile", "besides",
  "moreover", "furthermore", "nevertheless", "consequently", "specifically",
  "particularly", "especially", "generally", "usually", "typically",
  "frequently", "rarely", "seldom", "hardly", "barely", "merely", "simply",
  "exactly", "precisely", "approximately", "roughly", "together", "apart",
  "away", "back", "forward", "ahead", "however", "therefore", "thus", "hence",
]);

// be 动词：其后接 -ed 形式视为被动语态，不构成动宾
const BE_FORMS = new Set(["am", "is", "are", "was", "were", "be", "been", "being"]);

// 有限 be 动词（可独立作谓语）：兜底抽动词时的最后手段
const FINITE_BE = new Set(["am", "is", "are", "was", "were"]);

// 触发「名/动兼类词当动词用」的助动词
// （不含 be 动词："is like" 里 like 不是动词；不含 have："has twin babies" 里 twin 是形容词）
const AUX_TRIGGER = new Set([
  "to", "can", "could", "may", "might", "must", "shall", "should",
  "will", "would", "ought", "do", "does", "did",
]);

// 常见副词（用于跳过，寻找真正的助动词）
const ADVERBS = new Set([
  "often", "just", "also", "still", "already", "never", "always", "usually",
  "typically", "generally", "frequently", "rarely", "sometimes", "well",
  "then", "now", "soon", "later", "finally", "merely", "simply", "hardly",
  "barely", "nearly", "almost", "quite", "rather", "really", "truly",
  "actually", "apparently", "reportedly", "commonly", "widely", "largely",
  "mainly", "mostly", "fully", "completely", "entirely", "greatly", "highly",
  "deeply", "heavily", "strongly", "sharply", "rapidly", "slowly",
  "gradually", "suddenly", "immediately", "eventually", "ultimately",
  "recently", "previously", "formerly", "originally", "initially",
  "subsequently", "consequently", "thus", "hence", "therefore", "however",
]);

// 可触发 -ing 形式作谓语的助动词（"is building"）；其余 -ing 视为定语/动名词
const AUX_FOR_ING = new Set([
  "am", "is", "are", "was", "were", "be", "been", "being", "to",
]);

// 时间状语名词：last month / next week 等不是宾语
const TIME_NOUNS = new Set([
  "day", "days", "week", "weeks", "month", "months", "year", "years",
  "morning", "afternoon", "evening", "night", "moment", "minute", "minutes",
  "hour", "hours", "time", "times", "while", "decade", "decades", "century",
  "centuries", "season", "spring", "summer", "autumn", "winter", "weekend",
  "period", "term", "era", "age", "today", "yesterday", "tomorrow",
]);
const TIME_DETS = new Set([
  "last", "next", "this", "that", "every", "past", "recent",
  "previous", "following", "coming",
]);

// 系动词 / 半系动词 / 常见不及物动词：其后为表语或状语，不构成动宾短语
const NON_VO_VERBS = new Set([
  "become", "becomes", "became", "becoming", "seem", "seems", "seemed", "seeming",
  "appear", "appears", "appeared", "appearing", "remain", "remains", "remained", "remaining",
  "stay", "stays", "stayed", "staying", "prove", "proves", "proved", "proven", "proving",
  "look", "looks", "looked", "looking", "sound", "sounds", "sounded", "sounding",
  "feel", "feels", "felt", "feeling", "go", "goes", "went", "gone", "going",
  "come", "comes", "came", "coming", "arrive", "arrives", "arrived", "arriving",
  "depart", "departs", "departed", "happen", "happens", "happened", "happening",
  "occur", "occurs", "occurred", "occurring", "exist", "exists", "existed", "existing",
  "belong", "belongs", "belonged", "consist", "consists", "consisted",
  "depend", "depends", "depended", "differ", "differs", "differed",
  "matter", "matters", "mattered", "tend", "tends", "tended",
  "rise", "rises", "rose", "risen", "rising", "fall", "falls", "fell", "fallen", "falling",
  "die", "dies", "died", "dying", "lie", "lies", "lay", "lain", "lying",
  "stand", "stands", "stood", "standing", "sit", "sits", "sat", "sitting",
  "wait", "waits", "waited", "listen", "listens", "listened",
  "agree", "agrees", "agreed", "refuse", "refuses", "refused",
  "apologize", "apologizes", "apologized", "complain", "complains", "complained",
  "respond", "responds", "responded", "reply", "replies", "replied",
  "react", "reacts", "reacted", "participate", "participates", "participated",
  "rely", "relies", "relied", "escape", "escapes", "escaped",
  "flee", "flees", "fled", "fleeing", "smile", "smiles", "smiled", "smiling",
  "cry", "cries", "cried", "crying", "sigh", "sighs", "sighed",
  "sleep", "sleeps", "slept", "sleeping", "wake", "wakes", "woke", "woken",
  "kneel", "kneels", "knelt", "swim", "swims", "swam", "swum",
]);

// 常见及物动词表：名/动兼类词（demand、test、pay…）在此表中才判定为动词
const COMMON_VERBS = new Set([
  "accept", "accompany", "accomplish", "accuse", "achieve", "acknowledge", "acquire",
  "adapt", "add", "address", "adjust", "admire", "admit", "adopt", "advance", "advise",
  "affect", "afford", "aim", "alert", "allow", "alter", "analyze", "announce", "answer",
  "anticipate", "appeal", "apply", "appoint", "appreciate", "approach", "approve", "argue",
  "arrange", "arrest", "ask", "assemble", "assess", "assign", "assist", "assume", "assure",
  "attach", "attack", "attempt", "attend", "attract", "avoid", "back", "ban", "base", "bear",
  "beat", "beg", "begin", "behave", "believe", "bend", "benefit", "bet", "betray", "blame",
  "blend", "block", "boost", "borrow", "bother", "break", "bring", "broadcast", "build",
  "burn", "buy", "calculate", "call", "calm", "cancel", "capture", "carry", "cast", "catch",
  "cause", "celebrate", "challenge", "change", "charge", "chase", "cheat", "check", "cheer",
  "choose", "cite", "claim", "clarify", "clean", "clear", "climb", "close", "collect",
  "combine", "comfort", "command", "comment", "commit", "compare", "compel", "compensate",
  "compete", "complain", "complete", "compose", "concentrate", "concern", "conclude",
  "condemn", "conduct", "confess", "confirm", "confront", "confuse", "congratulate",
  "connect", "conquer", "conserve", "consider", "console", "construct", "consult", "consume",
  "contain", "continue", "contribute", "control", "convince", "cook", "cooperate", "copy",
  "correct", "cost", "count", "cover", "create", "criticize", "cross", "cure", "cut",
  "damage", "deal", "debate", "decide", "declare", "decline", "decorate", "decrease",
  "dedicate", "defeat", "defend", "define", "delay", "delegate", "delete", "deliver",
  "demand", "demonstrate", "deny", "depict", "deposit", "describe", "deserve", "design",
  "desire", "destroy", "detect", "determine", "develop", "devote", "diagnose", "dig",
  "direct", "discover", "discuss", "dislike", "display", "dissolve", "distinguish",
  "distribute", "disturb", "divide", "document", "dominate", "donate", "doubt", "download",
  "drag", "draw", "dream", "dress", "drink", "drive", "drop", "drown", "earn", "eat",
  "educate", "elect", "eliminate", "embarrass", "employ", "empower", "enable", "encourage",
  "endanger", "endure", "enforce", "engage", "enjoy", "ensure", "enter", "entertain",
  "envy", "equip", "erase", "establish", "estimate", "evaluate", "examine", "exceed",
  "exchange", "excite", "exclude", "excuse", "execute", "exercise", "exhibit", "expand",
  "expect", "experiment", "explain", "explore", "export", "expose", "express", "extend",
  "face", "facilitate", "fail", "fasten", "favor", "fear", "feed", "fetch", "fight",
  "figure", "fill", "finance", "find", "finish", "fire", "fit", "fix", "float", "flood",
  "flow", "fly", "fold", "follow", "forbid", "force", "forecast", "forget", "forgive",
  "form", "found", "freeze", "frighten", "frustrate", "fulfill", "function", "fund", "gain",
  "gather", "generate", "get", "give", "govern", "grab", "graduate", "grant", "grasp",
  "greet", "grieve", "grind", "grip", "grow", "guarantee", "guard", "guess", "guide",
  "handle", "hang", "harm", "hate", "heal", "hear", "heat", "help", "hide", "highlight",
  "hire", "hit", "hold", "honor", "hope", "host", "hug", "hunt", "hurry", "hurt",
  "identify", "ignore", "illustrate", "imagine", "imitate", "implement", "imply", "import",
  "impose", "impress", "improve", "include", "incorporate", "increase", "indicate",
  "influence", "inform", "inherit", "injure", "insert", "insist", "inspect", "inspire",
  "install", "instruct", "insult", "insure", "integrate", "intend", "interact", "interest",
  "interfere", "interpret", "interrupt", "introduce", "invent", "invest", "investigate",
  "invite", "involve", "isolate", "issue", "join", "judge", "justify", "keep", "kick",
  "kill", "kiss", "knock", "know", "label", "lack", "land", "laugh", "launch", "lay",
  "lead", "leak", "lean", "leap", "learn", "leave", "lend", "lengthen", "let", "level",
  "liberate", "lift", "light", "limit", "link", "live", "load", "locate", "lock",
  "lose", "love", "lower", "maintain", "make", "manage", "manufacture", "mark", "marry",
  "match", "mean", "measure", "meet", "melt", "mention", "merge", "migrate", "mimic",
  "mind", "miss", "mix", "modify", "monitor", "motivate", "mount", "move", "murder",
  "name", "need", "neglect", "negotiate", "nominate", "note", "notice", "notify", "nourish",
  "obey", "object", "observe", "obtain", "occupy", "offer", "open", "operate", "oppose",
  "order", "organize", "outline", "overcome", "overlook", "owe", "own", "pack", "paint",
  "participate", "pass", "pay", "perform", "permit", "persuade", "pick", "place", "plan",
  "plant", "play", "please", "point", "polish", "pollute", "possess", "postpone", "pour",
  "practice", "praise", "pray", "predict", "prefer", "prepare", "prescribe", "present",
  "preserve", "press", "pretend", "prevent", "print", "proceed", "process", "produce",
  "program", "prohibit", "project", "promise", "promote", "prompt", "pronounce", "propose",
  "protect", "protest", "prove", "provide", "publish", "pull", "punish", "purchase",
  "pursue", "push", "put", "qualify", "question", "quit", "quote", "raise", "rank", "reach",
  "read", "realize", "rebuild", "recall", "receive", "recognize", "recommend", "record",
  "recover", "reduce", "refer", "reflect", "refuse", "regain", "regard", "register",
  "regret", "reject", "relate", "relax", "release", "rely", "remain", "remark", "remember",
  "remind", "remove", "repair", "repeat", "replace", "reply", "report", "represent",
  "reproduce", "request", "require", "rescue", "research", "resemble", "reserve", "resist",
  "resolve", "respect", "respond", "rest", "restore", "restrict", "result", "resume",
  "retain", "retire", "retreat", "reveal", "review", "revise", "reward", "ride", "ring",
  "risk", "roll", "rub", "ruin", "rule", "run", "rush", "sacrifice", "sail", "satisfy",
  "save", "say", "scare", "schedule", "scold", "score", "scratch", "search", "secure",
  "seek", "seize", "select", "sell", "send", "sense", "separate", "serve", "set", "settle",
  "shake", "shape", "share", "shelter", "shine", "shoot", "shout", "show", "shrink", "shut",
  "sign", "signal", "sing", "sink", "skip", "slide", "slip", "smell", "smoke", "sneak",
  "solve", "sort", "speak", "specify", "speed", "spell", "spend", "spill", "spin", "split",
  "spoil", "sponsor", "spread", "squeeze", "stare", "start", "starve", "state", "steal",
  "steer", "stick", "stimulate", "stir", "stop", "store", "strengthen", "stress", "stretch",
  "strike", "strip", "struggle", "study", "submit", "substitute", "subtract", "succeed",
  "suffer", "suggest", "suit", "summarize", "supervise", "supply", "support", "suppose",
  "surprise", "surround", "survive", "suspect", "swallow", "swap", "swear", "sweep",
  "swing", "switch", "take", "talk", "tap", "target", "taste", "teach", "tear", "tease",
  "tell", "tempt", "terminate", "test", "thank", "threaten", "throw", "tie", "tighten",
  "tolerate", "toss", "touch", "trace", "track", "trade", "train", "transfer", "transform",
  "translate", "transmit", "transport", "travel", "treat", "trick", "trigger", "trust",
  "try", "turn", "twist", "type", "understand", "undertake", "unite", "unlock", "unpack",
  "update", "upgrade", "upload", "urge", "use", "utilize", "value", "vary", "verify",
  "visit", "vote", "wake", "walk", "wander", "want", "warm", "warn", "wash", "waste",
  "watch", "wave", "weaken", "wear", "weep", "weigh", "welcome", "whisper", "win", "wipe",
  "wish", "withdraw", "witness", "wonder", "work", "worry", "wrap", "wreck", "write",
  "yell", "yield",
]);

/* ----------------------------- 分词 ----------------------------- */

/**
 * 英文分词（保留原文字符偏移，便于精确还原短语原文）
 * @param {string} text
 * @returns {{type:"word"|"num"|"punct", text:string, lower:string, start:number, end:number}[]}
 */
export function tokenizeText(text) {
  const out = [];
  const raw = String(text || "");
  // 第 1 组：带点的缩写（Ph.D. / U.S. / e.g.）——必须放在普通单词前，否则会被切成 "Ph" + "." + "D"
  // 第 2 组：普通单词（允许词内 ' ’ -）
  // 第 3 组：数字；第 4 组：标点
  const re = /([A-Za-z]+(?:\.[A-Za-z]+)+\.?)|([A-Za-z]+(?:['’\-][A-Za-z]+)*)|(\d+(?:\.\d+)?)|([^A-Za-z\d]+)/g;
  let m;
  while ((m = re.exec(raw))) {
    const start = m.index;
    const text0 = m[0];
    if (m[1] || m[2]) out.push({ type: "word", text: text0, lower: text0.toLowerCase(), start, end: start + text0.length });
    else if (m[3]) out.push({ type: "num", text: text0, lower: text0, start, end: start + text0.length });
    else if (!/^\s+$/.test(text0)) out.push({ type: "punct", text: text0, lower: text0, start, end: start + text0.length });
  }
  return out;
}

function prevWordToken(tokens, i) {
  for (let k = i - 1; k >= 0; k -= 1) if (tokens[k].type === "word") return tokens[k];
  return null;
}

function nextWordToken(tokens, i) {
  for (let k = i + 1; k < tokens.length; k += 1) if (tokens[k].type === "word") return tokens[k];
  return null;
}

/* ----------------------------- 词性判定 ----------------------------- */

function posSet(posMap, w) {
  const entry = posMap && posMap.get ? posMap.get(w) : null;
  return entry && entry.pos && entry.pos.size ? entry.pos : null;
}
function isVerbWord(w, posMap) {
  const s = posSet(posMap, w);
  return !!(s && s.has("verb"));
}
function isNounWord(w, posMap) {
  const s = posSet(posMap, w);
  return !!(s && (s.has("noun") || s.has("pron")));
}
function isAdjWord(w, posMap) {
  const s = posSet(posMap, w);
  return !!(s && s.has("adj"));
}
/** 纯动词（不含名/形义）：可安全判定为「另一个动词」，结束当前宾语 */
function isVerbOnlyWord(w, posMap) {
  const s = posSet(posMap, w);
  return !!(s && s.has("verb") && !s.has("noun") && !s.has("adj"));
}
function isAdjOnlyWord(w, posMap) {
  const s = posSet(posMap, w);
  return !!(s && s.has("adj") && !s.has("noun") && !s.has("verb"));
}
function isAuxWord(w) {
  return AUX_MODAL.has(w) || HAVE_AUX.has(w);
}

/** 屈折形式 → 可能的原形（traveled→travel, studies→study …） */
function verbBaseForms(w) {
  const out = [w];
  if (w.endsWith("ies") && w.length > 4) out.push(`${w.slice(0, -3)}y`);
  if (w.endsWith("es") && w.length > 4) out.push(w.slice(0, -2));
  if (w.endsWith("s") && w.length > 3 && !w.endsWith("ss")) out.push(w.slice(0, -1));
  if (w.endsWith("ing") && w.length > 5) {
    out.push(w.slice(0, -3));
    out.push(`${w.slice(0, -3)}e`);
    if (w.length > 6 && w.at(-4) === w.at(-5)) out.push(w.slice(0, -4));
  }
  if (w.endsWith("ed") && w.length > 4) {
    out.push(w.slice(0, -2));
    out.push(w.slice(0, -1));
    if (w.length > 5 && w.at(-3) === w.at(-4)) out.push(w.slice(0, -3));
  }
  return out;
}
function inCommonVerbs(w) {
  return verbBaseForms(w).some((b) => COMMON_VERBS.has(b));
}

/** 不规则形态的释义常写作「take的过去式」「make的过去式和过去分词」，从中取回原形 */
const BASE_FROM_GLOSS_RE = /([a-z]{2,})的(?:过去式|过去分词|现在分词|第三人称单数|复数|比较级|最高级|原形|缩写)/;
function baseFromGloss(gloss) {
  const m = BASE_FROM_GLOSS_RE.exec(String(gloss || "").toLowerCase());
  return m ? m[1] : "";
}

/** 宽松动词判定（兜底抽动词用）：词典标了 verb，或在常见动词表里 */
function isAnyVerbWord(w, posMap) {
  const s = posSet(posMap, w);
  if (s && s.has("verb")) return true;
  if (inCommonVerbs(w)) return true;
  // 不规则形态（took / stole / made）的词条往往只写「take的过去式」而没有词性标注，
  // 从释义里把原形挖出来再判一次
  const entry = posMap && posMap.get ? posMap.get(w) : null;
  const base = baseFromGloss(entry?.gloss);
  return !!(base && inCommonVerbs(base));
}

// 功能词（不能作宾语中心词）
const FUNCTION_WORDS = new Set([
  ...DETERMINERS, ...PREPOSITIONS, ...SUBORDINATORS, ...COORDINATORS,
  ...AUX_MODAL, ...HAVE_AUX, "not", "no", "yes", "there", "here",
]);

/**
 * 词典不可用时的兜底中心词：取短语中最后一个实词
 * （英文名词短语的中心词通常在末尾，如 "certain performance requirements" → requirements）
 */
function fallbackHead(collected) {
  for (let k = collected.length - 1; k >= 0; k -= 1) {
    const t = collected[k];
    if (t.type !== "word") continue;
    const w = t.lower;
    if (w.length < 2 || NOT_HEAD.has(w) || FUNCTION_WORDS.has(w) || ADVERBS.has(w)) continue;
    return t.text;
  }
  return "";
}
function isAdverbWord(w, posMap) {  if (ADVERBS.has(w)) return true;
  const s = posSet(posMap, w);
  return !!(s && s.has("adv") && !s.has("noun") && !s.has("adj") && !s.has("verb"));
}
/** -ed 形式是否为被动语态（其前跳过副词后是 be 动词） */
function isPassiveEd(tokens, i, posMap) {
  let k = i - 1;
  while (k >= 0) {
    const t = tokens[k];
    if (t.type !== "word") { k -= 1; continue; }
    if (isAdverbWord(t.lower, posMap)) { k -= 1; continue; }
    return BE_FORMS.has(t.lower);
  }
  return false;
}

/**
 * 判断 tokens[i] 是否可作动宾短语的主动词
 * - 排除助动词/系动词
 * - 纯动词（无名词/形容词义）直接通过
 * - 名/动兼类词：仅在常见动词表、或在 to/情态助动词之后时判定为动词
 * - 排除 -ing 作前置定语（escalating scope）与后接标点/并列连词的情况
 */
function isVerbCandidate(tokens, i, posMap) {
  const tk = tokens[i];
  if (!tk || tk.type !== "word") return false;
  const w = tk.lower;
  if (isAuxWord(w) || NON_VO_VERBS.has(w)) return false;

  const s = posSet(posMap, w);
  const hasVerbSense = !!(s && s.has("verb")) || inCommonVerbs(w);
  if (!hasVerbSense) return false;

  const nx = tokens[i + 1];
  if (!nx) return false;
  if (nx.type === "punct") return false; // 动词后紧跟标点 → 不成动宾
  if (nx.type === "word" && COORDINATORS.has(nx.lower)) return false;

  const prev = prevWordToken(tokens, i);
  const pv = prev ? prev.lower : "";
  const afterAux = AUX_TRIGGER.has(pv);
  const afterIngAux = pv === "to" || AUX_FOR_ING.has(pv) || AUX_MODAL.has(pv);

  // -ing 形式：只有紧跟助动词（is building）或 to 时才算谓语；否则是定语/动名词
  if (/ing$/.test(w) && w.length > 4 && !afterIngAux) return false;
  // -ed 形式：被动语态或逗号后的分词短语，不构成动宾
  if (/ed$/.test(w) && (isPassiveEd(tokens, i, posMap) || tokens[i - 1]?.type === "punct")) return false;

  const verbOnly = !!(s && s.has("verb") && !s.has("noun") && !s.has("adj"));
  if (verbOnly) return true;
  if (inCommonVerbs(w)) return true;
  if (afterAux) return true;
  return false;
}

/* ----------------------------- 抽取核心 ----------------------------- */

/** 按句末标点切分成分句 */
function splitClauses(tokens) {
  const clauses = [];
  let cur = [];
  for (const tk of tokens) {
    if (tk.type === "punct" && /[.!?;:。！？；：]/.test(tk.text)) {
      if (cur.length) clauses.push(cur);
      cur = [];
    } else {
      cur.push(tk);
    }
  }
  if (cur.length) clauses.push(cur);
  return clauses;
}

/**
 * 收集动词后的宾语名词短语，并收敛到中心词
 * @returns {{headText:string, text:string}|null}
 */
/** 物主限定词：只有后接名词/形容词时才算「限定词用法」，否则可能是宾格代词（her） */
const POSSESSIVE_DET = new Set(["my", "your", "his", "her", "its", "our", "their", "whose"]);

function isDetUse(tokens, i, posMap) {
  const tk = tokens[i];
  if (!tk || tk.type !== "word" || !POSSESSIVE_DET.has(tk.lower)) return false;
  const nx = nextWordToken(tokens, i);
  if (!nx) return false;
  const nw = nx.lower;
  // 后接虚词（介词/连词/助动词）时，前面的物主词其实是宾格代词：test her / her on the work
  // 注意 ECDICT 会给 on / in 这类介词也标 a.（如 on = 开着的），只靠词性判断会误判
  if (PREPOSITIONS.has(nw) || SUBORDINATORS.has(nw) || COORDINATORS.has(nw) || isAuxWord(nw)) return false;
  return isNounWord(nw, posMap) || isAdjWord(nw, posMap);
}

function collectObject(tokens, start, source, posMap) {
  const n = tokens.length;
  const collected = [];
  let strongHead = ""; // 名词/代词（优先，排除纯形容词义）
  let weakHead = "";
  let i = start;

  while (i < n) {
    const tk = tokens[i];

    if (tk.type === "punct") {
      // 并列逗号（a, b, and c）继续；其余标点结束
      if (/[,，]/.test(tk.text)) { i += 1; continue; }
      break;
    }
    if (tk.type === "num") { collected.push(tk); i += 1; continue; }

    const w = tk.lower;
    if (PREPOSITIONS.has(w)) break;
    if (RELATIVE.has(w)) break;
    if (w === "that") {
      // "that" 作限定词（后接名词/形容词）时属于名词短语；否则视为从属连词
      const nx = nextWordToken(tokens, i);
      if (nx && (isNounWord(nx.lower, posMap) || isAdjWord(nx.lower, posMap))) {
        collected.push(tk); i += 1; continue;
      }
      break;
    }
    if (SUBORDINATORS.has(w)) break;
    if (COORDINATORS.has(w)) { i += 1; continue; }
    if (isAuxWord(w)) break;
    if (isVerbOnlyWord(w, posMap)) break;
    if (isVerbWord(w, posMap) && !isNounWord(w, posMap) && !isAdjWord(w, posMap)) break;

    if (!isDetUse(tokens, i, posMap) && !NOT_HEAD.has(w) && (isNounWord(w, posMap) || PRONOUN_HEADS.has(w))) {
      weakHead = tk.text;
      const s = posSet(posMap, w);
      const strong = (s && s.has("pron")) || (s && s.has("noun") && !s.has("adj")) || (!s && PRONOUN_HEADS.has(w));
      if (strong) strongHead = tk.text;
    }
    collected.push(tk);
    i += 1;
  }

  const headText = strongHead || weakHead || fallbackHead(collected);
  if (!headText || !collected.length) return null;

  // 时间状语（last month / next week）不是宾语
  if (TIME_NOUNS.has(headText.toLowerCase()) && collected.some((t) => t.type === "word" && TIME_DETS.has(t.lower))) {
    return null;
  }

  const first = collected[0];
  const last = collected[collected.length - 1];
  const text = String(source || "").slice(first.start, last.end).replace(/\s+/g, " ").trim();
  return { headText, text };
}

/**
 * 从单个分句里抽取「动词 + 宾语」对（含并列动词共享宾语）
 */
function extractClause(tokens, source, posMap) {
  const out = [];
  const n = tokens.length;
  let firstWordIdx = -1;
  for (let k = 0; k < n; k += 1) if (tokens[k].type === "word") { firstWordIdx = k; break; }
  let i = 0;

  while (i < n) {
    const tk = tokens[i];
    if (tk.type !== "word") { i += 1; continue; }
    const w = tk.lower;
    // 句中的大写词多为专有名词（United States / Trade unions），不作动词
    if (i !== firstWordIdx && /^[A-Z]/.test(tk.text)) { i += 1; continue; }
    if (!isVerbCandidate(tokens, i, posMap)) { i += 1; continue; }

    // 前面是限定词/纯形容词 → 此处更可能是名词（如 "the demand"），跳过
    const prev = prevWordToken(tokens, i);
    if (prev && (DETERMINERS.has(prev.lower) || isAdjOnlyWord(prev.lower, posMap)) && !isVerbOnlyWord(w, posMap)) {
      i += 1; continue;
    }

    // 并列动词：verb (and|or|nor verb)*
    const verbTokens = [tk];
    let j = i + 1;
    while (j + 1 < n) {
      const c = tokens[j];
      const v = tokens[j + 1];
      if (
        c.type === "word" && COORDINATORS.has(c.lower) &&
        v.type === "word" && isVerbCandidate(tokens, j + 1, posMap) && !isAuxWord(v.lower)
      ) {
        verbTokens.push(v);
        j += 2;
      } else break;
    }

    const np = collectObject(tokens, j, source, posMap);
    if (np) {
      for (const vt of verbTokens) {
        out.push({
          verb: vt.text,
          object: np.headText,
          fullObject: np.text,
          phrase: `${vt.text} ${np.headText}`,
          fullPhrase: `${vt.text} ${np.text}`,
        });
      }
    }
    i = j;
  }
  return out;
}

/** 把文章拆成 {en, zh} 单元（优先意群，退回整段按行） */
function collectUnits(q) {
  const groups = Array.isArray(q?.sense_groups) ? q.sense_groups : [];
  let units = groups
    .map((sg) => ({ en: String(sg?.english || "").trim(), zh: String(sg?.chinese || "").trim() }))
    .filter((u) => u.en);
  if (units.length) return units;
  const en = String(q?.en || "").trim();
  units = en
    .split(/\n+/)
    .map((s) => ({ en: s.trim(), zh: "" }))
    .filter((u) => u.en);
  return units;
}

/**
 * 纯抽取：给定 {en, zh} 单元与词性表，返回去重后的动宾短语
 * @param {{en:string, zh?:string}[]} units
 * @param {Map<string,{pos:Set<string>}>} posMap
 */
export function extractFromUnits(units, posMap) {
  const phrases = [];
  const seen = new Map();
  for (const u of units || []) {
    const tokens = tokenizeText(u.en);
    for (const clause of splitClauses(tokens)) {
      const found = extractClause(clause, u.en, posMap);
      for (const f of found) {
        const key = f.phrase.toLowerCase();
        const existing = seen.get(key);
        if (existing) { existing.count += 1; continue; }
        const entry = { ...f, zh: u.zh || "", source: u.en, count: 1 };
        seen.set(key, entry);
        phrases.push(entry);
      }
    }
  }
  return phrases;
}

/** 收集文章里所有英文单词（供批量查词性） */
export function collectWords(q) {
  const words = [];
  for (const u of collectUnits(q)) {
    for (const tk of tokenizeText(u.en)) if (tk.type === "word") words.push(tk.lower);
  }
  return words;
}

/**
 * 兜底：从句子里找「主要动词」——第一个既不是助动词/系动词、也不是介词/连词/副词的动词。
 * 保持原文形态（begins / Building / sharing），便于在句中定位；只取每分句第一个。
 * 若整句一个实义动词都没有（"was justifiable as a military necessity."），
 * 退回有限 be 动词当核心，保证「⇄」按钮不会因为抽不出东西而消失。
 */
function findClauseVerb(tokens, posMap) {
  const n = tokens.length;
  let firstWordIdx = -1;
  for (let k = 0; k < n; k += 1) if (tokens[k].type === "word") { firstWordIdx = k; break; }
  let beFallback = "";
  for (let i = 0; i < n; i += 1) {
    const tk = tokens[i];
    if (tk.type !== "word") continue;
    const w = tk.lower;
    // 句中的大写词多为专有名词（Hamburg / Nazis）
    if (i !== firstWordIdx && /^[A-Z]/.test(tk.text)) continue;
    // 二级兜底：有限 be 动词（is / was …）
    if (FINITE_BE.has(w)) { if (!beFallback) beFallback = tk.text; continue; }
    if (isAuxWord(w) || BE_FORMS.has(w)) continue;
    if (PREPOSITIONS.has(w) || SUBORDINATORS.has(w) || COORDINATORS.has(w)) continue;
    if (FUNCTION_WORDS.has(w) || NOT_HEAD.has(w) || ADVERBS.has(w)) continue;
    if (!isAnyVerbWord(w, posMap)) continue;
    // 前面是限定词 → 此处更可能是名词（"the demand"）；
    // 但 which/who/that 这类关系词常作主语，其后就是谓语，不能拦
    const prev = prevWordToken(tokens, i);
    if (prev && DETERMINERS.has(prev.lower) && !SUBJECT_PRONOUNS.has(prev.lower)) continue;
    return tk.text;
  }
  return beFallback;
}

/**
 * 纯抽取（兜底）：找不到动宾短语时，抽出各分句的主要动词
 * @param {{en:string, zh?:string}[]} units
 * @param {Map<string,{pos:Set<string>}>} posMap
 */
export function extractVerbsFromUnits(units, posMap) {
  const out = [];
  const seen = new Set();
  for (const u of units || []) {
    const tokens = tokenizeText(u.en);
    for (const clause of splitClauses(tokens)) {
      const v = findClauseVerb(clause, posMap);
      if (!v) continue;
      const key = v.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ verb: v, phrase: v, zh: u.zh || "", source: u.en, count: 1 });
    }
  }
  return out;
}

/**
 * 兜底：抽取一段英文里的主要动词（动宾抽取为空时用）
 * @param {string} text
 */
export async function extractVerbsFromText(text) {
  const en = String(text || "").trim();
  if (!en) return [];
  const { lookupEnWordsPos } = await import("./en-word-dict.js?v=20261010font4");
  const words = [];
  for (const tk of tokenizeText(en)) if (tk.type === "word") words.push(tk.lower);
  const posMap = await lookupEnWordsPos(words);
  return extractVerbsFromUnits([{ en, zh: "" }], posMap);
}

/**
 * 抽取一段英文（一个意群 / 一句话）里的动宾短语
 * @param {string} text
 * @returns {Promise<Array<{verb:string,object:string,phrase:string,fullPhrase:string,fullObject:string,zh:string,source:string,count:number}>>}
 */
export async function extractVoFromText(text) {
  const en = String(text || "").trim();
  if (!en) return [];
  const { lookupEnWordsPos } = await import("./en-word-dict.js?v=20261010font4");
  const words = [];
  for (const tk of tokenizeText(en)) if (tk.type === "word") words.push(tk.lower);
  const posMap = await lookupEnWordsPos(words);
  return extractFromUnits([{ en, zh: "" }], posMap);
}

export { collectUnits };
