"""知识图谱与趋势分析：把实体抽取结果汇聚成 graph.json / trends.json。

全部为确定性计算（不调用 LLM），输入是 794 条洞察 + entities.json，因此可离线复现。

趋势指标定义：
- 动量 momentum = (近 N 期均值 − 基线均值) / max(基线均值, 1)，N=3，基线取前 12 期并折算到同等窗口
- 新兴实体 = 首次出现落在最近 3 期且提及 ≥ 2
- 退潮实体 = 基线 ≥ 3 次且最近 3 期 0 次
- 商业/学术信号比 = 同分类下两种视角的洞察条数
- 关键量化指标 = 同 label 归并后保留 ≥ 3 个数据点，避免噪声
"""

from __future__ import annotations

import json
import re
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import categories, paths

CST = timezone(timedelta(hours=8))
ALIASES_PATH = Path(__file__).resolve().parent / "aliases.json"

RECENT_WINDOW = 3
BASELINE_WINDOW = 12
MIN_ENTITY_MENTIONS = 2  # 只把反复出现的实体放进图谱，避免噪声
MIN_COOCCUR = 2
MIN_METRIC_POINTS = 3


# ---------------------------------------------------------------- 别名归一

def load_aliases() -> dict[str, str]:
    """返回 别名(小写归一) → 规范名 的映射。"""
    if not ALIASES_PATH.is_file():
        return {}
    raw = json.loads(ALIASES_PATH.read_text(encoding="utf-8"))
    mapping: dict[str, str] = {}
    for canonical, aliases in (raw.get("canonical") or {}).items():
        for alias in aliases:
            mapping[_key(alias)] = canonical
        mapping[_key(canonical)] = canonical
    return mapping


def _key(name: str) -> str:
    """比较用的归一化键：去空白/标点、全角转半角、小写。"""
    text = name.strip().lower()
    text = text.replace("（", "(").replace("）", ")").replace("－", "-").replace("—", "-")
    text = re.sub(r"[\s\u3000]+", "", text)
    return text


def make_normalizer(aliases: dict[str, str]):
    """返回 normalize(name) → 规范名。"""

    def normalize(name: str) -> str:
        cleaned = name.strip()
        return aliases.get(_key(cleaned), cleaned)

    return normalize


def first_nonzero(counts: list[int]) -> int:
    """首个非零位置；全零返回 0。"""
    for index, value in enumerate(counts):
        if value > 0:
            return index
    return 0


def last_nonzero(counts: list[int]) -> int:
    """末个非零位置；全零返回 0。"""
    for index in range(len(counts) - 1, -1, -1):
        if counts[index] > 0:
            return index
    return 0


# ---------------------------------------------------------------- 图谱构建

