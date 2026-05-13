#!/usr/bin/env python3
"""
检查uploads目录中的文件，判断是否是待规划小区文件
"""

import pandas as pd
import os

# 检查文件路径
file_path = "D:/mycode/NetworkPlanningTooV3/backend/uploads/b1ddec70-ae10-49fd-a37b-17a0b5545882.xlsx"

if os.path.exists(file_path):
    print(f"找到文件: {file_path}")
    
    try:
        # 读取Excel文件
        xls = pd.ExcelFile(file_path)
        
        # 查看sheet名称
        sheet_names = xls.sheet_names
        print(f"\nsheet名称: {sheet_names}")
        
        # 检查每个sheet的内容
        for sheet_name in sheet_names:
            print(f"\n===== 检查sheet: {sheet_name} =====")
            
            # 读取前几行数据
            df = pd.read_excel(xls, sheet_name=sheet_name, nrows=5)
            print(f"前5行数据:")
            print(df)
            
            # 查看列名
            print(f"\n列名: {list(df.columns)}")
            
            # 判断是否是待规划小区文件
            if 'LTE' in sheet_name or 'NR' in sheet_name:
                print(f"\n✅ 可能是待规划小区文件，包含LTE/NR sheet")
                
            # 检查是否包含特定列
            has_id = any(col in df.columns for col in ['eNodeBID', 'gNodeBID', '基站ID', 'SiteID'])
            has_cell = any(col in df.columns for col in ['CellID', '小区ID', 'sector'])
            has_coords = any(col in df.columns for col in ['Longitude', 'Latitude', '经度', '纬度', '基站经度', '基站纬度'])
            
            if has_id and has_cell and not has_coords:
                print(f"\n✅ 可能是待规划小区文件：包含ID和Cell列，但没有经纬度列")
            
    except Exception as e:
        print(f"读取文件失败: {e}")
        import traceback
        traceback.print_exc()
else:
    print(f"文件不存在: {file_path}")

print("\n检查完成!")
