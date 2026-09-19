"""查询/更新：搜索 + 批量更新/删除测试"""
import pytest
from app.services.data_service import data_service


@pytest.fixture()
def query_env():
    """构造含 LTE/NR 多个站点/小区 + 全量工参 Excel 的环境（DB + 文件系统隔离）"""
    import uuid
    from app.core.database import SessionLocal
    from app.models.database import Workbook, Site, Sector

    wb_id = f"test-q-{uuid.uuid4()}"
    db = SessionLocal()
    db.add(Workbook(id=wb_id, user_id=1, name="q-test", file_type="full_params",
                    status="completed", created_at="2026-08-26"))
    db.commit()

    def _site(site_id, name, nt, lon, lat, me):
        s = Site(workbook_id=wb_id, user_id=1, site_id=site_id, name=name,
                 network_type=nt, longitude=lon, latitude=lat, managed_element_id=me)
        db.add(s)
        db.flush()
        return s

    lte = _site("111", "天河一号站", "LTE", 113.0, 23.0, "2001")
    nr = _site("222", "天河二号站", "NR", 113.1, 23.1, "2002")
    db.add(Sector(site_id_fk=lte.id, workbook_id=wb_id, user_id=1, sector_id="111_1",
                  name="TH-1", longitude=113.0, latitude=23.0, azimuth=0,
                  frequency=1825.0, cell_cover_type=1))
    db.add(Sector(site_id_fk=lte.id, workbook_id=wb_id, user_id=1, sector_id="111_2",
                  name="TH-2", longitude=113.0, latitude=23.0, azimuth=120))
    db.add(Sector(site_id_fk=nr.id, workbook_id=wb_id, user_id=1, sector_id="222_1",
                  name="NR-1", longitude=113.1, latitude=23.1, azimuth=0,
                  frequency=327040.0, cell_cover_type=4))
    db.commit()
    db.close()
    yield wb_id

    db = SessionLocal()
    try:
        for s in db.query(Sector).filter(Sector.workbook_id == wb_id).all():
            db.delete(s)
        for s in db.query(Site).filter(Site.workbook_id == wb_id).all():
            db.delete(s)
        wb = db.query(Workbook).filter(Workbook.id == wb_id).first()
        if wb:
            db.delete(wb)
        db.commit()
    finally:
        db.close()


def test_search_by_cell_name(query_env):
    data_service._invalidate_cell_search_index()
    r = data_service.search_cells("TH-", workbook_id=query_env)
    names = {i["cellName"] for i in r}
    assert names == {"TH-1", "TH-2"}


def test_search_by_site_id(query_env):
    data_service._invalidate_cell_search_index()
    r = data_service.search_cells("222", workbook_id=query_env)
    assert {i["cellName"] for i in r} == {"NR-1"}


def test_search_by_me_id(query_env):
    data_service._invalidate_cell_search_index()
    r = data_service.search_cells("2001", workbook_id=query_env)
    assert {i["cellName"] for i in r} == {"TH-1", "TH-2"}


def test_search_by_site_name(query_env):
    data_service._invalidate_cell_search_index()
    r = data_service.search_cells("天河", workbook_id=query_env)
    assert {i["cellName"] for i in r} == {"TH-1", "TH-2", "NR-1"}
    assert {i["siteName"] for i in r} == {"天河一号站", "天河二号站"}


def test_search_case_insensitive_and_rowkey(query_env):
    data_service._invalidate_cell_search_index()
    r = data_service.search_cells("th-1", workbook_id=query_env)
    assert len(r) == 1
    item = r[0]
    assert item["rowKey"].count(":") == 1          # "site_id:sector_id"
    assert item["networkType"] == "LTE"


def test_search_network_type_filter(query_env):
    data_service._invalidate_cell_search_index()
    r = data_service.search_cells("天河", network_type="NR", workbook_id=query_env)
    assert {i["cellName"] for i in r} == {"NR-1"}


def test_search_empty_result_and_limit(query_env):
    data_service._invalidate_cell_search_index()
    assert data_service.search_cells("不存在", workbook_id=query_env) == []
    r = data_service.search_cells("天", limit=1, workbook_id=query_env)
    assert len(r) == 1  # 只返回 1 条


