"""
数据库引擎和会话管理
使用 SQLite + SQLAlchemy ORM
"""
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker, Session, DeclarativeBase
from app.core.config import settings

# SQLite 数据库文件路径（as_posix 避免 Windows 反斜杠路径解析异常）
DATABASE_URL = f"sqlite:///{(settings.DATA_DIR / 'data.db').as_posix()}"
OLD_DATABASE_URL = f"sqlite:///{(settings.DATA_DIR / 'users.db').as_posix()}"

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False},
    echo=False,
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


# 启用 SQLite WAL 模式和外键约束
@event.listens_for(engine, "connect")
def _set_sqlite_pragma(dbapi_connection, connection_record):
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


class Base(DeclarativeBase):
    pass


def get_db():
    """FastAPI 依赖注入：获取数据库会话"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    """初始化数据库表结构（含迁移逻辑）"""
    # 迁移 users.db → data.db
    _migrate_users_db()

    from app.models.database import (
        User, UserSession, Workbook, Site, Sector, GeoFile, Layer, UserSettings, TaskResult,
        DatasetRevision, SystemSetting,
    )  # noqa: F401
    Base.metadata.create_all(bind=engine)

    # 迁移：为已有数据库添加新列
    with engine.connect() as conn:
        # 检查并添加 User 表新列
        existing_cols = [row[1] for row in conn.exec_driver_sql("PRAGMA table_info(users)").fetchall()]
        migrations = [
            ("city", "ALTER TABLE users ADD COLUMN city VARCHAR(100)"),
            ("operator", "ALTER TABLE users ADD COLUMN operator VARCHAR(50)"),
            ("last_login_ip", "ALTER TABLE users ADD COLUMN last_login_ip VARCHAR(45)"),
            ("ip_address", "ALTER TABLE user_sessions ADD COLUMN ip_address VARCHAR(45)"),
            ("user_type", "ALTER TABLE users ADD COLUMN user_type VARCHAR(10) NOT NULL DEFAULT 'pc'"),
            ("can_data_import", "ALTER TABLE users ADD COLUMN can_data_import BOOLEAN NOT NULL DEFAULT 0"),
            ("can_data_delete", "ALTER TABLE users ADD COLUMN can_data_delete BOOLEAN NOT NULL DEFAULT 0"),
            ("can_data_update", "ALTER TABLE users ADD COLUMN can_data_update BOOLEAN NOT NULL DEFAULT 0"),
            ("can_cell_entry", "ALTER TABLE users ADD COLUMN can_cell_entry BOOLEAN NOT NULL DEFAULT 0"),
            ("can_cell_query_update", "ALTER TABLE users ADD COLUMN can_cell_query_update BOOLEAN NOT NULL DEFAULT 0"),
            ("can_assistant", "ALTER TABLE users ADD COLUMN can_assistant BOOLEAN NOT NULL DEFAULT 0"),
            ("usage_accounted_at", "ALTER TABLE user_sessions ADD COLUMN usage_accounted_at DATETIME"),
        ]
        for col_name, sql in migrations:
            table_name = "user_sessions" if "user_sessions" in sql else "users"
            table_cols = [row[1] for row in conn.exec_driver_sql(f"PRAGMA table_info({table_name})").fetchall()]
            if col_name not in table_cols:
                conn.exec_driver_sql(sql)

        # 迁移：workbooks 表添加 remark 列
        wb_cols = [row[1] for row in conn.exec_driver_sql("PRAGMA table_info(workbooks)").fetchall()]
        if "remark" not in wb_cols:
            conn.exec_driver_sql("ALTER TABLE workbooks ADD COLUMN remark TEXT")

        # 迁移：桌面版授权记录添加数据组归属列（共享模式下按组共享服务器端数据）
        dl_cols = [row[1] for row in conn.exec_driver_sql("PRAGMA table_info(desktop_licenses)").fetchall()]
        if dl_cols:
            if "city" not in dl_cols:
                conn.exec_driver_sql("ALTER TABLE desktop_licenses ADD COLUMN city VARCHAR(100)")
            if "operator" not in dl_cols:
                conn.exec_driver_sql("ALTER TABLE desktop_licenses ADD COLUMN operator VARCHAR(50)")
            # 桌面端与网页端共用账号：授权记录绑定账号与运行模式
            if "mode" not in dl_cols:
                conn.exec_driver_sql(
                    "ALTER TABLE desktop_licenses ADD COLUMN mode VARCHAR(16) NOT NULL DEFAULT 'standalone'"
                )
            if "username" not in dl_cols:
                conn.exec_driver_sql("ALTER TABLE desktop_licenses ADD COLUMN username VARCHAR(100)")
            if "user_id" not in dl_cols:
                conn.exec_driver_sql("ALTER TABLE desktop_licenses ADD COLUMN user_id INTEGER")
            if "login_count" not in dl_cols:
                conn.exec_driver_sql(
                    "ALTER TABLE desktop_licenses ADD COLUMN login_count INTEGER NOT NULL DEFAULT 0"
                )
            if "last_login_at" not in dl_cols:
                conn.exec_driver_sql("ALTER TABLE desktop_licenses ADD COLUMN last_login_at VARCHAR(30)")
            if "idle_logout_days" not in dl_cols:
                conn.exec_driver_sql(
                    "ALTER TABLE desktop_licenses ADD COLUMN idle_logout_days INTEGER NOT NULL DEFAULT 2"
                )

        # 迁移：桌面共享模式数据集修订号表（早期版本可能缺组归属列）
        dr_cols = [row[1] for row in conn.exec_driver_sql("PRAGMA table_info(dataset_revisions)").fetchall()]
        if dr_cols:
            if "city" not in dr_cols:
                conn.exec_driver_sql("ALTER TABLE dataset_revisions ADD COLUMN city VARCHAR(100)")
            if "operator" not in dr_cols:
                conn.exec_driver_sql("ALTER TABLE dataset_revisions ADD COLUMN operator VARCHAR(50)")

        # 迁移：桌面版新增一个「影子用户」标记列，用于区分服务器为桌面端创建的
        # 不可登录账号（桌面端以签名授权为身份，没有真实账号）
        if "is_desktop_shadow" not in existing_cols:
            conn.exec_driver_sql("ALTER TABLE users ADD COLUMN is_desktop_shadow BOOLEAN NOT NULL DEFAULT 0")

        # 迁移：桌面版登录时选择的运行模式（shared / standalone，网页端为 NULL）
        if "desktop_run_mode" not in existing_cols:
            conn.exec_driver_sql("ALTER TABLE users ADD COLUMN desktop_run_mode VARCHAR(16)")

        # 迁移：task_results 表添加 is_applied 列
        tr_cols = [row[1] for row in conn.exec_driver_sql("PRAGMA table_info(task_results)").fetchall()]
        if "is_applied" not in tr_cols:
            conn.exec_driver_sql("ALTER TABLE task_results ADD COLUMN is_applied INTEGER DEFAULT 0")
        # 迁移：桌面端任务历史同步的来源标记（local / shared）
        if tr_cols and "origin" not in tr_cols:
            conn.exec_driver_sql(
                "ALTER TABLE task_results ADD COLUMN origin VARCHAR(10) NOT NULL DEFAULT 'local'"
            )

        # 迁移：user_settings 表添加 created_at 列（如从旧表结构升级）
        us_cols = [row[1] for row in conn.exec_driver_sql("PRAGMA table_info(user_settings)").fetchall() if row[0] >= 0]
        if us_cols and "created_at" not in us_cols:
            conn.exec_driver_sql("ALTER TABLE user_settings ADD COLUMN created_at VARCHAR(30)")

        # 迁移：user_sessions 表添加 client_type 列
        usess_cols = [row[1] for row in conn.exec_driver_sql("PRAGMA table_info(user_sessions)").fetchall()]
        if "client_type" not in usess_cols:
            conn.exec_driver_sql("ALTER TABLE user_sessions ADD COLUMN client_type VARCHAR(10) NOT NULL DEFAULT 'pc'")

        # 迁移：app_versions 表添加 download_count 列
        av_cols = [row[1] for row in conn.exec_driver_sql("PRAGMA table_info(app_versions)").fetchall()]
        if av_cols and "download_count" not in av_cols:
            conn.exec_driver_sql("ALTER TABLE app_versions ADD COLUMN download_count INTEGER DEFAULT 0")

        # 迁移：数据按（地市+运营商）分组隔离 —— 各业务表添加组归属列
        # 存量行保持 NULL = 仅管理员可见；新数据写入时由上传者/工参所属组盖章
        for table in (
            "workbooks", "sites", "sectors", "geo_files", "layers",
            "station_param_rows", "station_metric_rows", "task_results",
        ):
            table_cols = [row[1] for row in conn.exec_driver_sql(f"PRAGMA table_info({table})").fetchall()]
            if not table_cols:
                continue
            if "city" not in table_cols:
                conn.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN city VARCHAR(100)")
            if "operator" not in table_cols:
                conn.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN operator VARCHAR(50)")
        conn.commit()

    # 存量无组数据一次性迁移：归入主管理员所在组（幂等，仅 city IS NULL 的行）
    _migrate_legacy_data_groups()

    # 误归组任务一次性纠正（幂等）：任务创建未盖章期间产生的 NULL 组任务被上一步
    # 误归主管理员组，此处按创建人（user_name）的归属组重盖章，恢复组隔离
    _fix_misattributed_task_groups()


def _migrate_legacy_data_groups():
    """存量无组数据一次性迁移：归入主管理员（id 最小、组齐全的管理员）所在组。

    背景：可见性规则已改为「所有用户（含管理员）一律按组隔离」，NULL 组数据
    将对所有人不可见，因此启动时把存量 NULL 组数据盖章为主管理员组（幂等）。
    """
    import logging
    _logger = logging.getLogger(__name__)
    try:
        from app.models.database import User

        db = SessionLocal()
        try:
            admin = (db.query(User)
                     .filter(User.is_admin == True,  # noqa: E712
                             User.city.isnot(None), User.city != "",
                             User.operator.isnot(None), User.operator != "")
                     .order_by(User.id.asc())
                     .first())
        finally:
            db.close()
        if admin is None:
            _logger.warning("[组迁移] 未找到组信息齐全的管理员，跳过存量数据组迁移")
            return {"migrated": 0}

        city, operator = admin.city, admin.operator
        total = 0
        with engine.begin() as conn:
            for table in (
                "workbooks", "sites", "sectors", "geo_files", "layers",
                "station_param_rows", "station_metric_rows", "task_results",
            ):
                result = conn.exec_driver_sql(
                    f"UPDATE {table} SET city = ?, operator = ? WHERE city IS NULL",
                    (city, operator),
                )
                total += result.rowcount

        # 内存索引条目同步盖章（index.json 中缺组键/空组的存量条目）
        stamped = 0
        try:
            from app.services.data_service import data_service
            for entry in data_service.index.values():
                if not entry.get("city") or not entry.get("operator"):
                    entry["city"] = city
                    entry["operator"] = operator
                    stamped += 1
            if stamped:
                data_service._save_index()
        except Exception as e:
            _logger.warning(f"[组迁移] 索引条目盖章失败（不影响 SQLite 迁移）: {e}")

        if total or stamped:
            _logger.info(f"[组迁移] 存量无组数据已归入 ({city}, {operator}) 组: "
                         f"SQLite {total} 行, 索引条目 {stamped} 个")
        return {"migrated": total, "stamped": stamped}
    except Exception as e:
        _logger.warning(f"[组迁移] 执行失败（不影响启动）: {e}")
        return {"migrated": 0}


def _fix_misattributed_task_groups():
    """纠正误归组的任务结果行（幂等）。

    背景：任务创建端点曾长期不盖（地市+运营商）章，TaskResult 行组为 NULL，
    被 _migrate_legacy_data_groups 误归主管理员组，表现为：
    - 任务创建人刷新后历史任务"清空"（组过滤查不到自己的任务）
    - 主管理员组能看到其他组用户的任务（跨组串数据）
    纠正规则：task_results 中 user_name 对应用户组齐全、且与行组不一致的行，
    一律按创建人组重盖章（用户管理改过组后退回旧组的存量任务也一并归位）。
    创建人本人所属组与行组一致的行不受影响；无对应用户的行保持原样。
    """
    import logging
    _logger = logging.getLogger(__name__)
    try:
        from app.models.database import User, TaskResult

        db = SessionLocal()
        try:
            admin = (db.query(User)
                     .filter(User.is_admin == True,  # noqa: E712
                             User.city.isnot(None), User.city != "",
                             User.operator.isnot(None), User.operator != "")
                     .order_by(User.id.asc())
                     .first())
            if admin is None:
                return {"fixed": 0}

            # 创建人组齐全、且与行组不一致的任务行 → 按创建人组重盖章
            rows = (db.query(TaskResult, User)
                    .join(User, TaskResult.user_name == User.username)
                    .filter(
                        User.city.isnot(None), User.city != "",
                        User.operator.isnot(None), User.operator != "",
                        ((User.city != TaskResult.city) | (User.operator != TaskResult.operator)),
                    )
                    .all())
            fixed = 0
            for tr, u in rows:
                tr.city = u.city
                tr.operator = u.operator
                fixed += 1
            if fixed:
                db.commit()
                _logger.info(f"[组迁移] 误归组任务已按创建人重盖章 {fixed} 行")
            return {"fixed": fixed}
        finally:
            db.close()
    except Exception as e:
        _logger.warning(f"[组迁移] 误归组任务纠正失败（不影响启动）: {e}")
        return {"fixed": 0}


def _migrate_users_db():
    """将旧 users.db 中的用户数据迁移到 data.db"""
    import os
    import sqlite3
    from urllib.parse import urlparse

    old_path = urlparse(OLD_DATABASE_URL).path
    new_path = urlparse(DATABASE_URL).path

    if not os.path.exists(old_path):
        return

    # 情况 1: data.db 不存在 → 直接复制 users.db
    if not os.path.exists(new_path):
        try:
            src = sqlite3.connect(old_path)
            dst = sqlite3.connect(new_path)
            src.backup(dst)
            src.close()
            dst.close()
            os.rename(old_path, old_path + ".backup")
        except Exception:
            pass
        return

    # 情况 2: data.db 已存在但 users 表可能为空 → 补充迁移用户数据
    try:
        dst = sqlite3.connect(new_path)
        has_users = dst.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='users'"
        ).fetchone()[0]
        if not has_users:
            dst.close()
            return
        user_count = dst.execute("SELECT COUNT(*) FROM users").fetchone()[0]
        if user_count > 0:
            dst.close()
            return

        # data.db 有 users 表但为空，从 users.db 复制用户数据
        src = sqlite3.connect(old_path)
        src_users = src.execute("SELECT * FROM users").fetchall()
        src_sessions = src.execute("SELECT * FROM user_sessions").fetchall() if src.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='user_sessions'"
        ).fetchone()[0] else []

        if src_users:
            for row in src_users:
                placeholders = ",".join("?" * len(row))
                dst.execute(f"INSERT OR IGNORE INTO users VALUES ({placeholders})", row)
        if src_sessions:
            for row in src_sessions:
                placeholders = ",".join("?" * len(row))
                dst.execute(f"INSERT OR IGNORE INTO user_sessions VALUES ({placeholders})", row)

        dst.commit()
        src.close()
        dst.close()
        os.rename(old_path, old_path + ".backup")
    except Exception:
        pass


def create_default_admin():
    """创建默认管理员账号（如不存在）。

    桌面版（NPT_DESKTOP=1）不预置任何账号：桌面端与网页端共用账号，
    登录时由服务器校验后在本机镜像出本地账号。
    """
    from app.models.database import User
    from app.services.auth_service import auth_service

    db = SessionLocal()
    try:
        if settings.NPT_DESKTOP:
            return

        existing_admin = db.query(User).filter(User.is_admin == True).first()
        if existing_admin is None:
            admin = User(
                username="admin",
                password_hash=auth_service.hash_password("admin123"),
                is_admin=True,
                is_active=True,
                must_change_password=True,
                license_expiry=None,
                city=None,
                operator=None,
            )
            db.add(admin)
            db.commit()
    finally:
        db.close()
