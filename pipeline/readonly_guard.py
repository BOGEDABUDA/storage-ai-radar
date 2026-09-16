"""只读保证：构建前后对数据源做哈希清单比对。

这是硬需求 —— 本服务绝不允许修改 Daily Report 目录下任何内容。
`manifest()` 递归记录每个文件的 (size, mtime_ns, sha256)，
`diff()` 比较两次清单并报告任何差异。

用法：
    python3 -m pipeline.readonly_guard snapshot   # 写 pipeline/cache/readonly_before.json
    python3 -m pipeline.readonly_guard verify     # 与 snapshot 比对，退出码非 0 表示被改动
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

from . import paths

SNAPSHOT_PATH = paths.CACHE_DIR / "readonly_snapshot.json"
_CHUNK = 1 << 20  # 1 MiB


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:  # 只读
        while chunk := fh.read(_CHUNK):
            h.update(chunk)
    return h.hexdigest()


def manifest(root: Path) -> dict[str, list]:
    """返回 {相对路径: [size, mtime_ns, sha256]}，全部以只读方式读取。"""
    out: dict[str, list] = {}
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        try:
            st = path.stat()
        except OSError:
            continue
        out[str(path.relative_to(root))] = [st.st_size, st.st_mtime_ns, _sha256(path)]
    return out


def diff(before: dict, after: dict) -> dict[str, list[str]]:
    """比较两份清单，返回 added / removed / changed。"""
    b, a = set(before), set(after)
    changed = [k for k in sorted(b & a) if before[k] != after[k]]
    return {
        "added": sorted(a - b),
        "removed": sorted(b - a),
        "changed": changed,
    }


def snapshot() -> None:
    paths.CACHE_DIR.mkdir(parents=True, exist_ok=True)
    root = paths.source_dir()
    man = manifest(root)
    SNAPSHOT_PATH.write_text(json.dumps(man, sort_keys=True), encoding="utf-8")
    print(f"[只读快照] {len(man)} 个文件 → {SNAPSHOT_PATH}")


def verify() -> int:
    if not SNAPSHOT_PATH.exists():
        print("[只读校验] 未找到快照，请先运行 snapshot", file=sys.stderr)
        return 2
    before = json.loads(SNAPSHOT_PATH.read_text(encoding="utf-8"))
    after = manifest(paths.source_dir())
    result = diff(before, after)
    dirty = {k: v for k, v in result.items() if v}
    if not dirty:
        print(f"[只读校验] ✅ 通过：{len(after)} 个文件全部未被修改")
        return 0
    print("[只读校验] ❌ 数据源被改动！", file=sys.stderr)
    for kind, items in dirty.items():
        for item in items[:20]:
            print(f"  {kind}: {item}", file=sys.stderr)
    return 1


def main(argv: list[str]) -> int:
    if len(argv) != 2 or argv[1] not in {"snapshot", "verify"}:
        print(__doc__, file=sys.stderr)
        return 2
    if argv[1] == "snapshot":
        snapshot()
        return 0
    return verify()


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
