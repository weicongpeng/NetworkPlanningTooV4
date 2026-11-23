"""
网优引擎 - FastAPI后端主程序
"""
import sys
import os
from pathlib import Path

# 【重要】必须在最前面配置编码，避免 Windows 下 GBK 编码问题
# 实现放在 app/core/console_encoding.py：print 兜底 + stdout/stderr 放宽
# （网页端/服务端沿用既有行为强制 utf-8；桌面端 desktop/launcher.py 共用同一实现，
#   传 force_utf8=False 保留控制台原生编码）
ROOT_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT_DIR))

from app.core.console_encoding import setup_console_encoding  # noqa: E402

setup_console_encoding()

import uvicorn
from app.api import create_app

app = create_app()

if __name__ == '__main__':
    # 从配置读取服务器参数
    from app.core.config import settings

    # 开发服务器配置
    # 注意：reload 模式下需要在启动命令中设置 PYTHONIOENCODING=utf-8
    # 或者在 uvicorn 配置中设置环境变量
    # 开发/生产模式配置
    # 生产环境建议设置 NPT_RELOAD=false 并使用 supervisor/systemd 管理进程
    use_reload = os.environ.get("NPT_RELOAD", "false").lower() == "true"

    # 生产环境建议设置 workers=1（默认）或多 workers 需要配合 NPT_MAX_TASKS 调整
    workers = int(os.environ.get("NPT_WORKERS", "1"))

    uvicorn.run(
        'main:app',
        host=settings.HOST,
        port=settings.PORT,
        reload=use_reload,
        workers=workers,
        log_level='warning',
        access_log=False,
        use_colors=False,
        # 🔥 关键：生产环境禁用 reload，避免 watchfiles 消耗资源
        reload_dirs=None if not use_reload else None,
    )
