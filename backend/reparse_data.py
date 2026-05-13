"""
重新解析已导入的Excel文件并更新data.json
"""
import sys
from pathlib import Path
import json
import shutil

# 添加项目根目录到Python路径
ROOT_DIR = Path(__file__).parent
sys.path.insert(0, str(ROOT_DIR))

from app.services.data_service import data_service
from app.core.config import settings


def reparse_existing_data():
    """重新解析已导入的数据"""
    print("=" * 50)
    print("重新解析已导入的Excel数据")
    print("=" * 50)

    # 读取索引
    index_path = settings.DATA_DIR / "index.json"

    if not index_path.exists():
        print("错误: 没有找到数据索引文件")
        return

    with open(index_path, 'r', encoding='utf-8') as f:
        index = json.load(f)

    updated_count = 0

    for data_id, info in index.items():
        if info.get('type') == 'excel':
            print(f"\n处理数据: {info['name']} (ID: {data_id})")

            # 检查原始文件
            data_dir = settings.DATA_DIR / data_id
            original_file = data_dir / "original.xlsx"

            if not original_file.exists():
                print(f"  警告: 原始文件不存在 - {original_file}")
                continue

            try:
                # 使用pandas读取Excel
                import pandas as pd
                df = pd.read_excel(original_file, sheet_name=0)

                print(f"  Excel行数: {len(df)}")

                # 使用新的解析逻辑
                result = data_service._parse_excel_data(df)
                print(f"  解析结果: {len(result)} 个基站, {sum(len(s['sectors']) for s in result)} 个小区")

                # 保存到data.json
                data_file = data_dir / "data.json"
                with open(data_file, 'w', encoding='utf-8') as f:
                    json.dump(result, f, ensure_ascii=False, indent=2)

                # 更新索引metadata
                total_sectors = sum(len(s['sectors']) for s in result)
                info['metadata'] = {
                    'siteCount': len(result),
                    'sectorCount': total_sectors
                }

                updated_count += 1
                print(f"  [OK] 已更新data.json")

            except Exception as e:
                print(f"  [FAIL] 失败: {e}")
                import traceback
                traceback.print_exc()

    # 保存更新后的索引
    if updated_count > 0:
        with open(index_path, 'w', encoding='utf-8') as f:
            json.dump(index, f, ensure_ascii=False, indent=2)

    print("\n" + "=" * 50)
    print(f"完成! 更新了 {updated_count} 个数据文件")
    print("=" * 50)

    # 显示更新后的数据统计
    print("\n更新后的数据统计:")
    for data_id, info in index.items():
        if info.get('type') == 'excel':
            print(f"  - {info['name']}: {info['metadata']['siteCount']} 个基站, {info['metadata']['sectorCount']} 个小区")


if __name__ == "__main__":
    reparse_existing_data()
