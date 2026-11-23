# backend/tests/test_table_merge.py
"""表格合并服务与接口测试"""
import os
import tempfile
from pathlib import Path

import pandas as pd
from fastapi.testclient import TestClient

from app.api import create_app
from app.core.config import settings
from app.core.security import require_data_import
from app.services.table_merge_service import (
    MODE_COLUMNS,
    MODE_SHEET,
    MODE_STRUCTURE,
    group_tables,
    plan_merge,
    read_tables,
)


def _make_client():
    app = create_app()
    app.dependency_overrides[require_data_import] = lambda: None
    return TestClient(app)


def _write_xlsx(path, frames):
    with pd.ExcelWriter(path) as w:
        for name, df in frames.items():
            df.to_excel(w, sheet_name=name, index=False)
    return str(path)


def test_merge_same_structure_concatenates_rows():
    """列结构相同的两个文件合并为一张表、行数相加"""
    a = _write_xlsx(
        tempfile.mktemp(suffix=".xlsx"),
        {"表1": pd.DataFrame({"名称": ["A"], "频点": [1]})},
    )
    b = _write_xlsx(
        tempfile.mktemp(suffix=".xlsx"),
        {"表1": pd.DataFrame({"名称": ["B"], "频点": [2]})},
    )
    tables = read_tables("a.xlsx", Path(a)) + read_tables("b.xlsx", Path(b))
    plans = plan_merge(tables, MODE_STRUCTURE, add_source=False, dedupe=False)
    assert len(plans) == 1
    assert plans[0].output_sheet == "表1"
    assert len(plans[0].rows) == 2
    assert plans[0].columns == ["名称", "频点"]
    for p in (a, b):
        os.unlink(p)


def test_merge_multi_sheet_keeps_separate_groups():
    """多 sheet 文件按 sheet 分别汇总；结构不同的表不混在一起"""
    a = _write_xlsx(
        tempfile.mktemp(suffix=".xlsx"),
        {
            "小区": pd.DataFrame({"名称": ["A"], "频点": [1]}),
            "站址": pd.DataFrame({"名称": ["S1"], "经度": [116.0]}),
        },
    )
    b = _write_xlsx(
        tempfile.mktemp(suffix=".xlsx"),
        {"小区": pd.DataFrame({"名称": ["B"], "频点": [2]})},
    )
    tables = read_tables("a.xlsx", Path(a)) + read_tables("b.xlsx", Path(b))
    plans = plan_merge(tables, MODE_STRUCTURE, add_source=False, dedupe=False)
    assert len(plans) == 2
    by_sheet = {p.output_sheet: p for p in plans}
    assert len(by_sheet["小区"].rows) == 2
    assert len(by_sheet["站址"].rows) == 1
    for p in (a, b):
        os.unlink(p)


def test_merge_by_sheet_mode_pairs_same_named_sheets():
    """sheet 模式：同名工作表合并，即便列结构不同也归为一组（列取并集）"""
    a = _write_xlsx(
        tempfile.mktemp(suffix=".xlsx"),
        {"数据": pd.DataFrame({"名称": ["A"], "频点": [1]})},
    )
    b = _write_xlsx(
        tempfile.mktemp(suffix=".xlsx"),
        {"数据": pd.DataFrame({"名称": ["B"], "经度": [116.0]})},
    )
    tables = read_tables("a.xlsx", Path(a)) + read_tables("b.xlsx", Path(b))
    groups = group_tables(tables, mode=MODE_SHEET)
    assert len(groups) == 1
    plans = plan_merge(tables, MODE_SHEET, add_source=False, dedupe=False)
    assert len(plans) == 1
    assert plans[0].columns == ["名称", "频点", "经度"]
    assert len(plans[0].rows) == 2
    for p in (a, b):
        os.unlink(p)


def test_merge_columns_mode_aligns_case_insensitive_into_one_table():
    """columns 模式：多文件不同 sheet 名也合并到一张表，同名列忽略大小写并为一列"""
    a = _write_xlsx(
        tempfile.mktemp(suffix=".xlsx"),
        {"甲": pd.DataFrame({"Name": ["A"], "Frequency": [1]})},
    )
    b = _write_xlsx(
        tempfile.mktemp(suffix=".xlsx"),
        {"乙": pd.DataFrame({"NAME": ["B"], "Longitude": [116.0]})},
    )
    tables = read_tables("a.xlsx", Path(a)) + read_tables("b.xlsx", Path(b))
    assert len(group_tables(tables, mode=MODE_COLUMNS)) == 1
    plans = plan_merge(tables, MODE_COLUMNS, add_source=False, dedupe=False)
    assert len(plans) == 1
    assert plans[0].output_sheet == "合并结果"
    assert plans[0].columns == ["Name", "Frequency", "Longitude"]
    assert plans[0].rows == [["A", 1, None], ["B", None, 116.0]]
    for p in (a, b):
        os.unlink(p)


