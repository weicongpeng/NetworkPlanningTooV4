"""网优助手对话编排

流程：用户问法 → 模型挑工具 → 后端执行取数 → 结果回灌 → 模型组织中文回答。
数据安全：模型拿不到数据库，只能调用白名单工具；所有数字来自工具返回；
聚合类问题一律走 analyze（QueryPlan），不允许模型自己算或写 SQL。
"""
import json
from typing import Any, Dict, List, Optional

from . import catalog, llm_client, query_service

_MAX_TOOL_ROUNDS = 5

_SYSTEM_PROMPT = """你是网优引擎内置的「网优助手」，服务通信网优工程师。你只能通过调用工具查询数据，回答必须严格基于工具返回的结果。

【铁律】
1. 严禁编造任何数字、参数值、站点名、指标。所有数值只能来自工具返回；不得自己做算术，需要聚合就算 analyze。
2. 工具返回 found=false 或带 candidates 时，不要猜，直接告诉用户未找到并列出候选名称让用户确认。
3. 小区名可能不精确时先调 search_cells 确认精确名，再用精确名查。
4. 聚合/趋势/排名/TopN/按维度统计/跨表对比（如"按 TAC 统计掉线率""最差 10 个小区""4G 与 5G 对比"）必须调 analyze，并传 QueryPlan：dataset=metrics，metrics 用口径名（掉线率/接通率/流量…），dimensions 用数据目录里的字段名。
5. 单小区的参数配置调 get_cell_params；单小区的规划参数（经纬度/PCI/TAC/频点/方位角）调 get_cell_workparams；周边距离调 find_nearby_sites。
6. 不确定有哪些数据时先调 catalog 或 data_overview，按目录里真实存在的指标与字段提问，不要猜列名。
7. 回答末尾附一句取数配方（把工具返回的 recipe 原样转述，含时间窗/过滤/聚合口径/行数）。工具返回 note/degraded 时必须转述这个限制。
8. 用简体中文，先给结论，再给依据；参数较多时用表格。日期默认用用户给出的，没给就不传日期。
"""


def _analyze_schema() -> Dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": "analyze",
            "description": ("聚合分析唯一入口：按维度统计指标、趋势、TopN、分组对比、跨表关联工参。"
                            "传结构化 QueryPlan，数值由服务端 SQL 计算。"),
            "parameters": {
                "type": "object",
                "properties": {
                    "dataset": {"type": "string", "enum": ["metrics", "sectors", "params"],
                                "description": "指标分析用 metrics；纯工参统计（如某制式小区数）用 sectors"},
                    "metrics": {
                        "type": "array",
                        "description": "要分析的指标（dataset=metrics 时必填），如 掉线率/接通率/流量",
                        "items": {
                            "type": "object",
                            "properties": {
                                "metric": {"type": "string", "description": "指标名或口径名"},
                                "agg": {"type": "string", "enum": ["ratio", "sum", "avg", "max"],
                                        "description": "可省略，默认按口径注册表"},
                                "label": {"type": "string", "description": "展示名，可省略"},
                            },
                            "required": ["metric"],
                        },
                    },
                    "dimensions": {
                        "type": "array",
                        "description": "分组维度（最多 3 个），取自数据目录字段",
                        "items": {
                            "type": "object",
                            "properties": {
                                "field": {"type": "string"},
                                "bucket": {"type": "string", "enum": ["hour", "day", "month"],
                                           "description": "仅时间维度需要"},
                            },
                            "required": ["field"],
                        },
                    },
                    "filters": {
                        "type": "array",
                        "description": "过滤条件（最多 10 个）",
                        "items": {
                            "type": "object",
                            "properties": {
                                "field": {"type": "string"},
                                "op": {"type": "string",
                                       "enum": ["=", "!=", "in", "not_in", ">", ">=", "<",
                                                "<=", "like", "between", "is_null",
                                                "is_not_null"]},
                                "value": {"description": "in/not_in 传数组，between 传 [起,止]"},
                            },
                            "required": ["field", "op"],
                        },
                    },
                    "time_range": {
                        "type": "object",
                        "properties": {
                            "start": {"type": "string", "description": "YYYY-MM-DD"},
                            "end": {"type": "string", "description": "YYYY-MM-DD"},
                            "granularity": {"type": "string",
                                            "enum": ["hour", "day", "month", "busy_hour"]},
                        },
                    },
                    "order_by": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {"field": {"type": "string"},
                                           "dir": {"type": "string", "enum": ["asc", "desc"]}},
                            "required": ["field"],
                        },
                    },
                    "limit": {"type": "integer", "description": "最多 5000 行，默认 200"},
                    "chart": {"type": "string",
                              "enum": ["auto", "line", "bar", "stacked_bar", "heatmap",
                                       "big_number", "table"],
                              "description": "auto 按结果自动选型"},
                },
                "required": ["dataset"],
            },
        },
    }


