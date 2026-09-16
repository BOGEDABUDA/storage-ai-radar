"""Markdown 解析的共享工具。

语料格式已实测：
- output/<date>/daily_report.md   : `## <分类>` + `### <视角>：<题>` + 正文段落
- total/<date>/<分类>.md          : `## <板块>` + `**标题**/**时间**/**总结**` 块，块间以 `---` 分隔
- output/<date>/<分类>_详细.md    : `## 要点N（视角）：<题>` + 正文 + `**来源**：[标题](URL) ...`
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

LINK_RE = re.compile(r"\[((?:[^\[\]]|\[[^\]]*\])*)\]\((https?://[^)\s]+)\)")
# `**标题**：xxx` / `**标题**: xxx`，允许字段名后紧跟全角或半角冒号
FIELD_RE = re.compile(r"^\*\*(标题|时间|总结)\*\*\s*[：:]\s*(.*)$")
# `### 商业视角：题` / `### 学术/技术视角: 题`
PERSPECTIVE_RE = re.compile(r"^(商业视角|学术/技术视角)\s*[：:]\s*(.+)$")

PERSPECTIVE_MAP = {"商业视角": "business", "学术/技术视角": "technical"}

SECTION_MAP = {"普通推文": "regular", "论文推荐": "paper"}


def read_lines(path: Path) -> list[str]:
    """只读读取文本并按行返回（容错解码，避免个别坏字节中断整批构建）。"""
    return path.read_text(encoding="utf-8", errors="replace").split("\n")


def normalize_topic(text: str) -> str:
    """用于「洞察 ←→ 详细要点」配对的规范化键。"""
    return re.sub(r"[\s　:：,，。.、;；()（）\-—_/]+", "", text).lower()


def stable_id(*parts: object) -> str:
    """按内容生成稳定短哈希（用于实体等需要去重的场景）。"""
    raw = "\x1f".join(str(p) for p in parts)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:12]


def extract_links(line: str) -> list[dict[str, str]]:
    """从一行 Markdown 中抽出全部 [标题](URL)。"""
    return [{"title": t.strip(), "url": u.strip()} for t, u in LINK_RE.findall(line)]


def clean(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()
