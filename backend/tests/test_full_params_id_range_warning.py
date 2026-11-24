"""全量工参 4G 号段核查回归：越界仅提示、无号段表跳过、样本数受限。"""
from __future__ import annotations

import pandas as pd

from app.services.data_service import DataService

LTE_SHEET = "LTE Project Parameters"
RANGE_SHEET = "4G号段使用范围"
RANGE_HEADER = [
    "地市", "运营商", "eNBId十进制起始值", "eNBId十进制结束值",
    "cellId十进制起始值", "cellId十进制结束值",
]
ComplexLTEHeader = [
    "城市\nCity\nString[0..20]",
    "运营商\nOperator\nString[0..20]",
    "eNodeB标识\neNodeB ID\nlong:[0..1048575]",
    "基站名称\neNodeB Name\nString[0..128]",
    "小区标识\ncellLocalId\ninteger:[0..2147483647]",
    "小区名称\nuserLabel\nString[0..128]",
]


class _ServiceStub:
    """只需要 _add_import_warning 的对象，便于纯函数式测试核查逻辑。"""

    def __init__(self):
        self.full_params_import_warnings = []

    def _add_import_warning(self, code, **fields):
        self.full_params_import_warnings.append({"code": code, **fields})


def _write_workbook(path, lte_rows, range_rows=None, *, complex_header=True):
    if complex_header:
        rows = [ComplexLTEHeader, ["必填"] * 6, ["非必填"] * 6] + lte_rows
    else:
        rows = [[
            "城市", "运营商", "eNodeB标识", "基站名称", "小区标识", "小区名称",
        ]] + lte_rows
    with pd.ExcelWriter(path, engine="openpyxl") as writer:
        pd.DataFrame(rows).to_excel(writer, sheet_name=LTE_SHEET, header=False, index=False)
        if range_rows is not None:
            pd.DataFrame(range_rows).to_excel(
                writer, sheet_name=RANGE_SHEET, header=False, index=False
            )


def _check(path):
    service = _ServiceStub()
    with pd.ExcelFile(path) as xls:
        DataService._check_4g_id_ranges(service, xls, xls.sheet_names)
    return service.full_params_import_warnings


def test_id_ranges_report_only_out_of_range_ids(tmp_path):
    """城市+运营商映射地市+运营商：越界样本给出 eNBId-cellId 对与不合规字段。"""
    path = tmp_path / "ProjectParameter_ranges.xlsx"
    _write_workbook(
        path,
        [
            ["河源", "移动", 100, "A站", 10, "A小区"],
            ["河源", "移动", 999, "B站", 10, "B小区"],
            ["河源", "移动", 100, "C站", 999, "C小区"],
            ["梅州", "移动", 300, "D站", 30, "D小区"],  # 号段表无该组合 → 不判定
        ],
        [RANGE_HEADER, ["河源", "移动", 100, 200, 10, 20]],
    )

    warnings = _check(path)

    assert len(warnings) == 1
    warning = warnings[0]
    assert warning["code"] == "id_range"
    assert warning["count"] == 2
    assert [(s["field"], s["siteId"], s["cellId"]) for s in warning["samples"]] == [
        ("eNBId", 999, 10),
        ("cellId", 100, 999),
    ]


def test_id_ranges_silent_without_range_sheet_or_invalid_ranges(tmp_path):
    """无号段 sheet / 起止值非数字时不核查、不产生提示。"""
    no_sheet = tmp_path / "ProjectParameter_no_sheet.xlsx"
    _write_workbook(no_sheet, [["河源", "移动", 999, "B站", 999, "B小区"]])
    assert _check(no_sheet) == []

    invalid = tmp_path / "ProjectParameter_invalid_range.xlsx"
    _write_workbook(
        invalid,
        [["河源", "移动", 999, "B站", 999, "B小区"]],
        [RANGE_HEADER, ["河源", "移动", "abc", "xyz", "bad", "worse"]],
    )
    assert _check(invalid) == []


