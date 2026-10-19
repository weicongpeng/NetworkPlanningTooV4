# backend/tests/test_duplicate_columns.py
"""工参（复杂表头）导入回归：重复列名、缺失必需列、不合规文件的报错与数据保护。

历史故障 1：清理表头只取第一行「\n 之前的中文名」，NR 表两列都叫「小区名称」，
    重名列让 df[col] 返回 DataFrame 而非 Series，下游 .str 报
    'DataFrame' object has no attribute 'str'，上传解析直接失败。
历史故障 2：不合法的工参文件在解析前就把已入库的旧工参删掉，且报错文案不可操作。
"""
import pandas as pd

from app.services.data_service import data_service
from app.services.distance_match_service import read_arbitrary_sheet
from app.utils.excel_columns import dedupe_column_names


def test_dedupe_column_names():
    """重复列名保留首个，后续追加 #2/#3；空列名同样参与去重"""
    assert dedupe_column_names(["小区名称", "gNodeB标识", "小区名称", "小区名称"]) == [
        "小区名称", "gNodeB标识", "小区名称#2", "小区名称#3",
    ]
    assert dedupe_column_names(["", "x", ""]) == ["", "x", "#2"]


def _write_vendor_style_xlsx(path, sheet_name: str = "NR Project Parameters") -> None:
    """写出厂商风复杂表头：第 1 行「中文名\\n英文名\\n元数据」，第 2-3 行元数据，第 4 行起数据。"""
    header = [
        "小区名称\nCELL NAME\nString[0..128]",
        "gNodeB标识\ngNodeB ID\nLong:[0..1048575]",
        "小区标识\ncellLocalId\nInteger:[0~2147483647]",
        "基站名称\ngNodeB Name\nString[0..128]",
        "基站经度\ngNodeB Longitude Double:[-180..180]",
        "基站纬度\ngNodeB Latitude\nDouble:[-90..90]",
        "\ngNodeBLength\nLong:[0..999999]",  # 首行为空：取英文名兜底，避免生成空列名
        "移动国家码\nMCC\nString:[3..3]",
        "移动网络码\nMNC\nString:[2..3]",
        "小区名称\nCELL NAME\nString[0..128]",  # 与第 1 列重名（真实文件即如此）
        "物理小区识别码\nPCI\nLong:[0..1007]",
    ]
    rows = [
        header,
        ["必填"] * len(header),
        ["非必填"] * len(header),
        ["Cell_A", 7905741, 1, "站A", 114.55, 24.03, 3, 460, 11, "Cell_A", 1],
        ["Cell_B", 7905741, 2, "站A", 114.55, 24.03, 3, 460, 11, "Cell_B", 2],
    ]
    pd.DataFrame(rows).to_excel(path, sheet_name=sheet_name, header=False, index=False)


def test_full_params_sheet_with_duplicate_columns(tmp_path):
    """重复列名 + 空首行列名：全量工参解析应成功且字段取值正确"""
    path = tmp_path / "ProjectParameter_dup.xlsx"
    _write_vendor_style_xlsx(path)
    data_service.full_params_import_warnings = []

    sites = data_service._parse_full_params_sheet(
        pd.ExcelFile(path), "NR Project Parameters", "NR"
    )

    assert [s["id"] for s in sites] == ["7905741"]
    site = sites[0]
    assert site["name"] == "站A"
    assert site["longitude"] == 114.55 and site["latitude"] == 24.03
    # 小区名称取首个「小区名称」列（两列内容一致）
    assert sorted(c["name"] for c in site["sectors"]) == ["Cell_A", "Cell_B"]
    assert sorted(c["id"] for c in site["sectors"]) == ["1", "2"]
    # 重复列名导入成功，但要留下导入提醒（前端黄色提示）
    assert data_service.full_params_import_warnings == [
        {"code": "duplicate_columns", "network": "NR", "columns": ["小区名称"]}
    ]


def test_distance_match_reads_sheet_with_duplicate_columns(tmp_path):
    """同一份表在距离匹配读取路径也应成功（此前抛 Length mismatch）"""
    path = tmp_path / "ProjectParameter_dup.xlsx"
    _write_vendor_style_xlsx(path)

    df = read_arbitrary_sheet(str(path), "NR Project Parameters", prefer_cell=True)

    assert list(df.columns) == ["CELL", "LON", "LAT"]
    assert sorted(df["CELL"].tolist()) == ["Cell_A", "Cell_B"]


def _write_full_params_missing_coords(path) -> None:
    """缺「基站经度/基站纬度」列的全量工参（其余结构正常）"""
    header = [
        "小区名称\nCELL NAME\nString[0..128]",
        "gNodeB标识\ngNodeB ID\nLong:[0..1048575]",
        "小区标识\ncellLocalId\nInteger:[0~2147483647]",
        "物理小区识别码\nPCI\nLong:[0..1007]",
    ]
    rows = [header, ["必填"] * len(header), ["非必填"] * len(header), ["Cell_A", 7905741, 1, 1]]
    pd.DataFrame(rows).to_excel(path, sheet_name="NR Project Parameters", header=False, index=False)


