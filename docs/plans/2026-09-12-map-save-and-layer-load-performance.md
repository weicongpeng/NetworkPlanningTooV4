# 2026-09-12 地图工具性能优化：图层保存 / 图层读取

## 目的

编辑态"图层文件"属性弹窗改字段值后点保存很慢；同时打开/勾选大图层也慢。本次从**保存链路**与**读取链路**两侧消除浪费。

## 根因（第一性原理）

| # | 问题 | 位置 | 代价（道路中心线 16k 线 / 86 万节点 / 39.8MB GeoJSON） |
|---|---|---|---|
| 1 | 保存时逐点 Python 递归做 GCJ02→WGS84，再用 `shapely.shape()` 逐要素建几何 | `layer_edit_service.save_layer_geojson` | ~8.5s |
| 2 | 读取时逐点递归转换 + `json.dump(..., ensure_ascii=False)` 回退**纯 Python JSON 编码器** + 流式 gzip（1620 次 compress） | `mapinfo_service.get_layer_data` | 冷读合计 ~29.6s |
| 3 | 改 1 个字段仍整层回传（40MB/gzip 10MB）并重建全层几何 | 前端 `saveSelectedToStore` + 保存端点 | 前端 stringify 3.0s + gzip 1.7s + 上传 + 后端 json.loads ~0.5s |
| 4 | 保存成功后全量失效缓存 + 重载扇区数据/重绘 + **重新下载刚保存的整层** | `MapPage` / `mapDataCacheStore` / `OnlineMap.refreshLayerData` | 保存后地图卡顿数秒 |
| 5 | 图层数据端点 ETag 读 `.cache/<id>.mtime`，实际写在 `.cache/v2/<id>.mtime` → ETag 永远为空 | `api/v1/endpoints/data.py` | 每次刷新都整层重下（304 从未生效） |
| 6 | `_read_tab_gdf` 优先 `encoding='gbk'`，项目写出的 TAB 其 .dat 是 UTF-8 → 中文列名**静默变乱码** | `layer_edit_service` | 保存时按乱码列名对齐，会把属性写进垃圾列 |
| 7 | `write_mapinfo_tab` 的中文列名恢复把几何列也算进占位符 → 几何列不在最后时列名整体错位一格 | `tab_io` | 样式列被写成 `geometry` 列 |

## 方案

1. **批量几何/坐标处理**（新增 `app/utils/geojson_geometry.py`）：
   - `build_geometries`：几何整层一次 numpy 数组化 → 一次向量化转换 → shapely 数组构造器；z 值/未知类型回退通用路径
   - `transform_coordinate_lists`：嵌套坐标批量转换（数组化 + `tolist()`），供读取链路复用
2. **保存链路**接入批量构建；抽出 `_write_layer_gdf` 作为"原子写 + 校验 + 元数据 + 缓存失效"共用收尾。
3. **增量保存**（新增 `app/services/layer_patch_service.py` + 端点 `patch` 分支）：
   ```
   PUT /data/{data_id}/layers/{layer_id}/data
   { "patch": { "base": { "count": N, "version": "<ETag>" },
                "upserts": [{ "row": i|null, "geometry": {...}, "properties": {...} }],
                "deletes": [row, ...] } }
   ```
   - 基底读现有 TAB（WGS84），仅对变更要素逆转换 + 建几何
   - `base.count` / `base.version`（源文件 mtime 指纹）不符 → **409**，前端自动回退整层保存，改动不丢
   - 写盘/元数据/缓存失效复用 `_write_layer_gdf`；响应带 `mode` 与新的 `version`
4. **前端保存计划**（`layerEditStore.buildSavePlan`）：工作集记录基底行号 `baseRows`、变更集 `changedIds`、版本指纹；能增量则只回传变更（新增 `row=null`，删除按基底行号），否则整层；无有效变更（画了又删）→ `mode='none'` 不写盘。
5. **保存后刷新瘦身**：`triggerDataRefresh('layer')` 范围化事件（地图页跳过扇区数据重载/重绘，缓存不全量失效）；`refreshLayerData(layerId, {data, version})` 用编辑工作集直接重建图层（不再下载整层）。
6. **读取链路**：transform 走数组化；缓存写盘改 `json.dumps`（C 编码器）+ 一次性 `gzip.compress`（gz 内容用字节拼接构造，省一次 40MB 序列化）。
7. **缓存目录/版本指纹统一**：`mapinfo_service.layer_cache_dir` / `layer_version_etag`，端点与保存接口共用 → ETag 与保存返回的 `version` 同构（修复 #5）。
8. **编码与列名修复**：`_read_tab_gdf` 默认编码优先、GBK 回退（#6）；`write_mapinfo_tab` 占位符只覆盖属性列（#7）。

## 验证

- 后端 `pytest`：**358 passed**（新增 `test_geojson_geometry.py` 14 项、`test_layer_patch_service.py` 9 项、端点增量/409/版本链路 3 项）
- 前端 `vitest`：`layerEditSavePlan.test.ts` 8 项通过（另有 2 个与本次无关的历史失败：`sector-config`、`mapDataService`）
- 几何等价性：4 个真实图层（线/面/点，48k 要素、150 万顶点）新旧路径几何**逐要素严格相等**（`equals_exact` 0 误差）
- 写盘等价性：真实 16k 图层新旧保存路径 .map 字节级相同、属性 md5 相同
- 增量保存验收（真实 18903 面图层，临时副本）：只改一行的增量保存 **4.2s**（其中 GDAL 整层重写约 3.6s）且仅目标行变化、其余行与列序不变；整层保存 16.7s；几何更新+新增+删除 1.0s；冲突正确拦截
- 实测提速：保存（后端）2–3x（道路中心线 12.3s→4.0s）；冷读 29.6s→10.1s

## 影响与风险

- 增量保存依赖"工作集数组顺序 == 文件行序"：前端每次保存后按当前顺序重排基底行号；服务端返回要素数与工作集不符（几何不符被跳过）时清空基底，下次自动整层保存
- 冲突（他人/其它标签页已保存）→ 409 → 自动整层保存，语义与改动前一致
- 仅后端 + 前端代码变更，无数据迁移；生效需重启后端并重新构建前端

## 遗留（本次未处理）

- `tests/conftest.py` 未隔离 SQLite，跑测试会往生产 `data/data.db` 写 `layers` 行（建议后续修）
- GDAL MITAB 整层重写（大图层 3–6s）是格式决定的下限；如需更快只能换存储格式
- 保存后仍会重建一次 Leaflet 图层（内存数据），大图层约 1–3s 主线程
