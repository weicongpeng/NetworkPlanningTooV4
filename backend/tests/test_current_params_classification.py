"""ZIP 导入分类：BaselineLab* 现网工参 vs 图层文件（两者同为 ZIP）

覆盖「导入时分类」与「存量索引纠正」，保证「已导入数据」六大类归组正确。
"""
import asyncio
import io
import zipfile

import pytest

from app.services import data_service as ds_mod


# ---------------------------------------------------------------- 纯函数：契约判定


def test_baselinelab_filename_contract():
    assert ds_mod.is_current_params_filename("BaselineLab_20261111.zip") is True
    assert ds_mod.is_current_params_filename("baselinelab_test.zip") is True
    assert ds_mod.is_current_params_filename("sector_layers.zip") is False
    assert ds_mod.is_current_params_filename("") is False


def test_current_params_content_names():
    assert ds_mod.has_current_params_content(["BaselineLab_20261111.zip"]) is True
    assert ds_mod.has_current_params_content(["LTE_SDR_CellInfo_20261111.csv"]) is True
    assert ds_mod.has_current_params_content(["NR_CellInfo_20261111.csv"]) is True
    assert ds_mod.has_current_params_content(["sector.tab", "a.csv"]) is False


def test_resolve_map_import_path_priority():
    resolve = ds_mod.resolve_map_import_path
    # 1) BaselineLab 包名最强，即便用户是从「图层文件」入口上传
    assert resolve("BaselineLab_1.zip", "map_layer", ["a.csv"]) == "current_params"
    # 2) 显式导入路径生效
    assert resolve("abc.zip", "current_params", ["a.csv"]) == "current_params"
    assert resolve("abc.zip", "map_layer", ["a.csv"]) == "map_layer"
    # 3) 无导入路径时按 ZIP 内容判定
    assert resolve("abc.zip", None, ["LTE_SDR_CellInfo_1.csv"]) == "current_params"
    assert resolve("abc.zip", None, ["BaselineLab_dir"]) == "current_params"
    # 4) 矢量图层 / 兜底 → 图层文件
    assert resolve("abc.zip", None, ["sector.tab"]) == "map_layer"
    assert resolve("abc.zip", None, ["readme.txt"]) == "map_layer"


# ---------------------------------------------------------------- 导入时落索引


def _zip_bytes(names):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name in names:
            zf.writestr(name, "dummy")
    return buf.getvalue()


class _FakeUploadFile:
    def __init__(self, filename, content):
        self.filename = filename
        self._content = content

    async def read(self):
        return self._content


def _run_upload(filename, names, file_type=None):
    """跑一次真实 ZIP 上传（不含矢量图层，走 offline 兜底分支），返回索引条目。"""
    import tempfile
    from pathlib import Path

    svc = ds_mod.data_service
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        original_index = dict(svc.index)
        old_data_dir = ds_mod.settings.DATA_DIR
        old_upload_dir = ds_mod.settings.UPLOAD_DIR
        try:
            (tmp / "uploads").mkdir(exist_ok=True)
            monkeypatch_dirs = (tmp, tmp / "uploads")
            ds_mod.settings.DATA_DIR = monkeypatch_dirs[0]
            ds_mod.settings.UPLOAD_DIR = monkeypatch_dirs[1]
            svc.index.clear()
            asyncio.run(
                svc.upload_map(
                    _FakeUploadFile(filename, _zip_bytes(names)),
                    file_type=file_type,
                )
            )
            assert len(svc.index) == 1, svc.index
            return next(iter(svc.index.values()))
        finally:
            ds_mod.settings.DATA_DIR = old_data_dir
            ds_mod.settings.UPLOAD_DIR = old_upload_dir
            svc.index.clear()
            svc.index.update(original_index)


def test_upload_baselinelab_zip_marks_current_params():
    """BaselineLab ZIP 从「图层文件」入口误传，导入时仍归现网工参"""
    entry = _run_upload("BaselineLab_20261111.zip", ["readme.csv"], file_type="map_layer")
    assert entry["fileType"] == "current_params"


def test_upload_baselinelab_zip_without_import_path():
    """旧前端没带 file_type 的 BaselineLab 包也要归现网工参"""
    entry = _run_upload("BaselineLab_20261111.zip", ["readme.csv"], file_type=None)
    assert entry["fileType"] == "current_params"


def test_upload_layer_zip_stays_map_layer():
    """正常图层 ZIP 不受影响"""
    entry = _run_upload("city_layers.zip", ["readme.txt"], file_type="map_layer")
    assert entry["fileType"] == "map_layer"


def test_upload_zip_with_cellinfo_csv_no_path():
    """无导入路径但包内含网管 CellInfo CSV → 现网工参"""
    entry = _run_upload("export.zip", ["LTE_SDR_CellInfo_20261111.csv"], file_type=None)
    assert entry["fileType"] == "current_params"


# ---------------------------------------------------------------- 存量索引纠正


def test_mark_map_import_paths_fixes_misclassified_baselinelab(tmp_path, monkeypatch):
    """启动时纠正已被误标成 map_layer 的 BaselineLab 存量条目"""
    svc = ds_mod.data_service
    monkeypatch.setattr(ds_mod.settings, "DATA_DIR", tmp_path)

    original_index = dict(svc.index)
    try:
        svc.index.clear()
        svc.index["wrong"] = {
            "id": "wrong", "name": "BaselineLab_20261111.zip",
            "type": "map", "fileType": "map_layer",
        }
        svc.index["no_type"] = {
            "id": "no_type", "name": "BaselineLab_20261110.zip", "type": "map",
        }
        svc.index["layer"] = {
            "id": "layer", "name": "city_layers.zip",
            "type": "map", "fileType": "map_layer",
        }
        layer_dir = tmp_path / "layer"
        layer_dir.mkdir()
        (layer_dir / "sector.tab").write_text("x", encoding="utf-8")

        svc._mark_map_import_paths()

        assert svc.index["wrong"]["fileType"] == "current_params"
        assert svc.index["no_type"]["fileType"] == "current_params"
        assert svc.index["layer"]["fileType"] == "map_layer"
    finally:
        svc.index.clear()
        svc.index.update(original_index)


def test_mark_map_import_paths_cellinfo_dir(tmp_path, monkeypatch):
    """目录内含网管 CellInfo CSV 的存量 map 条目纠正为现网工参"""
    svc = ds_mod.data_service
    monkeypatch.setattr(ds_mod.settings, "DATA_DIR", tmp_path)

    current_dir = tmp_path / "current_entry"
    current_dir.mkdir()
    (current_dir / "LTE_SDR_CellInfo_20261111.csv").write_text("a,b\n1,2\n", encoding="utf-8")

    original_index = dict(svc.index)
    try:
        svc.index.clear()
        svc.index["current_entry"] = {
            "id": "current_entry", "name": "export.zip",
            "type": "map", "fileType": "map_layer",
        }
        svc._mark_map_import_paths()
        assert svc.index["current_entry"]["fileType"] == "current_params"
    finally:
        svc.index.clear()
        svc.index.update(original_index)
