#!/usr/bin/env bash
#
# Lab Insight Radar · 一键更新与发布
#
# 用途：日报（周一/周四）产出新一期后，把新增内容增量更新到线上站点。
#
#   ./publish.sh                 检测到新期数就构建、验证、推送、等部署完成
#   ./publish.sh --check         只看有没有新内容，不做任何改动
#   ./publish.sh --dry-run       打印将要执行的步骤，不实际执行
#   ./publish.sh --no-push       只构建到本地，不推送（供你预览确认）
#   ./publish.sh --skip-arxiv    跳过 arXiv 解析（快路径，论文页退化为搜索链接）
#
# 设计要点：
# - 按**内容**检测新期数，而不是按时间：产出时间在 08:00~11:30 之间漂移，
#   偶尔还会滑到周二/周五，定时触发一定会漏
# - 只认「已完成」的期：output/<date>/daily_report.md 必须存在且已稳定 90 秒
#   （避免把正在写入的半成品发出去）
# - 验证门禁：只读断言 + 本地自检任一不过就中止，绝不推送
# - 幂等：没有新内容时秒退；重复运行安全
# - 文件锁：防止两次运行互相抢缓存（曾因两个 arXiv 进程并发而损坏过缓存）

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

SOURCE_DIR="${DAILY_REPORT_DIR:-/Users/boding/.openclaw/workspace/Daily Report}"
REPO_SLUG="BOGEDABUDA/storage-ai-radar"
LIVE_URL="https://bogedabuda.github.io/storage-ai-radar/"
STATE_FILE="$ROOT/pipeline/cache/publish_state.json"
LOCK_DIR="$ROOT/pipeline/cache/publish.lock"
LOG_DIR="$ROOT/logs"
LOG_FILE="$LOG_DIR/publish.log"
STABLE_SECONDS="${RADAR_STABLE_SECONDS:-90}"
PREVIEW_PORT="${RADAR_PREVIEW_PORT:-4199}"

MODE="run"
SKIP_ARXIV=0
for arg in "$@"; do
  case "$arg" in
    --check)      MODE="check" ;;
    --dry-run)    MODE="dry-run" ;;
    --no-push)    MODE="no-push" ;;
    --skip-arxiv) SKIP_ARXIV=1 ;;
    -h|--help)    sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$arg（用 --help 查看用法）" >&2; exit 2 ;;
  esac
done

mkdir -p "$LOG_DIR" "$(dirname "$STATE_FILE")"

log()  { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG_FILE" >&2; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$*" | tee -a "$LOG_FILE" >&2; }
die()  { printf '\033[31m[中止] %s\033[0m\n' "$*" | tee -a "$LOG_FILE" >&2; exit 1; }

# ---------------------------------------------------------------- 文件锁
acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    echo $$ > "$LOCK_DIR/pid"
  else
    local pid=""
    [ -f "$LOCK_DIR/pid" ] && pid="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      die "已有发布流程在运行（PID $pid），本次跳过"
    fi
    log "清理陈旧锁（PID ${pid:-未知} 已不存在）"
    rm -rf "$LOCK_DIR"
    mkdir "$LOCK_DIR" && echo $$ > "$LOCK_DIR/pid"
  fi
  trap 'rm -rf "$LOCK_DIR"' EXIT
}