@pytest.fixture()
def shared_env():
    """NR 共享小区场景：同基站同小区、不同 MNC 的两条 PLMN 记录 + 一条真重复行"""
    import uuid
    from app.core.database import SessionLocal
    from app.models.database import Workbook, Site, Sector

    wb_id = f"test-shared-{uuid.uuid4()}"
    db = SessionLocal()
    db.add(Workbook(id=wb_id, user_id=1, name="shared-test", file_type="full_params",
                    status="completed", created_at="2026-08-30"))
    db.flush()
    s = Site(workbook_id=wb_id, user_id=1, site_id="9001", name="共享基站",
             network_type="NR", longitude=114.0, latitude=23.0, managed_element_id="9001",
             mcc="460")
    db.add(s)
    db.flush()
    # 共享小区 cell=1：两条 PLMN（电信 460-11 / 联通 460-01），按工参唯一键均应保留
    for mnc in ("11", "1"):
        db.add(Sector(site_id_fk=s.id, workbook_id=wb_id, user_id=1, sector_id="9001_1",
                      name="SHARED-1", longitude=114.0, latitude=23.0, azimuth=0,
                      frequency=327040.0, cell_cover_type=1, mcc="460", mnc=mnc))
    # 真重复 cell=2：MCC/MNC/基站/小区完全相同的两行，应按唯一键去重为 1
    for _ in range(2):
        db.add(Sector(site_id_fk=s.id, workbook_id=wb_id, user_id=1, sector_id="9001_2",
                      name="DUP-2", longitude=114.0, latitude=23.0, azimuth=60,
                      frequency=327040.0, cell_cover_type=1, mcc="460", mnc="11"))
    db.commit()
    db.close()
    yield wb_id

    db = SessionLocal()
    try:
        for x in db.query(Sector).filter(Sector.workbook_id == wb_id).all():
            db.delete(x)
        for x in db.query(Site).filter(Site.workbook_id == wb_id).all():
            db.delete(x)
        wb = db.query(Workbook).filter(Workbook.id == wb_id).first()
        if wb:
            db.delete(wb)
        db.commit()
    finally:
        db.close()


def test_search_nr_shared_cell_keeps_two_plmn(shared_env):
    """共享小区：同基站/小区、不同 MNC 的两条 PLMN 记录都应加载且可区分（不折叠成一条）"""
    data_service._invalidate_cell_search_index()
    r = data_service.search_cells("SHARED-1", network_type="NR", workbook_id=shared_env)
    assert len(r) == 2
    assert {i["mnc"] for i in r} == {"11", "1"}          # 电信 / 联通两条 PLMN
    assert len({i["rowKey"] for i in r}) == 2           # 行键不同，可分别定位/编辑


def test_search_nr_true_duplicate_deduped(shared_env):
    """真重复：MCC/MNC/基站/小区完全相同的两行，按工参唯一键去重为 1 条"""
    data_service._invalidate_cell_search_index()
    r = data_service.search_cells("DUP-2", network_type="NR", workbook_id=shared_env)
    assert len(r) == 1
    assert r[0]["mnc"] == "11"


@pytest.fixture()
def excel_env(query_env, tmp_path, monkeypatch):
    """query_env 之上叠加隔离文件系统 + 最小全量工参 Excel"""
    from openpyxl import Workbook
    from app.core.config import settings
    from app.services.data_service import data_service

    monkeypatch.setattr(settings, "DATA_DIR", tmp_path)
    monkeypatch.setattr(data_service, "data_index_file", tmp_path / "index.json")

    excel_path = tmp_path / query_env / "original.xlsx"
    excel_path.parent.mkdir(parents=True, exist_ok=True)
    wb = Workbook()
    lte_ws = wb.active
    lte_ws.title = "LTE Project Parameters"
    lte_ws.append(["管理网元ID", "eNodeB标识", "小区标识", "小区名称",
                   "小区经度", "小区纬度", "天线方向角", "下行链路的中心载频", "小区覆盖类型"])
    lte_ws.append(["2001", 111, 1, "TH-1", 113.0, 23.0, 0, 1825.0, 1])
    lte_ws.append(["2001", 111, 2, "TH-2", 113.0, 23.0, 120, 1825.0, 1])
    nr_ws = wb.create_sheet("NR Project Parameters")
    nr_ws.append(["管理网元ID", "gNodeB标识", "小区标识", "小区名称",
                  "小区经度", "小区纬度", "天线方向角", "填写SSB频点", "小区覆盖类型"])
    nr_ws.append(["2002", 222, 1, "NR-1", 113.1, 23.1, 0, 327040.0, 4])
    wb.save(excel_path)
    wb.close()

    data_service.index[query_env] = {"fileType": "full_params", "id": query_env}
    yield query_env
    data_service.index.pop(query_env, None)


