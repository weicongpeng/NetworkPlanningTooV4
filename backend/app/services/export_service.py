"""
导出服务 - 用于导出规划结果
"""

import logging
from pathlib import Path
import pandas as pd
from datetime import datetime
from typing import Dict, Any

logger = logging.getLogger(__name__)


async def export_tac_result(task_id: str, result: Dict[str, Any], format: str = "xlsx"):
    """
    导出TAC规划结果

    Args:
        task_id: 任务ID
        result: 规划结果
        format: 导出格式 'xlsx' 或 'csv'

    Returns:
        文件内容（FileResponse）
    """
    try:
        logger.info(f"开始导出TAC规划结果: task_id={task_id}, format={format}")

        # 提取结果数据
        results = result.get("results", [])
        if not results:
            raise ValueError("没有可导出的结果数据")

        # 转换为DataFrame
        df = pd.DataFrame(results)

        # 重排列列顺序（第一列为运营商/厂家）
        columns_order = [
            "firstGroup",
            "siteId",
            "siteName",
            "sectorId",
            "sectorName",
            "networkType",
            "longitude",
            "latitude",
            "tac",
            "existingTac",
            "matched",
            "isSingularity",  # TAC是否插花
            "suggestedTac",  # TAC建议值
        ]

        # 确保所有列都存在
        for col in columns_order:
            if col not in df.columns:
                df[col] = None

        df = df[columns_order]

        # 重命名列
        df.columns = [
            "运营商/厂家",
            "站点ID",
            "站点名称",
            "小区ID",
            "小区名称",
            "网络类型",
            "经度",
            "纬度",
            "图层TAC",
            "现网TAC",
            "匹配状态",
            "TAC是否插花",  # 新增
            "TAC建议值",  # 新增：对于插花小区，取图层TAC值
        ]

        # 添加TAC是否一致列（放在最后）
        def check_consistency(row):
            tac = row["图层TAC"]
            existing_tac = row["现网TAC"]
            if pd.isna(tac) or pd.isna(existing_tac):
                return "-"
            # 标准化TAC值
            tac_str = str(tac).strip()
            existing_str = str(existing_tac).strip()
            # 去除前导零（但保留单个0）
            tac_str = tac_str.lstrip("0") or "0"
            existing_str = existing_str.lstrip("0") or "0"
            return "是" if tac_str == existing_str else "否"

        df["TAC是否一致"] = df.apply(check_consistency, axis=1)

        # 转换匹配状态为中文
        df["匹配状态"] = df["匹配状态"].map({True: "已匹配", False: "未匹配"})

        # 转换TAC是否插花为中文
        if "TAC是否插花" in df.columns:
            # 与统计卡片保持一致：直接根据isSingularity字段显示，现网TAC为空也显示"否"
            df["TAC是否插花"] = df["TAC是否插花"].map({True: "是", False: "否"})

        # 转换TAC建议值：与统计卡片保持一致，根据isSingularity决定显示
        def get_suggested_tac_display(row):
            is_singularity = row.get("TAC是否插花") == "是"
            tac = row.get("图层TAC")
            # 只有插花小区才显示建议值（取图层TAC值）
            if is_singularity and pd.notna(tac):
                return str(tac)
            return ""
        df["TAC建议值"] = df.apply(get_suggested_tac_display, axis=1)

        # 获取网络类型
        network_type = result.get("networkType", "LTE")
        # 使用LTE/NR作为标识
        network_label = network_type  # LTE 或 NR

        # 生成临时文件名（用于服务器端存储）
        temp_filename = f"tac_export_{task_id}.{format}"

        # 保存到临时文件
        from app.core.config import settings

        export_dir = settings.EXPORT_DIR
        export_dir.mkdir(parents=True, exist_ok=True)

        export_path = export_dir / temp_filename

        if format == "xlsx":
            # 导出为Excel
            df.to_excel(export_path, index=False, engine="openpyxl")
            logger.info(f"Excel文件已保存到: {export_path}")
        else:
            # 导出为CSV
            df.to_csv(export_path, index=False, encoding="utf-8-sig")
            logger.info(f"CSV文件已保存到: {export_path}")

        # 读取文件内容并返回
        with open(export_path, "rb") as f:
            content = f.read()

        logger.info(f"TAC规划结果导出成功: {temp_filename}, 大小: {len(content)} bytes")

        # 返回FastAPI的FileResponse
        from fastapi.responses import FileResponse

        media_type = (
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            if format == "xlsx"
            else "text/csv"
        )

        # 不设置 filename，让前端控制下载文件名
        return FileResponse(path=export_path, media_type=media_type)

    except Exception as e:
        logger.error(f"导出TAC规划结果失败: {e}")
        raise


async def export_tac_planning_result(
    task_id: str, result: Dict[str, Any], format: str = "xlsx"
):
    """
    导出TAC规划任务结果（待规划小区清单的TAC分配）

    Args:
        task_id: 任务ID
        result: 规划结果
        format: 导出格式 'xlsx' 或 'csv'

    Returns:
        文件内容（FileResponse）
    """
    try:
        logger.info(f"开始导出TAC规划结果: task_id={task_id}, format={format}")

        # 提取结果数据
        results = result.get("results", [])
        if not results:
            raise ValueError("没有可导出的结果数据")

        # 转换为DataFrame
        df = pd.DataFrame(results)

        # 重排列列顺序
        columns_order = [
            "siteId",
            "siteName",
            "sectorId",
            "sectorName",
            "networkType",
            "longitude",
            "latitude",
            "tac",
        ]

        # 确保所有列都存在
        for col in columns_order:
            if col not in df.columns:
                df[col] = None

        df = df[columns_order]

        # 重命名列
        df.columns = [
            "站点ID",
            "站点名称",
            "小区ID",
            "小区名称",
            "网络类型",
            "经度",
            "纬度",
            "TAC分配值",
        ]

        # 获取网络类型
        network_type = result.get("networkType", "LTE")
        network_type_label = "4G" if network_type == "LTE" else "5G"

        # 生成临时文件名（用于服务器端存储）
        temp_filename = f"tac_planning_export_{task_id}.{format}"

        # 保存到临时文件
        from app.core.config import settings

        export_dir = settings.EXPORT_DIR
        export_dir.mkdir(parents=True, exist_ok=True)

        export_path = export_dir / temp_filename

        if format == "xlsx":
            # 导出为Excel
            df.to_excel(export_path, index=False, engine="openpyxl")
            logger.info(f"Excel文件已保存到: {export_path}")
        else:
            # 导出为CSV
            df.to_csv(export_path, index=False, encoding="utf-8-sig")
            logger.info(f"CSV文件已保存到: {export_path}")

        # 读取文件内容并返回
        with open(export_path, "rb") as f:
            content_bytes = f.read()

        logger.info(
            f"TAC规划结果导出成功: {temp_filename}, 大小: {len(content_bytes)} bytes"
        )

        # 返回FastAPI的FileResponse
        from fastapi.responses import FileResponse

        media_type = (
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            if format == "xlsx"
            else "text/csv"
        )

        # 不设置 filename，让前端控制下载文件名
        return FileResponse(path=export_path, media_type=media_type)

    except Exception as e:
        logger.error(f"导出TAC规划结果失败: {e}")
        raise