def _fp_df(rows):
    """按全量工参列名构造 DataFrame（字段可覆盖）"""
    default = {
        "小区名称": "X", "基站名称": "站", "gNodeB标识": "0", "小区标识": "0",
        "基站经度": 113.0, "基站纬度": 23.0, "移动国家码": "460", "移动网络码": "11",
        "天线方向角": 0, "天线挂高": 30, "物理小区识别码": 0, "填写SSB频点": 327040.0,
        "跟踪区码": 1, "小区覆盖类型": 1, "是否共享": "否", "第一分组": "电信中兴",
        "管理网元ID": "2001",
    }
    return pd.DataFrame([{**default, **r} for r in rows])


def test_data_level_import_warnings():
    """数据级提醒：坐标缺失/为 0、小区标识为空、基站标识为空被丢弃（均不阻断导入）"""
    data_service.full_params_import_warnings = []
    df = _fp_df([
        {"gNodeB标识": "1", "小区标识": "1", "基站经度": 0, "基站纬度": 0},
        {"gNodeB标识": "1", "小区标识": "2", "基站经度": 113.1, "基站纬度": 23.1},
        {"gNodeB标识": "2", "小区标识": None, "基站经度": 113.2, "基站纬度": 23.2},
        {"gNodeB标识": None, "小区标识": "9", "基站经度": 113.3, "基站纬度": 23.3},
    ])

    sites = data_service._parse_full_params_dataframe(df, "NR")

    assert sum(len(s["sectors"]) for s in sites) == 3  # 基站标识为空的行被丢弃
    assert {"code": "coord_zero", "network": "NR", "count": 1} in data_service.full_params_import_warnings
    assert {"code": "sector_id_missing", "network": "NR", "count": 1} in data_service.full_params_import_warnings
    assert {"code": "site_id_dropped", "network": "NR", "count": 1} in data_service.full_params_import_warnings


def test_coord_zero_counts_deduped_cells():
    """坐标缺失提醒按去重后的入库记录统计

    回归：源文件里同一小区可能有多行（重复行、NR 共享小区的多条 PLMN 行），
    去重前按行数统计会把 4 条入库记录报成 8 个，网页端提示与落库结果对不上
    （桌面端按自己的解析结果提示 4 个，两端不一致）。
    """
    data_service.full_params_import_warnings = []
    df = _fp_df([
        # 同一 NR 小区（460-11）重复两行，基站坐标缺失
        {"gNodeB标识": "1", "小区标识": "1", "基站经度": None, "基站纬度": None, "移动网络码": "11"},
        {"gNodeB标识": "1", "小区标识": "1", "基站经度": None, "基站纬度": None, "移动网络码": "11"},
        # 共享小区的另一条 PLMN 行（460-01），同为缺失坐标，是独立入库记录
        {"gNodeB标识": "1", "小区标识": "1", "基站经度": None, "基站纬度": None, "移动网络码": "01"},
        {"gNodeB标识": "1", "小区标识": "2", "基站经度": 113.1, "基站纬度": 23.1},
    ])

    sites = data_service._parse_full_params_dataframe(df, "NR")

    zero_cells = sum(
        1 for s in sites for c in s["sectors"]
        if not c.get("longitude") or not c.get("latitude")
    )
    assert {"code": "coord_zero", "network": "NR", "count": zero_cells} in \
        data_service.full_params_import_warnings
    assert zero_cells == 2  # 重复行被去重，只剩两条 PLMN 记录


