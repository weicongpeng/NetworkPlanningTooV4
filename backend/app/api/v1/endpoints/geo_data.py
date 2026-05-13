"""
地理化数据 API 端点
"""

import json
from typing import Optional
from fastapi import APIRouter, HTTPException, UploadFile, Form
from fastapi.concurrency import run_in_threadpool
from pathlib import Path
from datetime import datetime

from app.services.data_service import data_service
from app.services.geo_data_service import GeoDataService
from app.core.config import settings


router = APIRouter()
geo_data_service = GeoDataService()


@router.post("/upload/geo")
async def upload_geo_data(
    file: Optional[UploadFile] = None,
    file_path: Optional[str] = Form(None)
):
    """
    上传地理化数据文件

    支持 Excel (.xlsx, .xls)、CSV (.csv)、TXT (.txt) 格式
    自动识别经纬度字段，智能判断点状/扇区图层
    """
    try:
        # 验证输入
        if not file and not file_path:
            raise HTTPException(
                status_code=400,
                detail="未提供文件，请选择要上传的文件"
            )

        # 生成唯一ID
        import uuid
        import os
        import shutil

        data_id = str(uuid.uuid4())

        # 获取文件名
        if file_path:
            file_path_clean = file_path.strip("\"'")
            filename = os.path.basename(file_path_clean)
            ext = os.path.splitext(filename)[1]
        elif file:
            filename = file.filename
            if not filename:
                raise ValueError("无法从上传的文件中获取文件名")
            ext = os.path.splitext(filename)[1]
        else:
            raise ValueError("必须提供文件或文件路径")

        # 保存文件
        saved_file_path = settings.UPLOAD_DIR / f"{data_id}{ext}"

        if file:
            # 从上传的文件保存
            content = await file.read()
            with open(saved_file_path, "wb") as f:
                f.write(content)
        elif file_path:
            # 从本地路径复制
            if not os.path.exists(file_path_clean):
                raise ValueError(f"文件不存在: {file_path_clean}")
            shutil.copy2(file_path_clean, saved_file_path)

        # 验证文件
        if not saved_file_path.exists():
            raise FileNotFoundError(f"文件保存失败: {saved_file_path}")

        # 解析数据
        parse_result = await run_in_threadpool(
            geo_data_service.parse_geo_data,
            str(saved_file_path),
            filename
        )

        # 保存解析结果到 JSON 文件
        data_dir = settings.DATA_DIR / data_id
        data_dir.mkdir(parents=True, exist_ok=True)

        # 保存为 default.json，与现有工参数据格式兼容
        json_path = data_dir / 'default.json'
        with open(json_path, 'w', encoding='utf-8') as f:
            json.dump(parse_result['data'], f, ensure_ascii=False, indent=2)

        # 更新索引
        data_service.index[data_id] = {
            'id': data_id,
            'name': filename,
            'type': 'excel',
            'fileType': 'geo_data',
            'geometryType': parse_result['geometryType'],
            'sourceType': 'excel',
            'size': len(str(parse_result['data'])),
            'uploadDate': datetime.now().isoformat(),
            'status': 'ready',
            'metadata': {
                'pointCount': parse_result['pointCount']
            }
        }
        data_service._save_index()

        # 返回结果
        return {
            'success': True,
            'data': {
                'id': data_id,
                'name': filename,
                'fileType': 'geo_data',
                'geometryType': parse_result['geometryType'],
                'pointCount': parse_result['pointCount']
            }
        }

    except HTTPException:
        # 直接抛出 HTTP 异常
        raise
    except ValueError as e:
        # 数据验证错误
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        # 其他错误
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"上传失败: {str(e)}")
