"""Unit tests for the LLM Service."""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.services.llm_service import LLMService


@pytest.fixture
def llm_service():
    return LLMService(
        api_url="http://localhost:8080/v1/chat/completions",
        api_key="test-key",
        model="test-model",
        timeout=10,
    )


def _make_mock_response(json_data: dict, status_code: int = 200):
    """Create a properly-structured mock httpx Response for use in async with."""
    response = MagicMock()
    response.status_code = status_code
    response.json = MagicMock(return_value=json_data)
    response.raise_for_status = MagicMock()
    return response


class TestLLMServiceSemanticParsing:
    """Tests for Mode 1: Semantic instruction parsing."""

    @pytest.mark.asyncio
    @patch("src.services.llm_service.httpx.AsyncClient")
    async def test_parse_navigate_intent(self, mock_client_cls, llm_service: LLMService):
        mock_response = _make_mock_response({
            "choices": [{
                "message": {
                    "content": '{"intent":"navigate","poi_name":"会议室","confidence":0.95}'
                }
            }]
        })
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client_cls.return_value.__aenter__.return_value = mock_client

        result = await llm_service.parse_instruction(
            text="去会议室",
            poi_whitelist=["会议室", "前台", "配电室"],
        )

        assert result.intent == "navigate"
        assert result.poi_name == "会议室"
        assert result.confidence == 0.95
        assert result.raw_llm is not None

    @pytest.mark.asyncio
    @patch("src.services.llm_service.httpx.AsyncClient")
    async def test_parse_unknown_intent(self, mock_client_cls, llm_service: LLMService):
        mock_response = _make_mock_response({
            "choices": [{
                "message": {
                    "content": '{"intent":"unknown","poi_name":null,"confidence":0.1}'
                }
            }]
        })
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client_cls.return_value.__aenter__.return_value = mock_client

        result = await llm_service.parse_instruction(
            text="啦啦啦",
            poi_whitelist=["会议室"],
        )

        assert result.intent == "unknown"
        assert result.poi_name is None

    @pytest.mark.asyncio
    @patch("src.services.llm_service.httpx.AsyncClient")
    async def test_parse_fallback_on_invalid_json(self, mock_client_cls, llm_service: LLMService):
        mock_response = _make_mock_response({
            "choices": [{
                "message": {"content": "这不是合法的JSON"}
            }]
        })
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client_cls.return_value.__aenter__.return_value = mock_client

        result = await llm_service.parse_instruction("随便说")

        assert result.intent == "unknown"
        assert result.confidence == 0.0


class TestLLMServiceMultiModal:
    """Tests for Mode 2: Multi-modal analysis."""

    @pytest.mark.asyncio
    @patch("src.services.llm_service.httpx.AsyncClient")
    async def test_analyze_scene_returns_result(self, mock_client_cls, llm_service: LLMService):
        mock_response = _make_mock_response({
            "choices": [{
                "message": {
                    "content": '{"analysis":"检测到前方有行人","hazard_level":"medium","recommended_action":"减速等待"}'
                }
            }]
        })
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client_cls.return_value.__aenter__.return_value = mock_client

        result = await llm_service.analyze_scene(
            image_base64="dGVzdA==",
            question="前方有什么障碍？",
        )

        assert result.analysis == "检测到前方有行人"
        assert result.hazard_level == "medium"
        assert result.recommended_action == "减速等待"

    @pytest.mark.asyncio
    @patch("src.services.llm_service.httpx.AsyncClient")
    async def test_analyze_scene_critical_hazard(self, mock_client_cls, llm_service: LLMService):
        mock_response = _make_mock_response({
            "choices": [{
                "message": {
                    "content": '{"analysis":"检测到烟雾","hazard_level":"critical","recommended_action":"立即停止"}'
                }
            }]
        })
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client_cls.return_value.__aenter__.return_value = mock_client

        result = await llm_service.analyze_scene(
            image_base64="dGVzdA==",
        )

        assert result.hazard_level == "critical"
        assert result.analysis == "检测到烟雾"

    @pytest.mark.asyncio
    @patch("src.services.llm_service.httpx.AsyncClient")
    async def test_analyze_scene_fallback_on_invalid_json(self, mock_client_cls, llm_service: LLMService):
        mock_response = _make_mock_response({
            "choices": [{
                "message": {"content": "非法响应"}
            }]
        })
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client_cls.return_value.__aenter__.return_value = mock_client

        result = await llm_service.analyze_scene(image_base64="dGVzdA==")

        assert result.hazard_level == "low"
        assert "人工确认" in result.recommended_action


