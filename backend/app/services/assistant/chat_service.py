"""网优助手对话编排

流程：用户问法 → LLM 决定调用哪个只读工具 → 后端执行取数 → 结果回灌
      → LLM 据此组织中文回答。多轮工具调用最多 5 次。
数据安全：LLM 拿不到数据库，只能调用白名单工具；所有数字来自工具返回。
"""
import json
from typing import Any, Dict, List

from . import llm_client, query_service

_MAX_TOOL_ROUNDS = 5

_SYSTEM_PROMPT = """你是网优引擎内置的「网优助手」，服务通信网优工程师。你只能通过调用工具查询数据，回答必须严格基于工具返回的结果：

【铁律】
1. 严禁编造任何数字、参数值、站点名、指标。所有数值只能来自工具返回。
2. 工具返回 found=false 或有 candidates 时，不要猜测，直接告诉用户未找到并列出候选小区名让用户确认。
3. 涉及参数/指标查询前，若小区名可能不精确，先调用 search_cells 确认，再用精确名查。
4. 指标类问题（掉线率、接通率、趋势、对比）必须调用 query_metrics，回答中说明时间范围，并引用图表。
5. 距离/周边/多少公里内/LTE站点清单类问题调用 find_nearby_sites。
6. 无线参数配置（功率、门限、切换参数、B2门限等）调用 get_cell_params；不确定有哪些数据先调 data_overview。
7. 全量工参规划数据（经纬度、方位角、PCI、TAC、频点、制式、站点基础信息）调用 get_cell_workparams。距离/坐标类问题也可先取工参。
7. 用简体中文，先给结论，再给依据；参数较多时用表格。日期默认用用户给出的，没有给就不传日期。
"""

# 工具 JSON Schema（OpenAI function calling 格式）
TOOLS: List[Dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "data_overview",
            "description": "查看已导入的基站参数、指标数据集清单及其字段/时间范围。不确定有哪些数据时先调用。",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_cells",
            "description": "按名称关键词模糊搜索小区，返回候选小区名列表，用于确认小区精确名称。",
            "parameters": {"type": "object", "properties": {
                "keyword": {"type": "string", "description": "小区/站点名片段，如 双田AAU3"}},
                "required": ["keyword"]},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_cell_params",
            "description": "查询某小区的基站无线参数配置（功率、切换门限、B2门限、重选参数等），返回键值对。",
            "parameters": {"type": "object", "properties": {
                "cell_name": {"type": "string", "description": "小区精确名称"}},
                "required": ["cell_name"]},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "query_metrics",
            "description": "查询某小区指标的时间趋势（掉线率、接通率、流量等），按天聚合并返回图表数据。",
            "parameters": {"type": "object", "properties": {
                "cell_name": {"type": "string", "description": "小区精确名称"},
                "metric": {"type": "string", "description": "指标关键词，如 掉线率/接通率/流量"},
                "start_date": {"type": "string", "description": "开始日期 YYYY-MM-DD，可留空"},
                "end_date": {"type": "string", "description": "结束日期 YYYY-MM-DD，可留空"},
                "granularity": {"type": "string", "description": "粒度 hour/day/month/busy_hour，可留空"}},
                "required": ["cell_name", "metric"]},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_cell_workparams",
            "description": "查询某小区的全量工参规划数据：经纬度、方位角、PCI、TAC、频点、制式、所属站点。定位/距离/规划参数类问题使用。",
            "parameters": {"type": "object", "properties": {
                "cell_name": {"type": "string", "description": "小区精确名称"}},
                "required": ["cell_name"]},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "find_nearby_sites",
            "description": "以某站点/小区为中心，查询周边指定半径(km)内的小区/站点清单，可按制式 LTE/NR 过滤。",
            "parameters": {"type": "object", "properties": {
                "site_name": {"type": "string", "description": "中心站点/小区名"},
                "radius_km": {"type": "number", "description": "半径公里，默认 1.0"},
                "network_type": {"type": "string", "description": "制式过滤 LTE 或 NR，留空为全部"}},
                "required": ["site_name"]},
        },
    },
]

_DISPATCH = {
    "data_overview": lambda user=None, **_: query_service.data_overview(user=user),
    "search_cells": query_service.search_cells,
    "get_cell_params": query_service.get_cell_params,
    "get_cell_workparams": query_service.get_cell_workparams,
    "query_metrics": query_service.query_metrics,
    "find_nearby_sites": query_service.find_nearby_sites,
}


def _exec_tool(name: str, args: Dict[str, Any], user=None) -> Dict[str, Any]:
    fn = _DISPATCH.get(name)
    if not fn:
        return {"error": f"未知工具 {name}"}
    # 组隔离上下文由服务端注入，忽略模型可能伪造的 user 参数
    call_args = {k: v for k, v in args.items() if k != "user"}
    try:
        return fn(**call_args, user=user)
    except TypeError:
        return {"error": f"工具 {name} 参数不合法"}
    except Exception as e:  # 工具异常不中断对话，回灌错误让模型说明
        return {"error": f"工具 {name} 执行失败：{e}"}


def chat(history: List[Dict[str, str]], user=None) -> Dict[str, Any]:
    """处理一轮对话。

    history: [{"role": "user"/"assistant", "content": "..."}]
    user: 发起对话的当前用户，工具查询按其（地市+运营商）组隔离。
    返回 {"reply": str, "charts": [chart_spec...], "configured": bool}
    """
    if not llm_client.is_configured():
        return {"configured": False, "reply": "", "charts": [],
                "message": ("网优助手未配置大模型。请在后端 .env 设置 "
                            "NPT_LLM_BASE_URL / NPT_LLM_API_KEY / NPT_LLM_MODEL 后重启。")}

    messages: List[Dict[str, Any]] = [{"role": "system", "content": _SYSTEM_PROMPT}, *history]
    charts: List[Dict[str, Any]] = []

    for _ in range(_MAX_TOOL_ROUNDS):
        msg = llm_client.chat(messages, tools=TOOLS)
        tool_calls = msg.get("tool_calls")
        if not tool_calls:
            return {"configured": True, "reply": msg.get("content", ""), "charts": charts}

        # 把助手的工具调用消息原样入栈，再逐个执行并回灌结果
        messages.append({
            "role": "assistant",
            "content": msg.get("content") or "",
            "tool_calls": tool_calls,
        })
        for call in tool_calls:
            fn = call.get("function", {})
            name = fn.get("name", "")
            try:
                args = json.loads(fn.get("arguments") or "{}")
            except json.JSONDecodeError:
                args = {}
            result = _exec_tool(name, args, user=user)
            chart = result.get("chart") if isinstance(result, dict) else None
            if chart:
                charts.append(chart)
            messages.append({
                "role": "tool",
                "tool_call_id": call.get("id", ""),
                "content": json.dumps(result, ensure_ascii=False, default=str),
            })

    # 超过工具轮数仍未收敛：让模型基于已有结果直接总结（不再给工具）
    final = llm_client.chat(messages, tools=None)
    return {"configured": True, "reply": final.get("content", "已达到最大查询次数，请细化问题。"),
            "charts": charts}
