# -*- coding: utf-8 -*-
from pathlib import Path
from collections import Counter
from skm_grammar_items import SKM
from try_grammar_items import TRY

OUT = Path("/Users/mslee/Desktop/biyi-practice-mac")


def write_article(path_article, path_list, title_ja, title_zh, preface_ja, preface_zh, sections, items, intro, source, counts_note):
    """items: (level, grammar, ja, zh, section_key or None)"""
    art = [title_ja, title_zh, preface_ja, preface_zh]
    current = None
    for level, grammar, ja, zh, sec in items:
        if sec and sec != current:
            current = sec
            sj, sz = sections[sec]
            art.append(sj)
            art.append(sz)
        art.append(ja)
        art.append(zh)
    path_article.write_text("\n".join(art) + "\n", encoding="utf-8")

    levels = Counter(x[0] for x in items)
    order = ["N5", "N4", "N3", "N2", "N1"]
    lines = [
        intro,
        counts_note,
        f"条数：" + " + ".join(f"{lv} {levels[lv]}条" for lv in order if levels[lv]) + f" = {len(items)}条。",
        source,
        "",
    ]
    num = {lv: 0 for lv in order}
    for level, grammar, ja, zh, _sec in items:
        num[level] += 1
        lines.append(f"{level}-{num[level]:03d}\t{grammar}\t{ja}")
    path_list.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(path_article.name, "pairs", len(items), dict(levels))


def skm_items():
    # 按等级切场景（编号不是小标题）
    sections = {
        "a": ("一、ノート", "一、笔记本"),
        "b": ("二、教室", "二、教室"),
        "c": ("三、台所", "三、厨房"),
        "d": ("四、紙", "四、纸上"),
        "e": ("五、外す", "五、拿掉"),
    }
    out = []
    for level, g, ja, zh in SKM:
        if level == "N5":
            sec = "a"
        elif level == "N4":
            sec = "b"
        elif level == "N3":
            sec = "c"
        elif level == "N2":
            sec = "d"
        else:
            sec = "e"
        out.append((level, g, ja, zh, sec))
    return sections, out


def try_items():
    sections = {
        "a": ("一、店", "一、店里"),
        "b": ("二、通り", "二、街上"),
        "c": ("三、口", "三、口头"),
        "d": ("四、張り紙", "四、告示"),
        "e": ("五、記事", "五、报道"),
    }
    out = []
    for level, g, ja, zh in TRY:
        sec = {"N5": "a", "N4": "b", "N3": "c", "N2": "d", "N1": "e"}[level]
        out.append((level, g, ja, zh, sec))
    return sections, out


def main():
    sections, items = skm_items()
    write_article(
        OUT / "日语N5到N1语法一篇-新完全マスター.txt",
        OUT / "日语N5到N1语法对照清单-新完全マスター.txt",
        "条件",
        "条件",
        "形がいくら正しくても、条件を抜いた説明は人を採点しているだけだ。朝のノートから教室、台所、翌朝の紙まで、その採点を外すまでの話である。",
        "形式再正确，抽掉条件的说明也不过是在给人打分。从早上的笔记本到教室、厨房、次日的纸，讲的是把那种打分拿掉。",
        sections,
        items,
        "对照清单：下面每一条都在《条件》这篇里，有一个专属句子。等级编号只用于核对。",
        "来源：《新完全マスター文法》N1–N4（スリーエーネットワーク）出版社目录的课内编号文型。系列没有独立N5文法册，N5收N4册「形の練習」与「第2部 文法形式の整理」。N2/N1的「整理」「文章の文法」是用法复习，不另起一条。",
        "N5是初級基础整理，N4起是各册第1部课内项。",
    )
    sections, items = try_items()
    write_article(
        OUT / "日语N5到N1语法一篇-TRY.txt",
        OUT / "日语N5到N1语法对照清单-TRY.txt",
        "場面",
        "场面",
        "場面の言葉は揃っている。揃っていないのは、その場にいた人の条件だ。店から通り、口、張り紙、記事まで、同じ商品が場面を渡り歩く話である。",
        "场面该有的词都齐了。不齐的，是当时在场的人的条件。从店到街、口头、告示、报道，讲的是同一件商品穿过这些场面。",
        sections,
        items,
        "对照清单：下面每一条都在《场面》这篇里，有一个专属句子。等级编号只用于核对。",
        "来源：ASK『TRY! 日本語能力試験 文法から伸ばす日本語』公开学习项目列表 PDF。宣传条数为 N5 46、N4 100、N3 127、N2 149、N1 129；公开列表实际编号为 45+93+113+139+123，另收 N5 第1课「あいさつ」。",
        "按公开学习项目列表全收，不另造未列出的番号。",
    )


if __name__ == "__main__":
    main()
