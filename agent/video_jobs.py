"""
장소 영상 작업 API (키오스크 대기 화면 + 옆 모니터)

Comfy Cloud 연결 (agent/.env 에 COMFY_API_KEY 가 있고, agent/workflows/ 에 장소 워크플로가 있을 때)
  - 장소 번호로 워크플로를 찾는다.  GIMHAE_013 → workflows/013_hwapo.json
  - 요청마다 시드를 새로 뽑아 넣고 Comfy Cloud 에 보낸다. (관람객마다 다른 영상)
  - 완성되면 static/videos/gen/ 에 내려받아 영상 주소를 돌려준다.
  - 누가·언제·어느 장소·몇 번 시드로 만들었는지 generated/video_log.jsonl 에 남긴다.

연결 전 (키나 워크플로가 없을 때)
  - static/videos/GIMHAE_xxx.mp4 처럼 미리 넣어 둔 영상이 있으면 그걸 결과로 쓴다.

API
  POST /api/videos            {place_id, session_id, select}  영상 작업 등록 (같은 세션·장소면 기존 작업 재사용)
  POST /api/videos/prefetch   {session_id, place_ids}         추천 5곳을 미리 동시에 생성 (모니터에는 안 띄움)
  GET  /api/video-status/{id}                                 진행 상태
  GET  /api/display/latest                                    옆 모니터용: 관람객이 마지막으로 고른 영상 (+ finished)
  POST /api/display/finish    {session_id}                    태블릿 '여행 마무리하기' → 모니터 마무리 멘트
"""
import json
import os
import random
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Callable, Dict, List

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WORKFLOW_DIR = os.path.join(BASE_DIR, "workflows")
GEN_DIR = os.path.join(BASE_DIR, "static", "videos", "gen")
LOG_PATH = os.path.join(BASE_DIR, "generated", "video_log.jsonl")

COMFY_URL = os.environ.get("COMFY_URL", "https://cloud.comfy.org").rstrip("/")
GEN_EST_SEC = float(os.environ.get("LOCALRISE_VIDEO_EST_SEC", "70"))   # 진행률 계산용 예상 시간
POLL_SEC = 5          # 상태 확인 간격 (너무 잦으면 Comfy Cloud 가 429 로 거절)
TIMEOUT_SEC = 600
DONE_STATES = {"success", "error", "non_retryable_error", "lost", "cancelled"}

TASKS: Dict[str, dict] = {}
DISPLAY = {"task_id": None, "finished": False, "seq": 0}   # 옆 모니터에 띄울 작업 / 마무리 여부 / 누른 횟수
_lock = threading.Lock()
_submit_lock = threading.Lock()
_ctx: Dict[str, Callable] = {}


def setup(places: dict, poi: dict, media_urls: Callable) -> None:
    """app.py 에서 장소 데이터와 미디어 주소 함수를 넘겨받는다."""
    _ctx["places"] = places
    _ctx["poi"] = poi
    _ctx["media_urls"] = media_urls
    print(f"[영상] Comfy Cloud {'연결됨' if api_key() else '키 없음 → 미리 넣은 영상 사용'}"
          f" · 워크플로 {len(_workflow_files())}개")


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def api_key() -> str:
    return os.environ.get("COMFY_API_KEY", "").strip()


# ---------------- 워크플로 ----------------
def _workflow_files() -> Dict[str, str]:
    """{'013': '.../013_hwapo.json', ...}"""
    out = {}
    if os.path.isdir(WORKFLOW_DIR):
        for f in os.listdir(WORKFLOW_DIR):
            if f.endswith(".json") and f[:3].isdigit():
                out[f[:3]] = os.path.join(WORKFLOW_DIR, f)
    return out


def workflow_path(place_id: str) -> str:
    num = place_id.split("_")[-1][-3:]          # GIMHAE_013 → 013
    return _workflow_files().get(num, "")


