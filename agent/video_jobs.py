"""
장소 영상 작업 API (시연 화면 STEP 3)

지금 (Comfy Cloud 연결 전)
  - static/videos/GIMHAE_001.mp4 처럼 영상 파일이 있으면 → 바로 완료(succeeded), 영상 주소 전달
  - 영상이 없고 이미지만 있으면 → 완료(succeeded), 이미지 주소만 전달 (화면은 이미지를 보여 줌)
  - 둘 다 없으면 → not_ready (화면은 "준비 중" 표시)

나중에 (Comfy Cloud 연결)
  - start_generation() 안에서 Comfy Cloud에 작업을 보내고,
    video_status() 에서 진행 상태를 돌려주면 된다.
  - 작업에는 장소별 LoRA·트리거·이미지 프롬프트(poi_config.json)가 이미 담겨 있다.
"""
import time
import uuid
from typing import Callable, Dict

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()

TASKS: Dict[str, dict] = {}
_ctx: Dict[str, Callable] = {}


def setup(places: dict, poi: dict, media_urls: Callable) -> None:
    """app.py 에서 장소 데이터와 미디어 주소 함수를 넘겨받는다."""
    _ctx["places"] = places
    _ctx["poi"] = poi
    _ctx["media_urls"] = media_urls


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S")


class VideoRequest(BaseModel):
    place_id: str
    session_id: str = ""


def start_generation(task: dict) -> None:
    """Comfy Cloud 연결 자리. 지금은 미리 넣어 둔 파일을 결과로 쓴다."""
    media = _ctx["media_urls"](task["place_id"])
    task["result"] = {"video_url": media.get("video_url"), "image_url": media.get("image_url")}
    task["status"] = "succeeded" if (media.get("video_url") or media.get("image_url")) else "not_ready"
    task["stage"] = "completed" if task["status"] == "succeeded" else "waiting_media"


@router.post("/api/videos")
def create_video(req: VideoRequest):
    """장소 영상 작업 등록. 같은 세션·장소면 기존 작업을 다시 쓴다."""
    if req.place_id not in _ctx.get("places", {}):
        raise HTTPException(status_code=404, detail="없는 장소입니다.")
    for task_id, t in TASKS.items():
        if t["place_id"] == req.place_id and t["session_id"] == req.session_id:
            return {"task_id": task_id, "place_id": req.place_id, "reused": True,
                    "status_url": f"/api/video-status/{task_id}"}
    cfg = _ctx["poi"].get(req.place_id, {})
    task_id = f"task_{uuid.uuid4().hex[:8]}"
    task = {"place_id": req.place_id, "session_id": req.session_id, "created_at": _now(),
            "status": "queued", "stage": "queued", "result": None,
            # 실제 생성 때 쓸 정보 (poi_config.json)
            "lora": cfg.get("lora", ""), "trigger": cfg.get("trigger", ""),
            "image_prompt": cfg.get("image_prompt", ""), "video_prompt": cfg.get("video_prompt", "")}
    TASKS[task_id] = task
    start_generation(task)
    return {"task_id": task_id, "place_id": req.place_id, "reused": False,
            "status_url": f"/api/video-status/{task_id}"}


@router.get("/api/video-status/{task_id}")
def video_status(task_id: str):
    task = TASKS.get(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="작업을 찾을 수 없습니다.")
    if task["status"] == "not_ready":   # 그사이 파일을 넣었으면 다시 확인
        start_generation(task)
    return {"task_id": task_id, "place_id": task["place_id"], "status": task["status"],
            "stage": task["stage"], "created_at": task["created_at"], "updated_at": _now(),
            "result": task["result"], "error": None}