def test_validate_cell_fields(query_env):
    ok, errs = data_service.validate_cell_fields({
        "managedElementId": "2001", "siteId": "111", "cellId": "1",
        "cellName": "X", "mnc": "11", "longitude": 113, "latitude": 23,
        "azimuth": 120, "frequency": "1825", "cellCoverType": 1,
    }, "LTE")
    assert ok and not errs


def test_validate_cell_fields_out_of_range(query_env):
    ok, errs = data_service.validate_cell_fields({
        "managedElementId": "2001", "siteId": "111", "cellId": "1",
        "cellName": "X", "mnc": "1", "longitude": 999, "latitude": 999,
        "azimuth": 999, "frequency": "abc", "cellCoverType": 4,
    }, "LTE")
    assert not ok
    joined = "；".join(errs)
    assert "经度" in joined and "纬度" in joined and "方向角" in joined
    assert "MNC" in joined and "频点" in joined


def test_bulk_update_cell(excel_env):
    from app.core.database import SessionLocal
    from app.models.database import Sector

    data_service._invalidate_cell_search_index()
    hit = data_service.search_cells("TH-1", workbook_id=excel_env)[0]
    row_key = hit["rowKey"]

    res = data_service.bulk_update_cells(
        [{"rowKey": row_key, "networkType": "LTE", "fields": {"cellName": "TH-1-改", "azimuth": 90}}],
        [], user_id=1, workbook_id=excel_env,
    )
    assert res["updated"] == 1 and res["deleted"] == 0
    item = res["results"][0]
    assert item["success"] and item["type"] == "update"

    db = SessionLocal()
    try:
        s = db.query(Sector).filter(Sector.id == int(row_key.split(":")[1])).first()
        assert s.name == "TH-1-改" and s.azimuth == 90
    finally:
        db.close()
    names = {i["cellName"] for i in data_service.search_cells("TH-1-改", workbook_id=excel_env)}
    assert "TH-1-改" in names

    # Excel 双写断言：改名/方向角已写入 LTE sheet
    # 归一化比较（Excel 单元格值可能是 int/float/str，如 '2001'/111/'1'）
    from openpyxl import load_workbook
    from pathlib import Path
    from app.core.config import settings
    wb = load_workbook(Path(settings.DATA_DIR) / excel_env / "original.xlsx")
    lte_ws = wb["LTE Project Parameters"]
    rows = list(lte_ws.iter_rows(min_row=2, values_only=True))

    def _norm(v):
        try:
            f = float(str(v).strip())
            return str(int(f)) if f == int(f) else str(f)
        except (ValueError, TypeError):
            return str(v).strip()

    updated_row = [r for r in rows if _norm(r[0]) == "2001" and _norm(r[1]) == "111" and _norm(r[2]) == "1"]
    assert updated_row, "Excel 中找不到 TH-1 数据行"
    assert updated_row[0][3] == "TH-1-改" and _norm(updated_row[0][6]) == "90"
    wb.close()


def test_bulk_update_shared_nr_cell_mnc1_normalized(excel_env):
    """联通共享小区库内 MNC 为入库归一化后的 '1'（非两位），更新非 MNC 字段不应被
    "MNC 必须为 2 位数字" 拦截（bulk_update 读库时应规范为两位补零）"""
    from app.core.database import SessionLocal
    from app.models.database import Sector

    data_service._invalidate_cell_search_index()
    hit = data_service.search_cells("NR-1", network_type="NR", workbook_id=excel_env)[0]
    row_key = hit["rowKey"]

    # 模拟联通共享小区：库内 mcc/mnc 为 460 / '1'
    db = SessionLocal()
    try:
        sec = db.query(Sector).filter(Sector.id == int(row_key.split(":")[1])).first()
        sec.mcc = "460"
        sec.mnc = "1"
        db.commit()
    finally:
        db.close()
    data_service._invalidate_cell_search_index()

    res = data_service.bulk_update_cells(
        [{"rowKey": row_key, "networkType": "NR", "fields": {"cellName": "NR-1-改"}}],
        [], user_id=1, workbook_id=excel_env,
    )
    assert res["updated"] == 1
    item = res["results"][0]
    assert item["success"], f"联通共享小区更新失败: {item.get('message')}"
    assert "MNC" not in (item.get("message") or "")

    # 更新后库内 MNC 已规范为两位 '01'
    db = SessionLocal()
    try:
        sec = db.query(Sector).filter(Sector.id == int(row_key.split(":")[1])).first()
        assert sec.mnc == "01" and sec.mcc == "460"
    finally:
        db.close()


