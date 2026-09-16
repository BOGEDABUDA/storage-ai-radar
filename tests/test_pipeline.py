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

WEB_DATA = ROOT / "web" / "data"

EXPECTED_REPORTS = 42
EXPECTED_ARTICLES = 15192
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

            first = {
                p.relative_to(data_dir): p.read_bytes()
                for p in sorted(data_dir.rglob("*.json"))
                if p.name != "manifest.json"
            }
            manifest_before = json.loads((data_dir / "manifest.json").read_text(encoding="utf-8"))
            _run_build(data_dir, tmp_path / "build_report.json")
            second = {
                p.relative_to(data_dir): p.read_bytes()
                for p in sorted(data_dir.rglob("*.json"))
                if p.name != "manifest.json"
            }
            manifest_after = json.loads((data_dir / "manifest.json").read_text(encoding="utf-8"))

            self.assertEqual(first.keys(), second.keys())
            for key in first:
                self.assertEqual(first[key], second[key], f"{key} 两次构建不一致（非幂等）")
            manifest_before.pop("generated_at")
            manifest_after.pop("generated_at")
            self.assertEqual(manifest_before, manifest_after)


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


if __name__ == "__main__":
    unittest.main(verbosity=2)
