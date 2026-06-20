"""
数据库引擎和会话管理
使用 SQLite + SQLAlchemy ORM
"""
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker, Session, DeclarativeBase
from app.core.config import settings

# SQLite 数据库文件路径
DATABASE_URL = f"sqlite:///{settings.DATA_DIR / 'data.db'}"
OLD_DATABASE_URL = f"sqlite:///{settings.DATA_DIR / 'users.db'}"

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
        User, UserSession, Workbook, Site, Sector, GeoFile, Layer, UserSettings, TaskResult
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

        # 迁移：task_results 表添加 is_applied 列
        tr_cols = [row[1] for row in conn.exec_driver_sql("PRAGMA table_info(task_results)").fetchall()]
        if "is_applied" not in tr_cols:
            conn.exec_driver_sql("ALTER TABLE task_results ADD COLUMN is_applied INTEGER DEFAULT 0")

        # 迁移：user_settings 表添加 created_at 列（如从旧表结构升级）
        us_cols = [row[1] for row in conn.exec_driver_sql("PRAGMA table_info(user_settings)").fetchall() if row[0] >= 0]
        if us_cols and "created_at" not in us_cols:
            conn.exec_driver_sql("ALTER TABLE user_settings ADD COLUMN created_at VARCHAR(30)")
        conn.commit()


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
    """创建默认管理员账号（如不存在）"""
    from app.models.database import User
    from app.services.auth_service import auth_service

    db = SessionLocal()
    try:
        existing_admin = db.query(User).filter(User.is_admin == True).first()
        if existing_admin is None:
            admin = User(
                username="admin",
                password_hash=auth_service.hash_password("admin123"),
                is_admin=True,
                is_active=True,
                must_change_password=True,
                license_expiry=None,
            )
            db.add(admin)
            db.commit()
    finally:
        db.close()
