"""桌面端共享模式：修订号、数据包打包/解包、影子账号、单用户形态。"""
from __future__ import annotations

import json
import zipfile

import pytest

from app.core.config import settings
from app.models.database import DesktopLicense, Layer, User


# ---------------------------------------------------------------- 修订号

def test_revision_bump_ensure_and_tombstone():
    from app.services import dataset_revision_service as revs

    data_id = "rev-test-0001"
    try:
        # 首次出现：补建初始修订号（否则桌面端无法建立基线，每次都误判为"有更新"）
        assert revs.ensure({data_id: {"city": "广州", "operator": "移动"}}) == {data_id: 1}
        assert revs.bump(data_id) == 2
        assert revs.bump(data_id) == 3

        row = revs.get(data_id)
        assert row["rev"] == 3 and row["deleted"] is False
        assert row["city"] == "广州" and row["operator"] == "移动"

        # 删除必须写墓碑：否则客户端的"本地删除"会被当成"本地新建"再推上来
        assert revs.mark_deleted(data_id, city="广州", operator="移动") == 4
        assert revs.get(data_id)["deleted"] is True

        # 墓碑能被按组列出（数据集已从索引移除，只有修订记录知道它属于哪组）
        tombs = [r for r in revs.list_group("广州", "移动") if r["data_id"] == data_id]
        assert tombs and tombs[0]["deleted"] is True
        assert not [r for r in revs.list_group("深圳", "移动") if r["data_id"] == data_id]
    finally:
        revs.remove(data_id)


# ---------------------------------------------------------------- 数据包

def test_package_roundtrip_map_dataset(tmp_path, monkeypatch):
    """打包 → 解包：文件还原、组被接收方覆盖、重复解包不产生重复图层文件。"""
    from app.services import desktop_dataset_packager as pkg
    from app.services.data_service import data_service

    data_id = "pkg-test-0001"
    monkeypatch.setattr(settings, "DATA_DIR", tmp_path / "data")
    data_dir = settings.DATA_DIR / data_id
    data_dir.mkdir(parents=True)
    (data_dir / "layer.tab").write_text("!table\n!version 300\n", encoding="utf-8")
    (data_dir / "layer.dat").write_bytes(b"\x03dummy")
    (data_dir / "layers.json").write_text(
        json.dumps([{"id": "pkg-layer-1", "name": "图层一", "file_path": str(data_dir / "layer.tab")}]),
        encoding="utf-8",
    )

    entry = {
        "id": data_id,
        "name": "测试图层",
        "type": "map",
        "subType": "mapinfo",
        "user_id": 1,
        "city": "广州",
        "operator": "移动",
        "status": "ready",
        "metadata": {
            "layerCount": 1,
            "layers": [{"id": "pkg-layer-1", "name": "图层一",
                        "file_path": str(data_dir / "layer.tab"), "geometry_type": "point"}],
        },
    }
    from app.core.database import SessionLocal

    db = SessionLocal()
    try:
        receiver_id = db.query(User).order_by(User.id.asc()).first().id
    finally:
        db.close()

    index_backup = dict(data_service.index)
    index_file_backup = data_service.data_index_file
    monkeypatch.setattr(data_service, "data_index_file", tmp_path / "index.json")
    data_service.index[data_id] = entry

    try:
        package = pkg.build_package(data_id)
        zip_path = package["path"]
        assert zip_path.is_file() and package["sha256"]

        with zipfile.ZipFile(zip_path) as zf:
            assert "meta.json" in zf.namelist()
            assert "layer.tab" in zf.namelist()

        # 接收方组与包内组不同 → 强制用接收方组盖章（杜绝跨组污染）
        result = pkg.install_package(
            zip_path, user_id=receiver_id, city="深圳", operator="电信", username="desktop-7"
        )
        assert result == {"data_id": data_id, "type": "map"}
        installed = data_service.index[data_id]
        assert installed["city"] == "深圳" and installed["operator"] == "电信"
        assert installed["user_id"] == receiver_id
        assert (settings.DATA_DIR / data_id / "layer.tab").is_file()

        # 重复解包：先删后插，文件数量不变（不会叠加出第二份）
        before = sorted(p.name for p in (settings.DATA_DIR / data_id).iterdir())
        pkg.install_package(zip_path, user_id=receiver_id, city="深圳", operator="电信")
        after = sorted(p.name for p in (settings.DATA_DIR / data_id).iterdir())
        assert before == after

        from app.services import dataset_revision_service as revs

        assert (revs.get(data_id) or {}).get("deleted") is False
        db = SessionLocal()
        try:
            assert db.query(Layer).filter(Layer.id == "pkg-layer-1").first() is not None
            db.query(Layer).filter(Layer.id == "pkg-layer-1").delete()
            db.commit()
        finally:
            db.close()
        revs.remove(data_id)
    finally:
        data_service.index.clear()
        data_service.index.update(index_backup)
        monkeypatch.setattr(data_service, "data_index_file", index_file_backup)
        data_service.index.pop(data_id, None)


