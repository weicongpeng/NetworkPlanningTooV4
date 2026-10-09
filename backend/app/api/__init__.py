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
from starlette.types import ASGIApp, Scope, Receive, Send
import logging
import multiprocessing
import socket
import sys
from concurrent.futures import ProcessPoolExecutor

from app.core.config import settings
from app.api.v1 import api_router


class SelectiveGZipMiddleware(GZipMiddleware):
    """GZip 中间件——跳过已压缩二进制文件（APK）的二次压缩

    APK 本身已是 ZIP 压缩格式，二次 GZip 在 ARM 芯片上消耗大量 CPU
    且破坏流式响应，导致下载变慢。此中间件对指定路径跳过压缩。
    """
    EXCLUDE_PATHS = (
        "/api/v1/app-versions/download/",
        "/api/v1/desktop-cloud/releases/download/",
        "/apks/",
    )

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            path = scope.get("path", "")
            if any(path.startswith(excluded) for excluded in self.EXCLUDE_PATHS):
                # 直接透传，不做任何压缩
                await self.app(scope, receive, send)
                return
        await super().__call__(scope, receive, send)

# 前端构建产物目录（冻结时位于资源根 _MEIPASS 内，由 PyInstaller add-data 提供）
FRONTEND_DIST = settings.BUNDLE_DIR / "frontend" / "dist-renderer"


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

    # 创建 APK 文件存储目录（可写数据根下）
    apks_dir = settings.APKS_DIR
    apks_dir.mkdir(parents=True, exist_ok=True)
    logger.info(f"✅ APK 存储目录已创建: {apks_dir}")

    # 创建桌面版安装包目录（OTA 分发）
    desktop_releases_dir = settings.DESKTOP_RELEASES_DIR
    desktop_releases_dir.mkdir(parents=True, exist_ok=True)
    logger.info(f"✅ 桌面版安装包目录已创建: {desktop_releases_dir}")

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

    # 🧹 清理 layer_tmp 中超过 24h 的临时文件
    # 分块上传后未消费/失败的残留（src_*），以及端点处理产生的临时副本
    import time
    _layer_tmp = settings.UPLOAD_DIR / "layer_tmp"
    if _layer_tmp.exists():
        now = time.time()
        removed = 0
        for f in _layer_tmp.glob("src_*"):
            try:
                if now - f.stat().st_mtime > 86400:  # 24h
                    f.unlink(missing_ok=True)
                    removed += 1
            except Exception:
                pass
        if removed:
            logger.info(f"✅ 已清理 {removed} 个过期 layer_tmp 临时文件")
        else:
            logger.info("✅ layer_tmp 临时文件检查完成，无过期文件")

    # 🧹 清理 distance_tmp 中超过 24h 的临时文件（批量距离匹配上传的清单残留）
    _distance_tmp = settings.UPLOAD_DIR / "distance_tmp"
    if _distance_tmp.exists():
        now = time.time()
        removed = 0
        for f in _distance_tmp.glob("src_*"):
            try:
                if now - f.stat().st_mtime > 86400:  # 24h
                    f.unlink(missing_ok=True)
                    removed += 1
            except Exception:
                pass
        if removed:
            logger.info(f"✅ 已清理 {removed} 个过期 distance_tmp 临时文件")
        else:
            logger.info("✅ distance_tmp 临时文件检查完成，无过期文件")

    # 初始化用户数据库
    try:
        from app.core.database import init_db, create_default_admin
        init_db()
        logger.info("✅ 用户数据库初始化完成")
        create_default_admin()
        logger.info("✅ 默认管理员账号检查完成")
    except Exception as e:
        logger.error(f"❌ 用户数据库初始化失败: {e}")

    # 桌面模式：同步签名授权到期日到 admin（前端展示依赖，失败不影响授权校验）
    try:
        if settings.NPT_DESKTOP:
            from app.services.license_service import license_service
            license_service.sync_desktop_admin_expiry()
    except Exception as e:
        logger.warning(f"⚠️ 同步桌面授权状态失败: {e}")

    # 桌面模式：后台自动续期（剩余 <20 天 或 距上次续期 ≥7 天时静默续期）
    if settings.NPT_DESKTOP:
        try:
            import asyncio
            from app.services.desktop_cloud_client import renewal_loop
            asyncio.create_task(renewal_loop())
        except Exception as e:
            logger.warning(f"⚠️ 启动桌面自动续期任务失败: {e}")

    # 桌面模式：共享模式定时数据同步（离线模式下任务内自行跳过）
    if settings.NPT_DESKTOP:
        try:
            import asyncio
            from app.services.desktop_sync_service import sync_loop
            asyncio.create_task(sync_loop())
        except Exception as e:
            logger.warning(f"⚠️ 启动桌面数据同步任务失败: {e}")

    # 桌面模式：同组数据变更即时监听（服务器长轮询 → 立刻同步，定时同步仅作兜底）
    if settings.NPT_DESKTOP:
        try:
            import asyncio
            from app.services.desktop_sync_service import watch_loop
            asyncio.create_task(watch_loop())
        except Exception as e:
            logger.warning(f"⚠️ 启动桌面数据变更监听失败: {e}")

    # 桌面模式：登录态守卫（同一账号在别处登录 → 本机自动登出）
    if settings.NPT_DESKTOP:
        try:
            import asyncio
            from app.api.v1.endpoints.desktop_local import session_guard_loop
            asyncio.create_task(session_guard_loop())
        except Exception as e:
            logger.warning(f"⚠️ 启动桌面登录态守卫失败: {e}")

    # 初始化进程池（用于 CPU 密集型任务）
    pool = None
    try:
        if hasattr(settings, 'MAX_WORKERS') and settings.MAX_WORKERS > 1:
            # fork 仅 Linux 可用；Windows/macOS 必须 spawn。
            # 冻结包（桌面版）默认 MAX_WORKERS=1，不会走到这里。
            mp_ctx = "fork" if sys.platform.startswith("linux") else "spawn"
            pool = ProcessPoolExecutor(
                max_workers=settings.MAX_WORKERS,
                mp_context=mp_ctx
            )
            logger.info(f"✅ ProcessPoolExecutor 已创建: {settings.MAX_WORKERS} workers ({mp_ctx})")

            # 注入到 TaskManager
            from app.services.task_manager import task_manager
            task_manager.set_process_pool(pool)
    except Exception as e:
        logger.warning(f"⚠️ ProcessPoolExecutor 创建失败: {e}，将使用线程池")
        pool = None

    # 🔥 启动时后台预热所有 MapInfo 图层的 GeoJSON 缓存
    # 解决"首次勾选图层时后端 parse+转换耗时过长导致前端 300s 超时"：
    # 现有数据在启动时即预热磁盘缓存，后续勾选图层请求直接命中缓存
    try:
        from app.services.data_service import data_service
        data_service.prewarm_all_map_caches()
    except Exception as e:
        logger.error(f"❌ 启动预热图层缓存失败: {e}")

    # 服务器形态：后台补齐存量任务的小数量与「已应用」标记（同组任务历史展示用）。
    # 只扫未计算过/标记为未应用的行，分批解析提交；桌面端不需要（本机任务可直接算）。
    if not settings.NPT_DESKTOP:
        try:
            import threading

            from app.services.task_manager import task_manager as _task_manager

            def _backfill_task_metadata() -> None:
                try:
                    count = _task_manager.backfill_task_cell_counts()
                    if count:
                        logger.info(f"✅ 存量任务小数量回填完成: {count} 条")
                except Exception as exc:  # noqa: BLE001
                    logger.warning(f"⚠️ 存量任务小数量回填失败: {exc}")
                try:
                    applied = _task_manager.backfill_applied_flags()
                    if applied:
                        logger.info(f"✅ 存量任务「已应用」标记回填完成: {applied} 条")
                except Exception as exc:  # noqa: BLE001
                    logger.warning(f"⚠️ 存量任务「已应用」标记回填失败: {exc}")

            threading.Thread(target=_backfill_task_metadata, daemon=True, name="npt-task-meta-backfill").start()
        except Exception as e:
            logger.warning(f"⚠️ 启动任务元数据回填失败: {e}")

    logger.info("应用启动完成")
    yield

    # 关闭时执行
    logger.info("应用关闭中...")
    if pool is not None:
        try:
            pool.shutdown(wait=False)
            logger.info("ProcessPoolExecutor 已关闭")
        except Exception as e:
            logger.warning(f"ProcessPoolExecutor 关闭异常: {e}")
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
        description="网优引擎API",
        lifespan=lifespan,
        default_response_class=UTF8JSONResponse,  # 设置默认响应类为UTF-8 JSON响应
    )

    # 诊断：python-multipart 不可用（如冻结包漏收）时，所有文件上传都会返回
    # 400 "There was an error parsing the body"，而真实原因会被 FastAPI 吞掉
    try:
        import multipart  # noqa: F401
    except Exception as exc:  # noqa: BLE001
        logging.getLogger(__name__).error("python-multipart 不可用，文件上传将全部失败: %s", exc)

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

    # GZip 压缩（排除 APK 等已压缩二进制文件——二次压缩在 ARM 上 CPU 开销极高）
    app.add_middleware(SelectiveGZipMiddleware, minimum_size=1024)

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

    # 图层制作输出文件（下载）
    layers_dir = settings.UPLOAD_DIR / "layers"
    layers_dir.mkdir(parents=True, exist_ok=True)
    app.mount("/layer-files", StaticFiles(directory=str(layers_dir)), name="layer-files")

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
            "message": "网优引擎API",
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
