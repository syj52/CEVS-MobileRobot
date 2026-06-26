"""
完整测试脚本 — 覆盖所有 API 场景
用法: python tests/test_all_api.py
"""
from __future__ import annotations

import asyncio
import json
import time
import uuid

import httpx


BASE = "http://localhost:8000"
TIMEOUT = 30.0


def log(title: str, data=None, color="", reset="\033[0m"):
    prefix = f"{color}[{title}]{reset}"
    if data is None:
        print(f"  {prefix}")
    elif isinstance(data, str):
        print(f"  {prefix} {data}")
    else:
        print(f"  {prefix}")
        print(json.dumps(data, indent=2, ensure_ascii=False))


def pass_(msg: str):
    log("PASS", msg, color="\033[92m")


def fail(msg: str, resp=None):
    log("FAIL", msg, color="\033[91m")
    if resp is not None:
        print(f"       status={resp.status_code}  body={resp.text[:200]}")


def section(name: str):
    print(f"\n{'='*60}")
    print(f"  {name}")
    print(f"{'='*60}")


async def main():
    async with httpx.AsyncClient(base_url=BASE, timeout=TIMEOUT) as client:

        # ── 0. 健康检查 ──────────────────────────────────────
        section("0. 健康检查")
        r = await client.get("/health")
        if r.status_code == 200:
            pass_("/health → ok")
            log("event_engine stats", r.json()["event_engine"])
        else:
            fail("/health", r)

        # ── 1. POI 导入（批量）────────────────────────────────
        section("1. POI 批量导入")
        pois = [
            {"name": "前台",    "coord_x": 0.0, "coord_y": 0.0, "description": "大厅入口"},
            {"name": "会议室A", "coord_x": 5.0, "coord_y": 3.0, "description": "一楼会议室"},
            {"name": "配电室",  "coord_x": 10.0,"coord_y": 2.0, "description": "电力设备间"},
            {"name": "走廊东",  "coord_x": 3.0, "coord_y": 8.0, "description": "东侧走廊"},
        ]
        r = await client.post(
            "/api/poi/import",
            files={"file": ("pois.json", json.dumps(pois), "application/json")},
        )
        if r.status_code == 200:
            data = r.json()
            pass_(f"/api/poi/import → 导入 {data['imported']} 条")
        else:
            fail("/api/poi/import", r)

        # ── 2. POI 单条查询 ──────────────────────────────────
        section("2. POI 查询")
        r = await client.get("/api/poi")
        if r.status_code == 200:
            poi_list = r.json()
            pass_(f"/api/poi → 共 {len(poi_list)} 条 POI")
            for p in poi_list:
                log("  POI", f"{p['name']}  coords=({p['coord_x']}, {p['coord_y']})")
        else:
            fail("/api/poi", r)

        # ── 3. POI 单条创建 ──────────────────────────────────
        section("3. POI 单条创建")
        r = await client.post("/api/poi", json={
            "name": "测试点",
            "coord_x": 7.5,
            "coord_y": 4.2,
            "description": "用于自动化测试的临时 POI",
        })
        if r.status_code == 200:
            pass_("/api/poi (POST) → 创建成功")
            log("创建结果", r.json())
        else:
            fail("/api/poi (POST)", r)

        # ── 4. POI 更新 ──────────────────────────────────────
        section("4. POI 更新")
        r = await client.put("/api/poi/测试点", json={
            "name": "测试点",
            "coord_x": 8.0,
            "coord_y": 5.0,
            "description": "测试点已更新",
        })
        if r.status_code == 200:
            pass_("/api/poi/{name} (PUT) → 更新成功")
            log("更新结果", r.json())
        else:
            fail("/api/poi PUT", r)

        # ── 5. 导航指令解析 ───────────────────────────────────
        section("5. 导航指令解析")
        for text in ["带我去会议室A", "我想去配电室", "到前台"]:
            r = await client.post("/api/navigation/parse", json={"text": text})
            if r.status_code == 200:
                data = r.json()
                coords = data.get("target_coords", {})
                log(
                    f"/api/navigation/parse ({text!r})",
                    f"→ {data.get('poi_name')}  coords=({coords.get('x')}, {coords.get('y')})",
                )
                if data.get("poi_name"):
                    pass_(f"  识别成功: {data['poi_name']}")
                else:
                    fail(f"  识别失败")
            else:
                fail(f"/api/navigation/parse ({text!r})", r)

        # ── 6. 导航状态查询 & 位置上报 ───────────────────────
        section("6. 导航状态 & 位置上报")
        r = await client.get("/api/navigation/current")
        log("/api/navigation/current", r.json() if r.status_code == 200 else r.text)

        r = await client.post("/api/navigation/position", params={"x": 2.5, "y": 1.5, "z": 0.0})
        if r.status_code == 200:
            pass_("/api/navigation/position → 位置上报成功")
        else:
            fail("/api/navigation/position", r)

        # ── 7. 巡检流程（完整）────────────────────────────────
        section("7. 完整巡检流程")
        patrol_id = None

        # 7.1 启动巡检
        r = await client.post("/api/patrol/start", json={
            "name": "自动化巡检测试",
            "patrol_points": ["前台", "会议室A", "配电室", "走廊东"],
        })
        if r.status_code == 200:
            data = r.json()
            patrol_id = data["id"]
            pass_(f"/api/patrol/start → session_id={patrol_id}")
            log("启动结果", data)
        else:
            fail("/api/patrol/start", r)

        if patrol_id:
            # 7.2 暂停
            r = await client.post(f"/api/patrol/{patrol_id}/pause")
            if r.status_code == 200:
                pass_(f"/api/patrol/{{id}}/pause")
            else:
                fail(f"/api/patrol/{{id}}/pause", r)

            # 7.3 恢复
            r = await client.post(f"/api/patrol/{patrol_id}/resume")
            if r.status_code == 200:
                pass_(f"/api/patrol/{{id}}/resume")
            else:
                fail(f"/api/patrol/{{id}}/resume", r)

            # 7.4 依次上报到达
            points = ["前台", "会议室A", "配电室", "走廊东"]
            coords = [(0.0, 0.0), (5.0, 3.0), (10.0, 2.0), (3.0, 8.0)]
            for i, (pt, (cx, cy)) in enumerate(zip(points, coords)):
                r = await client.post("/api/patrol/arrive", json={
                    "session_id": patrol_id,
                    "poi_name": pt,
                    "x": cx,
                    "y": cy,
                })
                if r.status_code == 200:
                    data = r.json()
                    anomaly = data.get("event", {}).get("severity", 0) or 0
                    log(f"  第{i+1}站: {pt}", f"severity={anomaly}  event_id={data.get('event',{}).get('id','n/a')}")
                    pass_(f"  /api/patrol/arrive → {pt}")
                else:
                    fail(f"/api/patrol/arrive ({pt})", r)
                await asyncio.sleep(0.1)

            # 7.5 查询巡检状态
            r = await client.get(f"/api/patrol/{patrol_id}")
            if r.status_code == 200:
                pass_("/api/patrol/{id} (GET)")
                log("巡检状态", r.json())
            else:
                fail("/api/patrol/{id}", r)

            # 7.6 完成巡检（可能调用 LLM，若无配置则返回 mock）
            r = await client.post(f"/api/patrol/complete?session_id={patrol_id}")
            if r.status_code == 200:
                data = r.json()
                summary_preview = (data.get("summary") or "")[:80]
                pass_(f"/api/patrol/complete → 完成")
                log("summary 摘要", summary_preview + "...")
            elif r.status_code == 404:
                print(f"  [{patrol_id}] session 未找到，可能已完成或 ID 有误")
            else:
                fail("/api/patrol/complete", r)

        # ── 8. 事件上报 ───────────────────────────────────────
        section("8. 事件上报 & 查询")
        test_events = [
            {
                "category": "sensor",
                "subtype": "temp_overrun",
                "severity": 2,
                "title": "温度超限告警",
                "content": "配电室温度超过40℃",
                "metadata": {"sensor_type": "temperature", "value": 42.5, "unit": "℃", "threshold": 40.0},
            },
            {
                "category": "patrol",
                "subtype": "checkpoint_reached",
                "severity": 3,
                "title": "巡检点已到达",
                "content": "机器人已到达配电室",
                "metadata": {"poi_name": "配电室"},
            },
            {
                "category": "system",
                "subtype": "heartbeat",
                "severity": 4,
                "title": "系统心跳",
                "content": "设备运行正常",
                "metadata": {},
            },
        ]

        created_ids = []
        for ev in test_events:
            r = await client.post("/api/events", json=ev)
            if r.status_code == 200:
                eid = r.json()["id"]
                created_ids.append(eid)
                pass_(f"/api/events POST [{ev['title']}] → {eid}")
            else:
                fail(f"/api/events POST [{ev['title']}]", r)

        # ── 9. 事件查询 & 过滤 ─────────────────────────────────
        section("9. 事件查询 & 多维度过滤")

        r = await client.get("/api/events", params={"limit": 5})
        if r.status_code == 200:
            all_evs = r.json()
            pass_(f"/api/events?limit=5 → {len(all_evs)} 条")
            for e in all_evs[:3]:
                log("  事件", f"[{e['category']}] {e['title']}  status={e['status']}")
        else:
            fail("/api/events", r)

        r = await client.get("/api/events", params={"category": "sensor"})
        if r.status_code == 200:
            sensor_evs = r.json()
            pass_(f"/api/events?category=sensor → {len(sensor_evs)} 条")
        else:
            fail("/api/events?category=sensor", r)

        r = await client.get("/api/events/window")
        if r.status_code == 200:
            win = r.json()
            pass_(f"/api/events/window → {len(win)} 条")
        else:
            fail("/api/events/window", r)

        r = await client.get("/api/events/stats")
        if r.status_code == 200:
            pass_(f"/api/events/stats")
            log("stats", r.json())
        else:
            fail("/api/events/stats", r)

        # ── 10. 事件确认与解决 ────────────────────────────────
        section("10. 事件确认 & 解决")

        if created_ids:
            eid = created_ids[0]
            r = await client.post(f"/api/events/{eid}/acknowledge", json={
                "operator": "测试操作员",
                "note": "已派人检查",
            })
            if r.status_code == 200:
                pass_(f"/api/events/{{id}}/acknowledge")
                log("确认后状态", r.json()["status"])
            else:
                fail("/api/events/acknowledge", r)

            r = await client.post(f"/api/events/{eid}/resolve")
            if r.status_code == 200:
                pass_(f"/api/events/{{id}}/resolve")
                log("解决后状态", r.json()["status"])
            else:
                fail("/api/events/resolve", r)

        # ── 11. LLM 对话接口 ─────────────────────────────────
        section("11. LLM 对话 & 感知分析")
        r = await client.post("/api/llm/chat", params={
            "message": "当前系统状态如何？",
            "session_id": patrol_id,
        })
        if r.status_code == 200:
            reply = r.json().get("reply", "")
            pass_(f"/api/llm/chat")
            log("LLM 回复", reply[:120] + ("..." if len(reply) > 120 else ""))
        else:
            print(f"  [WARN] /api/llm/chat status={r.status_code}  (可能 LLM 未配置)")
            print(f"         body: {r.text[:200]}")

        # 感知分析（mock 图像）
        r = await client.post("/api/perception/analyze", json={
            "image_base64": "",
            "question": "描述图中关键信息",
        })
        if r.status_code == 200:
            pass_(f"/api/perception/analyze")
            log("分析结果", r.json())
        else:
            print(f"  [WARN] /api/perception/analyze status={r.status_code}")
            print(f"         body: {r.text[:200]}")

        # ── 12. POI 删除 ──────────────────────────────────────
        section("12. POI 删除")
        r = await client.delete("/api/poi/测试点")
        if r.status_code == 200:
            pass_("/api/poi/{name} (DELETE)")
        else:
            fail("/api/poi DELETE", r)

        # ── 13. POI 更新（修改 name）────────────────────────
        section("13. POI name 修改（upsert）")
        r = await client.put("/api/poi/前台", json={
            "name": "大厅前台",
            "coord_x": 0.5,
            "coord_y": 0.5,
            "description": "已更名为大厅前台",
        })
        if r.status_code == 200:
            pass_("/api/poi/{name} (PUT rename)")
            log("结果", r.json())
        else:
            fail("/api/poi PUT rename", r)

        # ── 14. 查询不存在的资源 ─────────────────────────────
        section("14. 边界测试（404）")
        r = await client.get("/api/poi/不存在的POI")
        if r.status_code == 404:
            pass_("/api/poi/{name} → 404 Not Found（符合预期）")
        else:
            fail("应返回 404", r)

        if patrol_id:
            r = await client.get(f"/api/patrol/{patrol_id}")
            if r.status_code == 200:
                log("巡检会话仍可查询", r.json()["status"])
            else:
                fail("/api/patrol/{id} after complete", r)

        # ── 15. WebSocket 连接测试 ───────────────────────────
        section("15. WebSocket 实时推送测试")

        ws_url = "ws://localhost:8000/ws/push"
        try:
            async with httpx.AsyncClient() as ws_client:
                async with ws_client.stream("GET", ws_url) as resp:
                    if resp.status_code == 101:
                        pass_(f"WebSocket 握手成功: {ws_url}")
                    else:
                        print(f"  [WARN] WebSocket 状态码: {resp.status_code}")

                    async for line in resp.aiter_lines():
                        if line:
                            print(f"  [WS recv] {line[:120]}")
                            break
        except Exception as e:
            print(f"  [WARN] WebSocket 测试跳过: {e}")

        # ── 完成 ─────────────────────────────────────────────
        section("测试完成")
        print("  所有场景已执行完毕。")
        print("  浏览器打开 http://localhost:8000/docs 可交互式调试所有接口。")
        print("  浏览器打开 http://localhost:8000/redoc 可查看文档。")


if __name__ == "__main__":
    asyncio.run(main())
