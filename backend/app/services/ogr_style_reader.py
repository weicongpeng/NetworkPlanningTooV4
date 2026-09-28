"""读取矢量文件逐要素的 OGR 样式串（MapInfo TAB 真实配色的来源）。

背景：pyogrio/geopandas 只暴露几何与属性，而 MapInfo 的 Pen/Brush/Symbol 样式存在
同名 .map 二进制里（每个对象引用样式定义表）。GDAL 的 MapInfo 驱动会把每个要素的
样式解析成 OGR 样式串（如 ``PEN(w:1px,c:#000000,id:"mapinfo-pen-2,ogr-pen-0")``），
但只能通过 C API ``OGR_F_GetStyleString`` 取出，pyogrio 未暴露该接口。
pyogrio 的 wheel 自带 libgdal，这里用 ctypes 复用同一份动态库，不引入新依赖。

任何环节失败（找不到动态库 / 驱动不支持 / 文件损坏）一律返回 None，
调用方回退到默认配色，不影响导入流程。
"""
from __future__ import annotations

import ctypes
import ctypes.util
import glob
import os
import threading
from pathlib import Path
from typing import List, Optional

# GDALOpenEx 标志位（gdal.h）：只读 + 仅矢量 + 报错信息到 stderr。
# 注意 GDAL_OF_UPDATE=0x01 不是"只有矢量"——早期误写成 0x01 等于以 UPDATE 模式打开
# 全部驱动，会因只读驱动（.mif）拒绝打开而报 "not recognized as a supported file format"，
# 且有写锁风险。
_GDAL_OF_VECTOR = 0x04
_GDAL_OF_VERBOSE_ERROR = 0x40
_OPEN_READONLY_VECTOR = _GDAL_OF_VECTOR | _GDAL_OF_VERBOSE_ERROR

_lib_lock = threading.Lock()
_api: Optional["_OgrApi"] = None
_api_unavailable = False


def find_libgdal() -> Optional[str]:
    """定位 GDAL 动态库：优先 pyogrio 自带的那一份（与读取几何用的是同一个），
    其次交给动态链接器（conda / 系统 GDAL 场景）。

    用 find_spec 而不是 import pyogrio：导入 pyogrio 会触发它的 GDAL 环境探测，
    在 libgdal 已被 ctypes 先行加载的场景下会抛错（"Could not correctly detect
    GDAL data files..."），而这里只需要它的包目录。
    同时供写侧（tab_style_injector）复用，保证读写用的是同一份 GDAL。
    """
    import importlib.util

    candidates: List[str] = []
    try:
        spec = importlib.util.find_spec("pyogrio")
    except Exception:
        spec = None
    if spec is not None and spec.origin:
        root = Path(spec.origin).resolve().parent
        for directory in (root.parent / "pyogrio.libs", root, root.parent):
            if not directory.is_dir():
                continue
            for pattern in ("libgdal*.so*", "libgdal*.dylib", "gdal*.dll"):
                candidates.extend(sorted(glob.glob(str(directory / pattern))))
    for candidate in candidates:
        if os.path.isfile(candidate):
            return candidate
    try:
        return ctypes.util.find_library("gdal")
    except Exception:
        return None


class _OgrApi:
    """OGR C API 最小绑定：打开数据源 → 遍历要素 → 取样式串。"""

    def __init__(self, lib_path: str):
        lib = ctypes.CDLL(lib_path)
        lib.GDALAllRegister.restype = None
        lib.GDALAllRegister.argtypes = []
        lib.GDALOpenEx.restype = ctypes.c_void_p
        lib.GDALOpenEx.argtypes = [
            ctypes.c_char_p, ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
        ]
        lib.GDALDatasetGetLayer.restype = ctypes.c_void_p
        lib.GDALDatasetGetLayer.argtypes = [ctypes.c_void_p, ctypes.c_int]
        lib.OGR_L_GetNextFeature.restype = ctypes.c_void_p
        lib.OGR_L_GetNextFeature.argtypes = [ctypes.c_void_p]
        lib.OGR_F_GetStyleString.restype = ctypes.c_char_p
        lib.OGR_F_GetStyleString.argtypes = [ctypes.c_void_p]
        lib.OGR_F_Destroy.restype = None
        lib.OGR_F_Destroy.argtypes = [ctypes.c_void_p]
        lib.GDALClose.restype = None
        lib.GDALClose.argtypes = [ctypes.c_void_p]
        lib.GDALAllRegister()
        self._lib = lib

    def style_strings(self, path: str) -> Optional[List[Optional[str]]]:
        """返回按要素顺序排列的样式串（无样式要素为 None）；打不开或空图层返回 None。"""
        # 文件名走 OS 编码（Linux 上为字节路径），否则中文文件名打不开
        dataset = self._lib.GDALOpenEx(os.fsencode(path), _OPEN_READONLY_VECTOR, None, None, None)
        if not dataset:
            return None
        try:
            layer = self._lib.GDALDatasetGetLayer(dataset, 0)
            if not layer:
                return None
            styles: List[Optional[str]] = []
            while True:
                feature = self._lib.OGR_L_GetNextFeature(layer)
                if not feature:
                    break
                try:
                    raw = self._lib.OGR_F_GetStyleString(feature)
                finally:
                    self._lib.OGR_F_Destroy(feature)
                styles.append(raw.decode("utf-8", "replace") if raw else None)
            return styles or None
        finally:
            self._lib.GDALClose(dataset)


def read_feature_style_strings(path) -> Optional[List[Optional[str]]]:
    """读取矢量文件每要素的 OGR 样式串（按要素顺序，无样式为 None）。

    不可用或读取失败返回 None（调用方回退默认配色）。
    """
    global _api, _api_unavailable
    if _api is None and not _api_unavailable:
        with _lib_lock:
            if _api is None and not _api_unavailable:
                try:
                    lib_path = find_libgdal()
                    if lib_path:
                        _api = _OgrApi(lib_path)
                    else:
                        _api_unavailable = True
                        print("[OgrStyle] 未找到 GDAL 动态库，图层样式将回退默认配色")
                except Exception as exc:  # 动态库加载/符号缺失
                    _api_unavailable = True
                    print(f"[OgrStyle] GDAL 动态库不可用，图层样式将回退默认配色: {exc}")
    if _api is None:
        return None
    try:
        return _api.style_strings(str(path))
    except Exception as exc:
        print(f"[OgrStyle] 读取样式串失败 {path}: {exc}")
        return None