def test_bulk_update_clear_optional_fields(excel_env):
    """删除单元格内容（空字符串）应落库为 NULL/空单元格（回归：旧值保留）"""
    from app.core.database import SessionLocal
    from app.models.database import Sector, Site
    from openpyxl import load_workbook
    from pathlib import Path
    from app.core.config import settings

    data_service._invalidate_cell_search_index()
    hit = data_service.search_cells("TH-1", workbook_id=excel_env)[0]
    row_key = hit["rowKey"]
    sector_pk = int(row_key.split(":")[1])

    # 先写入 mcc/mnc/方向角，确认更新生效（含 sector 表 mcc/mnc 同步）
    res = data_service.bulk_update_cells(
        [{"rowKey": row_key, "networkType": "LTE",
          "fields": {"mcc": "460", "mnc": "11", "azimuth": 90}}],
        [], user_id=1, workbook_id=excel_env,
    )
    assert res["results"][0]["success"], res["results"][0]["message"]
    db = SessionLocal()
    try:
        sec = db.query(Sector).filter(Sector.id == sector_pk).first()
        site = db.query(Site).filter(Site.id == sec.site_id_fk).first()
        assert sec.mcc == "460" and sec.mnc == "11" and sec.azimuth == 90
        assert site.mcc == "460" and site.mnc == "11"
    finally:
        db.close()

    # 清空 mcc/mnc/方向角/频点（模拟删除单元格内容）
    res = data_service.bulk_update_cells(
        [{"rowKey": row_key, "networkType": "LTE",
          "fields": {"mcc": "", "mnc": "", "azimuth": "", "frequency": ""}}],
        [], user_id=1, workbook_id=excel_env,
    )
    assert res["results"][0]["success"], res["results"][0]["message"]
    db = SessionLocal()
    try:
        sec = db.query(Sector).filter(Sector.id == sector_pk).first()
        site = db.query(Site).filter(Site.id == sec.site_id_fk).first()
        assert sec.mcc is None and sec.mnc is None, "sector mcc/mnc 清空后应为 NULL"
        assert site.mcc is None and site.mnc is None, "site mcc/mnc 清空后应为 NULL"
        assert sec.azimuth is None, "方向角清空后应为 NULL"
        assert sec.frequency is None, "频点清空后应为 NULL"
    finally:
        db.close()

    # 再次搜索应读到空值（搜索索引读 sector 表）
    data_service._invalidate_cell_search_index()
    item = data_service.search_cells("TH-1", workbook_id=excel_env)[0]
    assert item["mcc"] is None and item["mnc"] is None
    assert item["azimuth"] is None and item["frequency"] is None

    # Excel 双写：方向角/频点单元格应为空
    wb = load_workbook(Path(settings.DATA_DIR) / excel_env / "original.xlsx")
    lte_ws = wb["LTE Project Parameters"]
    rows = list(lte_ws.iter_rows(min_row=2, values_only=True))

    def _norm(v):
        try:
            f = float(str(v).strip())
            return str(int(f)) if f == int(f) else str(f)
        except (ValueError, TypeError):
            return str(v).strip() if v is not None else ""

    updated_row = [r for r in rows if _norm(r[0]) == "2001" and _norm(r[1]) == "111" and _norm(r[2]) == "1"]
    assert updated_row, "Excel 中找不到 TH-1 数据行"
    assert updated_row[0][6] in (None, ""), f"方向角单元格应为空，实际 {updated_row[0][6]!r}"
    assert updated_row[0][7] in (None, ""), f"频点单元格应为空，实际 {updated_row[0][7]!r}"
    wb.close()