def test_backfill_coord_zero_warnings_from_db(tmp_path, monkeypatch):
    """存量条目：按库内小区记录重算坐标缺失提醒（旧 metadata 里的 8 修正为 4）"""
    import json
    import uuid

    from app.core.database import SessionLocal
    from app.models.database import Site, Sector, Workbook

    wb_id = f"test-warn-{uuid.uuid4()}"
    db = SessionLocal()
    try:
        db.add(Workbook(
            id=wb_id, user_id=1, name="warn-test", file_type="full_params",
            status="ready", created_at="2026-10-11T18:35:08",
            metadata_json=json.dumps({
                "importWarnings": [
                    {"code": "coord_zero", "network": "NR", "count": 8},   # 旧口径（偏大）
                    {"code": "single_network", "present": "LTE", "missing": "NR"},
                ]
            }, ensure_ascii=False),
        ))
        db.flush()  # 先落 Workbook，满足 Site 的外键约束
        site = Site(workbook_id=wb_id, user_id=1, site_id="7906591", name="共享站",
                    network_type="NR", longitude=113.0, latitude=23.0)
        db.add(site)
        db.flush()
        # 库内 4 条 NR 记录缺坐标（2 个共享小区 × 2 条 PLMN）+ 1 条正常
        for cell, mnc in (("104", "11"), ("104", "01"), ("4", "11"), ("4", "01")):
            db.add(Sector(site_id_fk=site.id, workbook_id=wb_id, user_id=1,
                          sector_id=cell, name=f"NR-{cell}", longitude=0, latitude=0,
                          azimuth=0, mcc="460", mnc=mnc))
        db.add(Sector(site_id_fk=site.id, workbook_id=wb_id, user_id=1,
                      sector_id="9", name="NR-9", longitude=113.0, latitude=23.0,
                      azimuth=0, mcc="460", mnc="11"))
        db.commit()
    finally:
        db.close()

    monkeypatch.setattr(data_service, "data_index_file", tmp_path / "index.json")
    data_service.index[wb_id] = {
        "id": wb_id, "fileType": "full_params", "name": "warn.xlsx",
        "metadata": {
            "importWarnings": [
                {"code": "coord_zero", "network": "NR", "count": 8},
                {"code": "single_network", "present": "LTE", "missing": "NR"},
            ]
        },
    }
    try:
        assert data_service.backfill_coord_zero_warnings() == 1
        warnings = data_service.index[wb_id]["metadata"]["importWarnings"]
        assert {"code": "coord_zero", "network": "NR", "count": 4} in warnings
        # 其它提醒原样保留
        assert {"code": "single_network", "present": "LTE", "missing": "NR"} in warnings

        # 已写回 SQLite（启动时索引由该表重建，不写回会回滚）
        db = SessionLocal()
        try:
            wb = db.query(Workbook).filter(Workbook.id == wb_id).first()
            assert json.loads(wb.metadata_json)["importWarnings"] == warnings
        finally:
            db.close()

        # 幂等：再跑一次不再修改
        assert data_service.backfill_coord_zero_warnings() == 0
    finally:
        data_service.index.pop(wb_id, None)
        db = SessionLocal()
        try:
            for s in db.query(Sector).filter(Sector.workbook_id == wb_id).all():
                db.delete(s)
            for s in db.query(Site).filter(Site.workbook_id == wb_id).all():
                db.delete(s)
            row = db.query(Workbook).filter(Workbook.id == wb_id).first()
            if row:
                db.delete(row)
            db.commit()
        finally:
            db.close()


def test_single_network_import_warning():
    """只含单一制式时提醒可能漏传（不影响导入）"""
    data_service.full_params_import_warnings = []
    data_service._collect_file_level_import_warnings({"LTE": [{"id": "1"}]})
    assert data_service.full_params_import_warnings == [
        {"code": "single_network", "present": "LTE", "missing": "NR"}
    ]

    data_service.full_params_import_warnings = []
    data_service._collect_file_level_import_warnings({"LTE": [{"id": "1"}], "NR": [{"id": "2"}]})
    assert data_service.full_params_import_warnings == []


def test_invalid_full_params_upload_reports_reason_and_keeps_existing(tmp_path, monkeypatch):
    """不合法的工参上传：状态置 error 且给出可操作原因，不能删除已入库的旧工参"""
    import app.core.database as core_database
    from app.core.config import settings

    uploads = tmp_path / "uploads"
    uploads.mkdir()
    monkeypatch.setattr(settings, "UPLOAD_DIR", uploads)
    monkeypatch.setattr(settings, "DATA_DIR", tmp_path)
    monkeypatch.setattr(data_service, "data_index_file", tmp_path / "index.json")
    # 不触碰真实数据库：TaskResult 重置失败仅告警，非致命
    monkeypatch.setattr(core_database, "SessionLocal", lambda: (_ for _ in ()).throw(RuntimeError("test: DB disabled")))

    new_id, old_id = "test-bad-full-params", "test-old-full-params"
    _write_full_params_missing_coords(uploads / f"{new_id}.xlsx")

    deleted = []
    monkeypatch.setattr(data_service, "delete_data", lambda did, *a, **kw: deleted.append(did))
    monkeypatch.setattr(data_service, "index", {
        new_id: {"id": new_id, "name": "ProjectParameter_mongoose_test.xlsx", "status": "processing"},
        old_id: {"id": old_id, "name": "old-full-params.xlsx", "fileType": "full_params", "status": "ready"},
    })

    data_service._process_upload_sync(new_id)

    entry = data_service.index[new_id]
    assert entry["status"] == "error"
    assert "基站经度" in entry["errorMessage"]
    assert "重新导入" in entry["errorMessage"]
    assert deleted == [], "不合法的文件不应删除已有工参"