def build_workflow(place_id: str, seed: int) -> dict:
    with open(workflow_path(place_id), encoding="utf-8") as f:
        wf = json.load(f)
    for node in wf.values():                  # 노이즈를 넣는 샘플러에 새 시드
        inp = node.get("inputs", {})
        if node.get("class_type") == "KSamplerAdvanced" and inp.get("add_noise") == "enable":
            inp["noise_seed"] = seed
        elif node.get("class_type") in ("KSampler", "RandomNoise") and "seed" in inp:
            inp["seed"] = seed
        elif node.get("class_type") in ("SaveVideo", "SaveImage") and "filename_prefix" in inp:
            inp["filename_prefix"] = f"localrise/{place_id}_{seed}"
    return wf


# ---------------- Comfy Cloud ----------------
class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):      # 302 를 따라가지 않음 (키가 저장소로 새지 않게)
        return None


RETRY_CODES = {429, 500, 502, 503, 504}


def _retry_wait(err, attempt: int) -> float:
    ra = getattr(err, "headers", None) and err.headers.get("Retry-After")
    try:
        return min(30.0, float(ra))
    except (TypeError, ValueError):
        return min(30.0, 2 * (2 ** attempt)) + random.random()   # 2, 4, 8, 16, 30초 + 살짝 랜덤


def _call(method: str, path: str, body: dict = None, timeout: float = 30) -> dict:
    """Comfy Cloud 호출. 429(요청 너무 많음)·일시 오류면 잠깐 기다렸다 다시 시도한다."""
    data = json.dumps(body).encode() if body is not None else None
    for attempt in range(6):
        req = urllib.request.Request(COMFY_URL + path, data=data, method=method,
                                     headers={"X-API-Key": api_key(), "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode() or "{}")
        except urllib.error.HTTPError as e:
            if e.code not in RETRY_CODES or attempt == 5:
                raise
            w = _retry_wait(e, attempt)
            print(f"[영상] Comfy {e.code} → {w:.0f}초 뒤 다시 시도 ({path.split('?')[0]})")
            time.sleep(w)


def _find_video(obj):
    """history 의 outputs 안에서 mp4 파일 정보를 찾는다."""
    if isinstance(obj, dict):
        fn = obj.get("filename", "")
        if isinstance(fn, str) and fn.lower().endswith((".mp4", ".webm", ".mov")):
            return obj
        for v in obj.values():
            hit = _find_video(v)
            if hit:
                return hit
    elif isinstance(obj, list):
        for v in obj:
            hit = _find_video(v)
            if hit:
                return hit
    return None


def _download(info: dict, dest: str) -> None:
    for attempt in range(6):
        try:
            return _download_once(info, dest)
        except urllib.error.HTTPError as e:
            if e.code not in RETRY_CODES or attempt == 5:
                raise
            w = _retry_wait(e, attempt)
            print(f"[영상] 다운로드 {e.code} → {w:.0f}초 뒤 다시 시도")
            time.sleep(w)


def _download_once(info: dict, dest: str) -> None:
    q = urllib.parse.urlencode({"filename": info["filename"], "subfolder": info.get("subfolder", ""),
                                "type": info.get("type", "output")})
    opener = urllib.request.build_opener(_NoRedirect)
    req = urllib.request.Request(f"{COMFY_URL}/api/view?{q}", headers={"X-API-Key": api_key()})
    try:
        r = opener.open(req, timeout=60)
        signed, content = None, r.read()      # 302 없이 바로 파일을 준 경우
    except urllib.error.HTTPError as e:
        if e.code not in (301, 302, 303, 307, 308):
            raise
        signed, content = e.headers["Location"], None
    if signed:
        with urllib.request.urlopen(signed, timeout=120) as r2:   # 서명된 주소: 키 없이
            content = r2.read()
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "wb") as f:
        f.write(content)


def _log(task: dict) -> None:
    try:
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        keep = ("task_id", "session_id", "place_id", "seed", "prompt_id", "status", "created_at",
                "gen_sec", "file", "error")
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps({k: task.get(k) for k in keep}, ensure_ascii=False) + "\n")
    except Exception as e:  # 기록 실패는 무시
        print("[영상 기록 실패]", e)