def test_bulk_update_clear_cover_type_and_required(excel_env):
    """覆盖类型清空回退默认 1；必填字段清空应被校验拦截"""
    from app.core.database import SessionLocal
    from app.models.database import Sector

    # NR-1 覆盖类型 4 → 清空 → 落库默认 1
    data_service._invalidate_cell_search_index()
    hit = data_service.search_cells("NR-1", workbook_id=excel_env)[0]
    row_key = hit["rowKey"]
    res = data_service.bulk_update_cells(
        [{"rowKey": row_key, "networkType": "NR", "fields": {"cellCoverType": ""}}],
        [], user_id=1, workbook_id=excel_env,
    )
    assert res["results"][0]["success"], res["results"][0]["message"]
    db = SessionLocal()
    try:
        sec = db.query(Sector).filter(Sector.id == int(row_key.split(":")[1])).first()
        assert sec.cell_cover_type == 1
    finally:
        db.close()

    # 必填字段（小区名称）清空 → 整行拒绝
    res = data_service.bulk_update_cells(
        [{"rowKey": row_key, "networkType": "NR", "fields": {"cellName": ""}}],
        [], user_id=1, workbook_id=excel_env,
    )
    assert res["results"][0]["success"] is False
    assert "必填" in res["results"][0]["message"]


def test_bulk_update_rekey_and_conflict(excel_env):
    data_service._invalidate_cell_search_index()
    hit = data_service.search_cells("TH-2", workbook_id=excel_env)[0]

    # 改键到已占用 (111_1) → 冲突拒绝
    res = data_service.bulk_update_cells(
        [{"rowKey": hit["rowKey"], "networkType": "LTE", "fields": {"cellId": "1"}}],
        [], user_id=1, workbook_id=excel_env,
    )
    assert res["results"][0]["success"] is False
    assert "占用" in res["results"][0]["message"] or "重复" in res["results"][0]["message"]

    # 改键到新站 999（原地改键）
    res = data_service.bulk_update_cells(
        [{"rowKey": hit["rowKey"], "networkType": "LTE",
          "fields": {"siteId": "999", "cellId": "9", "cellName": "TH-2-新"}}],
        [], user_id=1, workbook_id=excel_env,
    )
    assert res["results"][0]["success"]
    names = {i["cellName"] for i in data_service.search_cells("999", workbook_id=excel_env)}
    assert "TH-2-新" in names

    # Excel 双写断言：改键后新键 (999,9) 已写入 LTE sheet，旧键 (111,2) 行消失
    # 归一化比较（Excel 单元格值可能是 int/float/str，如 '999'/'9'）
    from openpyxl import load_workbook
    from pathlib import Path
    from app.core.config import settings
    wb = load_workbook(Path(settings.DATA_DIR) / excel_env / "original.xlsx")
    lte_ws = wb["LTE Project Parameters"]
    rows = list(lte_ws.iter_rows(min_row=2, values_only=True))

    def _norm(v):
        try:
            f = float(str(v).strip())
            return str(int(f)) if f == int(f) else str(f)
        except (ValueError, TypeError):
            return str(v).strip()

    new_key_rows = [r for r in rows if _norm(r[1]) == "999" and _norm(r[2]) == "9"]
    assert new_key_rows, "Excel 中找不到改键后 (999,9) 行"
    assert new_key_rows[0][3] == "TH-2-新"
    assert not any(_norm(r[1]) == "111" and _norm(r[2]) == "2" for r in rows), "旧键 (111,2) 行应已改键"
    wb.close()


def test_bulk_update_cross_type_occupied(excel_env):
    data_service._invalidate_cell_search_index()
    hit = data_service.search_cells("TH-2", network_type="LTE", workbook_id=excel_env)[0]
    res = data_service.bulk_update_cells(
        [{"rowKey": hit["rowKey"], "networkType": "LTE", "fields": {"siteId": "222", "cellId": "1"}}],
        [], user_id=1, workbook_id=excel_env,
    )
    assert res["results"][0]["success"] is False
    assert "NR" in res["results"][0]["message"]


def test_bulk_delete_cascades_site(excel_env):
    from app.core.database import SessionLocal
    from app.models.database import Site

    data_service._invalidate_cell_search_index()
    hits = data_service.search_cells("TH-", workbook_id=excel_env)  # TH-1 + TH-2
    res = data_service.bulk_update_cells(
        [],
        [{"rowKey": h["rowKey"], "networkType": "LTE"} for h in hits],
        user_id=1, workbook_id=excel_env,
    )
    assert res["deleted"] == 2
    db = SessionLocal()
    try:
        assert db.query(Site).filter(Site.workbook_id == excel_env, Site.site_id == "111").first() is None
        assert db.query(Site).filter(Site.workbook_id == excel_env, Site.site_id == "222").first() is not None
    finally:
        db.close()

    # Excel 双写断言：LTE sheet 中 (111,1)/(111,2) 行已删除
    from openpyxl import load_workbook
    from pathlib import Path
    from app.core.config import settings
    wb = load_workbook(Path(settings.DATA_DIR) / excel_env / "original.xlsx")
    lte_ws = wb["LTE Project Parameters"]
    rows = list(lte_ws.iter_rows(min_row=2, values_only=True))
    lte_rows = [r for r in rows if r[0] == "2001"]
    assert not any(r[1] == 111 for r in lte_rows), "Excel 中 (111,*) 行应已删除"
    wb.close()