class TestLLMServiceChat:
    """Tests for Mode 3: Free chat."""

    @pytest.mark.asyncio
    @patch("src.services.llm_service.httpx.AsyncClient")
    async def test_chat_returns_reply(self, mock_client_cls, llm_service: LLMService):
        mock_response = _make_mock_response({
            "choices": [{
                "message": {"content": "机器人目前状态正常，电量80%。"}
            }]
        })
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client_cls.return_value.__aenter__.return_value = mock_client

        reply = await llm_service.chat(message="机器人状态如何？")

        assert reply == "机器人目前状态正常，电量80%。"

    @pytest.mark.asyncio
    @patch("src.services.llm_service.httpx.AsyncClient")
    async def test_chat_with_history(self, mock_client_cls, llm_service: LLMService):
        mock_response = _make_mock_response({
            "choices": [{
                "message": {"content": "是的，可以去配电室巡检。"}
            }]
        })
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client_cls.return_value.__aenter__.return_value = mock_client

        history = [
            {"role": "user", "content": "现在可以开始巡检吗？"},
            {"role": "assistant", "content": "可以，机器人已就绪。"},
        ]
        reply = await llm_service.chat(message="去哪个点位？", history=history)

        assert "配电室" in reply


class TestLLMServiceReport:
    """Tests for Mode 4: Patrol report generation."""

    @pytest.mark.asyncio
    @patch("src.services.llm_service.httpx.AsyncClient")
    async def test_generate_patrol_report(self, mock_client_cls, llm_service: LLMService):
        mock_response = _make_mock_response({
            "choices": [{
                "message": {
                    "content": "本次巡检共检查3个点位，发现1处温度异常，已在配电室进行记录。建议加强该区域温控设备检查。"
                }
            }]
        })
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client_cls.return_value.__aenter__.return_value = mock_client

        events = [
            {
                "category": "patrol",
                "subtype": "checkpoint_reached",
                "title": "到达配电室",
                "created_at": "2026-05-17T10:00:00",
            },
            {
                "category": "sensor",
                "subtype": "temp_overrun",
                "title": "温度超限",
                "content": "温度42℃，超过阈值40℃",
                "created_at": "2026-05-17T10:05:00",
            },
        ]

        report = await llm_service.generate_patrol_report(
            session_name="园区日常巡检",
            events=events,
            checkpoints=["前台", "配电室", "会议室"],
        )

        assert "温度" in report or "异常" in report


class TestLLMServiceErrorHandling:
    """Tests for error handling."""

    @pytest.mark.asyncio
    @patch("src.services.llm_service.httpx.AsyncClient")
    async def test_timeout_returns_error_json(self, mock_client_cls, llm_service: LLMService):
        import httpx

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(side_effect=httpx.TimeoutException("timeout"))
        mock_client_cls.return_value.__aenter__.return_value = mock_client

        result = await llm_service.chat(message="你好")

        assert "error" in result

    @pytest.mark.asyncio
    @patch("src.services.llm_service.httpx.AsyncClient")
    async def test_http_error_returns_error_json(self, mock_client_cls, llm_service: LLMService):
        import httpx

        mock_response = _make_mock_response({}, status_code=500)
        mock_response.raise_for_status = MagicMock(
            side_effect=httpx.HTTPStatusError(
                "server error",
                request=MagicMock(),
                response=mock_response,
            )
        )
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client_cls.return_value.__aenter__.return_value = mock_client

        result = await llm_service.chat(message="你好")

        assert "error" in result
