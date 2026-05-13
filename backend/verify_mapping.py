"""
验证修改后的列名映射
"""
import sys
from pathlib import Path
ROOT_DIR = Path(__file__).parent
sys.path.insert(0, str(ROOT_DIR))

import pandas as pd

test_file = r'D:\mycode\NetworkPlanningTooV2\全量工参\ProjectParameter_mongoose河源电联20251225110859.xlsx'

print("="*80)
print("验证修改后的列名映射")
print("="*80)

with pd.ExcelFile(test_file) as xls:
    for network_type in ['LTE', 'NR']:
        sheet_name = f'{network_type} Project Parameters'
        print(f"\n处理 {sheet_name}:")
        
        # 读取第一行
        header_row = pd.read_excel(xls, sheet_name=sheet_name, header=None, nrows=1).iloc[0]
        
        # 提取列名
        clean_columns = []
        for col in header_row:
            col_str = str(col).strip() if pd.notna(col) else ''
            if '\n' in col_str:
                chinese_name = col_str.split('\n')[0].strip()
                clean_columns.append(chinese_name)
            else:
                clean_columns.append(col_str)
        
        # 定义列名映射（修改后的）
        if network_type == "LTE":
            required_columns = {
                'site_id': ['eNodeB标识', 'eNodeBID', 'eNodeB ID', '基站ID', '管理网元ID'],
                'longitude': ['基站经度', '经度', '小区经度'],
                'latitude': ['基站纬度', '纬度', '小区纬度'],
                'sector_id': ['小区标识', '小区ID'],
            }
        else:  # NR
            required_columns = {
                'site_id': ['gNodeB标识', 'gNodeBID', 'gNodeB ID', '基站ID', '管理网元ID'],
                'longitude': ['基站经度', '经度', '小区经度'],
                'latitude': ['基站纬度', '纬度', '小区纬度'],
                'sector_id': ['小区标识', '小区ID'],
            }
        
        def find_column(df_cols, possible_names):
            df_cols_lower = [str(c).strip().lower() for c in df_cols]
            for possible in possible_names:
                possible_lower = possible.lower()
                if possible_lower in df_cols_lower:
                    idx = df_cols_lower.index(possible_lower)
                    return df_cols[idx]
                for i, df_col in enumerate(df_cols_lower):
                    if possible_lower in df_col or df_col in possible_lower:
                        return df_cols[i]
            return None
        
        # 执行映射
        mapped_columns = {}
        for key, possible_names in required_columns.items():
            found_col = find_column(clean_columns, possible_names)
            if found_col is not None:
                mapped_columns[key] = found_col
                print(f"  ✓ {key:15s} -> {found_col}")
            else:
                print(f"  ✗ {key:15s} -> 未找到")
        
        # 检查必需列
        required_keys = ['site_id', 'longitude', 'latitude', 'sector_id']
        missing_keys = [k for k in required_keys if k not in mapped_columns]
        
        if missing_keys:
            print(f"  ✗ 缺少必需列: {missing_keys}")
        else:
            print(f"  ✅ 所有必需列都已找到！")

print("\n" + "="*80)
print("验证完成")
print("="*80)
