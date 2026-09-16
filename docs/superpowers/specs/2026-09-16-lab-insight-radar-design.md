# Lab Insight Radar — 设计文档

- **日期**：2026-09-16
- **状态**：待用户评审
- **作者**：DSH agent（与 波哥 共同设计）
- **项目目录**：`/Users/boding/Desktop/DeepSeek Harness WorkSpace/storage-ai-radar`
- **数据源（只读）**：`/Users/boding/.openclaw/workspace/Daily Report`

---

## 1. 背景与目标

波哥（存储系统研究员）的 OpenClaw 日报工作流已持续产出 4.5 个月的结构化行业简报，但内容只以 Markdown 文件形式散落在本地，无法检索、无法看趋势、无法给 lab 同事共享。

本项目构建一个新服务，把该语料变成**可浏览、可检索、可看趋势的在线知识库**，并为 lab 同事提供特定研究领域的进展跟踪。

### 目标

1. 只读解析 Daily Report 语料，产出结构化派生数据
2. 用 GitHub Pages 发布一个**清新学术风**、支持**明暗双主题**的静态站点
3. 构建**知识图谱**与**领域进展趋势跟踪**（动量、新兴、退潮、商业/学术信号分野）
4. 集成 **Agent**：点击领域/实体可深挖，并能基于全部已有信息回答自由提问
5. **严格只读**：绝不修改 Daily Report 目录下任何内容

### 非目标（YAGNI）

- 不做用户登录、权限、多租户
- 不做实时爬取/改写现有日报工作流（只消费其产物）
- 不做云端托管的 Agent（Agent 仅本机运行）
- 不做移动端 App
- 不做报告原文编辑/评论

---

## 2. 数据源分析（已实测）

| 层级 | 路径 | 数量 | 用途 |
|---|---|---|---|
| 精选洞察 | `output/<date>/daily_report.md` | **794 条**（774 条带视角前缀 + 20 条自由标题） | 主图谱 + 趋势分析（高质量） |
| 文章摘要 | `total/<date>/<分类>.md` | **15,192 篇** | 检索层 + 领域明细 |
| 扩展要点 | `output/<date>/<分类>_详细.md` | **399 篇** | 精选洞察的原文引用链接 |
| 原文正文 | `articles/<date>/<公众号>/` | 353 MB | 仅本机 Agent 深度检索，不发布 |
| 账号分类简报 | `summarization/<date>/<公众号>/classification.md` | 28 MB | P3 可选补充 |

**日期范围**：2026-04-29 → 2026-09-14，共 42 期。
**格式稳定性（已验证）**：
- 42 期 `daily_report.md` 全部含完全相同的 10 个 `## <分类>`；10 个分类在 `total/` 下的文件名也 42/42 完全一致
- `daily_report.md` 三级标题形如 `### 商业视角：<题>` / `### 学术/技术视角：<题>`，共 **774** 条；另有 **20** 条为自由标题（无视角前缀），解析器必须兜底
- 每期 `###` 条目数分布：27 期 = 20 条（完整）、11 期 = 18 条、2 期 = 16 条、1 期 = 14 条、1 期 = 10 条（即 15 期存在缺失视角，属正常，不视为错误）
- `total/*.md` 内含 `## 普通推文` 与 `## 📖 论文推荐` 两个板块，字段 `**标题**` / `**时间**` / `**总结**` 覆盖率 100%（15,192 / 15,192 / 15,192）

### 10 个分类与稳定 slug

| 分类名 | slug |
|---|---|
| AI推理加速优化技术 | `ai-inference-acceleration` |
| AI模型及Agent_RAG等技术 | `ai-model-agent-rag` |
| 大容量存储设备 | `high-capacity-storage` |
| 新介质 | `new-media` |
| 新存储设备语义_协议 | `storage-semantics-protocol` |
| 模型性能的测评分析 | `model-benchmarking` |
| 近存加速_存内计算 | `near-memory-computing` |
| 高可靠性存储 | `high-reliability-storage` |
| 高性价比存储技术 | `cost-effective-storage` |
| 其他 | `others` |

slug 映射表硬编码在 `pipeline/categories.py`，遇到未知分类名时回退为拼音/哈希 slug 并在构建日志中告警（保证新分类不致命）。

---

## 3. 架构与数据流

