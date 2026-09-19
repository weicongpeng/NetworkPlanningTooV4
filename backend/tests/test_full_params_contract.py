"""全量工参文件名契约与上传门控测试"""
import asyncio
import pytest
import openpyxl


def _make_xlsx(path, sheets):
    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    for name in sheets:
        wb.create_sheet(name)
    wb.save(path)


class TestFilenameRecognition:
    def test_full_params_prefixes(self):
        from app.services.data_service import is_full_params_filename
        assert is_full_params_filename("ProjectParameter.xlsx")
        assert is_full_params_filename("projectparameter_河源电信.xlsx")
        # 存量旧命名读取侧仍识别
        assert is_full_params_filename("ProjectParameter_mongoose.xlsx")
        assert is_full_params_filename("mongoose_20260614.xlsx")
        # 无关文件不识别
        assert not is_full_params_filename("河源电信工参.xlsx")
        assert not is_full_params_filename("random.xls")

    def test_target_cells_prefixes(self):
        from app.services.data_service import is_target_cells_filename
        assert is_target_cells_filename("cell-tree-export-LTE.xlsx")
        assert is_target_cells_filename("Cell-Tree.xlsx")
        assert not is_target_cells_filename("ProjectParameter.xlsx")


class TestValidateExcelUploadContract:
    def test_valid_full_params(self, tmp_path):
        from app.services.data_service import validate_excel_upload_contract
        f = tmp_path / "ProjectParameter_河源20260918.xlsx"
        _make_xlsx(f, ["LTE Project Parameters", "NR Project Parameters"])
        assert validate_excel_upload_contract(f.name, f) == "full_params"

    def test_single_network_full_params_ok(self, tmp_path):
        from app.services.data_service import validate_excel_upload_contract
        f = tmp_path / "ProjectParameter_lte_only.xlsx"
        _make_xlsx(f, ["LTE Project Parameters"])
        assert validate_excel_upload_contract(f.name, f) == "full_params"

    def test_wrong_sheets_rejected(self, tmp_path):
        from app.services.data_service import validate_excel_upload_contract
        f = tmp_path / "ProjectParameter_bad.xlsx"
        _make_xlsx(f, ["LTE", "NR"])
        with pytest.raises(ValueError, match="Project Parameters"):
            validate_excel_upload_contract(f.name, f)

    def test_non_conforming_name_rejected(self, tmp_path):
        from app.services.data_service import validate_excel_upload_contract
        f = tmp_path / "河源电信工参2026.xlsx"
        _make_xlsx(f, ["LTE Project Parameters", "NR Project Parameters"])
        # 内容正确但文件名不规范：拒绝（问题1 误分类为"待规划"的根因）
        with pytest.raises(ValueError, match="ProjectParameter"):
            validate_excel_upload_contract(f.name, f)

    def test_legacy_mongoose_name_rejected_for_new_upload(self, tmp_path):
        from app.services.data_service import validate_excel_upload_contract
        f = tmp_path / "mongoose_20260614.xlsx"
        _make_xlsx(f, ["LTE Project Parameters"])
        with pytest.raises(ValueError, match="旧版命名"):
            validate_excel_upload_contract(f.name, f)

    def test_cell_tree_accepted(self, tmp_path):
        from app.services.data_service import validate_excel_upload_contract
        f = tmp_path / "cell-tree-export-LTE.xlsx"
        _make_xlsx(f, ["LTE"])
        assert validate_excel_upload_contract(f.name, f) == "target_cells"

    def test_corrupt_workbook_rejected(self, tmp_path):
        from app.services.data_service import validate_excel_upload_contract
        f = tmp_path / "ProjectParameter_broken.xlsx"
        f.write_bytes(b"not an excel file")
        with pytest.raises(ValueError):
            validate_excel_upload_contract(f.name, f)


class _FakeUpload:
    def __init__(self, filename, data: bytes):
        self.filename = filename
        self._data = data

    async def read(self):
        return self._data


class TestInitUploadGate:
    """init_upload 必须在落索引前拒绝不规范文件"""

    def test_bad_name_rejected_before_index(self, tmp_path):
        from app.services.data_service import data_service
        wb_path = tmp_path / "f.xlsx"
        _make_xlsx(wb_path, ["LTE Project Parameters"])

        before = dict(data_service.index)
        with pytest.raises(ValueError, match="文件名不符合导入规范"):
            asyncio.run(data_service.init_upload(
                _FakeUpload("随便起的名字.xlsx", wb_path.read_bytes()),
                user_id=999999, city="ZZ测试市", operator="移动",
            ))
        # 未留下任何索引条目
        assert data_service.index == before

    def test_bad_content_rejected_before_index(self, tmp_path):
        from app.services.data_service import data_service
        wb_path = tmp_path / "f.xlsx"
        _make_xlsx(wb_path, ["LTE", "NR"])  # 前缀对但工作表不对

        before = dict(data_service.index)
        with pytest.raises(ValueError, match="Project Parameters"):
            asyncio.run(data_service.init_upload(
                _FakeUpload("ProjectParameter_bad.xlsx", wb_path.read_bytes()),
                user_id=999999, city="ZZ测试市", operator="移动",
            ))
        assert data_service.index == before


class TestClassifyFile:
    def test_contract_name_wins(self):
        from app.services.data_service import DataService
        svc = DataService.__new__(DataService)
        # 文件名契约优先：cell-tree 即使内容像 LTE 单表也判待规划
        assert svc._classify_file("cell-tree-export.xlsx", ["LTE"]) == "target_cells"
        assert svc._classify_file("ProjectParameter.xlsx", ["Sheet1"]) == "full_params"

    def test_content_fallback_for_zip_inner_files(self):
        """ZIP 内无规范文件名的 Excel：按工作表内容兜底识别"""
        from app.services.data_service import DataService
        svc = DataService.__new__(DataService)
        assert svc._classify_file("data.xlsx", ["LTE Project Parameters"]) == "full_params"
        assert svc._classify_file("data.xlsx", ["LTE"]) == "target_cells"
        assert svc._classify_file("data.xlsx", ["Sheet1"]) == "default"
