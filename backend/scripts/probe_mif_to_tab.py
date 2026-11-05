"""探针：带样式的 MIF 转成 TAB 后样式是否保留（验证 tab_style_writer 这条路线）。

用法（backend/ 下）：.venv/bin/python scripts/probe_mif_to_tab.py [src.mif ...]
不传参时用仓库自带的两份 MIF 样本（面/点各一）。
"""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services.ogr_style_reader import read_feature_style_strings  # noqa: E402
from app.services.tab_style_writer import convert_mif_to_tab  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_SAMPLES = [
    "uploads/layers/s_LTE_sector.mif",
    "uploads/layers/ProjectParameter_河源电联_LTE_point.mif",
]


def main() -> None:
    srcs = sys.argv[1:] or DEFAULT_SAMPLES
    tmp = Path(tempfile.mkdtemp(prefix="probe_mif2tab_"))
    for rel in srcs:
        src = Path(rel) if Path(rel).is_absolute() else ROOT / rel
        dst = tmp / (src.stem + ".tab")
        print(f"=== {src.name}")
        print("  源样式:", (read_feature_style_strings(src) or [None])[0])
        try:
            convert_mif_to_tab(src, dst)
        except Exception as exc:  # noqa: BLE001
            print(f"  转换失败: {exc}")
            continue
        back = read_feature_style_strings(dst)
        print("  目标样式:", back[0] if back else None)
        print("  目标要素数:", len(back) if back else 0)
    print(f"\n临时目录: {tmp}")


if __name__ == "__main__":
    main()
