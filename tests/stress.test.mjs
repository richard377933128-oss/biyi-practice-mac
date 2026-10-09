/** 重音/分音节纯函数单元测试：node --test（npm test） */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatPhonetic,
  primaryStressIndex,
  syllabifyOrtho,
  markStressOnWord,
} from "../www/js/lib/stress.js";

const STRESS_CASES = [
  // 2026-10-09 修复回归：双字母单音素起首 ph/gh/rh/kh/dj
  ["astrophysics", "ˌæstrəuˈfiziks", "astroˈphysics"],
  ["Astrophysics", ",æstrəu'fiziks", "Astroˈphysics"],
  ["aghast", "ə'gɑːst", "aˈghast"],
  ["adjust", "ə'dʒʌst", "aˈdjust"],
  ["arrhythmia", "ə'riðmiə", "arˈrhythmia"],
  ["euphoria", "juː'fɔːriə", "euˈphoria"],
  ["ephemeral", "i'femərəl", "eˈphemeral"],
  ["photography", "fə'tɒgrəfi", "phoˈtography"],
  // 2026-10-09 修复回归：元音组拆分优先 i/u 起首
  ["pneumonia", "njuː'məuniə", "pneuˈmonia"],
  // 原有行为基线
  ["established", "is'tæbliʃt", "eˈstablished"],
  ["physics", "'fiziks", "ˈphysics"],
  ["machine", "mə'ʃiːn", "maˈchine"],
  ["guitar", "gi'tɑː", "guiˈtar"],
  ["receipt", "ri'siːt", "reˈceipt"],
  ["important", "im'pɔːtənt", "imˈportant"],
  ["subject", "'sʌbdʒikt", "ˈsubject"],
  ["suggests", "sə'dʒests", "sugˈgests"],
  ["attains", "ə'teinz", "atˈtains"],
  ["publication", "ˌpʌbli'keiʃən", "publiˈcation"],
  ["photograph", "'fəutəgrɑːf", "ˈphotograph"],
  ["radiation", "ˌreidi'eiʃən", "radiˈation"],
  ["association", "əˌsəusi'eiʃən", "associˈation"],
  ["situation", "ˌsitju'eiʃən", "situˈation"],
  ["continuum", "kən'tinjuəm", "conˈtinuum"],
  ["familiar", "fə'miliə", "faˈmiliar"],
  ["contempt", "kən'tempt", "conˈtempt"],
  ["language", "'læŋgwidʒ", "ˈlanguage"],
  ["experience", "ik'spiəriəns", "exˈperience"],
  ["technology", "tek'nɒlədʒi", "techˈnology"],
  ["unusual", "ʌn'juːʒuəl", "unˈusual"],
  ["beautiful", "'bjuːtəfəl", "ˈbeautiful"],
  // 边界
  ["", "ə'teinz", ""],
  ["word", "", "word"],
  ["word", null, "word"],
];

test("markStressOnWord", () => {
  for (const [word, phonetic, expected] of STRESS_CASES) {
    assert.equal(markStressOnWord(word, phonetic), expected, `${word} /${phonetic}/`);
  }
});

test("primaryStressIndex", () => {
  assert.equal(primaryStressIndex("kən'tempt"), 1);
  assert.equal(primaryStressIndex("'læŋgwidʒ"), 0);
  assert.equal(primaryStressIndex("ˌæstrəuˈfiziks"), 2);
  assert.equal(primaryStressIndex("sitiˈeiʃən"), 2);
  assert.equal(primaryStressIndex("nəʊstres"), -1);
});

test("formatPhonetic 清洗 ECDICT 音标", () => {
  assert.equal(formatPhonetic("/kən'tempt/"), "kənˈtempt");
  assert.equal(formatPhonetic("ik'spiəriəns(r)"), "ikˈspiəriəns");
  assert.equal(formatPhonetic("biːtə(r)"), "biːtə"); // 括号内容去掉
  assert.equal(formatPhonetic("'leɪ.bəl"), "ˈleɪˌbəl"); // . → 次重音
});

test("syllabifyOrtho 按重音切两段", () => {
  // 切分片段来自原词，不含重音符本身
  assert.deepEqual(syllabifyOrtho("astrophysics", "ˌæstrəuˈfiziks"), ["astro", "physics"]);
  assert.deepEqual(syllabifyOrtho("machine", "mə'ʃiːn"), ["ma", "chine"]);
  assert.deepEqual(syllabifyOrtho("language", "'læŋgwidʒ"), ["language"]);
});
