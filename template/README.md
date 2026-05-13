# Template 文件夹说明

本文件夹用于存放 Excel 模板文件，用户可下载这些模板作为参考。

## 模板文件说明

### 1. 全量工参模板

**文件命名规则：** `ProjectParameter_mongoose*.xlsx` 或 `ProjectParameter_mongoose*.xls`

**说明：**
- 这是全量工参数据的模板文件
- 包含 LTE 和 NR 两个 Sheet 页
- LTE Sheet: "LTE Project Parameters"
- NR Sheet: "NR Project Parameters"
- 用于导入全量基站和小区工参数据

**字段示例：**
- 基站信息：基站ID、基站名称、经度、纬度
- 小区信息：小区ID、小区名称、方位角、挂高、PCI、频点等
- 网络类型：LTE 或 NR
- 可选字段：TAC、是否共享、第一分组、小区覆盖类型等

### 2. 待规划小区模板

**文件命名规则：** `cell-tree-export*.xlsx` 或 `cell-tree-export*.xls`

**说明：**
- 这是待规划小区清单的模板文件
- 包含 LTE 和 NR 两个 Sheet 页
- LTE Sheet: "LTE"
- NR Sheet: "NR"
- 用于导入待规划的小区列表，系统将根据经纬度匹配 TAC 图层并分配 TAC 编号

**字段示例：**
- 基站信息：eNodeB ID/gNodeB ID（站点ID）
- 小区信息：Cell ID（小区标识）
- 必须包含：站点ID和小区ID字段
- 可选：小区名称等其他描述性字段

## 使用说明

### 上传模板文件

1. **手动放置模板文件**
   - 将模板文件直接放入本文件夹（template 目录）
   - 确保文件命名符合上述规则
   - 文件必须包含所有必需的 Sheet 页和字段

2. **下载模板**
   - 在"数据管理"页面，点击对应上传框右侧的"模板下载"按钮
   - 全量工参模板：下载 `ProjectParameter_mongoose*.xlsx`
   - 待规划小区模板：下载 `cell-tree-export*.xlsx`
   - 下载后可作为参考或直接上传使用

### 注意事项

1. **文件格式要求**
   - 必须是 Excel 格式（.xlsx 或 .xls）
   - Sheet 名称必须完全匹配（区分大小写）
   - 第一行必须是中文字段名

2. **必需字段**
   - **全量工参**：必须包含基站ID、基站名称、经度、纬度、小区ID、小区名称等关键字段
   - **待规划小区**：必须包含站点ID和小区ID字段

3. **数据完整性**
   - 确保所有必需字段都有值
   - 经纬度字段必须是有效的数字格式
   - 避免空行或无效数据

4. **编码问题**
   - 文件名使用 UTF-8 编码
   - 避免文件名包含特殊字符

## 技术实现

### 前端实现

- **模板下载按钮**：在 DataPage.tsx 中为"全量工参"和"待规划小区"添加模板下载按钮
- **API 调用**：通过 `/api/v1/data/template/{template_type}` 接口下载模板
- **类型参数**：`full_params`（全量工参）或 `target_cells`（待规划小区）

### 后端实现

- **API 端点**：`GET /api/v1/data/template/{template_type}`
- **模板目录**：`template` 文件夹，在项目根目录下
- **文件查找逻辑**：
  - `full_params` 类型：查找前缀为 `ProjectParameter_mongoose` 的文件
  - `target_cells` 类型：查找前缀为 `cell-tree-export` 的文件
- **文件编码**：支持 RFC 5987 标准的中文文件名编码

## 常见问题

### Q1: 点击"模板下载"提示"模板目录不存在"
**A:** 请先上传对应的模板文件到 `template` 文件夹，确保文件命名正确。

### Q2: 下载的文件名显示为乱码
**A:** 确保浏览器支持 UTF-8 编码，现代浏览器应该都能正常显示中文文件名。

### Q3: 模板文件上传后找不到对应的 Sheet
**A:** 检查 Sheet 名称是否完全匹配（区分大小写），例如：
   - LTE 全量工参：`LTE Project Parameters`
   - NR 全量工参：`NR Project Parameters`
   - LTE 待规划小区：`LTE`
   - NR 待规划小区：`NR`

### Q4: 模板中包含很多可选字段，哪些是必需的？
**A:**
   - **全量工参必需字段**：基站ID、基站名称、经度、纬度、小区ID、小区名称、方位角、挂高、PCI、频点
   - **待规划小区必需字段**：站点ID（eNodeB ID/gNodeB ID）、小区标识（Cell ID）

## 更新日志

### v1.0.0 (2026-01-16)
- 初始版本
- 支持全量工参和待规划小区模板下载
- 添加模板下载按钮到数据管理页面
- 完善模板文件说明文档