```
Daily Report（只读，绝不写入）
        │
        │  pipeline/  （Python 3 标准库，内容哈希缓存，幂等）
        ▼
  web/data/*.json（分片派生数据）  +  insight.sqlite（FTS5 全量索引）
        │                                    │
        ├──→ 静态站 web/（Vite + TS）        └──→ Agent 服务 agent/（Node 26，localhost:8787）
        │         │                                        ▲
        │         └──────── 运行时探测 /api/health ─────────┘
        ▼                                    （可用→启用问答；不可用→降级为纯检索）
   GitHub Pages
```

**核心决策**：`github.io` 上只发布**派生数据**（约 20 MB，Pages 有 gzip，实际传输约 5 MB，且按日期分片懒加载）；552 MB 原始语料永不发布，只被本机 Agent 用于深度检索。

### 语言与技术选型

| 组件 | 选型 | 理由 |
|---|---|---|
| pipeline | Python 3.14 标准库 | 零 pip 依赖，研究员可直接读懂和改 |
| 前端 | Vite + TypeScript + hash 路由 | 纯静态、GitHub Pages 友好、无 404 问题 |
| Agent | Node 26 标准库（`node:http`、`node:sqlite`） | 零 npm 依赖；已实测 `node:sqlite` FTS5 `trigram` 分词对中文检索有效 |
| LLM | DeepSeek API（复用波哥已有 key） | 复用现有额度；key 只存本机 `.env` |

---

## 4. 组件设计

### 4.1 解析层（`pipeline/`）

全部以只读模式打开文件，只写自己的输出目录。

| 模块 | 输入 | 输出 |
|---|---|---|
| `parse_digest.py` | `output/<date>/daily_report.md` | 794 条精选洞察（视角、题、正文） |
| `parse_articles.py` | `total/<date>/<分类>.md` | 15,192 篇文章（板块、标题、时间、总结） |
| `parse_detail.py` | `output/<date>/<分类>_详细.md` | 399 条扩展要点 + 原文链接 |
| `build_index.py` | 以上全部 + `articles/` 正文 | `insight.sqlite`（FTS5） |
| `build.py` | 编排以上，产出全部 web 数据 | `web/data/*` + `insight.sqlite` |

**健壮性要求**：
- 自由标题（无 `商业视角`/`学术/技术视角` 前缀）归入 `perspective="topic"`，不丢数据
- 分类缺某个视角时不报错，仅计数
- 单文件解析失败记入 `pipeline/build_report.json` 的 `warnings[]`，不中断整体构建
- 幂等：同一输入重复运行产出字节级一致（`generated_at` 除外）

### 4.2 数据契约（`web/data/`）

**`manifest.json`**
```json
{
  "generated_at": "2026-09-16T19:30:00+08:00",
  "source_dir": "/Users/boding/.openclaw/workspace/Daily Report",
  "report_count": 42, "article_count": 15192, "digest_count": 794, "detail_count": 399,
  "dates": ["2026-04-29", "..."],
  "categories": [
    {"key": "ai-inference-acceleration", "name": "AI推理加速优化技术",
     "article_count": 1186, "digest_count": 84, "first_seen": "2026-04-29", "last_seen": "2026-09-14"}
  ]
}
```

**各分类实测规模**（用于验证与 UI 排序）：

| 分类 | 文章数 | 洞察数 |
|---|---|---|
| 其他 | 6386 | 84 |
| AI模型及Agent_RAG等技术 | 5670 | 80 |
| AI推理加速优化技术 | 1186 | 84 |
| 模型性能的测评分析 | 807 | 80 |
| 大容量存储设备 | 281 | 80 |
| 新介质 | 231 | 80 |
| 近存加速_存内计算 | 218 | 82 |
| 新存储设备语义_协议 | 194 | 80 |
| 高性价比存储技术 | 149 | 80 |
| 高可靠性存储 | 70 | 64 |
| **合计** | **15192** | **794** |

> 注意：`其他` 占全部文章的 42%，内容异质。趋势/图谱页面须对 `其他` 单独标注，且不参与「领域热度排名」主榜，避免掩盖真实领域信号。

**`digests.json`**（单文件，794 条，体积小）
```json
[{
  "id": "2026-09-14|ai-inference-acceleration|business",
  "date": "2026-09-14",
  "category": "ai-inference-acceleration",
  "category_name": "AI推理加速优化技术",
  "perspective": "business|technical|topic",
  "topic": "算力转向Token生产逻辑",
  "text": "PEC 2026提出算力从…",
  "sources": [{"title": "…", "url": "https://…"}]
}]
```