# ---------------------------------------------------------------- 检测新期数
# 输出 JSON：{"new":[...],"complete":N,"published":N,"blocked":[...]}
detect() {
  ROOT="$ROOT" SRC="$SOURCE_DIR" STABLE="$STABLE_SECONDS" python3 - <<'PY'
import json, os, time
from pathlib import Path

src = Path(os.environ["SRC"])
root = Path(os.environ["ROOT"])
stable = int(os.environ["STABLE"])

state_path = root / "pipeline" / "cache" / "publish_state.json"
if state_path.exists():
    published = set(json.loads(state_path.read_text(encoding="utf-8")).get("published", []))
else:
    # 首次运行：以当前已构建的 manifest 作为"已发布"基线
    manifest = root / "web" / "public" / "data" / "manifest.json"
    published = set(json.loads(manifest.read_text(encoding="utf-8"))["dates"]) if manifest.exists() else set()

if not (src / "output").is_dir():
    print(json.dumps({"error": f"数据源不存在：{src}"}))
    raise SystemExit(0)

now = time.time()
complete, blocked = [], []
for entry in sorted((src / "output").iterdir()):
    if not entry.is_dir():
        continue
    date = entry.name
    report = entry / "daily_report.md"
    total_dir = src / "total" / date
    if not report.is_file():
        continue
    if not total_dir.is_dir() or not any(total_dir.glob("*.md")):
        blocked.append(date)          # 报告写了但聚合还没完成
        continue
    if now - report.stat().st_mtime < stable:
        blocked.append(date)          # 可能仍在写入
        continue
    complete.append(date)

new = [d for d in complete if d not in published]
print(json.dumps({"new": new, "complete": len(complete), "published": len(published), "blocked": blocked}))
PY
}

# ---------------------------------------------------------------- 实质变更判定
# 产物里带 generated_at 时间戳，重跑一次就会"有变更"。这里忽略纯时间戳差异，
# 避免每周两次发布之外还产生无意义的提交。
has_meaningful_changes() {
  python3 - <<'INNER_PY'
import json, subprocess

files = subprocess.run(["git", "diff", "--cached", "--name-only"],
                       capture_output=True, text=True).stdout.split()
if not files:
    print("NO")
    raise SystemExit(0)

def strip_timestamps(raw):
    try:
        data = json.loads(raw)
    except Exception:
        return raw
    if isinstance(data, dict):
        for key in ("generated_at", "updated_at", "built_at"):
            data.pop(key, None)
    return json.dumps(data, sort_keys=True, ensure_ascii=False).encode()

for path in files:
    old = subprocess.run(["git", "show", "HEAD:" + path], capture_output=True).stdout
    try:
        new = open(path, "rb").read()
    except OSError:
        print("YES")
        raise SystemExit(0)
    if old != new and strip_timestamps(old) != strip_timestamps(new):
        print("YES")
        raise SystemExit(0)
print("NO")
INNER_PY
}

# ---------------------------------------------------------------- 口径自检
# 语料的分类框架若发生变化（增删/改名），categories.py 必须同步，否则网页 URL 会退化
# 成哈希 slug、分类配色与排序也会丢。这里每次发布前自动对比，不一致就明确告警。
# 别名表与趋势常量属于"分析口味"，不参与同步检查，只报告覆盖率供参考。
check_taxonomy() {
  python3 - <<'INNER_PY'
import collections, glob, json, os, sys
sys.path.insert(0, os.environ.get("ROOT", "."))
from pipeline import categories

src = os.environ.get("SRC", "")
suffix = "_详细.md"

seen = collections.Counter()
for path in glob.glob(f"{src}/total/*/*.md"):
    seen[os.path.basename(path)[:-3]] += 1
for path in glob.glob(f"{src}/output/*/*{suffix}"):
    seen[os.path.basename(path)[:-len(suffix)]] += 1

known = set(categories.NAME_TO_SLUG)
unknown = sorted(set(seen) - known)
missing = sorted(known - set(seen))

print(f"  分类框架：语料 {len(seen)} 个 · categories.py {len(known)} 个")
if unknown:
    print(f"  ⚠ 语料里出现未登记的分类：{unknown}")
    print("    → 这些分类会退化为哈希 URL（能显示但链接难看、无配色与排序）")
    print("    → 请把分类名与 slug 补进 pipeline/categories.py 的 CATEGORIES")
if missing:
    print(f"  ⚠ categories.py 登记了但语料未出现：{missing}")
    print("    → 若是分类被改名或删除，请更新 categories.py")
if not unknown and not missing:
    print("  ✓ 分类框架一致，无需同步")

# 别名覆盖率（仅供参考，不需要同步）
store = os.path.join(os.environ.get("ROOT", "."), "pipeline", "entities.json")
if os.path.exists(store):
    entries = json.load(open(store, encoding="utf-8")).get("entries", {})
    names = collections.Counter()
    for row in entries.values():
        for entity in row.get("entities", []):
            names[entity["name"]] += 1
    alias_map = {}
    if os.path.exists(os.path.join(os.environ.get("ROOT", "."), "pipeline", "aliases.json")):
        raw = json.load(open(os.path.join(os.environ.get("ROOT", "."), "pipeline", "aliases.json"), encoding="utf-8"))
        for canonical, aliases in (raw.get("canonical") or {}).items():
            for alias in aliases:
                alias_map[alias.strip().lower()] = canonical
    covered = sum(count for name, count in names.items() if name.strip().lower() in alias_map)
    total = sum(names.values())
    print(f"  别名表：{len(alias_map)} 个别名，覆盖 {covered}/{total} 次提及"
          f"（{covered / total * 100 if total else 0:.1f}%）— 未覆盖不代表有问题，只是同一实体的不同写法不会自动合并")
INNER_PY
}