def test_id_ranges_support_simple_header_and_limit_samples(tmp_path):
    """简单表头同样可识别；所有越界样本都返回，供前端展开罗列。"""
    path = tmp_path / "ProjectParameter_simple.xlsx"
    lte_rows = [["河源", "移动", 999 + i, f"站{i}", 10, f"小区{i}"] for i in range(12)]
    _write_workbook(
        path, lte_rows, [RANGE_HEADER, ["河源", "移动", 100, 200, 10, 20]],
        complex_header=False,
    )

    warnings = _check(path)

    assert len(warnings) == 1
    assert warnings[0]["count"] == 12
    assert len(warnings[0]["samples"]) == 12
    assert (warnings[0]["samples"][0]["siteId"], warnings[0]["samples"][0]["cellId"]) == (999, 10)


def test_id_ranges_skip_when_city_column_missing(tmp_path):
    """LTE 工参缺少「城市」列时无法按地市匹配，静默跳过。"""
    path = tmp_path / "ProjectParameter_no_city.xlsx"
    with pd.ExcelWriter(path, engine="openpyxl") as writer:
        pd.DataFrame([
            ["eNodeB标识", "基站名称", "小区标识", "小区名称"],
            [999, "B站", 999, "B小区"],
        ]).to_excel(writer, sheet_name=LTE_SHEET, header=False, index=False)
        pd.DataFrame([
            RANGE_HEADER, ["河源", "移动", 100, 200, 10, 20],
        ]).to_excel(writer, sheet_name=RANGE_SHEET, header=False, index=False)
    assert _check(path) == []


def test_id_ranges_match_city_and_operator(tmp_path):
    """同地市不同运营商各用各的号段；号段表没有的地市+运营商组合跳过。"""
    path = tmp_path / "ProjectParameter_city_operator.xlsx"
    _write_workbook(
        path,
        [
            ["河源", "移动", 999, "B站", 10, "B小区"],   # 超出移动号段 → 提示
            ["河源", "联通", 550, "E站", 10, "E小区"],   # 命中联通号段 → 不提示
            ["河源", "电信", 999, "F站", 999, "F小区"],  # 号段表无此组合 → 不核查
        ],
        [
            RANGE_HEADER,
            ["河源", "移动", 100, 200, 10, 20],
            ["河源", "联通", 500, 600, 10, 20],
        ],
    )

    warnings = _check(path)

    assert len(warnings) == 1
    assert warnings[0]["count"] == 1
    assert [(s["field"], s["siteId"], s["cellId"]) for s in warnings[0]["samples"]] == [
        ("eNBId", 999, 10),
    ]


def test_id_ranges_skip_when_operator_missing(tmp_path):
    """LTE 缺「运营商」列或该列为空时无法构成匹配键，静默跳过。"""
    path = tmp_path / "ProjectParameter_no_operator.xlsx"
    with pd.ExcelWriter(path, engine="openpyxl") as writer:
        pd.DataFrame([
            ["城市", "eNodeB标识", "基站名称", "小区标识", "小区名称"],
            ["河源", 999, "B站", 999, "B小区"],
        ]).to_excel(writer, sheet_name=LTE_SHEET, header=False, index=False)
        pd.DataFrame([
            RANGE_HEADER, ["河源", "移动", 100, 200, 10, 20],
        ]).to_excel(writer, sheet_name=RANGE_SHEET, header=False, index=False)
    assert _check(path) == []

    blank = tmp_path / "ProjectParameter_blank_operator.xlsx"
    _write_workbook(
        blank,
        [["河源", "", 999, "B站", 999, "B小区"]],
        [RANGE_HEADER, ["河源", "移动", 100, 200, 10, 20]],
    )
    assert _check(blank) == []


