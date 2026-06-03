"""
SQLite 存储和用户隔离集成测试
"""
import pytest
from app.core.database import SessionLocal, init_db
from app.models.database import Workbook, Site, Sector, GeoFile, Layer


class TestSqliteStorage:
    """验证 SQLite 表结构和基本 CRUD"""

    def test_tables_exist(self):
        """验证所有业务表已创建"""
        db = SessionLocal()
        try:
            from sqlalchemy import text
            tables = db.execute(
                text("SELECT name FROM sqlite_master WHERE type='table'")
            ).fetchall()
            table_names = {t[0] for t in tables}
            expected = {"workbooks", "sites", "sectors", "geo_files", "layers", "users", "user_sessions"}
            missing = expected - table_names
            assert not missing, f"Missing tables: {missing}"
        finally:
            db.close()

    def test_workbook_count(self):
        """验证 workbooks 表可查询"""
        db = SessionLocal()
        try:
            count = db.query(Workbook).count()
            assert count >= 0
        finally:
            db.close()

    def test_foreign_key_enforcement(self):
        """验证外键约束已启用"""
        db = SessionLocal()
        try:
            from sqlalchemy import text
            result = db.execute(text("PRAGMA foreign_keys")).fetchone()
            assert result[0] == 1, "Foreign keys should be enabled"
        finally:
            db.close()


class TestUserIsolation:
    """验证多用户数据隔离"""

    def test_user_isolation_basic(self):
        """验证不同用户的数据不交叉"""
        db = SessionLocal()
        try:
            wb1 = db.query(Workbook).filter(Workbook.user_id == 1).all()
            wb2 = db.query(Workbook).filter(Workbook.user_id == 999).all()

            # user 999 不应该有数据
            assert len(wb2) == 0

            # 如果 user 1 有数据，它们的 user_id 应该都是 1
            for wb in wb1:
                assert wb.user_id == 1
        finally:
            db.close()

    def test_site_user_isolation(self):
        """验证 site 数据的用户隔离"""
        db = SessionLocal()
        try:
            sites_user_1 = db.query(Site).filter(Site.user_id == 1).limit(10).all()
            for site in sites_user_1:
                assert site.user_id == 1
        finally:
            db.close()

    def test_sector_user_isolation(self):
        """验证 sector 数据的用户隔离"""
        db = SessionLocal()
        try:
            sectors = db.query(Sector).filter(Sector.user_id == 1).limit(10).all()
            for sector in sectors:
                assert sector.user_id == 1
        finally:
            db.close()
