"""OpenAI 兼容 LLM 客户端

任意 OpenAI 协议端点均可：DeepSeek、通义千问、豆包、本地 vLLM/Ollama 等。
模型仅用于“理解用户问法 → 生成工具调用参数 → 组织答复”，绝不返回它编造的数值。
"""
from typing import Any, Dict, List, Optional

from . import llm_config


class LLMNotConfigured(Exception):
    """未配置 LLM（base_url/api_key/model 任一为空）"""


def is_configured() -> bool:
    c = llm_config.load_config()
    return bool(c["base_url"] and c["api_key"] and c["model"])


def chat(messages: List[Dict[str, Any]], tools: Optional[List[Dict]] = None,
         temperature: float = 0.1) -> Dict[str, Any]:
    """调用 OpenAI 兼容 chat.completions，返回原始 message（dict）。

    tools 存在时走 function calling；返回的 message 可能含 tool_calls。
    失败抛出含中文原因的异常。
    """
    cfg = llm_config.load_config()
    if not (cfg["base_url"] and cfg["api_key"] and cfg["model"]):
        raise LLMNotConfigured(
            "网优助手尚未配置大模型。请在【系统设置 → 大模型配置】填写接口地址、API Key、模型名称后保存。")
    try:
        from openai import OpenAI
    except ImportError:
        raise LLMNotConfigured("后端缺少 openai 依赖，请在 backend 目录执行：pip install openai")

    client = OpenAI(
        base_url=cfg["base_url"],
        api_key=cfg["api_key"],
        timeout=cfg["timeout"] or 60,
    )
    try:
        kwargs: Dict[str, Any] = {
            "model": cfg["model"],
            "messages": messages,
            "temperature": temperature,
        }
        if tools:
            kwargs["tools"] = tools
            kwargs["tool_choice"] = "auto"
        resp = client.chat.completions.create(**kwargs)
        return resp.choices[0].message.model_dump()
    except Exception as e:  # 网络/鉴权/模型错误统一透传中文提示
        raise RuntimeError(f"调用大模型失败：{e}") from e