def test_bulk_delete_multiple_same_key_rows(excel_env, tmp_path, monkeypatch):
    """同键多行删除回归：Excel 中三行同 (111,1)，全删且保留其他行"""
    from openpyxl import Workbook, load_workbook
    from app.core.config import settings
    from pathlib import Path

    # 在 excel_env 基础上，向 LTE sheet 追加两行 (111,1) 副本（共 3 行同键）
    ex_path = Path(settings.DATA_DIR) / excel_env / "original.xlsx"
    # 先还原: bulk 前 Excel 目前含 TH-1(111,1)、TH-2(111,2)；追加 (111,1) 副本
    wb = load_workbook(ex_path)
    lte_ws = wb["LTE Project Parameters"]
    base_row = [r for r in lte_ws.iter_rows(min_row=2, values_only=True)
                if r[1] == 111 and r[2] == 1][0]
    for _ in range(2):
        lte_ws.append(base_row)
    wb.save(ex_path)
    wb.close()

    data_service._invalidate_cell_search_index()
    hit = data_service.search_cells("TH-1", workbook_id=excel_env)[0]

    res = data_service.bulk_update_cells(
        [],
        [{"rowKey": hit["rowKey"], "networkType": "LTE"}],
        user_id=1, workbook_id=excel_env,
    )
    assert res["deleted"] == 1  # DB 侧只删 1 条（主键唯一）

    # Excel 侧：同键 (111,1) 的所有行都应删除（self 删除语义）
    wb = load_workbook(ex_path)
    lte_ws = wb["LTE Project Parameters"]
    rows = list(lte_ws.iter_rows(min_row=2, values_only=True))
    assert not any(r[1] == 111 and r[2] == 1 for r in rows), "Excel 中同键 (111,1) 行应全部删除"
    assert any(r[1] == 111 and r[2] == 2 for r in rows), "TH-2 (111,2) 行应保留"
    wb.close()


