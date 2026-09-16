"""解析 output/<date>/<分类>_详细.md → 扩展要点 + 原文来源链接。

结构有两种（实测：389 个文件带视角，10 个文件不带）：
    ## 要点1（商业）：<题>        ## 要点1：<题>
    <正文>
    **来源**：[标题](URL) [标题](URL)

产物用于给精选洞察补上可点击的原文引用。
"""

from __future__ import annotations

import re
from pathlib import Path

from . import categories, mdparse

POINT_RE = re.compile(r"^要点\s*(\d+)\s*(?:[（(]([^）)]*)[）)])?\s*[：:]\s*(.*)$")


def _perspective_of(label: str | None, ordinal: int) -> str:
    if label:
        if "商业" in label:
            return "business"
        if "学术" in label or "技术" in label:
            return "technical"
    # 无标注时按位置推断（要点1=商业，要点2=学术/技术，与 daily_report 顺序一致）
    return {1: "business", 2: "technical"}.get(ordinal, "topic")


def parse_file(path: Path, date: str | None = None) -> list[dict]:
    if date is None:
        date = path.parent.name
    records: list[dict] = []
    cur: dict | None = None

    def flush() -> None:
        nonlocal cur
        if cur is not None and (cur["text"] or cur["sources"]):
            records.append(cur)
        cur = None

    for raw_line in mdparse.read_lines(path):
        line = raw_line.rstrip()

        if line.startswith("## "):
            flush()
            heading = line[3:].strip()
            match = POINT_RE.match(heading)
            if match:
                ordinal = int(match.group(1))
                label = match.group(2)
                topic = match.group(3).strip()
            else:
                ordinal = len(records) + 1
                label = None
                topic = heading
            cur = {
                "date": date,
                "ordinal": ordinal,
                "perspective": _perspective_of(label, ordinal),
                "topic": topic,
                "text": "",
                "sources": [],
            }
            continue

        if cur is not None and line.startswith("**来源**"):
            cur["sources"] = mdparse.extract_links(line)
            continue

        if cur is not None and line.strip() and not line.startswith("#"):
            piece = line.strip()
            cur["text"] = f"{cur['text']} {piece}".strip() if cur["text"] else piece

    flush()
    return records


def parse_all(source: Path) -> tuple[list[dict], list[str]]:
    warnings: list[str] = []
    all_records: list[dict] = []
    for md in sorted((source / "output").glob("*/*_详细.md")):
        date = md.parent.name
        category_name = md.name[: -len("_详细.md")]
        slug = categories.slug_for(category_name)
        try:
            for rec in parse_file(md, date):
                rec["category"] = slug
                rec["category_name"] = category_name
                all_records.append(rec)
        except Exception as exc:
            warnings.append(f"{date}/{md.name}: 解析失败 {type(exc).__name__}: {exc}")
    warnings.extend(categories.take_warnings())
    return all_records, warnings


def attach_sources(digests: list[dict], details: list[dict]) -> int:
    """把详细要点里的来源链接挂到对应洞察上。

    依次尝试三级匹配键，命中即停：
    1. (日期, 分类, 视角, 规范化题名) —— 最精确
    2. (日期, 分类, 规范化题名)      —— 容忍视角缺失（首期报告用自由标题）
    3. (日期, 分类, 第 N 条)          —— 位置兜底
    返回成功挂上的洞察条数。
    """
    by_full: dict[tuple, list] = {}
    by_topic: dict[tuple, list] = {}
    by_pos: dict[tuple, list] = {}

    for rec in details:
        topic_key = mdparse.normalize_topic(rec["topic"])
        pos_key = (rec["date"], rec["category"], rec["ordinal"])
        by_pos.setdefault(pos_key, []).extend(rec["sources"])
        if rec["sources"]:
            by_full.setdefault(
                (rec["date"], rec["category"], rec["perspective"], topic_key), []
            ).extend(rec["sources"])
            by_topic.setdefault((rec["date"], rec["category"], topic_key), []).extend(rec["sources"])

    attached = 0
    position: dict[tuple[str, str], int] = {}
    for digest in digests:
        pair = (digest["date"], digest["category"])
        position[pair] = position.get(pair, 0) + 1
        candidates = (
            (digest["date"], digest["category"], digest["perspective"], mdparse.normalize_topic(digest["topic"])),
            (digest["date"], digest["category"], mdparse.normalize_topic(digest["topic"])),
            (digest["date"], digest["category"], position[pair]),
        )
        for lookup, key in zip((by_full, by_topic, by_pos), candidates):
            if lookup.get(key):
                digest["sources"] = lookup[key]
                attached += 1
                break
    return attached