def _looks_broken(place_id: str, path: str) -> bool:
    """노이즈로 깨진 영상은 용량이 비정상적으로 큼 → 같은 장소의 이전 정상 영상들 중간값의 1.8배를 넘으면 깨진 것으로 본다."""
    try:
        size = os.path.getsize(path)
        others = sorted(os.path.getsize(os.path.join(GEN_DIR, f)) for f in os.listdir(GEN_DIR)
                        if f.startswith(place_id + "_") and f.endswith(".mp4") and not f.endswith("_bad.mp4")
                        and os.path.join(GEN_DIR, f) != path)
        return bool(others) and size > 1.8 * others[len(others) // 2]
    except OSError:
        return False


def _run_comfy(task: dict) -> None:
    """Comfy Cloud 생성. 깨진(노이즈) 영상이 나오면 새 시드로 한 번 더 만든다."""
    for attempt in range(2):
        _run_comfy_once(task)
        f = os.path.join(BASE_DIR, task.get("file") or "")
        if task["status"] != "succeeded" or not _looks_broken(task["place_id"], f):
            return
        bad = f[:-4] + "_bad.mp4"
        try:
            os.replace(f, bad)
        except OSError:
            pass
        print(f"[영상 깨짐 → 다시 생성] {task['place_id']} 시드 {task['seed']}")
        task.update(status="running", stage="generating", result=None, file=None,
                    error="깨진 영상 감지", seed=random.randint(1, 2**50), t0=time.time())


def _run_comfy_once(task: dict) -> None:
    t0 = time.time()
    try:
        wf = build_workflow(task["place_id"], task["seed"])
        with _submit_lock:                     # 등록 요청을 한 번에 하나씩, 0.7초 간격으로
            res = _call("POST", "/api/prompt", {"prompt": wf})
            time.sleep(0.7)
        if res.get("error") or not res.get("prompt_id"):
            raise RuntimeError(f"작업 등록 실패: {res.get('error') or res.get('node_errors') or res}")
        task["prompt_id"] = res["prompt_id"]
        task.update(status="running", stage="generating")
        print(f"[영상] {task['place_id']} 시드 {task['seed']} → {task['prompt_id']}")
        state = ""
        while time.time() - t0 < TIMEOUT_SEC:
            time.sleep(POLL_SEC)
            try:
                state = _call("GET", f"/api/job/{task['prompt_id']}/status").get("status", "")
            except Exception as e:      # 잠깐 끊겨도 계속 확인
                print("[영상 상태 확인 오류]", e)
                continue
            task["comfy_status"] = state
            if state in DONE_STATES:
                break
        if state != "success":
            raise RuntimeError(f"생성 실패 ({state or '시간 초과'})")
        task["stage"] = "downloading"
        hist = _call("GET", f"/api/history_v2/{task['prompt_id']}")
        info = _find_video(hist.get(task["prompt_id"], hist).get("outputs", {}) if isinstance(hist, dict) else hist)
        if not info:
            raise RuntimeError("완성 영상을 찾지 못함")
        fname = f"{task['place_id']}_{task['task_id']}.mp4"
        _download(info, os.path.join(GEN_DIR, fname))
        task["file"] = f"static/videos/gen/{fname}"
        task["result"] = {"video_url": f"/static/videos/gen/{fname}",
                          "image_url": _ctx["media_urls"](task["place_id"]).get("image_url")}
        task.update(status="succeeded", stage="completed")
    except Exception as e:
        task.update(status="failed", stage="failed", error=str(e))
        print(f"[영상 실패] {task['place_id']}: {e}")
    task["gen_sec"] = round(time.time() - t0, 1)
    _log(task)


def start_generation(task: dict) -> None:
    if api_key() and workflow_path(task["place_id"]):
        task.update(status="queued", stage="queued", mode="comfy")
        threading.Thread(target=_run_comfy, args=(task,), daemon=True).start()
        return
    # 키·워크플로가 없으면: 미리 넣어 둔 파일을 결과로 쓴다
    media = _ctx["media_urls"](task["place_id"])
    task["mode"] = "file"
    task["result"] = {"video_url": media.get("video_url"), "image_url": media.get("image_url")}
    task["status"] = "succeeded" if (media.get("video_url") or media.get("image_url")) else "not_ready"
    task["stage"] = "completed" if task["status"] == "succeeded" else "waiting_media"


# ---------------- API ----------------
class VideoRequest(BaseModel):
    place_id: str
    session_id: str = ""
    select: bool = True          # True: 관람객이 고른 것 → 옆 모니터에 띄움


class PrefetchRequest(BaseModel):
    session_id: str
    place_ids: List[str]


def _get_or_create(place_id: str, session_id: str):
    with _lock:
        for task_id, t in TASKS.items():
            if t["place_id"] == place_id and t["session_id"] == session_id and t["status"] != "failed":
                return task_id, True
        task_id = f"task_{uuid.uuid4().hex[:8]}"
        place = _ctx["places"].get(place_id, {})
        TASKS[task_id] = {"task_id": task_id, "place_id": place_id, "session_id": session_id,
                          "place_name": place.get("place_name", ""), "created_at": _now(), "t0": time.time(),
                          "seed": random.randint(1, 2**50), "status": "queued", "stage": "queued",
                          "result": None, "error": None}
    start_generation(TASKS[task_id])
    return task_id, False


@router.post("/api/videos")
def create_video(req: VideoRequest):
    """장소 영상 작업 등록. 같은 세션·장소면 (미리 만들던) 기존 작업을 다시 쓴다."""
    if req.place_id not in _ctx.get("places", {}):
        raise HTTPException(status_code=404, detail="없는 장소입니다.")
    task_id, reused = _get_or_create(req.place_id, req.session_id)
    if req.select:
        DISPLAY["task_id"] = task_id
        DISPLAY["finished"] = False
        DISPLAY["seq"] += 1          # 같은 영상을 다시 눌러도 모니터가 다시 재생하도록
    return {"task_id": task_id, "place_id": req.place_id, "reused": reused,
            "status_url": f"/api/video-status/{task_id}"}


@router.post("/api/videos/prefetch")
def prefetch(req: PrefetchRequest):
    """질문이 끝나자마자 추천 장소들을 동시에 생성 시작 (모니터에는 띄우지 않음)."""
    out = []
    for pid in req.place_ids[:5]:
        if pid in _ctx.get("places", {}):
            task_id, reused = _get_or_create(pid, req.session_id)
            out.append({"place_id": pid, "task_id": task_id, "reused": reused})
    return {"tasks": out}


def _public(task: dict) -> dict:
    el = time.time() - task["t0"]
    prog = 100 if task["status"] == "succeeded" else (0 if task["status"] in ("failed", "not_ready")
                                                      else round(min(95, el / GEN_EST_SEC * 100), 1))
    return {"task_id": task["task_id"], "place_id": task["place_id"], "place_name": task.get("place_name", ""),
            "status": task["status"], "stage": task["stage"], "progress": prog, "elapsed_sec": round(el, 1),
            "seed": task.get("seed"), "created_at": task["created_at"], "updated_at": _now(),
            "result": task["result"], "error": task.get("error")}


@router.get("/api/video-status/{task_id}")
def video_status(task_id: str):
    task = TASKS.get(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="작업을 찾을 수 없습니다.")
    if task["status"] == "not_ready":   # 그사이 파일을 넣었으면 다시 확인
        start_generation(task)
    return _public(task)


class FinishRequest(BaseModel):
    session_id: str = ""


@router.post("/api/display/finish")
def display_finish(req: FinishRequest):
    """태블릿에서 '여행 마무리하기'를 누르면 옆 모니터를 마무리 멘트로."""
    DISPLAY["finished"] = True
    return {"ok": True}


@router.get("/api/display/latest")
def display_latest():
    """옆 모니터: 관람객이 마지막으로 고른 영상 작업 (+ 마무리 여부)."""
    task = TASKS.get(DISPLAY["task_id"] or "")
    return ({**_public(task), "finished": DISPLAY["finished"], "show_key": f"{task['task_id']}:{DISPLAY['seq']}"}
            if task else {"task_id": None})