TOOLS: List[Dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "catalog",
            "description": "查看数据目录：真实存在的指标、字段、时间覆盖、粒度。不确定有哪些数据时先调用。",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_cells",
            "description": "按名称片段检索小区，返回按精确度排序的候选名称。用于确认精确名。",
            "parameters": {"type": "object", "properties": {
                "keyword": {"type": "string", "description": "小区/站点名片段"},
                "network_type": {"type": "string", "description": "可选，LTE 或 NR"}},
                "required": ["keyword"]},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_cell_params",
            "description": "查询某小区的基站无线参数配置（功率、切换门限、B2门限、重选参数等）。",
            "parameters": {"type": "object", "properties": {
                "cell_name": {"type": "string", "description": "小区精确名称"}},
                "required": ["cell_name"]},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_cell_workparams",
            "description": "查询某小区的全量工参：经纬度、方位角、PCI、TAC、频点、制式、所属站点。",
            "parameters": {"type": "object", "properties": {
                "cell_name": {"type": "string", "description": "小区精确名称"}},
                "required": ["cell_name"]},
        },
    },
    _analyze_schema(),
    {
        "type": "function",
        "function": {
            "name": "find_nearby_sites",
            "description": "以某小区为中心，查周边指定半径(km)内的小区清单，可按制式过滤。",
            "parameters": {"type": "object", "properties": {
                "site_name": {"type": "string"},
                "radius_km": {"type": "number", "description": "半径公里，默认 1.0"},
                "network_type": {"type": "string", "description": "LTE 或 NR，留空为全部"}},
                "required": ["site_name"]},
        },
    },
]

_DISPATCH = {
    "catalog": lambda user=None, **_: query_service.get_catalog(user=user),
    "search_cells": query_service.search_cells,
    "get_cell_params": query_service.get_cell_params,
    "get_cell_workparams": query_service.get_cell_workparams,
    "find_nearby_sites": query_service.find_nearby_sites,
}


def _exec_tool(name: str, args: Dict[str, Any], user=None) -> Dict[str, Any]:
    # 组隔离上下文由服务端注入，忽略模型可能伪造的 user 参数
    call_args = {k: v for k, v in args.items() if k != "user"}
    try:
        if name == "analyze":
            return query_service.analyze(call_args, user=user)
        fn = _DISPATCH.get(name)
        if not fn:
            return {"error": f"未知工具 {name}"}
        return fn(**call_args, user=user)
    except TypeError as exc:
        return {"error": f"工具 {name} 参数不合法：{exc}"}
    except Exception as exc:  # 工具异常不中断对话，回灌让模型说明
        return {"error": f"工具 {name} 执行失败：{exc}"}


def _system_prompt(user=None) -> str:
    try:
        cat = catalog.build_catalog(user)
        section = catalog.render_prompt(cat)
    except Exception as exc:  # 目录失败不阻断对话
        section = f"（数据目录读取失败：{exc}）"
    return f"{_SYSTEM_PROMPT}\n【当前数据目录】\n{section}\n"


def chat(history: List[Dict[str, str]], user=None) -> Dict[str, Any]:
    """处理一轮对话。

    返回 {"reply", "charts", "artifacts", "configured"}
    artifacts: [{charts, table, provenance}] —— 只给前端，不回灌模型。
    """
    if not llm_client.is_configured():
        return {"configured": False, "reply": "", "charts": [], "artifacts": [],
                "message": ("网优助手未配置大模型。请在【系统设置 → 大模型配置】填写接口地址、"
                            "API Key、模型名称后保存。")}

    messages: List[Dict[str, Any]] = [
        {"role": "system", "content": _system_prompt(user)}, *history]
    charts: List[Dict[str, Any]] = []
    artifacts: List[Dict[str, Any]] = []

    for _ in range(_MAX_TOOL_ROUNDS):
        msg = llm_client.chat(messages, tools=TOOLS)
        tool_calls = msg.get("tool_calls")
        if not tool_calls:
            return {"configured": True, "reply": msg.get("content", ""),
                    "charts": charts, "artifacts": artifacts}

        messages.append({"role": "assistant", "content": msg.get("content") or "",
                         "tool_calls": tool_calls})
        for call in tool_calls:
            fn = call.get("function", {})
            name = fn.get("name", "")
            try:
                args = json.loads(fn.get("arguments") or "{}")
            except json.JSONDecodeError:
                args = {}
            result = _exec_tool(name, args, user=user)
            if isinstance(result, dict):
                artifact = result.pop("artifacts", None)
                if artifact:
                    artifacts.append(artifact)
                    charts.extend(artifact.get("charts") or [])
                legacy_chart = result.pop("chart", None)
                if legacy_chart:
                    # 旧结构（周边站点散点）没有明细表/配方，包成 artifact 让前端统一渲染
                    charts.append(legacy_chart)
                    artifacts.append({"charts": [legacy_chart]})
            messages.append({
                "role": "tool",
                "tool_call_id": call.get("id", ""),
                "content": json.dumps(result, ensure_ascii=False, default=str),
            })

    final = llm_client.chat(messages, tools=None)
    return {"configured": True,
            "reply": final.get("content") or "已达到最大查询次数，请细化问题。",
            "charts": charts, "artifacts": artifacts}
