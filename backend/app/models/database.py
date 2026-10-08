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
    # 服务器为桌面端创建的影子账号（不可登录），用于承载桌面端同步上来数据的归属
    is_desktop_shadow = Column(Boolean, default=False, nullable=False)
    must_change_password = Column(Boolean, default=False, nullable=False)
    license_expiry = Column(DateTime, nullable=True)
    total_usage_seconds = Column(Integer, default=0, nullable=False)
    last_login = Column(DateTime, nullable=True)
    last_login_ip = Column(String(45), nullable=True)
    created_at = Column(DateTime, default=_utcnow, nullable=False)
    city = Column(String(100), nullable=True)
    operator = Column(String(50), nullable=True)
    user_type = Column(String(10), default='pc', nullable=False)
    # 桌面版登录时选择的运行模式：shared=共享模式（权限/分组与网页端一致）
    # / standalone=单机模式（数据本机私有；权限同样按下方权限位，与网页端一致）。网页端恒为 NULL。
    desktop_run_mode = Column(String(16), nullable=True)

    # 细粒度权限（数据管理/功能页面操作权限，默认全部关闭，管理员自动拥有全部权限）
    # 由管理员在「用户管理 → 编辑」设置，网页端与桌面端（含单机模式）一致生效
    can_data_import = Column(Boolean, default=False, nullable=False)
    can_data_delete = Column(Boolean, default=False, nullable=False)
    can_data_update = Column(Boolean, default=False, nullable=False)
    can_cell_entry = Column(Boolean, default=False, nullable=False)
    can_cell_query_update = Column(Boolean, default=False, nullable=False)
    # 网优助手功能权限（对话/基站参数·指标数据集/大模型配置），管理员自动拥有
    can_assistant = Column(Boolean, default=False, nullable=False)

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
            "is_desktop_shadow": self.is_desktop_shadow,
            "desktop_run_mode": self.desktop_run_mode,
            "can_data_import": self.can_data_import,
            "can_data_delete": self.can_data_delete,
            "can_data_update": self.can_data_update,
            "can_cell_entry": self.can_cell_entry,
            "can_cell_query_update": self.can_cell_query_update,
            "can_assistant": self.can_assistant,
        }


class UserSession(Base):
    __tablename__ = "user_sessions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    token_jti = Column(String(255), unique=True, nullable=False, index=True)
    ip_address = Column(String(45), nullable=True)
    client_type = Column(String(10), default='pc', nullable=False)
    login_time = Column(DateTime, default=_utcnow, nullable=False)
    logout_time = Column(DateTime, nullable=True)
    last_activity = Column(DateTime, default=_utcnow, nullable=False)
    # 使用时长已结算到该时刻（增量结算标记，避免重复累加；与登录态无关）
    usage_accounted_at = Column(DateTime, nullable=True)

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
            "client_type": self.client_type,
        }