**`articles/<date>.json`**（42 个分片，每片约 350–560 篇）
```json
[{
  "id": "2026-09-14|ai-inference-acceleration|0",
  "date": "2026-09-14",
  "category": "ai-inference-acceleration",
  "category_name": "AI推理加速优化技术",
  "section": "普通推文|论文推荐",
  "title": "…", "time_hint": "2天前", "summary": "…"
}]
```

**`articles.index.json`**：搜索用的轻量索引（id / date / category / section / title 短摘要），首屏即可用，正文分片按需加载。

**`timeline.json`**
```json
{"dates": ["2026-04-29", "…"],
 "series": [{"category": "ai-inference-acceleration", "counts": [12, 9, "…"]}]}
```

**`graph.json`**
```json
{"nodes": [
   {"id": "cat:ai-inference-acceleration", "label": "AI推理加速优化技术", "type": "category"},
   {"id": "ent:浪潮信息", "label": "浪潮信息", "type": "entity",
    "entity_type": "company|tech|product|metric|paper",
    "category": "high-reliability-storage", "mentions": 14,
    "first_seen": "2026-05-11", "last_seen": "2026-09-14", "weight": 3.5},
   {"id": "date:2026-09-14", "label": "2026-09-14", "type": "date"}
 ],
 "edges": [
   {"source": "ent:浪潮信息", "target": "cat:high-reliability-storage", "type": "belongs_to", "weight": 0.9},
   {"source": "ent:浪潮信息", "target": "date:2026-09-14", "type": "mentioned_on", "weight": 1.0},
   {"source": "ent:浪潮信息", "target": "ent:KV Cache", "type": "co_occurs", "weight": 5}
 ]}
```

**`trends.json`**
```json
{"generated_at": "…",
 "categories": [{"category": "…", "momentum": 0.42, "direction": "up|flat|down",
                 "business": 21, "technical": 21, "recent_share": 0.31}],
 "rising_entities":   [{"id": "…", "label": "…", "category": "…", "momentum": 1.8, "recent": 6, "baseline": 2.1}],
 "new_entities":      [{"id": "…", "label": "…", "first_seen": "2026-09-11"}],
 "fading_entities":   [{"id": "…", "label": "…", "momentum": -0.6}],
 "metrics": [{"key": "kv-cache-bytes-per-token", "label": "KV缓存单token占用",
              "unit": "B", "points": [{"date": "…", "value": 890}]}]
}
```

### 4.3 知识抽取与趋势分析

**实体抽取**：LLM（DeepSeek）对 794 条精选洞察逐条抽取实体与关系。
- **按内容 SHA-256 缓存**到 `pipeline/cache/entities/<hash>.json`，重复运行零成本、结果稳定
- 别名归一：`pipeline/aliases.json` 手工可维护（如 浪潮信息 / 浪潮 / Inspur → 同一节点）
- 抽取结果先落 `entities.raw.json`，再由确定性代码组装 `graph.json`，保证可复现

**趋势指标定义**（这是给 lab 同事的核心价值，全部在构建期算好）：

| 指标 | 定义 |
|---|---|
| 领域热度 | 每期每分类的文章数与精选洞察数 |
| 动量 momentum | 近 3 期均值 ÷ 前 12 期均值 − 1；> +0.3 为 `up`，< −0.3 为 `down`，否则 `flat` |
| 新兴实体 | `first_seen` 落在最近 3 期内的实体 |
| 退潮实体 | 前 12 期出现 ≥3 次、最近 3 期出现 0 次 |
| 商业/学术信号比 | 同分类下 `business` 与 `technical` 视角条目数之比 |
| 关键量化指标 | 正则抽取「数值 + 单位」（倍 / IOPS / GB/s / TOPS / W / μs / 美元 / 元 / %），由 LLM 归并成指标键；**仅保留 ≥3 个数据点的指标**，避免噪声 |

### 4.4 前端站点（`web/`）

**页面结构**

| 路由（hash） | 页面 | 内容 |
|---|---|---|
| `#/` | 概览 | 语料统计、10 领域卡片（含迷你动量曲线）、最新一期亮点 |
| `#/domain/:slug` | 领域（×10） | 趋势图、核心实体、精选洞察时间线、代表文章、新兴/退潮主题 |
| `#/graph` | 知识图谱 | 力导向交互图；按时间/分类/实体类型过滤；点节点 → 详情抽屉 |
| `#/trends` | 趋势跟踪 | 跨领域看板：上升实体、新进榜、减速主题、商业/学术信号分野、量化指标曲线 |
| `#/search` | 检索 | 全文检索 15,192 篇 + 794 条洞察；时间/分类/板块过滤；命中高亮 |
| `#/archive` `#/report/:date` | 归档 | 42 期报告，逐期浏览、可分享链接 |
| 全局侧栏 | Agent | 滑出对话面板 |

