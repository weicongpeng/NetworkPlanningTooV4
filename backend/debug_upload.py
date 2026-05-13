import sys
import os
from pathlib import Path

# 添加app目录到路径
sys.path.append(str(Path(__file__).parent))

import asyncio
from app.services.data_service import data_service
from app.core.config import settings

async def test_upload_map():
    print("Testing upload_map with None file and local path...")
    try:
        # 预先创建一个测试文件
        test_file = Path("test_map.tab")
        test_file.touch()
        
        # 调用 upload_map
        result = await data_service.upload_map(None, str(test_file.absolute()))
        print(f"Success! Result: {result}")
        
    except Exception as e:
        print(f"Failed with error: {type(e).__name__}: {e}")
        import traceback
        traceback.print_exc()
    finally:
        if Path("test_map.tab").exists():
            os.remove("test_map.tab")

if __name__ == "__main__":
    asyncio.run(test_upload_map())
