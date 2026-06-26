"""Cloud LLM Service — Custom API wrapper for multi-modal AI integration."""
from __future__ import annotations

import asyncio
import json
from typing import Any, Optional

import httpx

from src.models.event import NavigationParseResponse, PerceptionAnalyzeResponse


class LLMService:
    """Wrapper around a custom cloud LLM API.

    Supports three modes:
    1. Semantic parsing — natural language → structured intent + POI name
    2. Multi-modal analysis — image + question → scene understanding
    3. Free chat — conversational Q&A with context
    4. Report generation — patrol events → Chinese summary
    """

    def __init__(
        self,
        api_url: str,
        api_key: str = "",
        model: str = "default-model",
        vision_model: Optional[str] = None,
        timeout: int = 30,
    ):
        self.api_url = api_url
        self.api_key = api_key
        self.model = model
        self.vision_model = vision_model or model
        self.timeout = timeout

    # -------------------------------------------------------------------------
    # Mode 1: Semantic instruction parsing
    # -------------------------------------------------------------------------

    async def parse_instruction(
        self,
        text: str,
        poi_whitelist: Optional[list[str]] = None,
    ) -> NavigationParseResponse:
        """
        Parse a natural-language instruction into a structured navigation intent.

        Example: "去会议室" → {intent: "navigate", poi_name: "会议室", confidence: 0.95}
        """
        whitelist_str = (
            ", ".join(poi_whitelist) if poi_whitelist else "无（自行判断）"
        )
        system_prompt = (
            "你是一个导航指令解析器。用户会输入自然语言指令，你需要判断其导航意图。\n"
            "可用的地点名称如下（请优先匹配）：\n"
            f"{whitelist_str}\n\n"
            "输出严格的 JSON 格式，不要包含任何其他文字：\n"
            "{\n"
            '  "intent": "navigate" | "unknown" | "cancel",\n'
            '  "poi_name": "地点名称（如匹配到可用地点）",\n'
            '  "confidence": 0.0~1.0,\n'
            '  "fallback_coords": {"x": 0, "y": 0} 或 null\n'
            "}\n"
            "只输出 JSON，不要有其他内容。"
        )

        response_text = await self._chat(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": text},
            ],
            model=self.model,
            temperature=0.1,
        )

        try:
            parsed = json.loads(response_text)
            return NavigationParseResponse(
                intent=parsed.get("intent", "unknown"),
                poi_name=parsed.get("poi_name"),
                target_coords=parsed.get("fallback_coords"),
                confidence=parsed.get("confidence", 0.0),
                raw_llm=parsed,
            )
        except json.JSONDecodeError:
            return NavigationParseResponse(
                intent="unknown",
                poi_name=None,
                target_coords=None,
                confidence=0.0,
                raw_llm={"raw": response_text},
            )

    # -------------------------------------------------------------------------
    # Mode 2: Multi-modal scene perception
    # -------------------------------------------------------------------------

    async def analyze_scene(
        self,
        image_base64: str,
        question: str = "描述这张图片中的关键信息，包括任何需要注意的物体或异常。",
    ) -> PerceptionAnalyzeResponse:
        """
        Analyze an image frame combined with a text question.

        Returns scene understanding, hazard level, and recommended action.
        """
        system_prompt = (
            "你是一个环境感知分析助手。给定一张图像和问题，返回结构化的分析结果。\n\n"
            "输出严格的 JSON 格式，不要包含任何其他文字：\n"
            "{\n"
            '  "analysis": "对场景的描述性分析（1-3句话）",\n'
            '  "hazard_level": "none | low | medium | high | critical",\n'
            '  "recommended_action": "建议的操作（简短发令，如"减速等待"或"继续前进"）"\n'
            "}\n"
            "注意：hazard_level 为 none 表示无任何风险，critical 表示极高风险需立即处理。\n"
            "只输出 JSON，不要有其他内容。"
        )

        response_text = await self._chat(
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": system_prompt},
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:image/jpeg;base64,{image_base64}"
                            },
                        },
                        {"type": "text", "text": question},
                    ],
                }
            ],
            model=self.vision_model,
            temperature=0.3,
        )

        try:
            parsed = json.loads(response_text)
            return PerceptionAnalyzeResponse(
                analysis=parsed.get("analysis", ""),
                hazard_level=parsed.get("hazard_level", "none"),
                recommended_action=parsed.get("recommended_action", "继续"),
                raw_llm=parsed,
            )
        except json.JSONDecodeError:
            return PerceptionAnalyzeResponse(
                analysis=response_text[:200],
                hazard_level="low",
                recommended_action="人工确认",
                raw_llm={"raw": response_text},
            )

    # -------------------------------------------------------------------------
    # Mode 3: Free chat with context
    # -------------------------------------------------------------------------

    async def chat(
        self,
        message: str,
        history: Optional[list[dict[str, str]]] = None,
        system_prompt: Optional[str] = None,
    ) -> str:
        """
        Free-form chat with optional conversation history.

        Args:
            message: Current user message
            history: List of {"role": "user"|"assistant", "content": "..."} entries
            system_prompt: Optional system-level instruction

        Returns:
            Assistant's reply text
        """
        messages: list[dict[str, Any]] = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        if history:
            messages.extend(history)
        messages.append({"role": "user", "content": message})

        return await self._chat(
            messages=messages,
            model=self.model,
            temperature=0.7,
        )

    # -------------------------------------------------------------------------
    # Mode 4: Patrol report generation
    # -------------------------------------------------------------------------

    async def generate_patrol_report(
        self,
        session_name: str,
        events: list[dict[str, Any]],
        checkpoints: list[str],
    ) -> str:
        """
        Generate a Chinese-language patrol summary from event data.

        Args:
            session_name: Name of the patrol session
            events: List of event dicts (category, subtype, title, content, created_at)
            checkpoints: List of POI names that were visited

        Returns:
            Chinese-language patrol summary
        """
        system_prompt = (
            "你是一个巡检报告生成助手。根据提供的巡检事件记录，"
            "生成一段简洁的中文巡检报告摘要（200字以内）。\n"
            "报告应包含：巡检概况、发现的异常或问题、处理建议。\n"
            "语气专业、简洁、有条理。不要输出 JSON，直接输出中文报告正文。"
        )

        events_summary = "\n".join(
            f"- [{e.get('category','?')}/{e.get('subtype','?')}] "
            f"{e.get('title','无标题')} "
            f"{'(' + e.get('content','') + ')' if e.get('content') else ''}"
            for e in events
        ) or "无异常事件"

        user_content = (
            f"巡检名称：{session_name}\n"
            f"已巡检点位：{', '.join(checkpoints) or '无'}\n"
            f"事件记录如下：\n{events_summary}\n\n"
            "请生成巡检报告摘要。"
        )

        return await self._chat(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_content},
            ],
            model=self.model,
            temperature=0.3,
        )

    # -------------------------------------------------------------------------
    # Internal HTTP call
    # -------------------------------------------------------------------------

    async def _chat(
        self,
        messages: list[dict[str, Any]],
        model: str,
        temperature: float = 0.7,
        max_tokens: int = 1024,
        retries: int = 2,
    ) -> str:
        """
        Send a chat completion request to the configured API endpoint.

        Supports both OpenAI-compatible `/v1/chat/completions` format
        and custom JSON-RPC style endpoints.

        Retries up to `retries` times on timeout or 5xx errors,
        with exponential backoff (1s, 2s, ...).
        """
        headers = {
            "Content-Type": "application/json",
        }
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        payload: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }

        last_error: str = ""

        for attempt in range(retries + 1):
            try:
                async with httpx.AsyncClient(timeout=self.timeout) as client:
                    response = await client.post(
                        self.api_url,
                        json=payload,
                        headers=headers,
                    )

                    if response.status_code >= 500 and attempt < retries:
                        # Server error — retry with backoff
                        await asyncio.sleep(2 ** attempt)
                        last_error = f"LLM API 服务器错误: {response.status_code}"
                        continue

                    response.raise_for_status()
                    data = response.json()

                    # OpenAI-compatible response format
                    if "choices" in data:
                        return (
                            data["choices"][0]
                            .get("message", {})
                            .get("content", "")
                            .strip()
                        )
                    # Generic response (return raw text)
                    if isinstance(data, str):
                        return data
                    # Custom format: try common keys
                    for key in ("text", "content", "response", "result", "output"):
                        if key in data:
                            val = data[key]
                            if isinstance(val, str):
                                return val.strip()
                            if isinstance(val, dict):
                                return json.dumps(val, ensure_ascii=False)
                    return json.dumps(data, ensure_ascii=False)

            except httpx.TimeoutException:
                last_error = "LLM API 请求超时，请检查服务连接。"
                if attempt < retries:
                    await asyncio.sleep(2 ** attempt)
                else:
                    return json.dumps({"error": last_error})
            except httpx.HTTPStatusError as e:
                last_error = f"LLM API 错误: {e.response.status_code}"
                if attempt < retries:
                    await asyncio.sleep(2 ** attempt)
                else:
                    return json.dumps({"error": last_error})
            except Exception as e:
                return json.dumps({"error": f"LLM 调用失败: {str(e)}"})

        # Should not reach here, but just in case
        return json.dumps({"error": last_error})