class Workbook(Base):
    """工参工作簿元数据"""
    __tablename__ = "workbooks"

    id = Column(String(36), primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    # 数据所属组（地市+运营商）归属快照；NULL=存量数据，仅管理员可见
    city = Column(String(100), nullable=True, index=True)
    operator = Column(String(50), nullable=True)
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
    # 数据所属组（地市+运营商）归属快照；NULL=存量数据，仅管理员可见
    city = Column(String(100), nullable=True, index=True)
    operator = Column(String(50), nullable=True)
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
    # 数据所属组（地市+运营商）归属快照；NULL=存量数据，仅管理员可见
    city = Column(String(100), nullable=True, index=True)
    operator = Column(String(50), nullable=True)
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
    # 数据所属组（地市+运营商）归属快照；NULL=存量数据，仅管理员可见
    city = Column(String(100), nullable=True)
    operator = Column(String(50), nullable=True)
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
    # 数据所属组（地市+运营商）归属快照；NULL=存量数据，仅管理员可见
    city = Column(String(100), nullable=True)
    operator = Column(String(50), nullable=True)
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


class SystemSetting(Base):
    """全局系统设置（键值对，全站唯一一份，非按用户）。

    当前用于承载全局授权期限：授权是对**所有用户**生效的系统级设置，
    不能存在某个用户行上（否则管理员改自己的期限不影响别人）。
    个别用户的例外期限仍放在 users.license_expiry。
    """
    __tablename__ = "system_settings"

    key = Column(String(64), primary_key=True)
    value = Column(Text, nullable=True)
    updated_at = Column(String(30), nullable=False)


class TaskResult(Base):
    """规划任务结果持久化"""
    __tablename__ = "task_results"

    id = Column(Integer, primary_key=True, autoincrement=True)
    task_id = Column(String(36), unique=True, nullable=False, index=True)
    task_type = Column(String(50), nullable=False)
    task_name = Column(String(255), nullable=True)
    user_name = Column(String(50), nullable=True)
    # 任务发起时的组快照（执行线程不反查用户表）；NULL=存量任务
    city = Column(String(100), nullable=True)
    operator = Column(String(50), nullable=True)
    config_json = Column(Text, nullable=True)
    result_json = Column(Text, nullable=True)
    status = Column(String(20), nullable=False, default="completed")
    progress = Column(Float, default=100.0)
    error_message = Column(Text, nullable=True)
    is_applied = Column(Integer, default=0)  # 0=未应用, 1=已应用
    created_at = Column(String(30), nullable=False)
    completed_at = Column(String(30), nullable=True)
    # 任务来源：local=本机创建 / shared=同组共享同步进来的镜像（桌面端用；
    # 镜像行只读，结果在查看/导出时按需从服务器拉取，不参与上行推送）
    origin = Column(String(10), nullable=False, default="local")

    __table_args__ = (
        Index("idx_task_results_type", "task_type"),
        Index("idx_task_results_created", "created_at"),
    )


class AppVersion(Base):
    """APP 版本记录"""
    __tablename__ = "app_versions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    version = Column(String(20), nullable=False, index=True)
    changelog = Column(Text, nullable=True)
    apk_filename = Column(String(255), nullable=False)
    apk_path = Column(Text, nullable=False)
    file_size = Column(Integer, nullable=True)
    is_latest = Column(Boolean, default=False, nullable=False)
    download_count = Column(Integer, default=0, nullable=True)
    created_at = Column(String(30), nullable=False)
    updated_at = Column(String(30), nullable=True)

    def to_dict(self):
        return {
            "id": self.id,
            "version": self.version,
            "changelog": self.changelog,
            "apk_filename": self.apk_filename,
            "apk_path": self.apk_path,
            "file_size": self.file_size,
            "is_latest": self.is_latest,
            "download_count": self.download_count or 0,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


class DesktopLicense(Base):
    """桌面版在线授权记录（按用户授权，许可文件绑定机器码，租约制）

    两种来源：precreate（管理员预建激活码）/ approve（客户端申请后管理员批准）。
    状态：pending（待批准）/ issued（已生成激活码待激活）/ active（已绑定机器）/
          rejected（已拒绝）/ disabled（已禁用）。
    """
    __tablename__ = "desktop_licenses"

    id = Column(Integer, primary_key=True, autoincrement=True)
    activation_code = Column(String(32), nullable=True, unique=True, index=True)
    licensee_username = Column(String(100), nullable=False)
    organization = Column(String(200), nullable=True)
    machine_code = Column(String(64), nullable=True, index=True)
    # 运行模式：standalone=单机授权（需管理员批准）/ shared=共享模式登录时自动签发
    mode = Column(String(16), nullable=False, default="standalone", index=True)
    # 绑定的网页端账号：桌面端与网页端共用同一账号权限与数据组
    username = Column(String(100), nullable=True, index=True)
    user_id = Column(Integer, nullable=True, index=True)
    status = Column(String(16), nullable=False, default="issued", index=True)
    source = Column(String(10), nullable=False, default="precreate")
    lease_days = Column(Integer, nullable=False, default=30)
    expire_date = Column(String(10), nullable=True)
    # 该桌面端所属数据组（地市+运营商）：为空时由桌面端自选并在首次同步时绑定，
    # 非空时以服务器为准（管理员可在「桌面授权」页修改/解绑）。
    city = Column(String(100), nullable=True)
    operator = Column(String(50), nullable=True)
    request_token = Column(String(64), nullable=True, unique=True)
    applied_note = Column(Text, nullable=True)
    review_note = Column(Text, nullable=True)
    note = Column(Text, nullable=True)
    created_by = Column(String(100), nullable=True)
    approved_by = Column(String(100), nullable=True)
    client_version = Column(String(30), nullable=True)
    hostname = Column(String(100), nullable=True)
    renewal_count = Column(Integer, nullable=False, default=0)
    # 历史登录次数（单机模式每次登录累加）与最近登录时间
    login_count = Column(Integer, nullable=False, default=0)
    last_login_at = Column(String(30), nullable=True)
    # 单机用户无操作自动退出登录的时长（天），默认 2 天，随许可下发到本机
    idle_logout_days = Column(Integer, nullable=False, default=2)
    created_at = Column(String(30), nullable=False)
    activated_at = Column(String(30), nullable=True)
    machine_bound_at = Column(String(30), nullable=True)
    last_renewed_at = Column(String(30), nullable=True)
    disabled_at = Column(String(30), nullable=True)
    updated_at = Column(String(30), nullable=True)

    def to_dict(self):
        return {
            "id": self.id,
            "activation_code": self.activation_code,
            "licensee_username": self.licensee_username,
            "organization": self.organization,
            "machine_code": self.machine_code,
            "mode": self.mode,
            "username": self.username,
            "user_id": self.user_id,
            "status": self.status,
            "source": self.source,
            "lease_days": self.lease_days,
            "login_count": self.login_count or 0,
            "last_login_at": self.last_login_at,
            "idle_logout_days": self.idle_logout_days if self.idle_logout_days is not None else 2,
            "expire_date": self.expire_date,
            "city": self.city,
            "operator": self.operator,
            "request_id": self.request_token,
            "applied_note": self.applied_note,
            "review_note": self.review_note,
            "note": self.note,
            "created_by": self.created_by,
            "approved_by": self.approved_by,
            "client_version": self.client_version,
            "hostname": self.hostname,
            "renewal_count": self.renewal_count or 0,
            "created_at": self.created_at,
            "activated_at": self.activated_at,
            "machine_bound_at": self.machine_bound_at,
            "last_renewed_at": self.last_renewed_at,
            "disabled_at": self.disabled_at,
            "updated_at": self.updated_at,
        }


class DesktopRelease(Base):
    """Windows 桌面版安装包版本记录（OTA 分发）"""
    __tablename__ = "desktop_releases"

    id = Column(Integer, primary_key=True, autoincrement=True)
    version = Column(String(30), nullable=False, index=True)
    channel = Column(String(20), nullable=False, default="stable", index=True)
    filename = Column(String(255), nullable=False)
    file_path = Column(Text, nullable=False)
    file_size = Column(Integer, nullable=True)
    sha256 = Column(String(64), nullable=True)
    release_notes = Column(Text, nullable=True)
    # 强制更新已下线（新版本只提示、可关闭）；列保留仅因 SQLite 不便下线，不再读写
    is_latest = Column(Boolean, nullable=False, default=False)
    download_count = Column(Integer, nullable=True, default=0)
    created_by = Column(String(100), nullable=True)
    created_at = Column(String(30), nullable=False)
    updated_at = Column(String(30), nullable=True)

    def to_dict(self):
        return {
            "id": self.id,
            "version": self.version,
            "channel": self.channel,
            "filename": self.filename,
            "file_path": self.file_path,
            "file_size": self.file_size,
            "sha256": self.sha256,
            "release_notes": self.release_notes,
            "is_latest": bool(self.is_latest),
            "download_count": self.download_count or 0,
            "created_by": self.created_by,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


class DatasetRevision(Base):
    """数据集修订号：桌面端共享模式下判断「服务器上的数据是否更新过」的唯一依据。

    一个数据集（index.json 中的数据条目 id）一条记录。
    rev 单调递增，任何改变数据集内容的写入都要 bump（详见 dataset_revision_service）：
    上传完成 / 图层整层与增量保存 / PCI·TAC 应用到工参 / 小区批量更新 / 删除（墓碑）/ 组迁移。
    deleted 为墓碑：不写墓碑的话，客户端本地删除会被当成「本地新建」被再次推上来。
    """
    __tablename__ = "dataset_revisions"

    data_id = Column(String(36), primary_key=True)
    rev = Column(Integer, nullable=False, default=0)
    sha256 = Column(String(64), nullable=True)
    deleted = Column(Boolean, nullable=False, default=False)
    updated_by = Column(String(100), nullable=True)
    updated_at = Column(String(30), nullable=True)
    # 组归属快照：删除后数据集不再出现在索引里，只有靠这里才知道墓碑属于哪个组，
    # 桌面端才能在清单里收到"服务器上这条已被删除"。
    city = Column(String(100), nullable=True)
    operator = Column(String(50), nullable=True)

    def to_dict(self):
        return {
            "data_id": self.data_id,
            "rev": self.rev,
            "sha256": self.sha256,
            "deleted": bool(self.deleted),
            "updated_by": self.updated_by,
            "updated_at": self.updated_at,
            "city": self.city,
            "operator": self.operator,
        }


class StationParamRow(Base):
    """网优助手-基站无线参数（一行一个小区，参数为动态 KV）

    全量工参(Site/Sector)是小区基础规划数据；本表存网管配置的无线参数
    （功率、切换门限、重选参数等），列随网管版本变化，故动态参数存 params_json。
    """
    __tablename__ = "station_param_rows"

    id = Column(Integer, primary_key=True, autoincrement=True)
    workbook_id = Column(String(36), ForeignKey("workbooks.id"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    # 数据所属组（地市+运营商）归属快照；NULL=存量数据，仅管理员可见
    city = Column(String(100), nullable=True)
    operator = Column(String(50), nullable=True)
    cell_name = Column(String(255), nullable=False, index=True)
    site_id = Column(String(100), nullable=True)
    cell_id = Column(String(100), nullable=True)
    network_type = Column(String(10), nullable=True)
    params_json = Column(Text, nullable=False, default="{}")
    created_at = Column(String(30), nullable=False)

    __table_args__ = (
        Index("idx_param_rows_user_cell", "user_id", "cell_name"),
    )


class StationMetricRow(Base):
    """网优助手-基站性能指标（长表：一行 = 小区 × 时间 × 指标）

    长表而非宽表：指标列随网管/粒度（月/天/小时/忙时）变化，
    宽表要频繁改表结构；长表 + 索引在 SQLite 百万级下查询足够快。
    """
    __tablename__ = "station_metric_rows"

    id = Column(Integer, primary_key=True, autoincrement=True)
    workbook_id = Column(String(36), ForeignKey("workbooks.id"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    # 数据所属组（地市+运营商）归属快照；NULL=存量数据，仅管理员可见
    city = Column(String(100), nullable=True)
    operator = Column(String(50), nullable=True)
    cell_name = Column(String(255), nullable=False, index=True)
    site_id = Column(String(100), nullable=True)
    cell_id = Column(String(100), nullable=True)
    granularity = Column(String(10), nullable=True)  # hour/day/month/busy_hour
    metric_time = Column(DateTime, nullable=False, index=True)
    metric_name = Column(String(100), nullable=False, index=True)
    metric_value = Column(Float, nullable=True)
    created_at = Column(String(30), nullable=False)

    __table_args__ = (
        Index("idx_metric_rows_query", "user_id", "cell_name", "metric_name", "metric_time"),
    )
