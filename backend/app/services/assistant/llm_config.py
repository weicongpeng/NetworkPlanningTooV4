"""网优助手 LLM 配置持久化

存储于 data/llm_config.json（部署在用户自有服务器，本地文件）。
未配置文件时回退到 .env 环境变量。api_key 对外读取时脱敏。
所有主流国产模型（DeepSeek/通义千问/豆包）及本地 vLLM/Ollama 均走 OpenAI 兼容协议。
"""
import json
from typing import Any, Dict

from app.core.config import settings

_CONFIG_PATH = settings.DATA_DIR / "llm_config.json"
_FIELDS = ("protocol", "base_url", "api_key", "model", "timeout")
_DEFAULTS: Dict[str, Any] = {
    "protocol": "openai", "base_url": "", "api_key": "", "model": "", "timeout": 60,
}


def load_config() -> Dict[str, Any]:
    """读取生效配置：文件优先，缺省回退 .env。"""
    cfg = dict(_DEFAULTS)
    if _CONFIG_PATH.exists():
        try:
            cfg.update({k: v for k, v in json.loads(
                _CONFIG_PATH.read_text(encoding="utf-8")).items() if k in _FIELDS})
            return cfg
        except Exception:
            pass
    # 回退环境变量
    cfg.update({
        "base_url": settings.NPT_LLM_BASE_URL,
        "api_key": settings.NPT_LLM_API_KEY,
        "model": settings.NPT_LLM_MODEL,
        "timeout": settings.NPT_LLM_TIMEOUT,
    })
    return cfg


def save_config(updates: Dict[str, Any]) -> Dict[str, Any]:
    """更新配置。api_key 传空串表示不修改（保留原值）。"""
    cfg = load_config()
    for k in _FIELDS:
        if k in updates and updates[k] is not None:
            if k == "api_key" and updates[k] == "":
                continue  # 空串=保持原密钥
            cfg[k] = updates[k]
    _CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    _CONFIG_PATH.write_text(
        json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    return cfg


def public_config() -> Dict[str, Any]:
    """对外视图：api_key 脱敏，仅回传是否已配置与掩码。"""
    c = load_config()
    key = c.get("api_key") or ""
    return {
        "protocol": c["protocol"],
        "base_url": c["base_url"],
        "model": c["model"],
        "timeout": c["timeout"],
        "has_api_key": bool(key),
        "api_key_masked": (key[:6] + "****") if len(key) > 6 else ("****" if key else ""),
    }