def build_graph(digests: list[dict], entries: dict[str, dict], dates: list[str]) -> dict:
    aliases = load_aliases()
    normalize = make_normalizer(aliases)
    date_index = {date: i for i, date in enumerate(dates)}

    by_digest = {d["id"]: d for d in digests}

    mentions: Counter[str] = Counter()
    etype: dict[str, str] = {}
    cat_count: dict[str, Counter] = defaultdict(Counter)
    series: dict[str, list[int]] = defaultdict(lambda: [0] * len(dates))
    perspective: dict[str, Counter] = defaultdict(Counter)
    digest_refs: dict[str, list[str]] = defaultdict(list)
    cooc: Counter[tuple[str, str]] = Counter()

    for digest_id, row in entries.items():
        digest = by_digest.get(digest_id)
        if digest is None:
            continue
        index = date_index.get(digest["date"])
        if index is None:
            continue

        names: list[str] = []
        seen_local: set[str] = set()
        for entity in row.get("entities", []):
            canonical = normalize(entity["name"])
            if not canonical or canonical in seen_local:
                continue
            seen_local.add(canonical)
            names.append(canonical)
            mentions[canonical] += 1
            # 类型取首次出现的（同一实体类型应稳定）
            etype.setdefault(canonical, entity["type"])
            cat_count[canonical][digest["category"]] += 1
            series[canonical][index] += 1
            perspective[canonical][digest["perspective"]] += 1
            if len(digest_refs[canonical]) < 40:
                digest_refs[canonical].append(digest_id)

        for i, left in enumerate(names):
            for right in names[i + 1 :]:
                pair = (left, right) if left <= right else (right, left)
                cooc[pair] += 1

    # 节点：只保留反复出现的实体
    kept = [name for name, count in mentions.items() if count >= MIN_ENTITY_MENTIONS]
    kept.sort(key=lambda name: (-mentions[name], name))

    nodes = []
    for name in kept:
        top_category = cat_count[name].most_common(1)[0][0]
        nodes.append(
            {
                "id": f"ent:{name}",
                "label": name,
                "kind": "entity",
                "etype": etype.get(name, "tech"),
                "category": top_category,
                "mentions": mentions[name],
                "first_seen": dates[first_nonzero(series[name])],
                "last_seen": dates[last_nonzero(series[name])],
                "business": perspective[name].get("business", 0),
                "technical": perspective[name].get("technical", 0),
                "series": series[name],
                "digests": digest_refs[name],
            }
        )

    for meta in categories.CATEGORIES:
        nodes.append(
            {
                "id": f"cat:{meta[1]}",
                "label": meta[0],
                "kind": "category",
                "etype": "category",
                "category": meta[1],
                "mentions": sum(
                    1 for digest in digests if digest["category"] == meta[1]
                ),
            }
        )

    kept_set = set(kept)
    edges = []
    for (left, right), weight in cooc.items():
        if weight >= MIN_COOCCUR and left in kept_set and right in kept_set:
            edges.append({"source": f"ent:{left}", "target": f"ent:{right}", "kind": "co_occurs", "weight": weight})
    for name in kept:
        for slug, weight in cat_count[name].items():
            if weight >= 2:
                edges.append({"source": f"ent:{name}", "target": f"cat:{slug}", "kind": "belongs_to", "weight": weight})

    edges.sort(key=lambda e: (-e["weight"], e["source"], e["target"]))

    return {
        "generated_at": datetime.now(CST).isoformat(timespec="seconds"),
        "dates": dates,
        "stats": {
            "digests": len(digests),
            "entities_total": len(mentions),
            "entities_in_graph": len(kept),
            "edges": len(edges),
            "min_mentions": MIN_ENTITY_MENTIONS,
            "min_cooccur": MIN_COOCCUR,
        },
        "nodes": nodes,
        "edges": edges,
    }


# ---------------------------------------------------------------- 趋势分析

def _window_momentum(series_counts: list[int]) -> tuple[float, int, float]:
    """返回 (momentum, recent_sum, baseline_mean)。"""
    if len(series_counts) <= RECENT_WINDOW:
        return 0.0, sum(series_counts), 0.0
    recent = sum(series_counts[-RECENT_WINDOW:])
    baseline_zone = series_counts[-(RECENT_WINDOW + BASELINE_WINDOW) : -RECENT_WINDOW]
    if not baseline_zone:
        return 0.0, recent, 0.0
    baseline_mean = sum(baseline_zone) / len(baseline_zone) * RECENT_WINDOW
    momentum = (recent - baseline_mean) / max(baseline_mean, 1.0)
    return momentum, recent, baseline_mean


def _direction(momentum: float) -> str:
    if momentum >= 0.3:
        return "up"
    if momentum <= -0.3:
        return "down"
    return "flat"


