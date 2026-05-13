"""
完整模拟上传流程测试
"""
import sys
import os
from pathlib import Path

# 添加项目路径
ROOT_DIR = Path(__file__).parent
sys.path.insert(0, str(ROOT_DIR))

import pandas as pd
from app.core.config import settings

# 测试文件路径
test_file = r'D:\mycode\NetworkPlanningTooV2\全量工参\ProjectParameter_mongoose河源电联20251225110859.xlsx'

print("=" * 80)
print("完整上传流程测试")
print("=" * 80)

class MockFile:
    """模拟UploadFile对象"""
    def __init__(self, file_path):
        self.filename = os.path.basename(file_path)
        self.file_path = file_path
        
    async def read(self):
        with open(self.file_path, 'rb') as f:
            return f.read()

async def test_upload():
    """模拟上传流程"""
    import uuid
    import re
    
    print(f"\n1. 模拟文件上传")
    print(f"   源文件: {test_file}")
    print(f"   文件名: {os.path.basename(test_file)}")
    
    # 模拟文件对象
    mock_file = MockFile(test_file)
    
    # 生成UUID
    data_id = str(uuid.uuid4())
    print(f"   生成ID: {data_id}")
    
    # 清理文件名
    safe_filename = re.sub(r'[<>:"/\\|?*]', '_', mock_file.filename)
    if len(safe_filename) > 100:
        name, ext = os.path.splitext(safe_filename)
        safe_filename = name[:90] + ext
    print(f"   安全文件名: {safe_filename}")
    
    # 保存文件
    file_path = settings.UPLOAD_DIR / f"{data_id}.xlsx"
    print(f"   目标路径: {file_path}")
    
    try:
        print("\n2. 保存文件到上传目录...")
        content = await mock_file.read()
        print(f"   读取了 {len(content):,} 字节")
        
        with open(file_path, 'wb') as f:
            f.write(content)
        print(f"   ✓ 文件已保存")
        
        # 检查文件
        if file_path.exists():
            print(f"   ✓ 文件存在，大小: {file_path.stat().st_size:,} 字节")
        else:
            print(f"   ✗ 文件保存失败！")
            return
        
        print("\n3. 打开Excel文件...")
        with pd.ExcelFile(file_path) as xls:
            sheet_names = xls.sheet_names
            print(f"   ✓ 成功打开")
            print(f"   Sheet列表: {sheet_names}")
            
            # 判断文件类型
            print("\n4. 判断文件类型...")
            filename_lower = mock_file.filename.lower()
            sheet_names_lower = [s.lower() for s in sheet_names]
            
            # 待规划小区
            if 'cell-tree' in filename_lower or 'export' in filename_lower:
                file_type = "target_cells"
            # 全量工参
            elif 'lte project parameters' in sheet_names_lower and \
                 'nr project parameters' in sheet_names_lower:
                file_type = "full_params"
            else:
                file_type = "default"
            
            print(f"   识别类型: {file_type}")
            
            if file_type == "full_params":
                print("\n5. 解析全量工参文件...")
                
                for network in ['LTE', 'NR']:
                    sheet_name = f"{network} Project Parameters"
                    if sheet_name in sheet_names:
                        print(f"\n   处理 {sheet_name}:")
                        
                        try:
                            # 读取第一行
                            header_row = pd.read_excel(xls, sheet_name=sheet_name, header=None, nrows=1).iloc[0]
                            print(f"     列数: {len(header_row)}")
                            
                            # 检查列名
                            first_col = str(header_row.iloc[0])
                            if '\n' in first_col:
                                print(f"     ✓ 包含多行列名")
                            
                            # 读取数据
                            df = pd.read_excel(xls, sheet_name=sheet_name, header=None, skiprows=3)
                            print(f"     ✓ 读取数据: {df.shape[0]} 行 x {df.shape[1]} 列")
                            
                            # 设置列名
                            clean_columns = []
                            for col in header_row:
                                col_str = str(col).strip() if pd.notna(col) else ''
                                if '\n' in col_str:
                                    chinese_name = col_str.split('\n')[0].strip()
                                    clean_columns.append(chinese_name)
                                else:
                                    clean_columns.append(col_str)
                            
                            df.columns = clean_columns
                            print(f"     列名示例: {list(df.columns)[:5]}")
                            
                            # 检查必需列
                            required = ['基站ID', '经度', '纬度', '小区ID']
                            found_cols = []
                            for req in required:
                                for col in df.columns:
                                    if req in str(col):
                                        found_cols.append(req)
                                        break
                            
                            print(f"     找到必需列: {found_cols}")
                            
                            if len(found_cols) >= 3:
                                print(f"     ✓ 包含足够的必需列")
                            else:
                                print(f"     ✗ 缺少必需列")
                            
                        except Exception as e:
                            print(f"     ✗ 解析失败: {e}")
                            import traceback
                            traceback.print_exc()
            
            else:
                print(f"\n   ✗ 文件类型不是全量工参！")
        
        # 清理测试文件
        print(f"\n6. 清理测试文件...")
        if file_path.exists():
            file_path.unlink()
            print(f"   ✓ 已删除测试文件")
        
        print("\n" + "=" * 80)
        print("✓ 测试完成")
        print("=" * 80)
        
    except PermissionError as e:
        print(f"\n✗ 权限错误: {e}")
        print("   → 文件可能正在被其他程序使用")
        
    except OSError as e:
        print(f"\n✗ 系统错误 [Errno {e.errno}]: {e}")
        if e.errno == 22:
            print("   → 这就是您看到的 [Errno 22] Invalid argument 错误!")
        
    except Exception as e:
        print(f"\n✗ 未预期的错误: {type(e).__name__}: {e}")
        import traceback
        traceback.print_exc()

# 运行异步测试
if __name__ == "__main__":
    import asyncio
    asyncio.run(test_upload())
