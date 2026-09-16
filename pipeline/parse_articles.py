"""解析 total/<date>/<分类>.md → 文章摘要（检索层主体，15,192 篇）。

结构：
    # <分类>
    > 来源: N 篇相关文章
    ## 普通推文 | ## 📖 论文推荐
    **标题**：...
    **时间**：...
    **总结**：...（实测有 6 处总结跨多行，必须做续行拼接）
    ---
"""

from __future__ import annotations

import re
from pathlib import Path

from . import categories, mdparse

# 板块名 → 稳定标识（去掉 emoji 后匹配）
_SECTION_ALIASES = {
    "普通推文": "regular",
    "论文推荐": "paper",
}


def _section_of(raw: str) -> str:
    key = raw.replace("📖", "").strip()
    return _SECTION_ALIASES.get(key, "regular")


def _title_key(title: str) -> str:
    """标题归一化键：去空白、小写。用于合并同一期同一分类里的重复文章。"""
    return re.sub(r"[\s\u3000]+", "", title).lower()


def dedupe(records: list[dict]) -> tuple[list[dict], int]:
    """合并同一期同一分类内的重复文章（同标题）。

    语料里同一篇文章会被多个公众号转发，导致同一分类下出现 2~6 条同名记录
    （实测 216 条）。合并时保留首个条目的 id 以维持引用稳定，摘要取「非空且最长」
    的那条（实测有 123 组同名但摘要不同）。跨分类的多标签与跨日期的重复播报
    属于不同信息，这里不合并。

    返回 (去重后记录, 合并掉的条数)。
    """
    merged: dict[str, dict] = {}
    order: list[str] = []
    removed = 0
    for record in records:
        key = _title_key(record["title"])
        existing = merged.get(key)
        if existing is None:
            merged[key] = record
            order.append(key)
            continue
        removed += 1
        existing["merged_count"] = existing.get("merged_count", 1) + 1
        # 摘要：优先保留非空且更长的
        if len(record["summary"]) > len(existing["summary"]):
            existing["summary"] = record["summary"]
        if not existing["time_hint"] and record["time_hint"]:
            existing["time_hint"] = record["time_hint"]
    return [merged[key] for key in order], removed


def parse_file(path: Path, date: str, category_name: str, category_slug: str) -> list[dict]:
    records: list[dict] = []
    buf: dict[str, str] = {}
    field: str | None = None
    section = "regular"
    raw_section = "普通推文"
    counter: dict[str, int] = {}

    def flush() -> None:
        nonlocal buf, field
        title = (buf.get("标题") or "").strip()
        if title:
            index = counter.get(section, 0)
            counter[section] = index + 1
            records.append(
                {
                    "id": f"{date}|{category_slug}|{section}|{index}",
                    "date": date,
                    "category": category_slug,
                    "category_name": category_name,
                    "section": section,
                    "section_raw": raw_section,
                    "title": title,
                    "time_hint": (buf.get("时间") or "").strip(),
                    "summary": mdparse.clean(buf.get("总结") or ""),
                }
            )
        buf = {}
        field = None

    for raw_line in mdparse.read_lines(path):
        line = raw_line.rstrip()

        if line.startswith("## "):
            flush()
            raw_section = line[3:].strip()
            section = _section_of(raw_section)
            continue

        if line.strip() == "---":
            flush()
            continue

        match = mdparse.FIELD_RE.match(line)
        if match:
            name, value = match.group(1), match.group(2).strip()
            if name == "标题" and buf.get("标题"):
                flush()  # 容错：上一块缺少分隔线
            field = name
            buf[name] = value
            continue

        if field is not None and line.strip() and not line.startswith("#"):
            buf[field] = f"{buf[field]} {line.strip()}".strip()

    flush()
    return records


def parse_all(source: Path) -> tuple[list[dict], list[str]]:
    warnings: list[str] = []
    all_records: list[dict] = []
    duplicates_removed = 0
    total_dir = source / "total"
    dates = sorted(p.name for p in total_dir.iterdir() if p.is_dir())

    for date in dates:
        date_dir = total_dir / date
        for md in sorted(date_dir.glob("*.md")):
            category_name = md.stem
            slug = categories.slug_for(category_name)
            try:
                records, removed = dedupe(parse_file(md, date, category_name, slug))
                all_records.extend(records)
                duplicates_removed += removed
            except Exception as exc:
                warnings.append(f"{date}/{md.name}: 解析失败 {type(exc).__name__}: {exc}")
    # 去重条数属于正常统计信息，不计入 warnings（warnings 只放真正的问题）
    parse_all.last_duplicates_removed = duplicates_removed  # type: ignore[attr-defined]
    warnings.extend(categories.take_warnings())
    return all_records, warnings
