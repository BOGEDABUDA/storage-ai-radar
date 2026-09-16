"""Lab Insight Radar — 流水线测试。

分四组：
- TestParsers       合成 Markdown 的边界用例（自由标题、跨行总结、嵌套方括号链接）
- TestContracts     已构建产物的契约与计数断言（快）
- TestHermeticBuild 用临时目录跑真实 CLI，断言计数与幂等
- TestReadOnly      硬需求：构建前后数据源哈希清单必须完全一致
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from pipeline import categories, mdparse, parse_articles, parse_detail, parse_digest, paths  # noqa: E402
from pipeline import readonly_guard  # noqa: E402

WEB_DATA = ROOT / "web" / "public" / "data"

EXPECTED_REPORTS = 42
EXPECTED_ARTICLES = 14976
EXPECTED_DIGESTS = 794
EXPECTED_CATEGORIES = 10


def _run_build(data_dir: Path, report_path: Path) -> dict:
    """在子进程中跑真实 CLI（同时覆盖命令行入口）。"""
    env = {
        **os.environ,
        "RADAR_DATA_DIR": str(data_dir),
        "RADAR_BUILD_REPORT": str(report_path),
    }
    proc = subprocess.run(
        [sys.executable, "-m", "pipeline.build"],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise AssertionError(f"构建失败：\n{proc.stdout}\n{proc.stderr}")
    return json.loads(report_path.read_text(encoding="utf-8"))


class TestParsers(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="radar-test-"))

    def _write(self, name: str, text: str) -> Path:
        path = self.tmp / name
        path.write_text(text, encoding="utf-8")
        return path

    def test_free_form_heading_becomes_topic(self) -> None:
        """没有「商业视角/学术技术视角」前缀的标题不能丢，归入 topic。"""
        path = self._write(
            "daily_report.md",
            "# 每日信息简报 — 2026-01-01\n\n## AI推理加速优化技术\n\n"
            "### 商业视角：标准条目\n正文A\n\n### 自由标题条目\n正文B\n",
        )
        records = parse_digest.parse_file(path, "2026-01-01")
        self.assertEqual(len(records), 2)
        self.assertEqual(records[0]["perspective"], "business")
        self.assertEqual(records[1]["perspective"], "topic")
        self.assertEqual(records[1]["topic"], "自由标题条目")
        self.assertEqual(records[1]["text"], "正文B")

    def test_multiline_summary_is_joined(self) -> None:
        """实测有 6 处「总结」跨行，必须拼接而不是只取首行。"""
        path = self._write(
            "cat.md",
            "# 新介质\n\n## 普通推文\n\n**标题**：跨行测试\n**时间**：1天前\n"
            "**总结**：第一行内容\n第二行内容\n第三行内容\n\n---\n",
        )
        records = parse_articles.parse_file(path, "2026-01-01", "新介质", "new-media")
        self.assertEqual(len(records), 1)
        self.assertIn("第一行内容", records[0]["summary"])
        self.assertIn("第三行内容", records[0]["summary"])

    def test_nested_bracket_title_link(self) -> None:
        """标题含嵌套方括号时仍要抽出链接（真实语料存在该形态）。"""
        links = mdparse.extract_links(
            "**来源**：[[论文科普] 大模型的表面和谐](https://weixin.sogou.com/x?ie=utf8)"
            " [第二个](https://b.com)"
        )
        self.assertEqual(len(links), 2)
        self.assertEqual(links[0]["url"], "https://weixin.sogou.com/x?ie=utf8")
        self.assertEqual(links[1]["title"], "第二个")

    def test_missing_perspective_label_infers_by_position(self) -> None:
        """详细要点无视角标注时，按位置推断（要点1=商业，要点2=学术）。"""
        path = self._write(
            "d_详细.md",
            "# 新介质\n\n## 要点1：题A\n正文\n\n**来源**：[A](https://a.com)\n\n"
            "## 要点2：题B\n正文\n\n**来源**：[B](https://b.com)\n",
        )
        records = parse_detail.parse_file(path, "2026-01-01")
        self.assertEqual([r["perspective"] for r in records], ["business", "technical"])
        self.assertEqual(len(records[1]["sources"]), 1)

    def test_write_guard_rejects_source_path(self) -> None:
        """写入门禁必须拒绝落在只读数据源内的路径。"""
        from pipeline import paths

        with self.assertRaises(SystemExit):
            paths.assert_writable(paths.source_dir() / "evil.json")

    def test_all_categories_have_slugs(self) -> None:
        self.assertEqual(len(categories.CATEGORIES), EXPECTED_CATEGORIES)
        slugs = [slug for _, slug in categories.CATEGORIES]
        self.assertEqual(len(set(slugs)), EXPECTED_CATEGORIES, "slug 不允许重复")
        for name, slug in categories.CATEGORIES:
            self.assertEqual(categories.slug_for(name), slug)


class TestContracts(unittest.TestCase):
    """针对已构建产物做契约断言（无则跳过）。"""

    @classmethod
    def setUpClass(cls) -> None:
        if not (WEB_DATA / "manifest.json").exists():
            raise unittest.SkipTest("web/data 尚未构建，先运行 python3 -m pipeline.build")
        cls.manifest = json.loads((WEB_DATA / "manifest.json").read_text(encoding="utf-8"))
        cls.digests = json.loads((WEB_DATA / "digests.json").read_text(encoding="utf-8"))
        cls.timeline = json.loads((WEB_DATA / "timeline.json").read_text(encoding="utf-8"))
        cls.index = json.loads((WEB_DATA / "articles.index.json").read_text(encoding="utf-8"))

    def test_counts(self) -> None:
        self.assertEqual(self.manifest["report_count"], EXPECTED_REPORTS)
        self.assertEqual(self.manifest["article_count"], EXPECTED_ARTICLES)
        self.assertEqual(self.manifest["digest_count"], EXPECTED_DIGESTS)
        self.assertEqual(len(self.manifest["categories"]), EXPECTED_CATEGORIES)
        self.assertEqual(len(self.digests), EXPECTED_DIGESTS)

    def test_no_local_absolute_path_published(self) -> None:
        """公开产物不得泄露本机绝对路径。"""
        raw = (WEB_DATA / "manifest.json").read_text(encoding="utf-8")
        self.assertNotIn("/Users/", raw)
        self.assertIn("source_label", self.manifest)

    def test_digest_ids_unique_and_sources_attached(self) -> None:
        ids = [d["id"] for d in self.digests]
        self.assertEqual(len(set(ids)), len(ids), "洞察 id 必须唯一")
        with_sources = sum(1 for d in self.digests if d["sources"])
        self.assertEqual(with_sources, EXPECTED_DIGESTS, "每条洞察都应挂上原文来源")

    def test_digest_fields_nonempty(self) -> None:
        for d in self.digests:
            for field in ("date", "category", "perspective", "topic", "text"):
                self.assertTrue(d[field], f"{d['id']} 的 {field} 为空")

    def test_articles_every_date_and_category(self) -> None:
        """分类文件每期都是 10 个，但 12 期存在「分类为 0 篇」的稀疏情况（真实数据）。

        断言：每期至少 1 个分类有文章；跨全期覆盖全部 10 个分类；稀疏期数有界。
        """
        seen_categories: set[str] = set()
        sparse_dates = 0
        for date in self.manifest["dates"]:
            shard = WEB_DATA / "articles" / f"{date}.json"
            self.assertTrue(shard.exists(), f"缺少分片 {date}")
            rows = json.loads(shard.read_text(encoding="utf-8"))
            self.assertTrue(rows, f"{date} 分片为空")
            cats = {r["category"] for r in rows}
            seen_categories |= cats
            self.assertTrue(1 <= len(cats) <= EXPECTED_CATEGORIES, f"{date} 分类数异常：{cats}")
            if len(cats) < EXPECTED_CATEGORIES:
                sparse_dates += 1
            for r in rows:
                self.assertTrue(r["title"], f"{date} 有文章缺标题")
                self.assertTrue(r["time_hint"], f"{date} 有文章缺时间")
        self.assertEqual(seen_categories, {slug for _, slug in categories.CATEGORIES})
        self.assertLessEqual(sparse_dates, 15, "稀疏期数异常增长，需排查")

    def test_empty_summaries_bounded_and_declared(self) -> None:
        """源数据本身有少量文章「总结」为空，数量必须有界且在 manifest 中声明。"""
        empty = 0
        for date in self.manifest["dates"]:
            rows = json.loads((WEB_DATA / "articles" / f"{date}.json").read_text(encoding="utf-8"))
            empty += sum(1 for r in rows if not r["summary"])
        self.assertLessEqual(empty, 80, "空摘要数量异常增长，需排查解析或源数据")
        self.assertEqual(empty, self.manifest["empty_summaries"])

    def test_timeline_sums_match(self) -> None:
        self.assertEqual(sum(sum(s["article_counts"]) for s in self.timeline["series"]), EXPECTED_ARTICLES)
        self.assertEqual(sum(sum(s["digest_counts"]) for s in self.timeline["series"]), EXPECTED_DIGESTS)
        self.assertEqual(len(self.timeline["dates"]), EXPECTED_REPORTS)

    def test_index_rows_match_articles(self) -> None:
        self.assertEqual(len(self.index["rows"]), EXPECTED_ARTICLES)
        self.assertEqual(self.index["fields"], ["i", "d", "c", "s", "t", "l"])

    def test_catch_all_flagged(self) -> None:
        catch_all = [c for c in self.manifest["categories"] if c["is_catch_all"]]
        self.assertEqual(len(catch_all), 1)
        self.assertEqual(catch_all[0]["key"], categories.CATCH_ALL_SLUG)
        self.assertGreater(catch_all[0]["article_count"], 6000)


class TestHermeticBuild(unittest.TestCase):
    def test_build_and_idempotency(self) -> None:
        with tempfile.TemporaryDirectory(prefix="radar-build-") as tmp:
            tmp_path = Path(tmp)
            data_dir = tmp_path / "data"
            report = _run_build(data_dir, tmp_path / "build_report.json")

            self.assertEqual(report["counts"]["reports"], EXPECTED_REPORTS)
            self.assertEqual(report["counts"]["articles"], EXPECTED_ARTICLES)
            self.assertEqual(report["counts"]["digests"], EXPECTED_DIGESTS)
            self.assertEqual(report["warnings"], [], "构建不应产生告警")

            def snapshot() -> dict[str, str]:
                """除时间戳外应完全一致：所有 JSON 去掉 generated_at 后做规范化比较。"""
                out: dict[str, str] = {}
                for path in sorted(data_dir.rglob("*.json")):
                    data = json.loads(path.read_text(encoding="utf-8"))
                    if isinstance(data, dict):
                        data.pop("generated_at", None)
                    out[str(path.relative_to(data_dir))] = json.dumps(
                        data, sort_keys=True, ensure_ascii=False
                    )
                return out

            first = snapshot()
            _run_build(data_dir, tmp_path / "build_report.json")
            second = snapshot()

            self.assertEqual(first.keys(), second.keys(), "两次构建产出的文件集合不一致")
            for key in first:
                self.assertEqual(first[key], second[key], f"{key} 两次构建不一致（非幂等）")


class TestReadOnly(unittest.TestCase):
    """硬需求：全量构建不得改动数据源任何一个字节。"""

    def test_source_tree_unchanged_after_full_build(self) -> None:
        source = paths.source_dir()
        before = readonly_guard.manifest(source)
        self.assertGreater(len(before), 20000, "数据源文件数异常偏少")
        with tempfile.TemporaryDirectory(prefix="radar-ro-") as tmp:
            tmp_path = Path(tmp)
            _run_build(tmp_path / "data", tmp_path / "build_report.json")
        after = readonly_guard.manifest(source)
        self.assertEqual(readonly_guard.diff(before, after), {"added": [], "removed": [], "changed": []})


class TestGraphTrends(unittest.TestCase):
    """P2：知识图谱与趋势产物的契约断言。"""

    @classmethod
    def setUpClass(cls) -> None:
        graph_path = WEB_DATA / "graph.json"
        trends_path = WEB_DATA / "trends.json"
        if not graph_path.exists() or not trends_path.exists():
            raise unittest.SkipTest("graph.json / trends.json 尚未生成")
        cls.graph = json.loads(graph_path.read_text(encoding="utf-8"))
        cls.trends = json.loads(trends_path.read_text(encoding="utf-8"))
        cls.entities = json.loads((ROOT / "pipeline" / "entities.json").read_text(encoding="utf-8"))
        cls.manifest = json.loads((WEB_DATA / "manifest.json").read_text(encoding="utf-8"))

    def test_extraction_covers_every_digest(self) -> None:
        """抽取结果必须覆盖全部 794 条洞察，且每条都有 hash。"""
        entries = self.entities["entries"]
        self.assertEqual(len(entries), EXPECTED_DIGESTS)
        for digest_id, row in entries.items():
            self.assertTrue(row.get("hash"), f"{digest_id} 缺少内容哈希")

    def test_graph_shape_and_edges_resolve(self) -> None:
        nodes = self.graph["nodes"]
        edges = self.graph["edges"]
        self.assertTrue(nodes, "图谱节点为空")
        self.assertTrue(edges, "图谱边为空")

        ids = [node["id"] for node in nodes]
        self.assertEqual(len(set(ids)), len(ids), "节点 id 必须唯一")
        known = set(ids)

        for edge in edges:
            self.assertIn(edge["source"], known, f"边源节点不存在：{edge['source']}")
            self.assertIn(edge["target"], known, f"边目标节点不存在：{edge['target']}")
            self.assertIn(edge["kind"], {"co_occurs", "belongs_to"})
            self.assertGreaterEqual(edge["weight"], 1)

        # 共现边必须达到最小权重阈值，避免噪声边
        for edge in edges:
            if edge["kind"] == "co_occurs":
                self.assertGreaterEqual(edge["weight"], self.graph["stats"]["min_cooccur"])

    def test_entity_nodes_meet_threshold_and_series_align(self) -> None:
        """入图实体都达到最小提及量；逐期序列长度必须与期数一致。"""
        period = len(self.graph["dates"])
        self.assertEqual(period, EXPECTED_REPORTS)
        entity_nodes = [n for n in self.graph["nodes"] if n["kind"] == "entity"]
        self.assertTrue(entity_nodes)
        threshold = self.graph["stats"]["min_mentions"]
        for node in entity_nodes:
            self.assertGreaterEqual(node["mentions"], threshold, f"{node['label']} 低于入图阈值")
            self.assertEqual(len(node["series"]), period, f"{node['label']} 序列长度不等于期数")
            self.assertEqual(sum(node["series"]), node["mentions"], f"{node['label']} 序列之和与提及数不符")

    def test_trends_categories_and_directions(self) -> None:
        categories = self.trends["categories"]
        self.assertEqual(len(categories), EXPECTED_CATEGORIES)
        for category in categories:
            self.assertIn(category["direction"], {"up", "flat", "down"})
            self.assertIsInstance(category["momentum"], (int, float))
            self.assertEqual(len(category["article_counts"]), EXPECTED_REPORTS)

    def test_metric_series_are_subject_scoped(self) -> None:
        """关键正确性：指标序列必须绑定主体，不能只按指标名合并不同主体。"""
        for metric in self.trends["metrics"]:
            self.assertTrue(metric["subject"], f"{metric['label']} 缺少主体")
            self.assertGreaterEqual(metric["count"], 3, f"{metric['label']} 数据点不足")
            self.assertEqual(len(metric["points"]), metric["count"])
            self.assertEqual(metric["points"], sorted(metric["points"], key=lambda p: p["date"]))

    def test_entity_perspective_lean_range(self) -> None:
        rows = self.trends["entity_perspective"]
        self.assertTrue(rows, "实体视角样本为空")
        for row in rows:
            self.assertGreaterEqual(row["business"] + row["technical"], 3)
            self.assertGreaterEqual(row["lean"], -1.0)
            self.assertLessEqual(row["lean"], 1.0)

    def test_rising_new_fading_are_disjoint_lists(self) -> None:
        for key in ("rising_entities", "new_entities", "fading_entities"):
            self.assertIsInstance(self.trends[key], list)
            ids = [item["id"] for item in self.trends[key]]
            self.assertEqual(len(set(ids)), len(ids), f"{key} 存在重复实体")


class TestDedupeAndPapers(unittest.TestCase):
    """去重与学术论文推荐（P4）。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls.manifest = json.loads((WEB_DATA / "manifest.json").read_text(encoding="utf-8"))
        cls.papers_path = WEB_DATA / "papers.json"
        cls.papers = json.loads(cls.papers_path.read_text(encoding="utf-8")) if cls.papers_path.exists() else None

    def test_exact_duplicates_merged(self) -> None:
        """同一期同一分类内不允许再有同名文章（多账号转发产生的重复已合并）。"""
        seen: set[tuple[str, str, str]] = set()
        duplicates: list[str] = []
        for date in self.manifest["dates"]:
            rows = json.loads((WEB_DATA / "articles" / f"{date}.json").read_text(encoding="utf-8"))
            for row in rows:
                key = (row["date"], row["category"], "".join(row["title"].split()).lower())
                if key in seen:
                    duplicates.append(row["title"])
                seen.add(key)
        self.assertEqual(duplicates, [], f"仍存在未合并的重复文章：{duplicates[:3]}")
        self.assertEqual(self.manifest["duplicates_merged"], 216, "合并条数与实测不符")
        self.assertEqual(self.manifest["article_count"], EXPECTED_ARTICLES)

    def test_cross_category_articles_kept(self) -> None:
        """跨领域多标签属于有用信息，不应被合并掉。"""
        by_key: dict[tuple[str, str], set[str]] = {}
        for date in self.manifest["dates"]:
            rows = json.loads((WEB_DATA / "articles" / f"{date}.json").read_text(encoding="utf-8"))
            for row in rows:
                by_key.setdefault((row["date"], "".join(row["title"].split()).lower()), set()).add(row["category"])
        multi = sum(1 for cats in by_key.values() if len(cats) > 1)
        self.assertGreater(multi, 1000, "跨领域多标签文章数量异常偏少，可能被误合并")

    @unittest.skipUnless(WEB_DATA.joinpath("papers.json").exists(), "papers.json 尚未生成")
    def test_papers_shape_and_dedup(self) -> None:
        papers = self.papers["papers"]
        self.assertTrue(papers)
        ids = [p["id"] for p in papers]
        self.assertEqual(len(set(ids)), len(ids), "论文 id 必须唯一（同一篇不应重复出现）")

        arxiv_ids = [p["arxiv"]["id"] for p in papers if p["arxiv"]]
        self.assertEqual(len(set(arxiv_ids)), len(arxiv_ids), "同一篇 arXiv 论文不应重复列出")

        for paper in papers:
            self.assertTrue(paper["title"], "论文标题为空")
            self.assertTrue(paper["categories"], "论文缺少领域标签")
            self.assertTrue(paper["dates"], "论文缺少推荐日期")
            # 解析不到也必须给出搜索链接兜底
            self.assertTrue(paper["links"]["scholar"].startswith("https://scholar.google.com/"))
            self.assertTrue(paper["links"]["arxiv_search"].startswith("https://arxiv.org/"))

    @unittest.skipUnless(WEB_DATA.joinpath("papers.json").exists(), "papers.json 尚未生成")
    def test_resolved_papers_have_real_metadata(self) -> None:
        resolved = [p for p in self.papers["papers"] if p["arxiv"]]
        for paper in resolved:
            arxiv = paper["arxiv"]
            self.assertRegex(arxiv["id"], r"^\d{4}\.\d{4,5}$")
            self.assertEqual(arxiv["url"], f"https://arxiv.org/abs/{arxiv['id']}")
            self.assertTrue(arxiv["title"])
            self.assertTrue(arxiv["abstract"], f"{arxiv['id']} 缺少英文摘要")
            # 领域闸门：不应出现与语料无关的学科
            primary = (arxiv["categories"] or [""])[0]
            self.assertFalse(
                primary.startswith(("hep-", "astro-ph", "nucl-", "gr-qc")),
                f"{arxiv['id']} 属于无关学科 {primary}，领域闸门失效",
            )
        self.assertEqual(len(resolved), self.papers["stats"]["resolved"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
