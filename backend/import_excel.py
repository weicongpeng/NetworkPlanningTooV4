"""
完整的文件导入脚本 - 绕过Web上传
直接处理本地Excel文件并添加到数据库
"""
import sys
from pathlib import Path
ROOT_DIR = Path(__file__).parent
sys.path.insert(0, str(ROOT_DIR))

import json
import shutil
import uuid
from datetime import datetime
import pandas as pd

from app.core.config import settings
from app.services.data_service import data_service

def import_excel_file(file_path: str):
    """
    直接导入Excel文件到系统
    
    Args:
        file_path: Excel文件的完整路径
    """
    file_path = Path(file_path)
    
    if not file_path.exists():
        print(f"❌ 错误: 文件不存在 - {file_path}")
        return False
    
    if not file_path.suffix.lower() in ['.xlsx', '.xls']:
        print(f"❌ 错误: 不是Excel文件 - {file_path}")
        return False
    
    print("="*80)
    print("开始导入Excel文件")
    print("="*80)
    print(f"文件: {file_path.name}")
    print(f"大小: {file_path.stat().st_size:,} 字节")
    print()
    
    # 生成UUID
    data_id = str(uuid.uuid4())
    print(f"生成ID: {data_id}")
    
    try:
        # 1. 打开Excel文件
        print(f"\n步骤1: 读取Excel文件...")
        with pd.ExcelFile(file_path) as xls:
            sheet_names = xls.sheet_names
            print(f"  Sheet列表: {sheet_names}")
            
            # 2. 判断文件类型
            print(f"\n步骤2: 识别文件类型...")
            file_type = data_service._classify_file(file_path.name, sheet_names)
            print(f"  文件类型: {file_type}")
            
            # 3. 解析数据
            print(f"\n步骤3: 解析数据...")
            parsed_data = {}
            metadata = {}
            
            if file_type == "full_params":
                # 全量工参
                for network in ['LTE', 'NR']:
                    sheet_name = f"{network} Project Parameters"
                    if sheet_name in sheet_names:
                        print(f"  解析 {sheet_name}...")
                        sites = data_service._parse_sheet_data(xls, sheet_name, network)
                        parsed_data[network] = sites
                        metadata[f"{network}SiteCount"] = len(sites)
                        metadata[f"{network}SectorCount"] = sum(len(s.get('sectors', [])) for s in sites)
                        print(f"    ✓ {len(sites)} 个基站, {metadata[f'{network}SectorCount']} 个小区")
                        
            elif file_type == "target_cells":
                # 待规划小区
                for network in ['LTE', 'NR']:
                    if network in sheet_names:
                        print(f"  解析 {network}...")
                        sites = data_service._parse_sheet_data(xls, network, network)
                        parsed_data[network] = sites
                        metadata[f"{network}SiteCount"] = len(sites)
                        metadata[f"{network}SectorCount"] = sum(len(s.get('sectors', [])) for s in sites)
                        print(f"    ✓ {len(sites)} 个基站, {metadata[f'{network}SectorCount']} 个小区")
            else:
                # 默认格式
                print(f"  使用默认解析...")
                sites = data_service._parse_default_excel(xls)
                parsed_data['default'] = sites
                metadata['siteCount'] = len(sites)
                metadata['sectorCount'] = sum(len(s.get('sectors', [])) for s in sites)
                print(f"    ✓ {len(sites)} 个基站, {metadata['sectorCount']} 个小区")
        
        # 4. 保存数据
        print(f"\n步骤4: 保存数据...")
        data_dir = settings.DATA_DIR / data_id
        data_dir.mkdir(parents=True, exist_ok=True)
        
        # 保存原始文件
        shutil.copy(file_path, data_dir / "original.xlsx")
        print(f"  ✓ 原始文件已保存")
        
        # 保存解析后的数据
        with open(data_dir / "data.json", 'w', encoding='utf-8') as f:
            json.dump(parsed_data, f, ensure_ascii=False, indent=2)
        print(f"  ✓ 数据已保存为JSON")
        
        # 5. 更新索引
        print(f"\n步骤5: 更新索引...")
        data_service.index[data_id] = {
            "id": data_id,
            "name": file_path.name,
            "type": "excel",
            "fileType": file_type,
            "size": file_path.stat().st_size,
            "uploadDate": datetime.now().isoformat(),
            "status": "ready",
            "metadata": metadata
        }
        data_service._save_index()
        print(f"  ✓ 索引已更新")
        
        print(f"\n" + "="*80)
        print(f"✅ 导入成功！")
        print(f"="*80)
        print(f"数据ID: {data_id}")
        print(f"文件名: {file_path.name}")
        print(f"类型: {file_type}")
        print(f"元数据: {metadata}")
        print()
        print("现在您可以刷新前端页面，应该能看到导入的数据。")
        
        return True
        
    except Exception as e:
        print(f"\n❌ 导入失败: {type(e).__name__}: {e}")
        import traceback
        traceback.print_exc()
        
        # 清理
        data_dir = settings.DATA_DIR / data_id
        if data_dir.exists():
            shutil.rmtree(data_dir)
            print(f"已清理失败的数据")
        
        return False


if __name__ == "__main__":
    # 默认文件路径
    default_file = r"D:\mycode\NetworkPlanningTooV2\全量工参\ProjectParameter_mongoose河源电联20251225110859.xlsx"
    
    if len(sys.argv) > 1:
        file_to_import = sys.argv[1]
    else:
        file_to_import = default_file
        print(f"使用默认文件: {file_to_import}")
        print(f"您也可以指定文件: python import_excel.py <文件路径>\n")
    
    success = import_excel_file(file_to_import)
    
    if success:
        print("\n提示: 请刷新浏览器页面以查看导入的数据")
    else:
        print("\n导入失败，请检查错误信息")
    
    sys.exit(0 if success else 1)