def test_search_endpoint_smoke(query_env):
    """search 端点端到端冒烟：注入 index + 鉴权用户 + token"""
    from fastapi.testclient import TestClient
    from app.core.database import SessionLocal, init_db
    from app.models.database import User
    from app.services.auth_service import auth_service
    from app.api import create_app
    from app.services.data_service import data_service

    # 注入 index（同 dup_env 模式：临时移除既有 full_params 条目）
    saved_index = dict(data_service.index)
    for k in [k for k, v in saved_index.items()
              if isinstance(v, dict) and v.get("fileType") == "full_params"]:
        data_service.index.pop(k)
    data_service.index[query_env] = {"fileType": "full_params"}

    init_db()
    username = "q_search_user"
    db = SessionLocal()
    try:
        existing = auth_service.get_user_by_username(db, username)
        if existing:
            db.delete(existing)
            db.commit()
        user, err = auth_service.create_user(db, username, "Test@12345")
        assert err is None
        user.can_cell_query_update = True
        db.commit()
        db.refresh(user)
        token, _ = auth_service.create_access_token(user.id, user.username, False)
    finally:
        db.close()

    try:
        client = TestClient(create_app())
        resp = client.post(
            "/api/v1/data/full-params/cells/search",
            headers={"Authorization": f"Bearer {token}"},
            json={"query": "天河", "limit": 20},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert len(data) == 3
        assert {i["siteName"] for i in data} == {"天河一号站", "天河二号站"}
    finally:
        db = SessionLocal()
        try:
            user = auth_service.get_user_by_username(db, username)
            if user:
                db.delete(user)
                db.commit()
        finally:
            db.close()
        data_service.index.clear()
        data_service.index.update(saved_index)


def test_bulk_update_endpoint_smoke(excel_env):
    """bulk-update 端点端到端冒烟：搜索→改小区名→确认→落库"""
    from fastapi.testclient import TestClient
    from app.core.database import SessionLocal, init_db
    from app.models.database import User, Sector
    from app.services.auth_service import auth_service
    from app.api import create_app
    from app.services.data_service import data_service

    init_db()
    username = "q_update_user"
    db = SessionLocal()
    try:
        existing = auth_service.get_user_by_username(db, username)
        if existing:
            db.delete(existing)
            db.commit()
        user, err = auth_service.create_user(db, username, "Test@12345")
        assert err is None
        user.can_cell_query_update = True
        db.commit()
        db.refresh(user)
        token, _ = auth_service.create_access_token(user.id, user.username, False)
    finally:
        db.close()

    data_service._invalidate_cell_search_index()
    hit = data_service.search_cells("NR-1", workbook_id=excel_env)[0]
    row_key = hit["rowKey"]

    # 端点内部通过 _find_full_params_id() 定位全量工参（不显式传 workbook_id）；
    # 与 test_search_endpoint_smoke 同模式，临时移除历史残留的 full_params 条目，
    # 确保定位到本用例注入的 excel_env（而非真实 index.json/SQLite 的历史条目）
    saved_index = dict(data_service.index)
    for k in [k for k, v in saved_index.items()
              if isinstance(v, dict) and v.get("fileType") == "full_params"]:
        data_service.index.pop(k)
    data_service.index[excel_env] = {"fileType": "full_params", "id": excel_env}

    try:
        client = TestClient(create_app())
        resp = client.post(
            "/api/v1/data/full-params/cells/bulk-update",
            headers={"Authorization": f"Bearer {token}"},
            json={"updates": [{"rowKey": row_key, "networkType": "NR",
                               "fields": {"cellName": "NR-1-改"}}], "deletes": []},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["success"] is True
        assert body["data"]["updated"] == 1
        assert body["data"]["results"][0]["success"] is True
    finally:
        db = SessionLocal()
        try:
            user = auth_service.get_user_by_username(db, username)
            if user:
                db.delete(user)
                db.commit()
        finally:
            db.close()
        data_service.index.clear()
        data_service.index.update(saved_index)


def test_bulk_update_preserves_pure_sector_id(excel_env):
    """全量工参解析入库 sector_id 为纯小区标识（如 '9'）；bulk_update 改非标识字段后不应被
    改写成 '基站_小区'（否则地图属性弹窗"小区ID"显示成 '555_9'）。"""
    from app.core.database import SessionLocal
    from app.models.database import Site, Sector

    db = SessionLocal()
    try:
        site = Site(workbook_id=excel_env, user_id=1, site_id="555", name="纯ID站",
                    network_type="LTE", longitude=113.0, latitude=23.0,
                    managed_element_id="5550")
        db.add(site)
        db.flush()
        db.add(Sector(site_id_fk=site.id, workbook_id=excel_env, user_id=1,
                      sector_id="9", name="纯ID小区", longitude=113.0, latitude=23.0, azimuth=0))
        db.commit()
        site_pk = site.id
        sec = db.query(Sector).filter(Sector.workbook_id == excel_env, Sector.sector_id == "9").first()
        sector_pk = sec.id
    finally:
        db.close()
    data_service._invalidate_cell_search_index()

    res = data_service.bulk_update_cells(
        [{"rowKey": f"{site_pk}:{sector_pk}", "networkType": "LTE",
          "fields": {"cellName": "纯ID小区-改", "azimuth": 120}}],
        [], user_id=1, workbook_id=excel_env,
    )
    assert res["results"][0]["success"], res["results"][0].get("message")

    db = SessionLocal()
    try:
        sec = db.query(Sector).filter(Sector.id == sector_pk).first()
        assert sec.sector_id == "9", f"纯小区标识被污染为 {sec.sector_id}"
        assert sec.azimuth == 120 and sec.name == "纯ID小区-改"
    finally:
        db.close()


def test_excel_delete_nr_shared_cell_plmn_aware(tmp_path):
    """NR 共享小区删除：Excel 行定位必须带 MCC/MNC，只删目标 PLMN 行，保留另一 PLMN。

    回归：旧逻辑 _find_rows 仅按 gNodeB标识+小区标识 匹配，会把同 基站_小区 的
    电信(460-11)/联通(460-01) 两行一起删掉，与 DB（按主键只删一条）不一致。
    """
    from openpyxl import Workbook, load_workbook

    wb = Workbook()
    ws = wb.active
    ws.title = "NR Project Parameters"
    ws.append(["管理网元ID", "gNodeB标识", "小区标识", "小区名称", "移动国家码", "移动网络码",
               "小区经度", "小区纬度", "天线方向角", "填写SSB频点", "小区覆盖类型"])
    ws.append(["2002", 300, 1, "电信小区", 460, 11, 113.0, 23.0, 0, 327040.0, 1])
    ws.append(["2002", 300, 1, "联通小区", 460, "01", 113.0, 23.0, 0, 327040.0, 1])
    ws.append(["2002", 400, 2, "其他小区", 460, 11, 114.0, 24.0, 60, 327040.0, 1])

    deletes = [{
        "rowKey": "1:2", "networkType": "NR",
        "_site_id": "300", "_cell_id": "1",
        "_mcc": "460", "_mnc": "1",   # 联通 PLMN（库内 mnc 归一化为 '1'，Excel 为 '01'）
    }]
    results = [{"rowKey": "1:2", "type": "delete", "success": True, "message": "ok"}]
    data_service._apply_excel_updates(wb, [], deletes, results)
    out = tmp_path / "nr_shared.xlsx"
    wb.save(out)
    wb.close()

    wb2 = load_workbook(out)
    ws2 = wb2["NR Project Parameters"]
    rows = [
        (str(ws2.cell(r, 2).value), str(ws2.cell(r, 3).value),
         str(ws2.cell(r, 5).value), str(ws2.cell(r, 6).value), ws2.cell(r, 4).value)
        for r in range(2, ws2.max_row + 1)
    ]
    wb2.close()

    # 联通(460-01)行已删；电信(460-11)行与无关小区保留
    assert ("300", "1", "460", "11", "电信小区") in rows
    assert not any(name == "联通小区" for *_, name in rows)
    assert ("400", "2", "460", "11", "其他小区") in rows


def test_height_roundtrip(excel_env):
    """站高(天线挂高)：新站录入写入 Sector.height → 搜索带出 → 查询/修改更新写回"""
    from app.core.database import SessionLocal
    from app.models.database import Sector

    # batch_add 走全局 _find_full_params_id()，需隔离 index 只保留本测试工作簿
    saved_index = dict(data_service.index)
    try:
        for k in [k for k, v in saved_index.items()
                  if isinstance(v, dict) and v.get("fileType") == "full_params" and k != excel_env]:
            data_service.index.pop(k, None)
        data_service.index[excel_env] = {"fileType": "full_params", "id": excel_env}

        res = data_service.batch_add_cells_to_full_params([
            {"networkType": "NR", "managedElementId": "2003", "siteId": "700", "cellId": "1",
             "cellName": "站高小区", "mcc": "460", "mnc": "11",
             "longitude": 113.5, "latitude": 23.5, "azimuth": 0, "height": 35,
             "ssbFrequency": "327040", "cellCoverType": 1, "userId": 1},
        ])
        assert res["results"][0]["success"], res["results"][0].get("message")
    finally:
        data_service.index.clear()
        data_service.index.update(saved_index)

    data_service._invalidate_cell_search_index()
    hit = data_service.search_cells("站高小区", "NR", 20, excel_env)[0]
    assert float(hit["height"]) == 35.0

    upd = data_service.bulk_update_cells(
        [{"rowKey": hit["rowKey"], "networkType": "NR", "fields": {"height": "42"}}],
        [], user_id=1, workbook_id=excel_env)
    assert upd["results"][0]["success"], upd["results"][0].get("message")

    db = SessionLocal()
    try:
        sec = db.query(Sector).filter(Sector.id == int(hit["rowKey"].split(":")[1])).first()
        assert float(sec.height) == 42.0
    finally:
        db.close()


def test_validate_height_optional_numeric():
    ok, _ = data_service.validate_cell_fields({
        "managedElementId": "1", "siteId": "1", "cellId": "1", "cellName": "X",
        "longitude": 113, "latitude": 23, "azimuth": 0, "cellCoverType": 1,
    }, "LTE")
    assert ok  # 站高选填，不填不报错
    ok2, errs2 = data_service.validate_cell_fields({
        "managedElementId": "1", "siteId": "1", "cellId": "1", "cellName": "X",
        "longitude": 113, "latitude": 23, "azimuth": 0, "cellCoverType": 1,
        "height": "abc",
    }, "LTE")
    assert not ok2 and any("站高" in e for e in errs2)
