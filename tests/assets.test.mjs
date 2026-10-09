/** 静态资源缓存版本一致性检查：所有 ?v= 必须是同一个值，且被引用文件真实存在 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WWW = join(ROOT, "www");
// 与 scripts/bump-version.mjs 同规：只认路径字符串里的 ?v=（带 / 前缀），避免误伤三元表达式
const VERSION_RE = /\/[\w./-]*\?v=([A-Za-z0-9._-]+)/g;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === ".DS_Store" || name === "vendor") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(js|html)$/.test(name)) out.push(full);
  }
  return out;
}

test("所有 ?v= 版本号一致", () => {
  const seen = new Map();
  for (const file of [join(WWW, "index.html"), ...walk(join(WWW, "js"))]) {
    const src = readFileSync(file, "utf8");
    let m;
    while ((m = VERSION_RE.exec(src))) {
      seen.set(m[1], seen.get(m[1]) || []);
      seen.get(m[1]).push(relative(ROOT, file));
    }
  }
  assert.ok(seen.size > 0, "没扫到任何 ?v=，检查扫描范围");
  const versions = [...seen.keys()];
  assert.equal(
    versions.length,
    1,
    `缓存版本号漂移：${versions.map((v) => `${v} (${seen.get(v).join(", ")})`).join(" | ")}\n` +
      "请运行 npm run bump 统一后再提交"
  );
});

test("?v= 引用的文件真实存在", () => {
  const files = [join(WWW, "index.html"), ...walk(join(WWW, "js"))];
  let checked = 0;
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    // 匹配 import/from href/src 里带 ?v= 的相对路径
    const refRe = /(?:from\s+|import\s*\(\s*|["'(]\s*)(\.\/[^"')?]+\?v=)/g;
    let m;
    while ((m = refRe.exec(src))) {
      const rel = m[1].slice(0, -3); // 去掉 ?v=
      const target = join(dirname(file), rel);
      assert.ok(
        existsSync(target),
        `${relative(ROOT, file)} 引用的 ${rel} 不存在`
      );
      checked += 1;
    }
  }
  assert.ok(checked >= 10, `只检查到 ${checked} 处引用，正则可能失效`);
});

test("引用 kv-store API 的模块必须显式 import（2026-10-09 丢 import 事故回归）", () => {
  const KV_API = ["kvGet", "kvSet", "kvRemove", "initKvStore"];
  for (const file of walk(join(WWW, "js"))) {
    if (file.endsWith(join("lib", "kv-store.js"))) continue;
    const src = readFileSync(file, "utf8");
    for (const api of KV_API) {
      const used = new RegExp(`\\b${api}\\s*\\(`).test(src);
      if (!used) continue;
      const imported = new RegExp(
        `import\\s*\\{[^}]*\\b${api}\\b[^}]*\\}\\s*from\\s*["'][^"']*kv-store\\.js`
      ).test(src);
      assert.ok(imported, `${relative(ROOT, file)} 使用了 ${api}() 但没有从 kv-store.js 导入`);
    }
  }
});
