"""PyInstaller hook：收集 pyogrio 的包数据与自带 GDAL 动态库。

pyogrio 官方 wheel 由 delvewheel/auditwheel 生成，依赖动态库（gdal/proj/geos 等）
放在与包目录同级的 pyogrio.libs/ 下，PyInstaller 默认不会收集该目录；
pyinstaller-hooks-contrib 目前也没有 pyogrio 的 hook（geo 生态里只有 fiona/geopandas/
shapely/pyproj），因此这里显式处理，否则冻结后 GDAL 相关功能不可用。
"""
from __future__ import annotations

import glob
import os

from PyInstaller.utils.hooks import (
    collect_data_files,
    collect_dynamic_libs,
    collect_submodules,
    get_package_paths,
)

datas = collect_data_files("pyogrio")
binaries = collect_dynamic_libs("pyogrio")

hiddenimports = collect_submodules(
    "pyogrio", filter=lambda name: ".tests" not in name
)

# delvewheel（Windows）/ auditwheel（Linux）布局：<site-packages>/pyogrio.libs/
package_dir = get_package_paths("pyogrio")[1]
libs_dir = os.path.join(os.path.dirname(package_dir), "pyogrio.libs")
if os.path.isdir(libs_dir):
    for pattern in ("*.dll", "*.so*", "*.dylib"):
        for lib in glob.glob(os.path.join(libs_dir, pattern)):
            binaries.append((lib, "."))
