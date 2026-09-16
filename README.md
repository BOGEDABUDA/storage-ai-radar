# Lab Insight Radar · 领域洞察雷达

把 OpenClaw 日报语料（存储 / AI 基础设施，42 期，2026-04-29 → 2026-09-14）变成**可浏览、可检索、可看趋势**的知识库，并发布到 GitHub Pages。

线上地址：https://bogedabuda.github.io/storage-ai-radar/

## 三条硬约束

1. **只读**：绝不修改 `Daily Report` 目录下任何内容 —— 构建前后对 26,680 个文件做 SHA-256 清单比对断言
2. **静态优先**：GitHub Pages 只托管派生数据（约 26 MB，gzip 后约 6 MB），353 MB 原始正文永不发布
3. **可降级**：Agent 仅本机运行；未启动时站点自动降级为纯检索模式，功能不受影响

## 快速开始

```bash
./rebuild.sh          # 快照校验 → 解析语料 → 再校验 → 构建前端
cd web && pnpm preview  # 本地预览 http://localhost:4173/storage-ai-radar/
```

## 分阶段交付

| 阶段 | 内容 | 状态 |
|---|---|---|
| **P1** | 解析层 + 数据契约 + 站点核心（概览/领域/检索/归档）+ 明暗三态主题 + GitHub Pages 部署 | ✅ 已完成 |
| **P2** | 实体抽取（DeepSeek + 增量缓存）+ 知识图谱 + 趋势跟踪 | ✅ 已完成 |
| **P3** | Agent 服务（FTS5 中文 RAG + 流式问答 + 引用）+ 站点侧栏 | 待实现 |

## P2：知识图谱与趋势（实测结果）

| 指标 | 数值 |
|---|---|
| 抽取实体 | 1,685 个（来自 794 条洞察，0 失败） |
| 入图实体 | 493 个（提及 ≥ 2 次） |
| 关系边 | 1,429 条（共现 947 + 领域归属 482） |
| 关键指标序列 | 8 条（同主体 + 同指标 ≥ 3 个观测点） |
| 上升 / 新兴 / 退潮实体 | 29 / 12 / 1 |

**趋势指标定义**
- 动量 =（近 3 期均值 − 前 12 期基线）/ 基线；> +0.3 升温，< −0.3 降温
- 新兴实体 = 首次出现落在最近 3 期且提及 ≥ 2
- 退潮实体 = 基线 ≥ 3 次但最近 3 期 0 次

### P2 相对设计文档的三处修正（都是为了避免误导性结论）

1. **量化指标必须绑定主体**。原设计只按指标名归并，结果把不同主体的数值混成假趋势线
   （例如「模型参数量 4000→284 B」「毛利率 6.85→84.8%」）。现改为按 `(主体, 指标)` 成组出序列，
   并另外提供「指标名级观测清单」供查证具体数值。
2. **分类级「商业/学术」对比没有信息量**。日报模板对每个分类固定产出 1 条商业 + 1 条学术，
   所以各分类恒为 39/39、41/41。现改为**实体级视角倾向**（同一实体出现在哪种视角），
   这才有区分度：例如 `eSSD` 商业 10 / 学术 0（产业驱动），`H100` 商业 0 / 学术 6（实验室阶段）。
3. **去掉 `evolves`（演进）边**。该关系无法从语料可靠推导，强行生成会引入臆测，故不实现；
   实体与洞察的关联改为记录在节点 `digests` 字段上（避免 4,800+ 条低价值边）。

另：实体抽取结果存为**单个提交进仓库的 `pipeline/entities.json`**（而非 gitignore 的按哈希分片缓存），
这样图谱构建可离线复现，也让抽取结果可被 review。文本变化时按内容 SHA-256 自动重抽。


## 语料规模（实测）

| 指标 | 数值 |
|---|---|
| 报告期数 | 42（2026-04-29 → 2026-09-14） |
| 文章摘要 | 15,192 篇 |
| 精选洞察 | 794 条（774 条带视角 + 20 条自由标题） |
| 详细要点 | 798 条（原文引用覆盖 794/794） |
| 研究方向 | 10 个 |

### 两处真实数据稀疏（非解析缺陷）

- 12/42 期存在「分类为 0 篇」（分类文件只有标题行）；最稀疏的 `2026-05-15` 仅 22 篇、覆盖 5 个分类
- 32 篇文章的「总结」在源数据中即为空（多为招聘/汽车等非科技内容）

站点按**真实 0** 呈现，不做插值填补。

## 目录结构

```
pipeline/   只读解析语料（Python 标准库，零 pip 依赖）
  categories.py       分类 ↔ slug 映射
  parse_digest.py     output/*/daily_report.md  → 精选洞察
  parse_articles.py   total/*/*.md             → 文章摘要
  parse_detail.py     output/*/*_详细.md        → 原文来源链接
  extract_entities.py LLM 实体/指标抽取（增量、按内容哈希）
  analyze_trends.py   图谱与趋势的确定性计算
  aliases.json        实体别名归一表（可手工扩充）
  entities.json       抽取结果（提交进仓库，可离线复现）
  build.py            编排入口：python3 -m pipeline.build
  readonly_guard.py   只读保证：快照 / 校验
  paths.py            路径与写入门禁（拒绝写入数据源）
web/        Vite + TypeScript 静态站（唯一运行时依赖 d3-force，图表自绘 SVG）
  public/data/        派生数据（随仓库提交，CI 直接用）
  src/search/         全文检索 Web Worker（中文子串匹配 + AND 语义）
agent/      Node 零依赖 Agent 服务（P3）
tests/      unittest（17 项：契约/边界/幂等/只读）
```

## 常用命令

```bash
python3 -m pipeline.build              # 重新生成派生数据
python3 -m pipeline.readonly_guard verify   # 校验语料未被改动
python3 -m unittest discover -s tests -t .  # 跑测试
cd web && pnpm run build               # 前端构建
```

## 数据源

`/Users/boding/.openclaw/workspace/Daily Report`（可用 `DAILY_REPORT_DIR` 环境变量覆盖）

## 配置

前端子路径固定在 `web/vite.config.ts` 的 `base: '/storage-ai-radar/'`，与仓库名一致；改名时两处都要改。

## 文档

- 设计文档：[`docs/superpowers/specs/2026-09-16-lab-insight-radar-design.md`](docs/superpowers/specs/2026-09-16-lab-insight-radar-design.md)
