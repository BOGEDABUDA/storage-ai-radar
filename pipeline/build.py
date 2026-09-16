"""构建入口：只读解析语料 → web/data/* 派生数据。

    python3 -m pipeline.build

产物（全部落在项目内，绝不写入数据源）：
    web/data/manifest.json           语料总览与分类元数据
    web/data/digests.json            794 条精选洞察（含原文来源链接）
    web/data/articles/<date>.json    42 个分片，共 15,192 篇文章摘要
    web/data/articles.index.json     轻量索引（id/日期/分类/板块/标题/摘要开头）
    web/data/timeline.json           各分类逐期数量序列
    pipeline/build_report.json       构建报告（计数、告警、耗时、体积）
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import categories, parse_articles, parse_detail, parse_digest, paths

CST = timezone(timedelta(hours=8))
LEAD_CHARS = 80
INDEX_FIELDS = ["i", "d", "c", "s", "t", "l"]  # id, date, category, section, title, lead


def _write_json(path: Path, payload: object, *, compact: bool = False) -> int:
    """写入 JSON（经写入门禁，拒绝落入只读数据源），返回字节数。"""
    paths.assert_writable(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if compact:
        text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    else:
        text = json.dumps(payload, ensure_ascii=False, indent=2)
    path.write_text(text, encoding="utf-8")
    return len(text.encode("utf-8"))


def _category_sort(slug: str) -> tuple[int, str]:
    return categories.sort_key(slug)


def build(source: Path | None = None) -> dict:
    paths.ensure_output_dirs()
    source = source or paths.source_dir()
    started = datetime.now(CST)
    warnings: list[str] = []

    digests, w1 = parse_digest.parse_all(source)
    details, w2 = parse_detail.parse_all(source)
    warnings += w1 + w2
    attached = parse_detail.attach_sources(digests, details)

    articles, w3 = parse_articles.parse_all(source)
    warnings += w3

    # 确定性排序，保证重复构建结果稳定
    digests.sort(key=lambda r: (r["date"], _category_sort(r["category"]), r["perspective"], r["id"]))
    articles.sort(key=lambda r: (r["date"], _category_sort(r["category"]), r["section"], r["id"]))

    dates = sorted({r["date"] for r in digests} | {r["date"] for r in articles})

    # ---- manifest.json ----
    cat_meta = []
    for name, slug in categories.CATEGORIES:
        cat_articles = [r for r in articles if r["category"] == slug]
        cat_digests = [r for r in digests if r["category"] == slug]
        seen = sorted({r["date"] for r in cat_articles + cat_digests})
        cat_meta.append(
            {
                "key": slug,
                "name": name,
                "article_count": len(cat_articles),
                "digest_count": len(cat_digests),
                "first_seen": seen[0] if seen else None,
                "last_seen": seen[-1] if seen else None,
                "is_catch_all": slug == categories.CATCH_ALL_SLUG,
            }
        )

    manifest = {
        "generated_at": started.isoformat(timespec="seconds"),
        # 只发布目录名，不泄露本机绝对路径
        "source_label": source.name,
        "report_count": len(dates),
        "article_count": len(articles),
        "digest_count": len(digests),
        "detail_count": len(details),
        "sources_attached": attached,
        # 源数据中确有少量文章「总结」为空（爬取/总结环节未产出），非解析缺陷
        "empty_summaries": sum(1 for r in articles if not r["summary"]),
        "dates": dates,
        "categories": cat_meta,
        "index_fields": INDEX_FIELDS,
    }

    sizes = {
        "manifest.json": _write_json(paths.WEB_DATA_DIR / "manifest.json", manifest),
        "digests.json": _write_json(paths.WEB_DATA_DIR / "digests.json", digests, compact=True),
    }

    # ---- articles/<date>.json + articles.index.json ----
    index_rows: list[list] = []
    shard_total = 0
    for date in dates:
        shard = [r for r in articles if r["date"] == date]
        shard_total += _write_json(paths.ARTICLES_DATA_DIR / f"{date}.json", shard, compact=True)
        for r in shard:
            index_rows.append(
                [
                    r["id"],
                    r["date"],
                    r["category"],
                    r["section"],
                    r["title"],
                    r["summary"][:LEAD_CHARS],
                ]
            )
    sizes["articles/*.json"] = shard_total
    sizes["articles.index.json"] = _write_json(
        paths.WEB_DATA_DIR / "articles.index.json",
        {"fields": INDEX_FIELDS, "rows": index_rows},
        compact=True,
    )

    # ---- timeline.json ----
    series = []
    for name, slug in categories.CATEGORIES:
        article_counts, digest_counts = [], []
        for date in dates:
            article_counts.append(sum(1 for r in articles if r["date"] == date and r["category"] == slug))
            digest_counts.append(sum(1 for r in digests if r["date"] == date and r["category"] == slug))
        series.append(
            {
                "category": slug,
                "category_name": name,
                "is_catch_all": slug == categories.CATCH_ALL_SLUG,
                "article_counts": article_counts,
                "digest_counts": digest_counts,
            }
        )
    sizes["timeline.json"] = _write_json(
        paths.WEB_DATA_DIR / "timeline.json", {"dates": dates, "series": series}
    )

    finished = datetime.now(CST)
    report = {
        "started_at": started.isoformat(timespec="seconds"),
        "finished_at": finished.isoformat(timespec="seconds"),
        "elapsed_seconds": round((finished - started).total_seconds(), 2),
        "source_dir": str(source),
        "output_dir": str(paths.WEB_DATA_DIR),
        "counts": {
            "reports": len(dates),
            "articles": len(articles),
            "digests": len(digests),
            "details": len(details),
        },
        "sources_attached": attached,
        "output_bytes": sizes,
        "output_bytes_total": sum(sizes.values()),
        "warnings": warnings,
    }
    paths.BUILD_REPORT_PATH.write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return report


def main() -> int:
    report = build()
    counts = report["counts"]
    print(
        f"[构建完成] {counts['reports']} 期 · {counts['articles']} 篇文章 · "
        f"{counts['digests']} 条洞察 · {counts['details']} 条详细要点"
    )
    print(f"[原文引用] {report['sources_attached']} 条洞察挂上了来源链接")
    print(f"[产物体积] {report['output_bytes_total'] / 1024 / 1024:.2f} MB → {report['output_dir']}")
    if report["warnings"]:
        print(f"[告警] {len(report['warnings'])} 条：")
        for item in report["warnings"][:10]:
            print(f"  - {item}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