def test_merge_columns_mode_rejects_multi_sheet_files():
    """columns 模式只接受 CSV 或单 sheet Excel，多 sheet 文件读取/接口均报错"""
    multi = _write_xlsx(
        tempfile.mktemp(suffix=".xlsx"),
        {
            "小区": pd.DataFrame({"名称": ["A"]}),
            "站址": pd.DataFrame({"名称": ["S1"]}),
        },
    )
    try:
        try:
            read_tables("multi.xlsx", Path(multi), require_single_table=True)
            assert False, "多 sheet 文件应当报错"
        except ValueError as e:
            assert "2 个工作表" in str(e)
    finally:
        os.unlink(multi)

    single = _write_xlsx(
        tempfile.mktemp(suffix=".xlsx"),
        {"数据": pd.DataFrame({"名称": ["A"]})},
    )
    csv = tempfile.mktemp(suffix=".csv")
    with open(csv, "w", encoding="utf-8") as f:
        f.write("名称,频点\nB,1\n")
    client = _make_client()
    try:
        with open(single, "rb") as fs, open(csv, "rb") as fc:
            resp = client.post(
                "/api/v1/table-merge/inspect",
                data={"mode": MODE_COLUMNS},
                files=[
                    ("files", ("single.xlsx", fs, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")),
                    ("files", ("b.csv", fc, "text/csv")),
                ],
            )
        assert resp.status_code == 200, resp.text
        assert resp.json()["data"]["total_tables"] == 2
    finally:
        os.unlink(single)
        os.unlink(csv)

    multi = _write_xlsx(
        tempfile.mktemp(suffix=".xlsx"),
        {"小区": pd.DataFrame({"名称": ["A"]}), "站址": pd.DataFrame({"名称": ["S1"]})},
    )
    try:
        with open(multi, "rb") as fm:
            resp = client.post(
                "/api/v1/table-merge/merge",
                data={"mode": MODE_COLUMNS},
                files=[("files", ("multi.xlsx", fm, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"))],
            )
        assert resp.status_code == 400, resp.text
        assert "只包含一个工作表" in resp.json()["detail"]
    finally:
        os.unlink(multi)


def test_merge_columns_mode_endpoint_merges_csv_and_single_sheet():
    """接口：CSV + 单 sheet Excel 按列名合并为一张表（sheet 名不参与分组）"""
    a = _write_xlsx(
        tempfile.mktemp(suffix=".xlsx"),
        {"数据": pd.DataFrame({"Name": ["A"], "Frequency": [1]})},
    )
    csv = tempfile.mktemp(suffix=".csv")
    with open(csv, "w", encoding="utf-8") as f:
        f.write("name,Longitude\nB,116.0\n")
    client = _make_client()
    try:
        with open(a, "rb") as fa, open(csv, "rb") as fc:
            resp = client.post(
                "/api/v1/table-merge/merge",
                data={"mode": MODE_COLUMNS, "add_source": "false", "dedupe": "false"},
                files=[
                    ("files", ("a.xlsx", fa, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")),
                    ("files", ("b.csv", fc, "text/csv")),
                ],
            )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert len(data["sheets"]) == 1
        assert data["sheets"][0]["output_sheet"] == "合并结果"
        assert data["sheets"][0]["row_count"] == 2
        df = pd.read_excel(settings.OUTPUT_DIR / data["filename"], sheet_name="合并结果")
        assert list(df.columns) == ["Name", "Frequency", "Longitude"]
        assert df["Name"].tolist() == ["A", "B"]
        assert pd.isna(df.loc[0, "Longitude"])
        assert df.loc[1, "Longitude"] == 116.0
    finally:
        os.unlink(a)
        os.unlink(csv)


def test_merge_add_source_columns_and_dedupe():
    """附加来源列 + 完全重复行去重"""
    a = _write_xlsx(
        tempfile.mktemp(suffix=".xlsx"),
        {"表1": pd.DataFrame({"名称": ["A", "A"], "频点": [1, 1]})},
    )
    b = _write_xlsx(
        tempfile.mktemp(suffix=".xlsx"),
        {"表1": pd.DataFrame({"名称": ["B"], "频点": [2]})},
    )
    tables = read_tables("a.xlsx", Path(a)) + read_tables("b.xlsx", Path(b))
    plans = plan_merge(tables, MODE_STRUCTURE, add_source=True, dedupe=True)
    assert len(plans) == 1
    assert plans[0].columns[:2] == ["来源文件", "来源Sheet"]
    # A 重复行去重后剩 A、B 两行
    assert len(plans[0].rows) == 2
    assert plans[0].rows[0][0] == "a.xlsx"
    for p in (a, b):
        os.unlink(p)


def test_read_csv_gbk_encoding():
    """GBK 编码的 CSV 也能正确读出中文列名（CSV 单元格按原样保留为文本，不做数值猜测）"""
    tmp = tempfile.mktemp(suffix=".csv")
    with open(tmp, "w", encoding="gbk") as f:
        f.write("名称,频点\nA,1\n")
    tables = read_tables("t.csv", Path(tmp))
    assert len(tables) == 1
    assert tables[0].columns == ["名称", "频点"]
    assert tables[0].rows == [["A", "1"]]
    os.unlink(tmp)


def test_merge_endpoint_writes_output_file():
    """接口：上传两个同格式文件 → 输出单个 Excel，含合并后的数据"""
    a = _write_xlsx(
        tempfile.mktemp(suffix=".xlsx"),
        {"表1": pd.DataFrame({"名称": ["A"], "频点": [1]})},
    )
    b = _write_xlsx(
        tempfile.mktemp(suffix=".xlsx"),
        {"表1": pd.DataFrame({"名称": ["B"], "频点": [2]})},
    )
    client = _make_client()
    try:
        with open(a, "rb") as fa, open(b, "rb") as fb:
            resp = client.post(
                "/api/v1/table-merge/merge",
                data={"mode": MODE_STRUCTURE, "add_source": "false", "dedupe": "false"},
                files=[
                    ("files", ("a.xlsx", fa, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")),
                    ("files", ("b.xlsx", fb, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")),
                ],
            )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["success"] is True
        data = body["data"]
        assert data["filename"].endswith(".xlsx")
        assert data["download_url"].startswith("/static/")
        assert len(data["sheets"]) == 1
        assert data["sheets"][0]["row_count"] == 2
        out_file = settings.OUTPUT_DIR / data["filename"]
        assert out_file.is_file()
        df = pd.read_excel(out_file, sheet_name="表1")
        assert len(df) == 2
        assert list(df["名称"]) == ["A", "B"]
    finally:
        for p in (a, b):
            os.unlink(p)


def test_inspect_endpoint_returns_groups():
    """接口：inspect 返回文件工作表概览与合并分组"""
    a = _write_xlsx(
        tempfile.mktemp(suffix=".xlsx"),
        {
            "小区": pd.DataFrame({"名称": ["A"], "频点": [1]}),
            "站址": pd.DataFrame({"名称": ["S1"], "经度": [116.0]}),
        },
    )
    client = _make_client()
    try:
        with open(a, "rb") as fa:
            resp = client.post(
                "/api/v1/table-merge/inspect",
                files=[
                    ("files", ("a.xlsx", fa, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")),
                ],
            )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert len(data["files"]) == 1
        assert [s["sheet_name"] for s in data["files"][0]["sheets"]] == ["小区", "站址"]
        assert len(data["groups"]) == 2
        assert data["total_tables"] == 2
    finally:
        os.unlink(a)


def test_merge_endpoint_rejects_unsupported_extension():
    """不支持的文件扩展名返回 400"""
    tmp = tempfile.mktemp(suffix=".docx")
    with open(tmp, "wb") as f:
        f.write(b"not a table")
    client = _make_client()
    try:
        with open(tmp, "rb") as f:
            resp = client.post(
                "/api/v1/table-merge/merge",
                files=[("files", ("a.docx", f, "application/octet-stream"))],
            )
        assert resp.status_code == 400
        assert "仅支持" in str(resp.json()["detail"])
    finally:
        os.unlink(tmp)
