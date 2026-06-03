"""
API路由创建和注册
"""

from pathlib import Path
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.responses import Response
from contextlib import asynccontextmanager
import logging
import socket

from app.core.config import settings
from app.api.v1 import api_router

# 前端构建产物目录
FRONTEND_DIST = Path(__file__).parent.parent.parent.parent / "frontend" / "dist-renderer"


def get_local_ip():
    """获取本机局域网IP"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


local_ip = get_local_ip()

# 配置日志
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期管理"""
    # 启动时执行
    logger.info("应用启动中...")

    # 确保必要的目录存在
    settings.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    settings.OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    settings.LICENSE_DIR.mkdir(parents=True, exist_ok=True)
    settings.DATA_DIR.mkdir(parents=True, exist_ok=True)
    settings.TEMPLATE_DIR.mkdir(parents=True, exist_ok=True)

    # 🔥 启动时自动清理无效数据索引
    # 清理文件已删除但索引中仍存在的无效项
    try:
        from app.services.data_service import data_service
        cleanup_result = data_service.cleanup_index()
        removed_count = cleanup_result.get('removed', 0)
        if removed_count > 0:
            logger.info(f"✅ 已清理 {removed_count} 个无效数据索引项")
            for item in cleanup_result.get('items', []):
                logger.info(f"   - {item.get('name', '未知')} ({item.get('id', '')}): {item.get('reason', '')}")
        else:
            logger.info("✅ 数据索引检查完成，无无效项")
    except Exception as e:
        logger.error(f"❌ 清理无效数据索引失败: {e}")

    # 初始化用户数据库
    try:
        from app.core.database import init_db, create_default_admin
        init_db()
        logger.info("✅ 用户数据库初始化完成")
        create_default_admin()
        logger.info("✅ 默认管理员账号检查完成")
    except Exception as e:
        logger.error(f"❌ 用户数据库初始化失败: {e}")

    logger.info("应用启动完成")
    yield

    # 关闭时执行
    logger.info("应用关闭中...")
    logger.info("应用关闭完成")


def create_app() -> FastAPI:
    """创建FastAPI应用实例"""

    # 配置JSON响应使用UTF-8编码
    from fastapi.responses import JSONResponse
    from fastapi.encoders import jsonable_encoder
    from typing import Any
    import json

    # 自定义JSON响应类，确保使用UTF-8编码
    class UTF8JSONResponse(JSONResponse):
        def render(self, content: Any) -> bytes:
            # 使用UTF-8编码序列化JSON
            # 🔥 禁止 allow_nan，避免 NaN/Infinity 产生非法 JSON 导致前端 JSON.parse 失败
            # NaN/Infinity 会被 json.dumps 拒绝（raise ValueError），通过 sanitize 转为字符串
            try:
                return json.dumps(
                    content,
                    ensure_ascii=False,
                    allow_nan=False,
                    indent=None,
                    separators=(",", ":"),
                ).encode("utf-8")
            except (ValueError, OverflowError) as e:
                # 回退：递归替换 NaN/Infinity 为字符串，确保响应始终有效 JSON
                import math as _math
                def _sanitize(obj):
                    if isinstance(obj, float):
                        if _math.isnan(obj):
                            return None
                        if _math.isinf(obj):
                            return None
                        return obj
                    elif isinstance(obj, dict):
                        return {k: _sanitize(v) for k, v in obj.items()}
                    elif isinstance(obj, (list, tuple)):
                        return [_sanitize(i) for i in obj]
                    elif isinstance(obj, (int, bool, str, type(None))):
                        return obj
                    else:
                        return str(obj)
                return json.dumps(
                    _sanitize(content),
                    ensure_ascii=False,
                    allow_nan=False,
                    indent=None,
                    separators=(",", ":"),
                ).encode("utf-8")

    app = FastAPI(
        title=settings.PROJECT_NAME,
        version=settings.VERSION,
        description="网络规划工具API",
        lifespan=lifespan,
        default_response_class=UTF8JSONResponse,  # 设置默认响应类为UTF-8 JSON响应
    )

    # 配置CORS
    # 保留原有配置，同时添加局域网IP支持
    cors_origins = settings.BACKEND_CORS_ORIGINS + [
        f"http://{local_ip}:5173",
        f"http://{local_ip}:8000",
    ]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_origin_regex=r"(http://.*:(5173|8000))|(https://.*\.pengwc\.asia)|(null)|(file://.*)",
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["Content-Disposition", "Content-Length", "Content-Type"],
    )

    # GZip 压缩（对大响应启用，移动端受益明显：9MB → ~1.5MB）
    app.add_middleware(GZipMiddleware, minimum_size=1024)

    # 添加 Cache-Control 中间件：防止 HTML 被浏览器缓存
    @app.middleware("http")
    async def add_cache_control(request, call_next):
        response = await call_next(request)
        if response.headers.get("content-type", "").startswith("text/html"):
            response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        return response

    # 注册路由
    app.include_router(api_router, prefix=settings.API_V1_STR)

    # 静态文件服务（用于导出文件下载）
    # 在挂载静态文件之前确保目录存在
    settings.OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    app.mount("/static", StaticFiles(directory=str(settings.OUTPUT_DIR)), name="static")

    def _serve_index():
        """读取 index.html 并返回 HTML 响应（禁用缓存）"""
        index_path = FRONTEND_DIST / "index.html"
        if not index_path.exists():
            return None
        from fastapi.responses import Response
        content = index_path.read_text(encoding="utf-8")
        return Response(
            content=content,
            media_type="text/html",
            headers={
                "Cache-Control": "no-cache, no-store, must-revalidate",
                "Pragma": "no-cache",
                "Expires": "0",
            }
        )

    @app.get("/")
    async def root():
        result = _serve_index()
        if result:
            return result
        return {
            "message": "网络规划工具API",
            "version": settings.VERSION,
            "status": "running",
        }

    @app.get("/health")
    async def health():
        return {"status": "healthy"}

    # SPA 前端托管：捕获所有未匹配的 GET 请求
    # 优先返回 dist 中的静态文件，否则作为 SPA 路由返回 index.html
    @app.get("/{full_path:path}")
    async def serve_frontend(full_path: str):
        # 排除 API 和系统路径
        if full_path.startswith("api/") or full_path.startswith("static/") or full_path == "health":
            raise HTTPException(status_code=404)

        file_path = FRONTEND_DIST / full_path
        if file_path.exists() and file_path.is_file():
            # JS/CSS 等带 hash 的静态资源可以缓存（Vite 输出文件名含内容哈希）
            # 没有 hash 的普通文件短时间缓存
            ext = Path(full_path).suffix
            if ext in ('.js', '.css'):
                return FileResponse(file_path, headers={
                    "Cache-Control": "public, max-age=31536000, immutable",
                })
            return FileResponse(file_path, headers={
                "Cache-Control": "no-cache, must-revalidate",
            })

        # SPA 回退：所有前端路由都返回 index.html
        result = _serve_index()
        if result:
            return result

        raise HTTPException(status_code=404)

    return app
