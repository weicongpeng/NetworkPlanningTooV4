"""
网络规划工具 - FastAPI后端主程序
"""
import sys
import os
from pathlib import Path

# 【重要】必须在最前面配置编码，避免Windows下GBK编码问题
# 方法1：设置环境变量（优先级最高）
os.environ['PYTHONIOENCODING'] = 'utf-8'
os.environ['PYTHONUTF8'] = '1'

# 方法2：覆盖内置的 print 函数，确保所有输出都是安全的
_original_print = print
def _safe_print(*args, **kwargs):
    """安全的print函数，处理编码错误和管道断开"""
    try:
        _original_print(*args, **kwargs)
    except UnicodeEncodeError:
        # 如果遇到编码错误，尝试用GBK安全的方式打印（Windows默认编码）
        safe_args = []
        for arg in args:
            if isinstance(arg, str):
                # 替换无法编码的字符
                safe_arg = arg.encode('gbk', errors='replace').decode('gbk')
                safe_args.append(safe_arg)
            else:
                safe_args.append(arg)
        _original_print(*safe_args, **kwargs)
    except OSError:
        # stdout/stderr 管道断开或关闭时（如 nohup/容器环境）静默忽略
        # 避免 [Errno 32] Broken pipe 导致任务中断
        pass

# 替换全局print函数
import builtins
builtins.print = _safe_print

# 方法3：配置stdout/stderr
if sys.platform == 'win32':
    try:
        # Python 3.7+ 支持的方法
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        # 降级方案：使用TextIOWrapper
        try:
            import io
            sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
            sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')
        except:
            pass

# 添加项目根目录到Python路径
ROOT_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT_DIR))

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