# ---------------------------------------------------------------- 本地自检
self_check() {
  local expect_dates="$1"
  step "本地自检（起 preview 于 :$PREVIEW_PORT 核对页面与数据）"
  ( cd "$ROOT/web" && pnpm preview --port "$PREVIEW_PORT" >/dev/null 2>&1 & echo $! > /tmp/radar-preview.pid )
  sleep 5
  local base="http://localhost:$PREVIEW_PORT/storage-ai-radar"
  local ok=1
  for path in "/" "/data/manifest.json" "/data/digests.json" "/data/graph.json" "/data/trends.json" "/data/papers.json"; do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$base$path" || echo 000)"
    if [ "$code" != "200" ]; then
      log "  ✗ $path → $code"
      ok=0
    else
      log "  ✓ $path"
    fi
  done

  if [ "$ok" = "1" ]; then
    # 新期数必须真的出现在产物里
    EXPORT_DATES="$expect_dates" python3 - "$base" <<'PY' || ok=0
import json, os, sys, urllib.request
base = sys.argv[1]
expect = [d for d in os.environ.get("EXPORT_DATES", "").split(",") if d]
with urllib.request.urlopen(f"{base}/data/manifest.json", timeout=30) as r:
    manifest = json.load(r)
missing = [d for d in expect if d not in manifest["dates"]]
if missing:
    print(f"  ✗ 产物缺少新期数：{missing}", file=sys.stderr)
    raise SystemExit(1)
print(f"  ✓ 新期数已入产物：{expect}（共 {manifest['report_count']} 期）")
PY
  fi

  kill "$(cat /tmp/radar-preview.pid 2>/dev/null)" 2>/dev/null || true
  pkill -f "vite preview --port $PREVIEW_PORT" 2>/dev/null || true
  rm -f /tmp/radar-preview.pid
  [ "$ok" = "1" ] || die "本地自检未通过，已中止（不会推送）"
  log "本地自检通过"
}

# ---------------------------------------------------------------- 主流程
acquire_lock

step "检测新增期数（数据源：$SOURCE_DIR）"
DETECT="$(detect)"
if echo "$DETECT" | grep -q '"error"'; then
  die "$(echo "$DETECT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["error"])')"
fi
NEW_DATES="$(echo "$DETECT" | python3 -c 'import json,sys; print(",".join(json.load(sys.stdin)["new"]))')"
COMPLETE_N="$(echo "$DETECT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["complete"])')"
PUBLISHED_N="$(echo "$DETECT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["published"])')"
BLOCKED="$(echo "$DETECT" | python3 -c 'import json,sys; b=json.load(sys.stdin)["blocked"]; print(",".join(b))')"

log "已完成期数 $COMPLETE_N · 已发布 $PUBLISHED_N · 待发布 ${NEW_DATES:-无}"
[ -n "$BLOCKED" ] && log "跳过（未完成或仍在写入）：$BLOCKED"

