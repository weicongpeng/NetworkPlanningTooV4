"""
API路由创建和注册
"""

from pathlib import Path
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, HTMLResponse
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
            return json.dumps(
                content,
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

    # 注册路由
    app.include_router(api_router, prefix=settings.API_V1_STR)

    # 静态文件服务（用于导出文件下载）
    # 在挂载静态文件之前确保目录存在
    settings.OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    app.mount("/static", StaticFiles(directory=str(settings.OUTPUT_DIR)), name="static")

    @app.get("/")
    async def root():
        # 前端已构建时，返回前端页面
        index_path = FRONTEND_DIST / "index.html"
        if index_path.exists():
            return HTMLResponse(index_path.read_text(encoding="utf-8"))
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
            return FileResponse(file_path)

        # SPA 回退：所有前端路由都返回 index.html
        index_path = FRONTEND_DIST / "index.html"
        if index_path.exists():
            return HTMLResponse(index_path.read_text(encoding="utf-8"), media_type="text/html")

        raise HTTPException(status_code=404)

    return app