def test_package_rejects_bad_meta(tmp_path):
    from app.core.database import SessionLocal

    from app.services import desktop_dataset_packager as pkg

    db = SessionLocal()
    try:
        user_id = db.query(User).order_by(User.id.asc()).first().id
    finally:
        db.close()

    # 缺少 meta.json
    empty = tmp_path / "empty.zip"
    with zipfile.ZipFile(empty, "w") as zf:
        zf.writestr("layer.tab", "x")
    with pytest.raises(pkg.DatasetPackageError):
        pkg.read_package_meta(empty)

    # 版本不符
    bad = tmp_path / "bad.zip"
    with zipfile.ZipFile(bad, "w") as zf:
        zf.writestr("meta.json", json.dumps({"version": 99, "data_id": "x", "entry": {}}))
    assert pkg.read_package_meta(bad)["version"] == 99
    with pytest.raises(pkg.DatasetPackageError):
        pkg.install_package(bad, user_id=user_id, city="广州", operator="移动")


# ---------------------------------------------------------------- 影子账号

def test_shadow_user_created_and_follows_group():
    from app.core.database import SessionLocal
    from app.services.desktop_license_service import desktop_license_service, ensure_shadow_user

    db = SessionLocal()
    record = None
    try:
        record, _code = desktop_license_service.create(
            db, licensee_username="影子账号测试", city="广州", operator="移动", with_code=False
        )
        assert record.city == "广州"

        user = ensure_shadow_user(db, record)
        db.commit()
        assert user.username == f"desktop-{record.id}"
        assert user.is_active is False and user.is_desktop_shadow is True
        assert (user.city, user.operator) == ("广州", "移动")

        # 管理员改组 → 影子账号跟随，否则桌面端同步上来的数据会落进旧组而"消失"
        desktop_license_service.update(db, record.id, city="深圳", operator="联通")
        again = ensure_shadow_user(db, record)
        db.commit()
        assert (again.city, again.operator) == ("深圳", "联通")
    finally:
        if record is not None:
            db.query(User).filter(User.username == f"desktop-{record.id}").delete()
            db.query(DesktopLicense).filter(DesktopLicense.id == record.id).delete()
            db.commit()
        db.close()


# ---------------------------------------------------------------- 单用户形态

def test_desktop_mode_uses_owner_instead_of_admin(monkeypatch):
    """桌面模式不再创建 admin/admin123，而是确保唯一 owner 账号。"""
    import app.core.database as database

    monkeypatch.setattr(settings, "NPT_DESKTOP", True)
    calls = []

    def fake_ensure(db, User, auth_service):
        calls.append("owner")

    monkeypatch.setattr(database, "_ensure_desktop_owner", fake_ensure)
    database.create_default_admin()
    assert calls == ["owner"]
    assert database.DESKTOP_OWNER_USERNAME == "owner"
