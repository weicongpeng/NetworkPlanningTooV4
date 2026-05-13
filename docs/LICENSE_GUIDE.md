# License授权系统使用指南

## 概述

本系统采用基于硬件指纹的License授权机制，提供安全可靠的软件授权管理。系统支持：

- **硬件指纹绑定**：License与特定机器绑定，防止随意复制
- **RSA数字签名**：使用非对称加密确保License不可伪造
- **功能权限控制**：可精细控制各功能模块的访问权限
- **时间限制**：支持设置License有效期
- **在线激活**：通过激活码方式完成License激活

## 架构说明

### 核心组件

1. **硬件指纹获取器** (`backend/app/utils/hardware_fingerprint.py`)
   - 收集CPU、MAC地址、磁盘ID等硬件信息
   - 生成唯一的SHA256哈希作为机器标识

2. **License服务** (`backend/app/services/license_service.py`)
   - License验证与激活
   - 硬件指纹匹配检查
   - RSA签名验证
   - 功能权限检查

3. **License生成工具** (`tools/license_generator.py`)
   - 独立的License生成工具
   - 支持自定义参数
   - 命令行和编程接口

4. **前端激活界面** (`frontend/src/renderer/pages/LicensePage.tsx`)
   - 硬件指纹显示与复制
   - License激活码输入
   - 状态显示与错误提示

## 快速开始

### 1. 用户端获取硬件指纹

1. 启动应用，进入"配置管理"页面
2. 找到"硬件指纹"部分
3. 点击"复制"按钮获取指纹

### 2. 管理员端生成License

使用命令行工具生成License：

```bash
# 基本用法
python tools/license_generator.py \
  --generate \
  --licensee "公司名称" \
  --fingerprint "用户的硬件指纹" \
  --days 365

# 完整参数
python tools/license_generator.py \
  --generate \
  --licensee "某某科技有限公司" \
  --fingerprint "a1b2c3d4e5f6..." \
  --days 365 \
  --features pci_planning,neighbor_planning,map_viewing \
  --max-seats 1 \
  --output license.lic
```

### 3. 用户端激活License

1. 用户收到激活码后，在"配置管理"页面
2. 将激活码粘贴到"许可证激活码"输入框
3. 点击"激活许可证"按钮

## 命令行工具详细说明

### 生成License

```bash
python tools/license_generator.py --generate [参数]
```

**必需参数：**
- `--licensee TEXT`: 许可证持有人/公司名称
- `--fingerprint TEXT`: 目标机器的硬件指纹

**可选参数：**
- `--days INT`: 有效期（天），默认365天
- `--features TEXT`: 启用功能，逗号分隔（默认全部）
- `--max-seats INT`: 最大许可数，默认1
- `--note TEXT`: 备注信息
- `--output PATH`: 输出文件路径（不指定则打印到控制台）

**示例：**

```bash
# 生成1年有效期的全功能License
python tools/license_generator.py --generate \
  --licensee "测试公司" \
  --fingerprint "abc123def456..."

# 生成90天有效期的部分功能License
python tools/license_generator.py --generate \
  --licensee "测试公司" \
  --fingerprint "abc123def456..." \
  --days 90 \
  --features pci_planning,neighbor_planning

# 生成并保存到文件
python tools/license_generator.py --generate \
  --licensee "测试公司" \
  --fingerprint "abc123def456..." \
  --days 365 \
  --output license.lic
```

### 解码License

```bash
python tools/license_generator.py --decode BASE64_STRING
```

**示例：**

```bash
python tools/license_generator.py --decode "eyJ2ZXJzaW9uI..."
```

### 验证License格式

```bash
python tools/license_generator.py --validate BASE64_STRING
```

**示例：**

```bash
python tools/license_generator.py --validate "eyJ2ZXJzaW9uI..."
```

## 可用功能列表

| 功能代码 | 功能名称 | 描述 |
|---------|---------|------|
| `pci_planning` | PCI规划 | PCI规划功能 |
| `neighbor_planning` | 邻区规划 | 邻区规划功能 |
| `map_viewing` | 地图查看 | 地图查看功能 |
| `data_management` | 数据管理 | 数据管理功能 |
| `export` | 数据导出 | 数据导出功能 |
| `advanced_analytics` | 高级分析 | 高级分析功能 |

## API接口

### 获取License状态

```http
GET /api/v1/license/status
```