step "口径自检"
ROOT="$ROOT" SRC="$SOURCE_DIR" check_taxonomy 2>&1 | tee -a "$LOG_FILE" >&2

if [ -z "$NEW_DATES" ]; then
  log "没有新内容，结束"
  exit 0
fi

if [ "$MODE" = "check" ]; then
  log "（--check 模式，不做任何改动）"
  exit 0
fi

if [ "$MODE" = "dry-run" ]; then
  cat <<EOF

将执行以下步骤（--dry-run，未实际执行）：
  1. 只读快照
  2. 增量抽取实体（仅新洞察）
  3. 增量抽取论文（仅新论文推荐）
  4. 增量 arXiv 解析（$([ "$SKIP_ARXIV" = "1" ] && echo '已跳过' || echo '限速 1 请求/3 秒')）
  5. 重建派生数据 + 前端
  6. 重建 Agent 检索索引
  7. 只读校验（不过则中止）
  8. 本地自检：$LIVE_URL 对应产物在新期数上是否完整
  9. 提交并推送到 $REPO_SLUG
 10. 等待 Actions 部署并验证 $LIVE_URL

新增期数：$NEW_DATES
EOF
  exit 0
fi

# 1) 只读快照
step "1/10 建立只读基线快照"
python3 -m pipeline.readonly_guard snapshot | tee -a "$LOG_FILE" >&2

# 2) 增量抽取实体
step "2/10 增量抽取实体（仅新洞察）"
python3 -m pipeline.extract_entities 2>&1 | tee -a "$LOG_FILE" >&2 || die "实体抽取失败，本次不发布（下次巡检会重试）"

# 3) 增量抽取论文
step "3/10 增量抽取论文（仅新论文推荐）"
python3 -m pipeline.extract_papers 2>&1 | tee -a "$LOG_FILE" >&2 || die "论文抽取失败，本次不发布（下次巡检会重试）"

# 4) 增量 arXiv 解析（非致命）
if [ "$SKIP_ARXIV" = "1" ]; then
  log "4/10 已跳过 arXiv 解析"
else
  step "4/10 增量 arXiv 解析（限速 1 请求/3 秒）"
  if ! python3 -m pipeline.resolve_papers --rate 3 2>&1 | tee -a "$LOG_FILE" >&2; then
    log "arXiv 解析出现错误，已忽略（论文页对未解析条目自动退化为搜索链接）"
  fi
fi

# 5) 重建派生数据 + 前端
step "5/10 重建派生数据"
python3 -m pipeline.build 2>&1 | tee -a "$LOG_FILE" >&2 || die "数据构建失败"
step "5/10 构建前端"
( cd "$ROOT/web" && pnpm run build 2>&1 | tee -a "$LOG_FILE" >&2 ) || die "前端构建失败"

# 6) Agent 检索索引（非致命）
step "6/10 重建 Agent 检索索引"
python3 -m pipeline.build_index 2>&1 | tail -3 | tee -a "$LOG_FILE" >&2 || log "索引重建失败，已忽略（不影响静态站点）"

# 7) 只读校验（致命）
step "7/10 只读校验（语料必须零改动）"
python3 -m pipeline.readonly_guard verify 2>&1 | tee -a "$LOG_FILE" >&2 || die "语料被改动，已中止发布"

# 8) 本地自检（致命）
self_check "$NEW_DATES"

if [ "$MODE" = "no-push" ]; then
  log "（--no-push 模式）构建已完成，未推送。预览：cd web && pnpm preview"
  exit 0
fi

# 9) 提交并推送
step "9/10 提交并推送"
# 你的网络直连 github.com 被阻断，推送必须走代理。代理没起来就早失败，
# 给出明确提示而不是卡住或抛一堆 git 错误。
PROXY_URL="$(git config --get 'http.https://github.com/.proxy' || true)"
if [ -n "$PROXY_URL" ]; then
  if curl -s -o /dev/null --max-time 8 -x "$PROXY_URL" https://github.com; then
    log "推送代理可用：$PROXY_URL"
  else
    die "推送代理 $PROXY_URL 不通，无法推送到 GitHub。请确认代理在运行；若只想本地构建请加 --no-push"
  fi
