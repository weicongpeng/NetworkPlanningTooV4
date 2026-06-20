"""
SQLAlchemy ORM 模型定义
"""
import json
from datetime import datetime, timezone
from sqlalchemy import (
    Column, Integer, String, Boolean, DateTime, Float, ForeignKey, Index, Text
)
from sqlalchemy.orm import relationship
from app.core.database import Base


def _utcnow():
    return datetime.now(timezone.utc)


def _serialize_dt(dt: datetime | None) -> str | None:
    """序列化 datetime 为 ISO 字符串，确保时区信息不丢失

    SQLite 存储 datetime 时会丢失 tzinfo，导致 .isoformat() 输出无时区后缀。
    此函数为无时区信息的 datetime 添加 UTC 标记，使前端能正确转换时区。
    """
    if dt is None:
        return None
    if dt.tzinfo is None:
        # SQLite 丢失了时区信息，假定为 UTC
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String(50), unique=True, nullable=False, index=True)
    password_hash = Column(String(255), nullable=False)
    is_admin = Column(Boolean, default=False, nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)
    must_change_password = Column(Boolean, default=False, nullable=False)
    license_expiry = Column(DateTime, nullable=True)
    total_usage_seconds = Column(Integer, default=0, nullable=False)
    last_login = Column(DateTime, nullable=True)
    last_login_ip = Column(String(45), nullable=True)
    created_at = Column(DateTime, default=_utcnow, nullable=False)
    city = Column(String(100), nullable=True)
    operator = Column(String(50), nullable=True)
    user_type = Column(String(10), default='pc', nullable=False)

    sessions = relationship("UserSession", back_populates="user", lazy="dynamic")

    def to_dict(self):
        return {
            "id": self.id,
            "username": self.username,
            "is_admin": self.is_admin,
            "is_active": self.is_active,
            "must_change_password": self.must_change_password,
            "license_expiry": _serialize_dt(self.license_expiry),
            "total_usage_seconds": self.total_usage_seconds,
            "last_login": _serialize_dt(self.last_login),
            "last_login_ip": self.last_login_ip,
            "created_at": _serialize_dt(self.created_at),
            "city": self.city,
            "operator": self.operator,
            "user_type": self.user_type,
        }


class UserSession(Base):
    __tablename__ = "user_sessions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    token_jti = Column(String(255), unique=True, nullable=False, index=True)
    ip_address = Column(String(45), nullable=True)
    login_time = Column(DateTime, default=_utcnow, nullable=False)
    logout_time = Column(DateTime, nullable=True)
    last_activity = Column(DateTime, default=_utcnow, nullable=False)

    user = relationship("User", back_populates="sessions")

    def to_dict(self):
        return {
            "id": self.id,
            "user_id": self.user_id,
            "token_jti": self.token_jti,
            "login_time": _serialize_dt(self.login_time),
            "logout_time": _serialize_dt(self.logout_time),
            "last_activity": _serialize_dt(self.last_activity),
            "ip_address": self.ip_address,
        }