**响应：**

```json
{
  "success": true,
  "data": {
    "valid": true,
    "expiryDate": "2026-01-15T00:00:00",
    "licensee": "某某科技有限公司",
    "licenseKey": "eyJ2ZXJzaW9uI...",
    "features": ["pci_planning", "neighbor_planning"],
    "version": "2.0",
    "errorMessage": null,
    "remainingDays": 365
  }
}
```

### 激活License

```http
POST /api/v1/license/activate
Content-Type: application/json

{
  "license_key": "eyJ2ZXJzaW9uI..."
}
```

**响应：**

```json
{
  "success": true,
  "message": "许可证激活成功"
}
```

### 获取硬件指纹

```http
GET /api/v1/license/fingerprint
```

**响应：**

```json
{
  "success": true,
  "data": {
    "fingerprint": "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0",
    "note": "请将此硬件指纹发送给许可证管理员以获取激活码"
  }
}
```

### 获取可用功能

```http
GET /api/v1/license/features
```

**响应：**

```json
{
  "success": true,
  "data": {
    "pci_planning": "PCI规划",
    "neighbor_planning": "邻区规划",
    "map_viewing": "地图查看",
    "data_management": "数据管理",
    "export": "数据导出",
    "advanced_analytics": "高级分析"
  }
}
```

## 安全性说明

### 硬件指纹安全性

- 使用多个硬件特征组合生成
- SHA256哈希确保唯一性和不可逆性
- 不收集敏感信息（如具体硬件型号、序列号等）

### License签名验证

- 使用2048位RSA密钥对
- PSS填充方案
- SHA256哈希算法
- 防止License伪造和篡改

### 数据加密

- License文件使用Fernet对称加密存储
- PBKDF2密钥派生函数（100,000次迭代）
- 防止License文件被直接读取或篡改

## 故障排除

### License激活失败

**错误信息：** "许可证与当前硬件不匹配"

**解决方案：**
- 确认硬件指纹是否正确
- 确认License是为当前机器生成的

**错误信息：** "许可证已过期"

**解决方案：**
- 检查License有效期
- 联系管理员续期

**错误信息：** "许可证签名验证失败"

**解决方案：**
- 确认激活码完整且未损坏
- 联系管理员重新生成

### 硬件指纹不正确

如果硬件指纹异常：

1. 检查系统时间和日期是否正确
2. 检查是否有虚拟机软件运行
3. 重启应用后重新获取指纹

## 最佳实践

### 管理员端

1. **记录用户信息**：为每个License记录用户信息、硬件指纹、发放日期
2. **定期备份密钥**：妥善保管private_key.pem文件
3. **设置合理有效期**：根据License类型设置合理的有效期
4. **功能权限最小化**：只授予必要的功能权限

### 用户端

1. **保存激活码**：妥善保存激活码备份
2. **及时续期**：在License到期前30天联系管理员
3. **硬件变更**：如更换硬件，需重新获取指纹并申请新License
4. **定期检查**：定期检查License状态和剩余天数

## 技术细节

### License数据结构

```json
{
  "version": "2.0",
  "licensee": "某某科技有限公司",
  "hardwareFingerprint": "a1b2c3d4e5f6...",
  "expiryDate": "2026-01-15T00:00:00",
  "features": ["pci_planning", "neighbor_planning"],
  "maxSeats": 1,
  "note": "标准版License",
  "generatedAt": "2025-01-15T00:00:00",
  "signature": "base64编码的RSA签名"
}
```

### 签名算法

1. 收集License数据（排除signature字段）
2. 按字段名排序
3. JSON序列化（无空格，排序键）
4. 使用私钥RSA-PSS-SHA256签名

### 验证流程

1. 解码License数据
2. 验证RSA签名
3. 检查版本兼容性
4. 验证硬件指纹匹配
5. 检查有效期

## 版本历史

### v2.0 (2025-01-15)

- 新增硬件指纹绑定
- 新增RSA数字签名
- 新增功能权限控制
- 新增独立License生成工具
- 移除重复的上传文件功能

### v1.0 (2024-XX-XX)

- 基础License功能
- 时间限制
- 简单签名验证

## 联系支持

如有问题，请联系：
- 技术支持邮箱：support@example.com
- License管理：license@example.com

---

**文档版本：** 2.0
**最后更新：** 2025-01-15