def test_download_template_columns_and_range_sheet():
    """下载模板列对齐：城市右侧运营商、NR 下倾角列、无填充色、内置号段表。"""
    import openpyxl
    from pathlib import Path

    template = Path(__file__).resolve().parents[2] / "template" / "ProjectParameter_mongoose.xlsx"
    wb = openpyxl.load_workbook(template)
    try:
        for sheet_name in ("LTE Project Parameters", "NR Project Parameters"):
            ws = wb[sheet_name]
            assert [ws.cell(row, 1).value for row in (1, 2, 3)] == ["城市", "非必填", "City"]
            assert [ws.cell(row, 2).value for row in (1, 2, 3)] == [
                "运营商", "非必填", "Operator",
            ]
            assert ws.cell(1, 3).value == "是否现网"

        nr = wb["NR Project Parameters"]
        azimuth_col = next(
            col for col in range(1, nr.max_column + 1)
            if str(nr.cell(1, col).value or "").split("\n")[0].strip() == "天线方向角"
        )
        assert [nr.cell(row, azimuth_col + 1).value for row in (1, 2, 3)] == [
            "天线机械下倾角", "非必填", "Mechanical Downtilt",
        ]
        assert all(cell.fill.fill_type is None for row in nr.iter_rows() for cell in row)

        range_ws = wb["4G号段使用范围"]
        assert [range_ws.cell(1, col).value for col in (1, 2, 5, 6, 9, 10)] == [
            "地市", "运营商", "eNBId十进制起始值", "eNBId十进制结束值",
            "cellId十进制起始值", "cellId十进制结束值",
        ]
        assert range_ws.max_row > 100
        assert any(
            row[0] == "河源" and row[1] == "电信"
            and row[4] == 103424 and row[5] == 103551 and row[8] == 128 and row[9] == 255
            for row in range_ws.iter_rows(min_row=2, values_only=True)
        )
    finally:
        wb.close()


def test_id_ranges_use_paired_rows_and_report_both_fields(tmp_path):
    """eNBId 与 cellId 必须命中同一行；跨行混用算不合规，两个都越界标 both。"""
    path = tmp_path / "ProjectParameter_paired.xlsx"
    _write_workbook(
        path,
        [
            ["河源", "移动", 550, "A站", 10, "A小区"],   # eNBId 在第二行、cellId 在第一行 → 跨行
            ["河源", "移动", 878592, "B站", 256, "B小区"],  # 两项都超出所有行 → both
            ["河源", "移动", 936192, "C站", 127, "C小区"],  # eNBId 第四行、cellId 不在该行
        ],
        [
            RANGE_HEADER,
            ["河源", "移动", 103424, 103551, 128, 255],
            ["河源", "移动", 500, 600, 128, 255],
            ["河源", "移动", 878336, 878591, 128, 255],
            ["河源", "移动", 936192, 937983, 128, 255],
        ],
    )

    warnings = _check(path)

    assert len(warnings) == 1
    assert warnings[0]["count"] == 3
    assert [(s["field"], s["siteId"], s["cellId"]) for s in warnings[0]["samples"]] == [
        ("cellId", 550, 10),
        ("both", 878592, 256),
        ("cellId", 936192, 127),
    ]


def test_id_ranges_prefer_rightmost_decimal_column(tmp_path):
    """号段表出现重复的 cellId 十进制列时，用最右侧的十进制列而非左侧旧列。"""
    path = tmp_path / "ProjectParameter_dup_range_cols.xlsx"
    header = [
        "地市", "运营商",
        "eNBId十进制起始值", "eNBId十进制结束值",
        "cellId十进制起始值", "cellId十进制结束值",
        "cellId十进制起始值", "cellId十进制结束值",
    ]
    with pd.ExcelWriter(path, engine="openpyxl") as writer:
        pd.DataFrame([
            ["城市", "运营商", "eNodeB标识", "基站名称", "小区标识", "小区名称"],
            ["河源", "移动", 103424, "A站", 128, "A小区"],
        ]).to_excel(writer, sheet_name=LTE_SHEET, header=False, index=False)
        pd.DataFrame([
            header,
            ["河源", "移动", 103424, 103551, 80, "FF", 128, 255],
        ]).to_excel(writer, sheet_name=RANGE_SHEET, header=False, index=False)
    assert _check(path) == []