class Workbook(Base):
    """工参工作簿元数据"""
    __tablename__ = "workbooks"

    id = Column(String(36), primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    name = Column(String(255), nullable=False)
    file_type = Column(String(50), nullable=False)
    network_types = Column(Text, nullable=True)
    status = Column(String(20), nullable=False, default="processing")
    size = Column(Integer, nullable=True)
    original_path = Column(Text, nullable=True)
    metadata_json = Column(Text, nullable=True)
    error_message = Column(Text, nullable=True)
    remark = Column(Text, nullable=True)
    created_at = Column(String(30), nullable=False)
    updated_at = Column(String(30), nullable=True)

    __table_args__ = (
        Index("idx_workbooks_user_type", "user_id", "file_type"),
    )


class Site(Base):
    """站点"""
    __tablename__ = "sites"

    id = Column(Integer, primary_key=True, autoincrement=True)
    workbook_id = Column(String(36), ForeignKey("workbooks.id"), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    site_id = Column(String(100), nullable=False)
    name = Column(String(255), nullable=True)
    longitude = Column(Float, nullable=True)
    latitude = Column(Float, nullable=True)
    network_type = Column(String(10), nullable=False)
    managed_element_id = Column(String(100), nullable=True)
    mcc = Column(String(10), nullable=True)
    mnc = Column(String(10), nullable=True)

    __table_args__ = (
        Index("idx_sites_user_workbook", "user_id", "workbook_id"),
        Index("idx_sites_network_coords", "network_type", "latitude", "longitude"),
    )


class Sector(Base):
    """扇区"""
    __tablename__ = "sectors"

    id = Column(Integer, primary_key=True, autoincrement=True)
    site_id_fk = Column(Integer, ForeignKey("sites.id"), nullable=True)
    workbook_id = Column(String(36), ForeignKey("workbooks.id"), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    sector_id = Column(String(100), nullable=False)
    name = Column(String(255), nullable=True)
    longitude = Column(Float, nullable=True)
    latitude = Column(Float, nullable=True)
    azimuth = Column(Float, nullable=True)
    beamwidth = Column(Float, nullable=True, default=65.0)
    height = Column(Float, nullable=True)
    pci = Column(Integer, nullable=True)
    tac = Column(Integer, nullable=True)
    frequency = Column(Float, nullable=True)
    cell_cover_type = Column(Integer, nullable=True, default=1)
    is_shared = Column(String(10), nullable=True)
    first_group = Column(String(100), nullable=True)
    mcc = Column(String(10), nullable=True)
    mnc = Column(String(10), nullable=True)

    __table_args__ = (
        Index("idx_sectors_user_workbook", "user_id", "workbook_id"),
        Index("idx_sectors_site", "site_id_fk"),
        Index("idx_sectors_pci", "workbook_id", "pci"),
        Index("idx_sectors_name", "name"),
    )


class GeoFile(Base):
    """地理化数据文件元数据"""
    __tablename__ = "geo_files"

    id = Column(String(36), primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    filename = Column(String(255), nullable=False)
    file_path = Column(Text, nullable=False)
    geometry_type = Column(String(20), nullable=False)
    field_mapping = Column(Text, nullable=True)
    point_count = Column(Integer, nullable=True)
    bbox = Column(Text, nullable=True)
    file_size = Column(Integer, nullable=True)
    created_at = Column(String(30), nullable=False)

    __table_args__ = (
        Index("idx_geo_files_user", "user_id"),
    )


class Layer(Base):
    """图层文件元数据"""
    __tablename__ = "layers"

    id = Column(String(36), primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    name = Column(String(255), nullable=False)
    file_path = Column(Text, nullable=False)
    layer_type = Column(String(20), nullable=False)
    geometry_type = Column(String(20), nullable=False)
    feature_count = Column(Integer, nullable=True)
    bbox = Column(Text, nullable=True)
    file_size = Column(Integer, nullable=True)
    created_at = Column(String(30), nullable=False)

    __table_args__ = (
        Index("idx_layers_user", "user_id"),
    )


class UserSettings(Base):
    """用户个性化设置（地图图层状态等）"""
    __tablename__ = "user_settings"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, unique=True, index=True)
    settings_json = Column(Text, nullable=False, default="{}")
    updated_at = Column(String(30), nullable=False)

    user = relationship("User", backref="settings", uselist=False)

    def to_dict(self):
        return {
            "user_id": self.user_id,
            "settings": json.loads(self.settings_json) if self.settings_json else {},
            "updated_at": self.updated_at,
        }


class TaskResult(Base):
    """规划任务结果持久化"""
    __tablename__ = "task_results"

    id = Column(Integer, primary_key=True, autoincrement=True)
    task_id = Column(String(36), unique=True, nullable=False, index=True)
    task_type = Column(String(50), nullable=False)
    task_name = Column(String(255), nullable=True)
    user_name = Column(String(50), nullable=True)
    config_json = Column(Text, nullable=True)
    result_json = Column(Text, nullable=True)
    status = Column(String(20), nullable=False, default="completed")
    progress = Column(Float, default=100.0)
    error_message = Column(Text, nullable=True)
    is_applied = Column(Integer, default=0)  # 0=未应用, 1=已应用
    created_at = Column(String(30), nullable=False)
    completed_at = Column(String(30), nullable=True)

    __table_args__ = (
        Index("idx_task_results_type", "task_type"),
        Index("idx_task_results_created", "created_at"),
    )
