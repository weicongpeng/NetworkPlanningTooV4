"""网优助手服务包

- ingest_service: 基站参数/指标 Excel·CSV 解析入库与删除
- query_service:  对话可调用的只读查询工具（参数/指标/距离/数据概览）
- llm_client:     OpenAI 兼容 LLM 客户端（DeepSeek/通义/豆包/本地 vLLM 等）
- chat_service:   Function Calling 编排（LLM 只生成工具调用，取数走 SQL）
"""
