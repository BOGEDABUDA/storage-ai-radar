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
    total_dir = source / "total"
    dates = sorted(p.name for p in total_dir.iterdir() if p.is_dir())

    for date in dates:
        date_dir = total_dir / date
        for md in sorted(date_dir.glob("*.md")):
            category_name = md.stem
            slug = categories.slug_for(category_name)
            try:
                all_records.extend(parse_file(md, date, category_name, slug))
            except Exception as exc:
                warnings.append(f"{date}/{md.name}: 解析失败 {type(exc).__name__}: {exc}")
    warnings.extend(categories.take_warnings())
    return all_records, warnings
