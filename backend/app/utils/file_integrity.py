"""工参文件（xlsx/zip）的原子写与完整性校验。

openpyxl 的 save() 直接以 'w' 打开目标路径写 zip：写出期间文件是半截的。
并发读取（下载 / 数据集打包 / 导入 / 另一个反写线程）会拿到不完整的 zip，
表现为 `CalamineError: Cannot detect file format`；写失败或进程被杀还会把
唯一一份全量工参永久写坏。所有对权威文件 original.xlsx 的改写都必须走
`save_workbook_atomic()`（写同目录临时文件后原子替换）。
"""
from __future__ import annotations

import logging
import os
import tempfile
import time
import zipfile
from pathlib import Path

logger = logging.getLogger(__name__)

_ZIP_MAGIC = b"PK\x03\x04"


def replace_with_retry(src: str, dst: str, *, attempts: int = 20, delay: float = 0.15) -> None:
    """os.replace(src, dst)，Windows 上目标被占用（PermissionError）时重试后回退覆盖写。"""
    for i in range(attempts):
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            if i == attempts - 1:
                break
            time.sleep(delay)

    # 目标仍被占用（如 GDAL/Excel 正打开着）：回退为逐块覆盖写。
    # 读者可能看到中间态，但至少不会因为临时文件残留而丢掉整份工参。
    logger.warning(f"[原子写] 目标文件持续被占用，回退为覆盖写: {dst}")
    with open(src, "rb") as fsrc, open(dst, "wb") as fdst:
        while chunk := fsrc.read(1024 * 1024):
            fdst.write(chunk)
    os.unlink(src)


def save_workbook_atomic(workbook, path) -> None:
    """openpyxl.Workbook 原子写回 path（临时文件 + os.replace）。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    os.close(fd)
    try:
        workbook.save(tmp_name)
        replace_with_retry(tmp_name, str(path))
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def assert_zip_intact(path, label: str = "文件") -> None:
    """校验 zip 容器（xlsx 本质是 zip）完整可读，损坏时抛 ValueError（中文可读原因）。

    截断写在 zip 层面就是读不出中央目录，早于 pandas/calamine 报错，
    因此这里做的是「这份文件还能不能被解析」的最前置检查。
    """
    path = Path(path)
    try:
        with open(path, "rb") as f:
            head = f.read(4)
        if head != _ZIP_MAGIC:
            raise ValueError(f"{label}不是有效的 Excel/zip 文件（内容被截断或不是该格式）：{path.name}")
        with zipfile.ZipFile(path) as zf:
            bad = zf.testzip()
            if bad is not None:
                raise ValueError(f"{label}已损坏（成员 {bad} 校验失败）：{path.name}")
    except zipfile.BadZipFile as exc:
        raise ValueError(f"{label}已损坏，无法作为 Excel 读取（{exc}）：{path.name}") from exc


def is_zip_based(path) -> bool:
    return Path(path).suffix.lower() in (".xlsx", ".xlsm", ".zip")