def build_trends(
    digests: list[dict],
    entries: dict[str, dict],
    timeline: dict,
    dates: list[str],
) -> dict:
    aliases = load_aliases()
    normalize = make_normalizer(aliases)

    # --- 分类动量（用文章数，量级更稳） ---
    cat_series = {s["category"]: s["article_counts"] for s in timeline["series"]}
    cat_digests = {s["category"]: s["digest_counts"] for s in timeline["series"]}
    persp = defaultdict(Counter)
    for digest in digests:
        persp[digest["category"]][digest["perspective"]] += 1

    cat_out = []
    for name, slug in categories.CATEGORIES:
        counts = cat_series.get(slug, [])
        momentum, recent, baseline = _window_momentum(counts)
        cat_out.append(
            {
                "category": slug,
                "name": name,
                "is_catch_all": slug == categories.CATCH_ALL_SLUG,
                "momentum": round(momentum, 3),
                "direction": _direction(momentum),
                "recent_articles": recent,
                "baseline_articles": round(baseline, 1),
                "article_counts": counts,
                "digest_counts": cat_digests.get(slug, []),
                "business": persp[slug].get("business", 0),
                "technical": persp[slug].get("technical", 0),
                "topic": persp[slug].get("topic", 0),
            }
        )

    # --- 实体级趋势 ---
    per_entity_series: dict[str, list[int]] = defaultdict(lambda: [0] * len(dates))
    per_entity_meta: dict[str, dict] = {}
    date_index = {date: i for i, date in enumerate(dates)}
    # entities.json 只记录了 date/category，视角从 digest id 反查
    perspective_of = {digest["id"]: digest["perspective"] for digest in digests}
    for digest_id, row in entries.items():
        for entity in row.get("entities", []):
            canonical = normalize(entity["name"])
            if not canonical:
                continue
            per_entity_meta.setdefault(
                canonical, {"etype": entity["type"], "categories": Counter(), "perspective": Counter()}
            )
            entry = per_entity_meta[canonical]
            entry["categories"][row.get("category", "others")] += 1
            entry["perspective"][perspective_of.get(digest_id, "topic")] += 1
            index = date_index.get(row.get("date", ""))
            if index is not None:
                per_entity_series[canonical][index] += 1

    rising, new, fading = [], [], []
    for canonical, counts in per_entity_series.items():
        total = sum(counts)
        if total < MIN_ENTITY_MENTIONS:
            continue
        momentum, recent, baseline = _window_momentum(counts)
        meta = per_entity_meta[canonical]
        first_index = first_nonzero(counts)
        record = {
            "id": f"ent:{canonical}",
            "label": canonical,
            "etype": meta["etype"],
            "category": meta["categories"].most_common(1)[0][0],
            "mentions": total,
            "recent": recent,
            "baseline": round(baseline, 1),
            "momentum": round(momentum, 3),
            "first_seen": dates[first_index],
        }
        if recent >= 2 and momentum >= 0.5:
            rising.append(record)
        if first_index >= len(dates) - RECENT_WINDOW and total >= 2:
            new.append(record)
        if baseline >= 3 and recent == 0:
            fading.append(record)

    # --- 实体级视角倾向 ---
    # 注意：分类层面的「商业/学术」条数几乎恒为 1:1（日报模板每条分类固定产出两个视角），
    # 因此分类级对比没有信息量；真正有信息量的是「同一个实体主要出现在哪种视角里」。
    entity_perspective = []
    for canonical, counts in per_entity_series.items():
        meta = per_entity_meta[canonical]
        business = meta["perspective"].get("business", 0)
        technical = meta["perspective"].get("technical", 0)
        total = business + technical
        if total < 3:
            continue
        entity_perspective.append(
            {
                "id": f"ent:{canonical}",
                "label": canonical,
                "etype": meta["etype"],
                "category": meta["categories"].most_common(1)[0][0],
                "mentions": sum(counts),
                "business": business,
                "technical": technical,
                "lean": round((business - technical) / total, 3),
            }
        )
    entity_perspective.sort(key=lambda r: (-abs(r["lean"]), -r["mentions"]))

    rising.sort(key=lambda r: (-r["momentum"], -r["mentions"]))
    new.sort(key=lambda r: (-r["mentions"], r["label"]))
    fading.sort(key=lambda r: (-r["baseline"], r["label"]))

    # --- 关键量化指标 ---
    # 关键：按 (主体, 指标) 分组。只按指标名分组会把不同主体的数值混成一条假的趋势线
    # （例如把各家模型的「参数量」、各家公司的「毛利率」画成一条曲线），因此必须带 subject。
    series_buckets: dict[tuple[str, str], dict] = {}
    label_buckets: dict[str, dict] = {}
    for digest_id, row in entries.items():
        date = row.get("date", "")
        for metric in row.get("metrics", []):
            subject = metric.get("subject") or "行业"
            label = metric["label"]
            key = (subject, _key(label))
            bucket = series_buckets.setdefault(
                key,
                {"subject": subject, "label": label, "unit": metric.get("unit"), "points": []},
            )
            bucket["points"].append({"date": date, "value": metric["value"]})
            if not bucket["unit"] and metric.get("unit"):
                bucket["unit"] = metric["unit"]

            # 同时保留「指标名」级别的观测清单，便于浏览「这个指标都报过哪些数」
            label_bucket = label_buckets.setdefault(
                _key(label), {"label": label, "unit": metric.get("unit"), "observations": []}
            )
            label_bucket["observations"].append(
                {"date": date, "subject": subject, "value": metric["value"], "unit": metric.get("unit")}
            )
            if not label_bucket["unit"] and metric.get("unit"):
                label_bucket["unit"] = metric["unit"]

    def _dedupe(bucket: dict) -> list[dict]:
        """同一日期多条时取中位数，避免同一条洞察里重复计入。"""
        by_date: dict[str, list[float]] = defaultdict(list)
        for point in bucket["points"]:
            by_date[point["date"]].append(point["value"])
        return [
            {"date": date, "value": sorted(values)[len(values) // 2]}
            for date, values in sorted(by_date.items())
        ]

    metrics_out = []
    for (subject, _label_key), bucket in series_buckets.items():
        points = _dedupe(bucket)
        if len(points) < MIN_METRIC_POINTS:
            continue
        first, last = points[0]["value"], points[-1]["value"]
        change = None if first == 0 else round((last - first) / abs(first), 3)
        metrics_out.append(
            {
                "key": f"{subject}｜{bucket['label']}",
                "subject": subject,
                "label": bucket["label"],
                "unit": bucket["unit"],
                "count": len(points),
                "points": points,
                "first": first,
                "last": last,
                "change": change,
            }
        )
    metrics_out.sort(key=lambda m: (-m["count"], m["label"]))

    # 指标名级观测清单：至少出现 2 次才展示，每条最多保留 12 个观测
    observations_out = []
    for _label_key, bucket in label_buckets.items():
        observations = sorted(bucket["observations"], key=lambda o: o["date"])
        if len(observations) < 2:
            continue
        observations_out.append(
            {
                "label": bucket["label"],
                "unit": bucket["unit"],
                "count": len(observations),
                "subjects": len({o["subject"] for o in observations}),
                "observations": observations[-12:],
            }
        )
    observations_out.sort(key=lambda o: (-o["count"], o["label"]))

    return {
        "generated_at": datetime.now(CST).isoformat(timespec="seconds"),
        "window": {"recent": RECENT_WINDOW, "baseline": BASELINE_WINDOW},
        "categories": cat_out,
        "rising_entities": rising[:60],
        "new_entities": new[:60],
        "fading_entities": fading[:60],
        "metrics": metrics_out[:80],
        "metric_observations": observations_out[:80],
        "entity_perspective": entity_perspective[:40],
    }


def main() -> int:
    """单独重算图谱与趋势（改了 aliases.json 后用这个，无需重跑 LLM 抽取）。"""
    from . import build, extract_entities, parse_articles, parse_digest

    source = paths.source_dir()
    digests, _ = parse_digest.parse_all(source)
    articles, _ = parse_articles.parse_all(source)
    dates = sorted({d["date"] for d in digests} | {a["date"] for a in articles})

    series = []
    for name, slug in categories.CATEGORIES:
        series.append(
            {
                "category": slug,
                "category_name": name,
                "is_catch_all": slug == categories.CATCH_ALL_SLUG,
                "article_counts": [
                    sum(1 for a in articles if a["date"] == date and a["category"] == slug) for date in dates
                ],
                "digest_counts": [
                    sum(1 for d in digests if d["date"] == date and d["category"] == slug) for date in dates
                ],
            }
        )

    store = extract_entities.load_store()
    entries = store.get("entries", {})
    if not entries:
        print("[错误] pipeline/entities.json 为空，请先运行 python3 -m pipeline.extract_entities")
        return 1

    graph = build_graph(digests, entries, dates)
    trends = build_trends(digests, entries, {"dates": dates, "series": series}, dates)
    graph["model"] = store.get("model")

    build._write_json(paths.WEB_DATA_DIR / "graph.json", graph, compact=True)
    build._write_json(paths.WEB_DATA_DIR / "trends.json", trends, compact=True)

    stats = graph["stats"]
    print(
        f"[图谱] 实体 {stats['entities_total']} → 入图 {stats['entities_in_graph']} · "
        f"边 {stats['edges']}"
    )
    print(
        f"[趋势] 上升 {len(trends['rising_entities'])} · 新兴 {len(trends['new_entities'])} · "
        f"退潮 {len(trends['fading_entities'])} · 指标 {len(trends['metrics'])} 项"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