**视觉规范（清新学术风）**

| 项 | 值 |
|---|---|
| 标题字 | Noto Serif SC / Source Serif 4 |
| 正文字 | Noto Sans SC / Inter |
| 数字等宽 | JetBrains Mono / IBM Plex Mono |
| 浅色 | 纸白 `#FBFBF9`、墨 `#1F2933`、靛青 `#2F6F8F`、灰绿 `#5B8C6E`、陶土强调 `#B4633A`、细线 `#E3E3DE` |
| 深色 | 底 `#12161A`、字 `#E6E8E6`、线 `#2A3036`，主色降饱和 |
| 元素 | 细网格线、脚注式引用上标、大留白、1px 描边卡片、无重阴影/无渐变滥用 |
| 主题 | `auto / light / dark` 三态；默认跟随 `prefers-color-scheme`；选择持久化 localStorage；首屏内联脚本防闪烁（FOUC） |

**技术要点**
- **图表全部自绘 SVG**（sparkline、折线、堆叠面积、条形），零第三方图表依赖——便于完全跟随明暗主题与学术风配色
- 知识图谱的力导向布局引入 **`d3-force`** 作为前端唯一运行时依赖（算法成熟、体积小，约 30 KB）；渲染仍用自绘 SVG
- 图谱节点 > 800 时自动降级为「分类聚类视图」，避免浏览器卡顿
- 检索在 **Web Worker** 中执行，避免阻塞主线程；正文分片按需加载并缓存到 IndexedDB
- 响应式：≥1200px 三栏、768–1200px 两栏、<768px 单栏

### 4.5 Agent 服务（`agent/`，本机可选）

零 npm 依赖：`node:http` + `node:sqlite` + `fetch`。

| 端点 | 说明 |
|---|---|
| `GET /api/health` | `{ok, corpus:{articles,digests}, model}`——前端据此决定是否启用问答 |
| `GET /api/search?q=&category=&from=&to=&limit=` | FTS5 trigram 检索，返回带高亮片段的结果 |
| `POST /api/ask` | 请求 `{question, history[]}`；**SSE 流式**返回 `sources` → `delta*` → `done` |
| `GET /api/entity/:id?depth=` | 实体/领域详情：相关洞察、相关文章、时间分布 |
| `POST /api/deep` | `{category, topic, date}` → 针对某条洞察深挖（读原始 `articles/` 正文） |

**RAG 流程**：FTS5 检索（trigram，中文友好）→ 按分类/时间/recency 加权取 Top-K → 拼接上下文（超长则按会话压缩）→ 调 DeepSeek → **强制返回引用来源**（来源在 UI 中可点击跳转到归档/原文）。

**安全与隐私**
- API key 只存在本机 `.env`（`.gitignore` 已排除），绝不进仓库、绝不出现在前端
- 服务默认只绑 `127.0.0.1:8787`（不对外监听）
- CORS 白名单：`https://bogedaornot.github.io` + `http://localhost:*`
- 前端探测失败时**优雅降级**为纯检索模式，不弹错误、不影响静态功能

### 4.6 部署

- 用 `gh auth login` 授权后：创建仓库 → 开启 Pages（Source = GitHub Actions）→ 推送
- 仓库名：**`storage-ai-radar`**（可改），地址 `https://bogedaornot.github.io/storage-ai-radar/`
- Vite `base` 必须配成 `/storage-ai-radar/`（否则子路径下资源 404）
- `.github/workflows/deploy.yml`：push 到 `main` → `pnpm install` → `pnpm build` → `upload-pages-artifact` → `deploy-pages`
- **CI 不解析语料**（语料只在波哥本机、CI 取不到）：派生数据随仓库提交，CI 只做构建与部署
- `.gitignore`：`.env`、`node_modules/`、`dist/`、`pipeline/cache/`、`insight.sqlite`

> ⚠️ **待确认（见第 8 节）**：免费版 GitHub Pages 要求仓库为 **public**，即派生数据（15,192 篇文章标题+AI 摘要）会公开可读。需波哥确认。

### 4.7 只读保证与测试

**只读保证（硬需求）**
- 所有解析器以 `open(..., "r", encoding="utf-8")` 只读打开；代码中不得出现对 `DAILY_REPORT_DIR` 的写操作
- `pipeline/verify_readonly.py`：递归计算 Daily Report 下每个文件的 `(相对路径, size, mtime_ns, sha256)` 清单；全量构建前后各算一次，断言完全一致
- 该断言作为测试用例固化，并在交付时**实际跑一次给波哥看**

