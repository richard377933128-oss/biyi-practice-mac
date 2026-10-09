#!/usr/bin/env node
/**
 * 统一 bump 静态资源缓存版本（?v=）。
 * 用法：
 *   npm run bump                 # 自动按当前时间生成版本号
 *   npm run bump -- v=xxx        # 指定版本号
 *
 * 扫描 www/index.html 与 www/js 下所有 js 文件中的 "?v=..." 并统一改写。
 * 一致性由 tests/assets.test.mjs 保证（npm test）。
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const WWW = join(ROOT, "www");
const VERSION_RE = /\?v=[A-Za-z0-9._-]+/g;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === ".DS_Store") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(js|html)$/.test(name)) out.push(full);
  }
  return out;
}

const arg = process.argv.slice(2).find((a) => a.startsWith("v="));
const now = new Date();
const pad = (n) => String(n).padStart(2, "0");
const auto = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}`;
const version = arg ? arg.slice(2) : auto;
if (!/^[A-Za-z0-9._-]+$/.test(version)) {
  console.error(`非法版本号: ${version}`);
  process.exit(1);
}

const files = [join(WWW, "index.html"), ...walk(join(WWW, "js"))];
let changed = 0;
let total = 0;
for (const file of files) {
  const src = readFileSync(file, "utf8");
  const count = (src.match(VERSION_RE) || []).length;
  if (!count) continue;
  total += count;
  const next = src.replace(VERSION_RE, `?v=${version}`);
  if (next !== src) {
    writeFileSync(file, next);
    changed += 1;
    console.log(`  ${relative(ROOT, file)} (${count} 处)`);
  }
}
console.log(`\n版本号统一为 ?v=${version}：${changed} 个文件、共 ${total} 处`);
