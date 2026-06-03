"""
用户个性化设置 API 端点
存储/读取用户的图层控制、标签设置等个性化配置
"""
import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import get_current_user
from app.models.database import User, UserSettings

router = APIRouter()


def _now_str() -> str:
    return datetime.now(timezone.utc).isoformat()


@router.get("/settings")
async def get_user_settings(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """获取当前用户的个性化设置"""
    settings = db.query(UserSettings).filter(UserSettings.user_id == current_user.id).first()
    if not settings:
        return {
            "success": True,
            "data": {
                "user_id": current_user.id,
                "settings": {},
                "updated_at": None,
            },
        }

    return {
        "success": True,
        "data": settings.to_dict(),
    }


@router.put("/settings")
async def update_user_settings(
    data: dict,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """更新当前用户的个性化设置（全量替换）"""
    settings_json = data.get("settings", {})
    if not isinstance(settings_json, dict):
        raise HTTPException(status_code=400, detail="settings 必须是 JSON 对象")

    now = _now_str()
    raw_json = json.dumps(settings_json, ensure_ascii=False)

    settings = db.query(UserSettings).filter(UserSettings.user_id == current_user.id).first()
    if settings:
        settings.settings_json = raw_json
        settings.updated_at = now
    else:
        settings = UserSettings(
            user_id=current_user.id,
            settings_json=raw_json,
            updated_at=now,
        )
        db.add(settings)

    db.commit()
    db.refresh(settings)

    return {
        "success": True,
        "data": settings.to_dict(),
    }