fi
if ! git config --get "http.https://github.com/.proxy" >/dev/null 2>&1; then
  log "提示：未配置 github.com 代理，若推送因网络失败请设置："
  log "  git config --local http.https://github.com/.proxy http://127.0.0.1:8001"
fi
git add -A
if git diff --cached --quiet; then
  log "没有文件变更，跳过提交"
elif [ "$(has_meaningful_changes)" = "NO" ]; then
  log "仅有时间戳变化（产物内容未变），跳过提交"
  git reset -q
  git checkout -q -- .
else
  git -c user.name="${GIT_AUTHOR_NAME:-BOGEDAORNOT}" \
      -c user.email="${GIT_AUTHOR_EMAIL:-dingbo346514782@hotmail.com}" \
      commit -q -m "publish: 新增 ${NEW_DATES} 期洞察

由 publish.sh 自动发布：
- 增量抽取实体与论文（仅新增内容）
- 重建派生数据、前端与检索索引
- 只读校验与本地自检均已通过" || die "提交失败"
  log "已提交：$(git log --oneline -1)"
fi
GIT_TERMINAL_PROMPT=0 git push origin main 2>&1 | tee -a "$LOG_FILE" >&2 || die "推送失败（检查代理是否在运行）"

# 10) 等部署并验证线上
step "10/10 等待 GitHub Actions 部署并验证线上"
sleep 10
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  RUN_ID="$(gh run list --repo "$REPO_SLUG" --limit 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null || true)"
  if [ -n "$RUN_ID" ]; then
    gh run watch "$RUN_ID" --repo "$REPO_SLUG" --exit-status >/dev/null 2>&1 \
      && log "Actions 部署成功（run $RUN_ID）" \
      || log "Actions 部署未成功，请查看：gh run view $RUN_ID --repo $REPO_SLUG"
  fi
else
  log "gh 不可用或未登录，跳过 Actions 状态检查"
fi

sleep 5
if EXPORT_DATES="$NEW_DATES" python3 - "$LIVE_URL" <<'PY'
import json, os, sys, time, urllib.request
live = sys.argv[1].rstrip("/")
expect = [d for d in os.environ.get("EXPORT_DATES", "").split(",") if d]
for attempt in range(10):
    try:
        with urllib.request.urlopen(f"{live}/data/manifest.json", timeout=25) as r:
            manifest = json.load(r)
        missing = [d for d in expect if d not in manifest["dates"]]
        if not missing:
            print(f"线上已包含新期数 {expect}（共 {manifest['report_count']} 期）")
            raise SystemExit(0)
        time.sleep(12)
    except SystemExit:
        raise
    except Exception:
        time.sleep(12)
print(f"线上尚未出现新期数 {expect}（可能仍在部署，稍后会自动生效）")
raise SystemExit(1)
PY
then
  log "线上验证通过"
else
  log "线上验证未通过——部署可能仍在进行，稍后刷新 $LIVE_URL 确认"
fi

# 记录已发布（放在 gitignore 的 cache 目录，无需提交）
python3 - "$STATE_FILE" "$NEW_DATES" <<'PY'
import json, os, sys
from datetime import datetime
state_path, dates = sys.argv[1], sys.argv[2]
try:
    state = json.loads(open(state_path, encoding="utf-8").read())
except Exception:
    state = {"published": []}
state["published"] = sorted(set(state.get("published", [])) | {d for d in dates.split(",") if d})
state["updated_at"] = datetime.now().astimezone().isoformat(timespec="seconds")
open(state_path, "w", encoding="utf-8").write(json.dumps(state, ensure_ascii=False, indent=1))
print(f"已记录发布状态：{len(state['published'])} 期")
PY

step "完成"
log "新期数 $NEW_DATES 已上线：$LIVE_URL"