**测试策略**（`unittest`，标准库）

| 用例 | 断言 |
|---|---|
| 解析计数 | 42 期、10 分类、15,192 篇、794 条洞察（允许 ±0，若有告警则显式列出） |
| 字段覆盖 | 每篇文章必有 title/date/category/summary，无空字符串 |
| slug 完整 | 10 个分类全部有 slug，无重复，无回退告警 |
| 边界 | 自由标题归入 `perspective="topic"`；缺失视角不报错 |
| 幂等 | 连续两次构建产出除 `generated_at` 外字节一致 |
| 只读 | 构建前后哈希清单一致 |
| 契约 | 所有 `web/data/*.json` 通过 JSON Schema 形状校验（字段存在且类型正确） |

---

## 5. 目录结构

```
storage-ai-radar/
├── docs/superpowers/specs/2026-09-16-lab-insight-radar-design.md
├── pipeline/
│   ├── categories.py          # 分类与 slug 映射
│   ├── parse_digest.py
│   ├── parse_articles.py
│   ├── parse_detail.py
│   ├── extract_entities.py    # LLM 抽取 + 哈希缓存
│   ├── analyze_trends.py
│   ├── build_index.py         # SQLite FTS5
│   ├── build.py               # 编排入口
│   ├── verify_readonly.py
│   ├── aliases.json
│   └── cache/                 # gitignored
├── web/
│   ├── index.html
│   ├── src/{styles,pages,components,lib}/
│   ├── public/
│   └── data/                  # 构建产物，随仓库提交
├── agent/
│   ├── server.mjs
│   ├── rag.mjs
│   ├── .env.example
│   └── README.md
├── tests/
├── .github/workflows/deploy.yml
├── .gitignore
└── README.md
```

---

## 6. 分阶段交付

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P1** | 解析层 + 数据契约 + 站点核心（概览/领域/检索/归档）+ 明暗主题 + 部署上线 | github.io 可访问，能检索 15,192 篇，只读断言通过 |
| **P2** | 实体抽取（LLM+缓存）+ 知识图谱页 + 趋势跟踪页 | 图谱可交互，趋势页给出上升/新兴/退潮实体与量化指标 |
| **P3** | Agent 服务（FTS5 RAG + SSE + 引用）+ 站点侧栏与降级 | 本机问答可用且带引用；Agent 未启动时站点功能不受影响 |

**实现计划拆分**：三个阶段共用一个 spec，但**各自产出独立的实现计划并分阶段验收**——先完成 P1（可上线、可检索），再 P2（图谱+趋势），最后 P3（Agent）。这样每个阶段结束时都是一个可用的产品，而不是半成品。

**每个阶段的完成定义（DoD）**：
1. 对应测试全部通过（含只读断言）
2. 本地以 `/storage-ai-radar/` 子路径构建并预览无 404
3. 已推送到 GitHub 且 Pages 部署成功
4. 向波哥演示该阶段的实际功能

---

## 7. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 派生数据体积过大 | 首屏慢 | 按日期分片 + 懒加载 + gzip；首屏仅加载 manifest/timeline/index |
| LLM 抽取成本/不稳定 | P2 变慢 | 内容哈希缓存，只跑 794 条精选层；抽取失败可降级为规则抽取 |
| 分类名未来变化 | 构建失败 | slug 映射带未知回退 + 告警，不中断 |
| Pages 子路径 | 资源 404 | Vite `base` 固定为 `/storage-ai-radar/`，构建后本地用子路径预览验证 |
| 仓库可见性 | 数据公开 / Pages 不可用 | 见第 8 节，需先决策 |
| 原始语料不可被 CI 访问 | CI 无法构建 | 派生数据随仓库提交，CI 只构建前端 |

---

## 8. 待确认事项

1. **仓库可见性**：免费 GitHub Pages 要求 **public** 仓库，意味着 15,192 篇文章标题 + AI 摘要、以及全部精选洞察会**公开可读**。请确认：
   - (a) 用 **public** 仓库（免费 Pages，数据公开）
   - (b) 用 **private** 仓库（需 GitHub Pro/Team 才有 Pages；若无则需另择托管）
2. **仓库名**：默认 `storage-ai-radar`，可改。
3. **P2 实体抽取**：同意调用 DeepSeek 跑 794 条（有缓存，首次约数百次请求）？若希望零成本，可先只做规则抽取。
