#!/usr/bin/env python3
"""从 ECDICT sqlite 生成 www/data/en-dict 分片 gzip 词库。"""
from __future__ import annotations

import gzip
import json
import os
import re
import sqlite3
import sys
from collections import defaultdict

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "www", "data", "en-dict")
DEFAULT_DB = "/tmp/ecdict-build/stardict.db"
WORD_RE = re.compile(r"^[a-z][a-z'-]{0,21}$")


def clean_gloss(t: str) -> str:
    t = (t or "").replace("\r", "").replace("\n", "；")
    parts = []
    for p in t.split("；"):
        p = p.strip()
        if not p:
            continue
        parts.append(p)
        if len(parts) >= 3:
            break
    s = "；".join(parts)
    if len(s) > 140:
        s = s[:137] + "…"
    return s


def clean_phone(p: str) -> str:
    return (p or "").strip().replace("ә", "ə")


def main() -> int:
    db = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_DB
    if not os.path.isfile(db):
        print(f"missing db: {db}", file=sys.stderr)
        return 1

    con = sqlite3.connect(db)
    rows = con.execute(
        "select word, phonetic, translation, exchange from stardict "
        "where translation is not null and translation!=''"
    ).fetchall()

    entries: dict[str, tuple[str, str]] = {}
    forms: dict[str, str] = {}
    for word, phonetic, translation, exchange in rows:
        w = (word or "").strip()
        if not WORD_RE.match(w):
            continue
        gloss = clean_gloss(translation)
        if not gloss:
            continue
        phone = clean_phone(phonetic)
        prev = entries.get(w)
        if not prev or (not prev[0] and phone):
            entries[w] = (phone, gloss)
        if not exchange:
            continue
        for part in str(exchange).split("/"):
            if ":" not in part:
                continue
            _, v = part.split(":", 1)
            v = v.strip().lower()
            if v and WORD_RE.match(v) and v != w:
                forms.setdefault(v, w)

    forms = {f: b for f, b in forms.items() if f not in entries or f != b}
    os.makedirs(OUT, exist_ok=True)

    # clear old shards
    for name in os.listdir(OUT):
        if name.endswith(".json") or name.endswith(".json.gz"):
            if name == "README.md":
                continue
            os.remove(os.path.join(OUT, name))

    shards: dict[str, dict] = defaultdict(dict)
    for w, (p, g) in entries.items():
        shards[w[0]][w] = [p, g]

    index = {"v": 1, "format": "gz", "shards": {}, "forms": "forms.json.gz"}
    for letter, data in sorted(shards.items()):
        body = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        gz_name = f"{letter}.json.gz"
        with gzip.open(os.path.join(OUT, gz_name), "wb", compresslevel=9) as f:
            f.write(body)
        index["shards"][letter] = {"file": gz_name, "bytes": os.path.getsize(os.path.join(OUT, gz_name))}
        print(letter, len(data), index["shards"][letter]["bytes"])

    forms_body = json.dumps(forms, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    with gzip.open(os.path.join(OUT, "forms.json.gz"), "wb", compresslevel=9) as f:
        f.write(forms_body)
    with open(os.path.join(OUT, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))

    print("entries", len(entries), "forms", len(forms))
    print("out", OUT)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
