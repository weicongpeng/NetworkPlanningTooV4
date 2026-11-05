"""结果分页响应的缓存头：任务完成后结果不可变，可安全复用。"""
from __future__ import annotations

import hashlib
from typing import Optional

from fastapi import Request, Response

_CACHE_CONTROL = "private, max-age=86400"


def _etag(request: Request, task_id: str) -> str:
    raw = f"{task_id}|{request.url.path}?{request.url.query}".encode("utf-8")
    return '"' + hashlib.md5(raw).hexdigest() + '"'


def not_modified(request: Request, task_id: str) -> Optional[Response]:
    etag = _etag(request, task_id)
    if request.headers.get("if-none-match") == etag:
        return Response(
            status_code=304,
            headers={"ETag": etag, "Cache-Control": _CACHE_CONTROL},
        )
    return None


def apply_headers(request: Request, response: Response, task_id: str) -> None:
    response.headers["ETag"] = _etag(request, task_id)
    response.headers["Cache-Control"] = _CACHE_CONTROL
