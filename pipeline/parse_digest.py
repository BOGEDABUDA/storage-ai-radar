"""解析 output/<date>/daily_report.md → 精选洞察。

每期报告结构：
    ## <分类>
    ### 商业视角：<题>
    <正文段落>
    ### 学术/技术视角：<题>
    <正文段落>

少量条目的三级标题没有视角前缀（实测 20/794），归入 perspective="topic"，
保证不丢数据。
"""

from __future__ import annotations

from pathlib import Path

from . import categories, mdparse


def parse_file(path: Path, date: str) -> list[dict]:
    records: list[dict] = []
    category_name: str | None = None
    category_slug: str | None = None
    cur: dict | None = None
    counter: dict[tuple[str, str], int] = {}

    def flush() -> None:
        nonlocal cur
        if cur is not None and cur["text"]:
            records.append(cur)
        cur = None

    for raw_line in mdparse.read_lines(path):
        line = raw_line.rstrip()

        if line.startswith("### "):
            flush()
            heading = line[4:].strip()
            match = mdparse.PERSPECTIVE_RE.match(heading)
            if match:
                perspective = mdparse.PERSPECTIVE_MAP[match.group(1)]
                topic = match.group(2).strip()
            else:
                perspective = "topic"
                topic = heading

            assert category_name is not None, f"{path}: 三级标题出现在分类标题之前"
            assert category_slug is not None
            key = (category_slug, perspective)
            index = counter.get(key, 0)
            counter[key] = index + 1
            cur = {
                "id": f"{date}|{category_slug}|{perspective}|{index}",
                "date": date,
                "category": category_slug,
                "category_name": category_name,
                "perspective": perspective,
                "topic": topic,
                "heading_raw": heading,
                "text": "",
                "sources": [],
            }

        elif line.startswith("## "):
            flush()
            category_name = line[3:].strip()
            category_slug = categories.slug_for(category_name)

        elif not line.strip() or line.strip() == "---":
            continue

        elif cur is not None:
            piece = line.strip()
            cur["text"] = f"{cur['text']} {piece}".strip() if cur["text"] else piece

    flush()
    return records


def parse_all(source: Path) -> tuple[list[dict], list[str]]:
    """遍历全部日期，返回 (洞察列表, 告警列表)。"""
    warnings: list[str] = []
    all_records: list[dict] = []
    dates = sorted(p.name for p in (source / "output").iterdir() if p.is_dir())
    for date in dates:
        report = source / "output" / date / "daily_report.md"
        if not report.is_file():
            warnings.append(f"{date}: 缺少 daily_report.md，已跳过")
            continue
        try:
            all_records.extend(parse_file(report, date))
        except Exception as exc:  # 单个文件失败不应中断整批构建
            warnings.append(f"{date}: 解析失败 {type(exc).__name__}: {exc}")
    warnings.extend(categories.take_warnings())
    return all_records, warnings
