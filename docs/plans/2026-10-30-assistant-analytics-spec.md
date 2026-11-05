# 网优助手：智能搜索与智能分析的七份规范（2026-10-30）

本文件是「网优助手」从固定工具集升级为**可审计的智能搜索 + 智能分析**的规范基线。
代码实现位于 `backend/app/services/assistant/`，任何改动违反以下规范都应视为缺陷。

## 0. 为什么需要规范

旧实现把每个问题写成一段固定 SQL 工具，并且对**所有**指标一律 `avg()` 按天聚合：
掉线率被"平均率"、次数被"平均量"，数学上错误；模型也拿不到真实字段清单，只能猜列名。
规范的目标是：**数字可核对、口径可追溯、越权不可能**。

## 1. 指标口径注册表（`semantic/builtin_metrics.json` + `data/metric_registry.json`）

字段：

| 字段 | 说明 |
|---|---|
| `metric_id` | 口径唯一标识（如 `call_drop_rate`） |
| `name` / `aliases` | 中文名与别名（列名 `掉线率(%)` 也能解析） |
| `unit` | `percent` / `MB` / `count` / … |
| `direction` | `higher_better` / `lower_better` / `none` |
| `aggregation` | `ratio` / `sum` / `avg` / `max` |
| `numerator` / `denominator` | **仅 ratio**，指向分子/分母的 `metric_id` |
| `granularities` / `source` | 可用粒度；口径出处（3GPP TS 28.552 或省公司 KPI 口径文件） |

硬规则：

1. **比率类必须存分子分母**，跨行聚合一律"分子分别求和 / 分母分别求和"；禁止 `avg(比率)`。
2. 数据里缺分子或分母时，允许降级为区间均值，但必须在 `provenance.degraded` 与回答里
   **显式说明**"该口径无法精确聚合，仅供趋势参考"——不允许静默用错口径。
3. 用户覆盖文件 `data/metric_registry.json` 优先于内置；改口径不需要改代码。
4. 每条口径必须有 `source`，否则 `test_builtin_registry_entries_are_well_formed` 失败。

当前内置：掉线率、接通率、RRC 建立请求/成功/异常释放次数、流量、PRB 利用率。

## 2. 数据目录 Catalog（`catalog.py` + `semantic/profile.py`）

- 入库时对每列做画像（`Workbook.metadata_json["columns"]`）：`role(metric/dimension/other)`、
  `type`、`coverage`、`distinct`、`samples`、数值列 `min/max`。超过 5000 行只采样并标 `sampled`。
- 查询期 `build_catalog(user)` 汇总：指标行数/小区数/时间覆盖/粒度/真实指标列名、
  全量工参规模/制式/TAC 数/频点范围、参数数据集动态键、三个数据集的字段白名单。
- `render_prompt(catalog)` 压成短文本注入 system prompt —— **模型只看目录，不猜列名**。
- 目录同样受 (city, operator) 组隔离约束。

## 3. QueryPlan DSL（`query_plan.py`）

模型唯一被允许产出的"查询语言"（JSON）：`dataset / metrics[] / dimensions[] / filters[] /
time_range / order_by / limit / chart`。校验规则见 `validate_plan()`：

- `dataset ∈ {metrics, sectors, params}`；`dataset=metrics` 必须给 `metrics`；
- `metrics ≤ 6`、`dimensions ≤ 3`、`filters ≤ 10`、`limit ≤ 5000`（超出直接夹紧）；
- 维度/过滤字段必须能被 `semantic/field_catalog.py` 解析（含中文别名），否则返回
  "字段不在可用字段内 + 可用字段清单"，**不做模糊猜测**；
- 不合法即 `PlanError`，错误消息原样回灌模型，让它自己改。

## 4. 编译器（`compiler.py`）

QueryPlan → 参数化 SQL，四条硬约束统一收口：

1. **字段白名单**：只有 `field_catalog` 里的字段能进 SQL；所有取值走命名参数绑定。
2. **数据组隔离**：强制 `m/s/p.city = ? AND operator = ?`；用户组缺失直接拒绝（不是返回空）。
3. **强制 LIMIT**（≤5000）与只读执行（`executor.py`：`mode=ro` + `PRAGMA query_only=1` +
   `set_progress_handler` 超时中断）。
4. **口径正确**：ratio 走分子分母 `CASE WHEN metric_id=…` 双 SUM；其余按 `sum/avg/max`；
   `percent` 口径 ×100 输出百分数；默认排序——有时间维度按时间正序，否则按度量值倒序。

跨表关联：`metrics` 数据集按需 `LEFT JOIN` 一个按 `name` 去重的扇区 CTE
（`ROW_NUMBER() OVER (PARTITION BY name ORDER BY id)`）再 `LEFT JOIN sites`，
避免双 PLMN 共享小区同名导致 SUM 翻倍。

## 5. 图表规格（`chart_spec.py`）

受控声明式规格：`type(line|bar|stacked_bar|heatmap|big_number)` + `x/y/series/values/note`。
选型由结果形状决定（无维度→单值卡；1 维→柱/线；时间×类别→多序列折线；显式 heatmap→热力格；
2 个类别维度→分组柱）。**模型只能选图型，不能造数据点**。

前端：`services/echartsLoader.ts` 从 CDN 懒加载 ECharts（不进主包），加载失败降级到内联 SVG；
`pages/assistant/Charts.tsx` 渲染，`pages/AssistantPage.tsx` 组织"结论 / 图表 / 明细表 / 取数配方"。

## 6. 取数配方 Provenance（`provenance.py`）

每轮回答必须给出：`dataset_label`、`metrics[].aggregation/unit/direction/source`、
`dimensions`、`filters`、`time_range`、`granularity`、`limit`、`row_count`、`elapsed_ms`、
`degraded`。前端可展开核对，回答末尾由模型转述一句 `recipe`。

## 7. 评测集与验收（`backend/tests/test_assistant_*.py`）

- `test_assistant_metric_registry.py`：口径解析、分子分母、覆盖优先级。
- `test_assistant_plan_compiler.py`：白名单拒绝、组过滤、LIMIT、参数绑定、比率编译、降级。
- `test_assistant_analyze.py`：数值正确性（含 Decimal 双实现交叉复算，容差 1e-9）、
  TopN、趋势时序、跨表对比、组隔离 0 命中、图表与明细同源、golden 回归集。
- `test_assistant_ingest.py`：入库解析 metric_id、列画像、目录、跨组删除被拒、入库→分析全链路。

验收命令：

```bash
cd backend && .venv/bin/python -m pytest tests/test_assistant_*.py -q
cd frontend && npm run build:vite
```

## 8. 明确不做

- 不让模型生成 SQL 文本；不做文档 RAG；不做"AI 洞察"式无出处长文；
- 不做用户自定义公式；不引预聚合表（除非性能基准证明必要）；
- 不新建 profile 表（复用 `Workbook.metadata_json`）。

## 9. 已知边界

- 指标时间只有天粒度时，"忙时"相关问题只能按 `granularity=busy_hour` 过滤已有数据。
- `params` 数据集当前只支持 `cell_name/site_id/cell_id/network_type` 维度；参数键查询走 `get_cell_params`。
- 比率降级路径（缺分子分母）只能看趋势，不可作为考核口径。
