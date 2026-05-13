#!/usr/bin/env python3
"""
检查uploads目录中的文件，判断是否是全量工参文件
"""

import pandas as pd
import os

# 检查文件路径
file_path = "D:/mycode/NetworkPlanningTooV3/backend/uploads/6ee22a46-e8c0-48ca-a9da-81a61295d359.xlsx"

if os.path.exists(file_path):
    print(f"找到文件: {file_path}")
    
    try:
        # 读取Excel文件
        xls = pd.ExcelFile(file_path)
        
        # 查看sheet名称
        sheet_names = xls.sheet_names
        print(f"\nsheet名称: {sheet_names}")
        
        # 判断是否是全量工参文件
        if 'LTE Project Parameters' in sheet_names and 'NR Project Parameters' in sheet_names:
            print(f"\n✅ 是全量工参文件：包含LTE Project Parameters和NR Project Parameters sheet")
        
        # 检查LTE Project Parameters sheet
        if 'LTE Project Parameters' in sheet_names:
            print(f"\n===== 检查LTE Project Parameters sheet =====")
            
            # 读取前几行数据
            df = pd.read_excel(xls, sheet_name='LTE Project Parameters', header=None, nrows=5)
            print(f"前5行数据:")
            print(df)
            
            # 提取中文名称（第一行中\n之前的部分）
            header_row = df.iloc[0]
            clean_columns = []
            for col in header_row:
                col_str = str(col).strip() if pd.notna(col) else ''
                if '\n' in col_str:
                    chinese_name = col_str.split('\n')[0].strip()
                    clean_columns.append(chinese_name)
                else:
                    clean_columns.append(col_str)
            
            print(f"\n提取到的列名: {clean_columns}")
            
            # 检查是否包含管理网元ID列
            if any('管理网元ID' in col or '网元' in col for col in clean_columns):
                print(f"\n✅ 包含管理网元ID相关列")
            
    except Exception as e:
        print(f"读取文件失败: {e}")
        import traceback
        traceback.print_exc()
else:
    print(f"文件不存在: {file_path}")

print("\n检查完成!")
