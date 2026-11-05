"""带样式地写 MapInfo TAB：把「带样式的 MIF」转换成 TAB。

为什么需要这个模块（实测结论，别再走回头路）：

- GDAL 的 MITAB 驱动**只能**通过要素的 OGR 样式串把 Pen/Brush/Symbol 写进 .map 定义表，
  而 pyogrio 不暴露 `OGR_F_SetStyleString`，所以 pyogrio 直接写的 TAB 永远只有默认样式。
- 试过「写完后以 UPDATE 模式逐要素 `OGR_F_SetStyleString` + `OGR_L_SetFeature`」：
  SetFeature 返回成功但样式不落盘（MITAB 的更新路径不重解析样式串，只沿用原有定义），
  读回仍是默认样式 —— 此路不通。
- 可行路径是**创建路径**：`GDALVectorTranslate`（等价 ogr2ogr）由 GDAL 的
  `IMapInfoFile::CreateTABFeature` 解析源要素样式串 → `ITABFeaturePen/Brush/Symbol::Set*FromStyleString`
  → `TABMAPFile::WritePenDef/WriteBrushDef/WriteSymbolDef`，样式因此进入 .map 定义表。
  实测：带 `Pen/Brush`、`Symbol (34,255,12)` 的 MIF 转换后样式完整保留（含万级要素图层）。

因此图层制作的 TAB 输出走「临时 MIF（已带样式）→ 本模块转换 → 修 charset/列名」。
"""
from __future__ import annotations

import ctypes
import os
import threading
from pathlib import Path
from typing import Optional

from app.services.ogr_style_reader import find_libgdal

# GDALOpenEx 标志位（gdal.h）：只读矢量 + 上报错误；GDALVectorTranslate 的目标由参数创建
_GDAL_OF_VECTOR = 0x04
_GDAL_OF_VERBOSE_ERROR = 0x40
_OPEN_READONLY_VECTOR = _GDAL_OF_VECTOR | _GDAL_OF_VERBOSE_ERROR

# 目标 charset：CP936 = WindowsSimpChinese（与 _write 的 GBK 字节流一致）
DEFAULT_TAB_ENCODING = "CP936"

_lib_lock = threading.Lock()
_translator: Optional["_MifToTabTranslator"] = None
_translator_unavailable = False


def _last_error(lib) -> str:
    try:
        raw = lib.CPLGetLastErrorMsg()
    except Exception:
        return ""
    return raw.decode("utf-8", "replace") if raw else ""


class _MifToTabTranslator:
    """GDALVectorTranslate 的最小 ctypes 绑定（源只读打开 + 目标新建）。"""

    def __init__(self, lib_path: str):
        lib = ctypes.CDLL(lib_path)
        lib.GDALAllRegister.restype = None
        lib.GDALAllRegister.argtypes = []
        lib.GDALOpenEx.restype = ctypes.c_void_p
        lib.GDALOpenEx.argtypes = [
            ctypes.c_char_p, ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
        ]
        lib.GDALClose.restype = None
        lib.GDALClose.argtypes = [ctypes.c_void_p]
        lib.GDALVectorTranslate.restype = ctypes.c_void_p
        lib.GDALVectorTranslate.argtypes = [
            ctypes.c_char_p, ctypes.c_void_p, ctypes.c_int,
            ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p, ctypes.POINTER(ctypes.c_int),
        ]
        lib.GDALVectorTranslateOptionsNew.restype = ctypes.c_void_p
        lib.GDALVectorTranslateOptionsNew.argtypes = [ctypes.POINTER(ctypes.c_char_p), ctypes.c_void_p]
        lib.GDALVectorTranslateOptionsFree.restype = None
        lib.GDALVectorTranslateOptionsFree.argtypes = [ctypes.c_void_p]
        lib.CPLGetLastErrorMsg.restype = ctypes.c_char_p
        lib.CPLGetLastErrorMsg.argtypes = []
        lib.GDALAllRegister()
        self._lib = lib

    def convert(self, src_path: str, dst_path: str, encoding: str) -> None:
        # 只传"选项"：源/目标数据集由函数参数传入，不能出现在 argv 里
        # （否则报 Maximum number of positional arguments exceeded）
        args = ["-f", "MapInfo File", "-lco", f"ENCODING={encoding}"]
        argv = (ctypes.c_char_p * (len(args) + 1))(*[a.encode() for a in args], None)
        options = self._lib.GDALVectorTranslateOptionsNew(argv, None)
        if not options:
            raise RuntimeError(f"转换选项解析失败: {_last_error(self._lib)}")
        src_ds = None
        dst_ds = None
        try:
            # 文件名走 OS 编码（Linux 上为字节路径），否则中文文件名打不开
            src_ds = self._lib.GDALOpenEx(
                os.fsencode(src_path), _OPEN_READONLY_VECTOR, None, None, None
            )
            if not src_ds:
                raise RuntimeError(f"源文件打不开: {_last_error(self._lib)}")
            src_arr = (ctypes.c_void_p * 1)(src_ds)
            usage_error = ctypes.c_int(0)
            dst_ds = self._lib.GDALVectorTranslate(
                os.fsencode(dst_path), None, 1, src_arr, options, ctypes.byref(usage_error)
            )
            if not dst_ds:
                raise RuntimeError(f"转换失败: {_last_error(self._lib)}")
        finally:
            self._lib.GDALVectorTranslateOptionsFree(options)
            if src_ds:
                self._lib.GDALClose(src_ds)
            if dst_ds:
                self._lib.GDALClose(dst_ds)


def _get_translator() -> Optional[_MifToTabTranslator]:
    global _translator, _translator_unavailable
    if _translator is None and not _translator_unavailable:
        with _lib_lock:
            if _translator is None and not _translator_unavailable:
                try:
                    lib_path = find_libgdal()
                    if lib_path:
                        _translator = _MifToTabTranslator(lib_path)
                    else:
                        _translator_unavailable = True
                        print("[TabStyle] 未找到 GDAL 动态库，TAB 样式转换不可用")
                except Exception as exc:
                    _translator_unavailable = True
                    print(f"[TabStyle] GDAL 动态库不可用，TAB 样式转换不可用: {exc}")
    return _translator


def convert_mif_to_tab(src_path, dst_path, encoding: str = DEFAULT_TAB_ENCODING) -> None:
    """把带样式的矢量文件（通常是 .mif）转换为 MapInfo TAB，样式写入 .map 定义表。

    失败抛 RuntimeError（调用方决定降级）；GDAL 不可用时抛 RuntimeError。
    """
    translator = _get_translator()
    if translator is None:
        raise RuntimeError("GDAL 转换能力不可用（未找到 libgdal）")
    dst = Path(dst_path)
    translator.convert(str(src_path), str(dst), encoding)
    if not dst.exists():
        raise RuntimeError(f"转换后未生成 {dst.name}")
