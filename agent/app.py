"""
LocalRise 김해 관광지 추천 API  (2026 AIM 챌린지 본선)

전체 흐름
  1) 성향 입력  : 2지선다 질문 답(POST /recommend_quiz) 또는 문장(POST /recommend)
  2) 후보 선정  : 질문 답 → 장소 특성표 점수 / 문장 → CSV 태그 점수 → 상위 8곳
  3) AI 분석    : OpenAI(GPT) 또는 Ollama(qwen2.5:7b)가 성향을 요약하고 후보 중 5곳을 골라 추천 이유 작성
                  (LOCALRISE_LLM=openai / ollama 로 선택. 키는 .env 파일에만 넣는다)
  4) 검증·보정  : 없는 장소/중복 제거, 근거 없는 문장 제거, 3문장 미만이면 CSV 원문으로 보충
  5) 응답       : { region_id, persona_summary, recommendations[5] }

실행: python app.py   →  http://0.0.0.0:5000  (대회 명세: 5000번 포트, 0.0.0.0 바인딩)
"""

import hashlib
import json
import os
import re
import threading
from contextlib import asynccontextmanager
from typing import Dict, List, Optional

import pandas as pd
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# =========================================================
# 1. 설정
# =========================================================

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def path(*parts: str) -> str:
    return os.path.join(BASE_DIR, *parts)


def load_dotenv_file() -> None:
    """agent/.env 또는 저장소 루트 .env 를 읽어 환경변수로 넣는다. (이미 설정된 값은 그대로 둠)"""
    for p in (path(".env"), path("..", ".env")):
        if not os.path.exists(p):
            continue
        with open(p, encoding="utf-8-sig") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k, v = k.strip(), v.strip().strip('"').strip("'")
                if k and v and k not in os.environ:
                    os.environ[k] = v


load_dotenv_file()


REGION_ID = "GIMHAE"

CSV_PATH = path("gimhae_places.csv")
QUIZ_PATH = path("quiz.json")
TRAITS_PATH = path("place_traits.json")
POI_PATH = path("poi_config.json")
STATIC_DIR = path("static")
CACHE_DIR = path("cache")

# AI 선택: openai (GPT) / ollama (내 컴퓨터 qwen2.5:7b)
#   LOCALRISE_LLM 을 안 정하면: OPENAI_API_KEY 가 있으면 openai, 없으면 ollama
LLM_BACKEND = os.environ.get(
    "LOCALRISE_LLM", "openai" if os.environ.get("OPENAI_API_KEY") else "ollama").strip().lower()
if LLM_BACKEND not in ("openai", "ollama"):
    LLM_BACKEND = "ollama"
OPENAI_MODEL = os.environ.get("LOCALRISE_OPENAI_MODEL", "gpt-4o-mini")

OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434")
OLLAMA_MODEL = os.environ.get("LOCALRISE_MODEL", "qwen2.5:7b")
LLM_MODEL = OPENAI_MODEL if LLM_BACKEND == "openai" else OLLAMA_MODEL
LLM_TIMEOUT = float(os.environ.get("LOCALRISE_LLM_TIMEOUT", "90"))  # 초. 넘으면 CSV 기반으로 대체
OLLAMA_OPTIONS = {
    "temperature": 0,      # 같은 입력 → 같은 결과 (제출 JSON 재현성)
    "seed": 42,
    "num_ctx": 8192,
    "num_predict": 1500,   # 출력 길이 상한 (무한 생성 방지)
}
KEEP_ALIVE = "24h"         # 모델을 메모리에 계속 올려 둠 (전시 중 첫 요청 지연 방지)

USE_CACHE = os.environ.get("LOCALRISE_CACHE", "1") != "0"

TARGET_COUNT = 5           # 추천 개수 (제출 규격)
# 추천 방식: "ai"    = 후보 10곳을 섞어서(번호 숨김) AI가 성향 비교를 읽고 코스를 구성 (기본)
#           "score" = 점수 상위 8곳을 순서대로 주고 AI는 위쪽 위주로 선택 (이전 v2 방식)
SELECT_MODE = os.environ.get("LOCALRISE_SELECT_MODE", "ai").strip().lower()
if SELECT_MODE not in ("ai", "score"):
    SELECT_MODE = "ai"
CANDIDATE_COUNT = 10 if SELECT_MODE == "ai" else 8   # AI에게 넘길 후보 수
MIN_QUIZ_SCORE = 0.0       # AI가 골라도 질문 점수가 이보다 낮으면(답과 반대가 많으면) 제외
MAX_ATTEMPTS = 2           # AI 재요청 횟수
MIN_SENTENCES = 2          # 평가 최소 기준
TARGET_SENTENCES = 3       # 여유 있게 3문장 이상으로 맞춤
MAX_SENTENCES = 5          # 평가는 앞 5문장까지만 반영
MIN_TAGS, MAX_TAGS = 2, 3
TERMINAL_PUNCT = (".", "!", "?")
TAG_FALLBACK_POOL = ["김해여행", "관광명소", "추천명소"]

DEFAULT_PREFERENCE = os.environ.get(
    "LOCALRISE_DEFAULT_PREFERENCE",
    "가족과 함께 김해의 가야 역사와 자연을 여유롭게 둘러보고 싶어요.",
)

PROMPT_VERSION = "v2.2"    # AI 지시문을 바꾸면 올릴 것 (캐시 자동 무효화)


# =========================================================
# 2. 데이터 로드
# =========================================================

def load_json(p: str) -> dict:
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def file_md5(p: str) -> str:
    with open(p, "rb") as f:
        return hashlib.md5(f.read()).hexdigest()


df_places = pd.read_csv(CSV_PATH, encoding="utf-8-sig", dtype=str).fillna("")
QUIZ = load_json(QUIZ_PATH)
QUESTIONS = QUIZ["questions"]
TRAITS = {k: v for k, v in load_json(TRAITS_PATH).items() if not k.startswith("_")}
POI = {k: v for k, v in load_json(POI_PATH).items() if not k.startswith("_")}

PLACES: Dict[str, dict] = {}       # place_id -> CSV 한 행 (dict)
for _, row in df_places.iterrows():
    rec = {k: str(v).strip() for k, v in row.items()}
    if rec.get("place_id") and rec.get("place_name"):
        PLACES[rec["place_id"]] = rec

PLACE_TEXT = {pid: " ".join(rec.values()) for pid, rec in PLACES.items()}

# 데이터 버전: CSV·질문·특성표·지시문이 바뀌면 캐시가 자동으로 새로 만들어진다
DATA_VERSION = hashlib.md5(
    (file_md5(CSV_PATH) + file_md5(QUIZ_PATH) + file_md5(TRAITS_PATH) + PROMPT_VERSION + SELECT_MODE
     + LLM_BACKEND + LLM_MODEL).encode()   # AI 종류·모델별로 캐시를 따로 저장 (섞이지 않게)
).hexdigest()[:10]

print(f"[LocalRise] 관광지 {len(PLACES)}곳, 질문 {len(QUESTIONS)}개, 추천 방식 {SELECT_MODE}, "
      f"AI {LLM_BACKEND}({LLM_MODEL}), 데이터 버전 {DATA_VERSION}")


# =========================================================
# 3. 텍스트 유틸 (평가 기준 문장 처리)
# =========================================================

def clean_text(value) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    return "" if text.lower() == "nan" else text


def split_sentences(text: str) -> list:
    """평가 기준: '.', '!', '?'로만 구분, 5자 이하 조각은 문장으로 보지 않음."""
    return [s.strip() for s in re.split(r"[.!?]", clean_text(text)) if len(s.strip()) > 5]


def count_valid_sentences(text: str) -> int:
    return len(split_sentences(text))


def fix_missing_internal_punctuation(text: str) -> str:
    """'~입니다 다음문장' 처럼 마침표가 빠진 곳을 보정."""
    text = clean_text(text)
    if not text:
        return ""
    pattern = (
        r"([가-힣]{2,}(?:습니다|니다|해요|이에요|예요|이죠|군요|했죠|있죠|없죠|합니다|됩니다))"
        r"\s+(?=[가-힣A-Za-z0-9])"
    )
    text = re.sub(pattern, r"\1. ", text)
    text = re.sub(r"\s+", " ", text).strip()
    if text and text[-1] not in TERMINAL_PUNCT:
        text += "."
    return text


def sentence_chunks(text: str) -> list:
    """구두점을 포함한 문장 단위로 자르기."""
    chunks = re.findall(r"[^.!?]+[.!?]+", clean_text(text))
    return [c.strip() for c in chunks if c.strip()]


def limit_sentences(text: str, max_n: int = MAX_SENTENCES) -> str:
    text = fix_missing_internal_punctuation(text)
    kept = []
    for s in sentence_chunks(text):
        if len(re.sub(r"[.!?]+$", "", s).strip()) <= 5:
            continue
        kept.append(s)
        if len(kept) >= max_n:
            break
    return " ".join(kept)


# =========================================================
# 4. 근거 검사 (지어내기 방지)
# =========================================================

# 문장에 이 단어가 있는데 "그 장소의 데이터"에 없으면 → 다른 장소 내용을 섞었거나 지어낸 문장
_FACT_TERMS_CANDIDATES = [
    "가야", "금관가야", "신라", "삼국시대", "고려시대", "조선", "임진왜란", "역사", "사적", "문화유산",
    "청동기", "철기", "토기", "장신구", "패총", "고분", "왕릉", "봉토분", "마애불", "석탑", "파사석탑",
    "숭선전", "홍살문", "구지봉", "신도비", "대웅전", "모은암", "해은사", "성벽", "산성",
    "박물관", "미술관", "돔하우스", "큐브전시관", "도자", "활쏘기", "레일바이크", "와인동굴",
    "천체망원경", "천문대", "워터파크", "슬라이드", "파도풀", "유수풀", "분수", "야시장", "매대", "공연",
    "철새", "습지", "갈대", "철쭉", "계곡", "호수", "낙동강", "김해평야", "평상", "반석",
    "야경", "별", "축제", "등산", "물놀이", "와인",
    # 어느 장소 근거에도 없는 단어: AI가 쓰면 무조건 지어낸 내용
    "노을", "일몰", "일출", "해돋이", "단풍", "벚꽃", "입장료", "무료",
]
FACT_TERMS = list(dict.fromkeys(_FACT_TERMS_CANDIDATES))

# 사실 검사 기준: 장소명·분류·잘 맞는 취향 태그·테마·근거 문장 (embedding_text 검색 키워드는 제외)
EVIDENCE_TEXT = {
    pid: " ".join([rec.get("place_name", ""), rec.get("category", ""), rec.get("preference_tags", ""),
                   rec.get("summary", "")]
                  + [rec.get(f"evidence_text_{i}", "") for i in range(1, 6)])
    for pid, rec in PLACES.items()
}


def remove_ungrounded_sentences(place_id: str, reason: str) -> str:
    own = EVIDENCE_TEXT.get(place_id, "")
    kept = []
    for s in sentence_chunks(reason):
        bad = [t for t in FACT_TERMS if t in s and t not in own]
        if bad:
            print(f"[근거 없는 문장 제거] {place_id} {bad}: {s}")
            continue
        kept.append(s)
    return " ".join(kept)


def evidence_sentences(place_id: str) -> list:
    rec = PLACES.get(place_id, {})
    out = []
    for key in ["evidence_text_1", "evidence_text_2", "evidence_text_3",
                "evidence_text_4", "evidence_text_5", "summary"]:
        t = clean_text(rec.get(key, ""))
        if len(t) > 5:
            out.append(t if t[-1] in TERMINAL_PUNCT else t + ".")
    return out


def _bigrams(text: str) -> set:
    t = re.sub(r"[^가-힣A-Za-z0-9]", "", text)
    return {t[i:i + 2] for i in range(len(t) - 1)}


def is_similar(a: str, b: str, threshold: float = 0.55) -> bool:
    """두 문장이 사실상 같은 내용인지 (글자 2개 묶음 겹침 비율)."""
    ba, bb = _bigrams(a), _bigrams(b)
    if not ba or not bb:
        return False
    return len(ba & bb) / min(len(ba), len(bb)) >= threshold


def remove_duplicate_sentences(reason: str) -> str:
    kept = []
    for s in sentence_chunks(reason):
        if any(is_similar(s, k) for k in kept):
            continue
        kept.append(s)
    return " ".join(kept)


def fill_with_evidence(place_id: str, reason: str) -> str:
    """3문장 미만이면 그 장소 CSV 근거 문장(원문)을 붙여 채운다. 이미 있는 내용과 겹치는 근거는 건너뛴다."""
    reason = remove_duplicate_sentences(reason)
    for cand in evidence_sentences(place_id):
        if count_valid_sentences(reason) >= TARGET_SENTENCES:
            break
        if any(is_similar(cand, s) for s in sentence_chunks(reason)):
            continue
        reason = (reason + " " + cand).strip()
    return limit_sentences(reason)


def polish_result(result: dict) -> dict:
    """캐시에서 꺼낸 결과에도 같은 마무리 보정을 적용 (중복 문장 제거 → 3문장 채우기)."""
    out = dict(result)
    out["recommendations"] = [
        {**r, "recommend_reason": fill_with_evidence(r["place_id"], r["recommend_reason"])}
        for r in result["recommendations"]
    ]
    return out


# =========================================================
# 5. 후보 선정 (다양성 확보 + AI 입력 단축)
# =========================================================

def split_tags(text: str) -> list:
    return [t.strip() for t in clean_text(text).split(",") if t.strip()]


def tag_hits(user_text: str, tag_text: str) -> int:
    return sum(1 for t in split_tags(tag_text) if len(t) >= 2 and t in user_text)


def stable_tiebreak(key: str, pid: str) -> int:
    """점수가 같을 때 입력마다 다르지만 항상 같은 순서가 나오도록."""
    return int(hashlib.md5((key + pid).encode()).hexdigest()[:8], 16)


def candidates_from_text(user_text: str, k: int = CANDIDATE_COUNT) -> list:
    tokens = set(re.findall(r"[가-힣A-Za-z0-9]+", user_text))
    scores = {}
    for pid, rec in PLACES.items():
        words = set(re.findall(r"[가-힣A-Za-z0-9]+", PLACE_TEXT[pid]))
        s = len(tokens & words)
        s += 3 * tag_hits(user_text, rec.get("preference_tags", ""))
        s += 1 * tag_hits(user_text, rec.get("category", ""))
        s -= 4 * tag_hits(user_text, rec.get("avoid_tags", ""))
        scores[pid] = s
    return sorted(scores, key=lambda p: (-scores[p], stable_tiebreak(user_text, p)))[:k]


def quiz_scores(answers: Dict[str, str]) -> Dict[str, float]:
    scores = {}
    for pid in PLACES:
        tr = TRAITS.get(pid, {})
        s = 0.0
        for q in QUESTIONS:
            v, a = tr.get(q["id"], "N"), answers[q["id"]]
            s += q.get("weight", 1.0) * (2.0 if v == a else (0.7 if v == "N" else -1.0))
        scores[pid] = round(s, 3)
    return scores


def candidates_from_quiz(answers: Dict[str, str], k: int = CANDIDATE_COUNT) -> list:
    sc = quiz_scores(answers)
    key = answers_key(answers)
    return sorted(sc, key=lambda p: (-sc[p], stable_tiebreak(key, p)))[:k]


# =========================================================
# 6. 질문 답 처리
# =========================================================

def normalize_answers(raw: Dict[str, str]) -> Dict[str, str]:
    answers = {}
    for q in QUESTIONS:
        v = str(raw.get(q["id"], "")).strip().upper()
        if v not in ("A", "B"):
            raise HTTPException(status_code=400, detail=f"질문 '{q['id']}'의 답은 A 또는 B여야 합니다.")
        answers[q["id"]] = v
    return answers


def answers_key(answers: Dict[str, str]) -> str:
    return "".join(answers[q["id"]] for q in QUESTIONS)


def answers_to_text(answers: Dict[str, str]) -> str:
    return " ".join(q["options"][answers[q["id"]]]["phrase"] for q in QUESTIONS)


def fallback_persona(answers: Optional[Dict[str, str]]) -> str:
    if not answers:
        return "입력하신 취향에 맞춰 김해의 여행지를 골라 보았어요."
    labels = [q["options"][answers[q["id"]]]["label"] for q in QUESTIONS]
    return (f"{labels[0]} 떠나는 여행, {labels[1]}과 {labels[2]}를 원하는 여행자예요. "
            f"취향에 맞는 김해 여행지 5곳을 골라 보았어요.")


# =========================================================
# 7. AI 호출
# =========================================================

LLM_LOCK = threading.Lock()   # AI 생성은 한 번에 하나씩 (같은 입력이면 같은 결과 + 비용·GPU 보호)
_ollama_client = None
_openai_client = None


def ollama_client():
    global _ollama_client
    if _ollama_client is None:
        from ollama import Client   # Ollama를 안 쓰면 설치 안 해도 되게, 필요할 때만 불러온다
        _ollama_client = Client(host=OLLAMA_HOST, timeout=LLM_TIMEOUT)
    return _ollama_client


def openai_client():
    global _openai_client
    if _openai_client is None:
        if not os.environ.get("OPENAI_API_KEY"):
            raise RuntimeError("OPENAI_API_KEY가 없습니다. agent/.env 에 키를 넣어 주세요.")
        from openai import OpenAI
        _openai_client = OpenAI(timeout=LLM_TIMEOUT, max_retries=1)
    return _openai_client


def llm_generate(system: str, prompt: str) -> str:
    """선택된 AI에 JSON 답을 요청하고 글자 그대로 돌려준다."""
    if LLM_BACKEND == "openai":
        resp = openai_client().chat.completions.create(
            model=OPENAI_MODEL,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": prompt}],
            response_format={"type": "json_object"},
            temperature=0, seed=42,   # 같은 입력 → 최대한 같은 결과 (최종 고정은 캐시로)
            max_tokens=2500,
        )
        return resp.choices[0].message.content or ""
    resp = ollama_client().generate(
        model=OLLAMA_MODEL, system=system, prompt=prompt,
        format="json", options=OLLAMA_OPTIONS, keep_alive=KEEP_ALIVE,
    )
    return resp["response"] if isinstance(resp, dict) else resp.response


def llm_ok() -> bool:
    """/health 용: AI에 연결할 수 있는지."""
    try:
        if LLM_BACKEND == "openai":
            return bool(os.environ.get("OPENAI_API_KEY"))   # 호출 비용을 아끼려고 키 유무만 확인
        ollama_client().list()
        return True
    except Exception:
        return False


def label_of(qid: str, choice: str) -> str:
    for q in QUESTIONS:
        if q["id"] == qid:
            return q["options"][choice]["label"]
    return choice


def quiz_notes(place_id: str, answers: Dict[str, str]) -> str:
    """관람객 답과 장소 성향 비교를 ✔/✘ 글로 만든다. (AI가 위치가 아니라 내용으로 판단하도록)"""
    tr = TRAITS.get(place_id, {})
    good, bad = [], []
    for q in QUESTIONS:
        v, a = tr.get(q["id"], "N"), answers[q["id"]]
        if v == a:
            good.append(f"✔ {label_of(q['id'], a)}")
        elif v != "N":
            bad.append(f"✘ {label_of(q['id'], a)} (이곳은 '{label_of(q['id'], v)}' 쪽)")
    return f"맞는 점: {', '.join(good) or '없음'} / 안 맞는 점: {', '.join(bad) or '없음'}"


def text_notes(place_id: str, user_text: str) -> str:
    rec = PLACES[place_id]
    good = [t for t in split_tags(rec.get("preference_tags", "")) if len(t) >= 2 and t in user_text]
    bad = [t for t in split_tags(rec.get("avoid_tags", "")) if len(t) >= 2 and t in user_text]
    return (f"맞는 점: {', '.join('✔ ' + t for t in good) or '직접 일치 없음'} / "
            f"안 맞는 점: {', '.join('✘ ' + t for t in bad) or '없음'}")


def display_order(candidate_ids: list, key: str) -> list:
    """AI 모드: 점수 순서를 숨기려고 섞는다. 섞는 방식은 고정(md5)이라 같은 입력이면 같은 순서."""
    if SELECT_MODE != "ai":
        return list(candidate_ids)
    return sorted(candidate_ids, key=lambda p: hashlib.md5(f"{key}|order|{p}".encode()).hexdigest())


def build_context(shown_ids: list, notes_fn) -> str:
    """장소ID(GIMHAE_001 등)는 숨기고 '후보 1~N' 번호로만 보여 준다. (번호 숫자에 끌리는 것 방지)"""
    blocks = []
    for n, pid in enumerate(shown_ids, 1):
        r = PLACES[pid]
        blocks.append(
            f"[후보 {n}]\n장소명: {r['place_name']}\n분류: {r.get('category', '')}\n"
            f"성향 비교: {notes_fn(pid)}\n"
            f"잘 맞는 취향: {r.get('preference_tags', '')}\n맞지 않는 취향: {r.get('avoid_tags', '')}\n"
            f"테마: {r.get('summary', '')}\n"
            f"근거1: {r.get('evidence_text_1', '')}\n근거2: {r.get('evidence_text_2', '')}\n"
            f"근거3: {r.get('evidence_text_3', '')}\n근거4: {r.get('evidence_text_4', '')}\n"
            f"근거5: {r.get('evidence_text_5', '')}"
        )
    return "\n--------------------\n".join(blocks)


_SELECT_RULES = {
    "ai": [
        "후보 목록의 순서는 무작위다. 순서와 번호는 아무 의미가 없으니, 각 후보의 '성향 비교'와 근거를 읽고 판단한다.",
        "'✔ 맞는 점'이 많고 '✘ 안 맞는 점'이 적은 장소를 우선한다. ✘가 있는 장소는 그 차이가 사용자에게 크지 않을 때만 고른다.",
        "코스 구성: 5곳의 분류가 한 종류(예: 유적만)로만 몰리면, 성향에 맞는 다른 분류의 장소를 1곳 이상 섞어 하루 여행 코스를 다채롭게 만든다.",
        "recommendations는 추천하고 싶은 순서대로 쓴다.",
    ],
    "score": [
        "후보 목록은 사용자에게 잘 맞는 순서로 정렬되어 있다. 위쪽 후보를 우선하되 성향에 더 맞으면 바꿔도 된다.",
    ],
}


def build_system_prompt() -> str:
    rules = (
        [f"recommendations는 정확히 {TARGET_COUNT}개, 서로 다른 후보. candidate_no와 place_name은 후보 목록 그대로 쓴다."]
        + _SELECT_RULES[SELECT_MODE]
        + ["persona_summary는 사용자가 입력한 성향만 근거로, 어떤 여행자인지 따뜻한 해요체로 1~2문장 쓴다.",
           "recommend_reason\n"
           "   - 정확히 4문장, 해요체('~예요', '~어요', '~요.'). 문장 끝은 반드시 '.', '!', '?' 중 하나. 쉼표는 문장 구분자가 아니다.\n"
           "   - 1~2번째 문장(장소 소개): 장소명으로 시작해, 그 후보의 근거1~5와 테마 문장의 표현을 거의 그대로 살려 무엇이 있는 곳인지, 어떤 풍경·분위기인지 쓴다.\n"
           "   - 3~4번째 문장(성향 연결): '✔ 맞는 점'의 취향을 하나씩 골라 '○○을 좋아한다면 (근거에 나오는 구체적인 활동·장소)이 잘 맞아요.' 또는 '○○와 함께라면 (근거에 나오는 활동)을 즐길 수 있어요.' 형식으로 쓴다.\n"
           "   - 취향만 나열하는 문장(예: '조용하고 차분한 분위기를 제공합니다.')은 쓰지 않는다. 모든 문장에 그 장소만의 구체적인 사실(근거에 있는 시설·풍경·활동)이 하나 이상 들어가야 한다.\n"
           "   - 장소에 대한 사실은 반드시 그 후보의 근거1~5와 테마 문장에 있는 내용만 쓴다.\n"
           "   - 유물·시설·숫자·연도·시대 표현은 그 후보 데이터에 있는 단어만 쓴다. 다른 후보의 단어를 섞지 않는다.\n"
           "   - 데이터에 없는 비용, 운영시간, 주차, 행사, 효과를 만들지 않는다.\n"
           "   - '후보 3' 같은 번호, '✔', '✘' 기호, \"~와 달리\", \"~을 피하고 싶다면\" 같은 부정 비교 표현을 쓰지 않는다.",
           "matching_tags는 2~3개의 짧은 명사 키워드."]
    )
    rule_text = "\n".join(f"{i}. {r}" for i, r in enumerate(rules, 1))
    return f"""
너는 김해시 관광지 추천 AI다. 사용자의 여행 성향을 분석하고, 제공된 후보 관광지 중에서만 추천한다.

반드시 아래 형식의 JSON 객체 하나만 출력한다.
{{
  "persona_summary": "사용자 성향 분석 1~2문장",
  "recommendations": [
    {{"candidate_no": 후보번호(숫자), "place_name": "...", "recommend_reason": "...", "matching_tags": ["...", "..."]}}
  ]
}}

규칙
{rule_text}
""".strip()


SYSTEM_PROMPT = build_system_prompt()


def call_llm(user_text: str, shown_ids: list, notes_fn, exclude: list) -> dict:
    exclude_text = f"\n이미 추천된 장소(제외): {', '.join(exclude)}\n" if exclude else ""
    prompt = (
        f"[사용자 여행 성향]\n{user_text}\n{exclude_text}\n"
        f"[후보 관광지 {len(shown_ids)}곳]\n{build_context(shown_ids, notes_fn)}\n\n"
        f"위 후보 중 {TARGET_COUNT}곳을 골라 JSON으로만 답하라."
    )
    with LLM_LOCK:
        text = llm_generate(SYSTEM_PROMPT, prompt)
    return parse_llm_json(text)


def resolve_pick(item: dict, shown_ids: list) -> Optional[str]:
    """AI가 답한 후보 번호(또는 장소명)를 실제 place_id로 되돌린다."""
    m = re.search(r"\d+", str(item.get("candidate_no", "")))
    if m and 1 <= int(m.group()) <= len(shown_ids):
        pid = shown_ids[int(m.group()) - 1]
        name = clean_text(item.get("place_name", ""))
        # 번호와 이름이 어긋나면 이름을 믿는다 (이름이 후보에 있을 때만)
        by_name = [p for p in shown_ids if PLACES[p]["place_name"] == name]
        return by_name[0] if by_name and by_name[0] != pid else pid
    name = clean_text(item.get("place_name", ""))
    for p in shown_ids:
        if PLACES[p]["place_name"] == name:
            return p
    pid = clean_text(item.get("place_id", ""))
    return pid if pid in shown_ids else None


def parse_llm_json(text: str) -> dict:
    text = clean_text(text)
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.IGNORECASE).strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        s, e = text.find("{"), text.rfind("}")
        if s == -1 or e <= s:
            return {}
        try:
            data = json.loads(text[s:e + 1])
        except json.JSONDecodeError:
            return {}
    if isinstance(data, list):
        return {"recommendations": data}
    return data if isinstance(data, dict) else {}



# =========================================================
# 8. 검증·보정
# =========================================================

def build_item(place_id: str, reason: str, tags: list) -> Optional[dict]:
    rec = PLACES[place_id]
    reason = limit_sentences(clean_text(reason))
    reason = remove_ungrounded_sentences(place_id, reason)
    reason = fill_with_evidence(place_id, reason)
    if count_valid_sentences(reason) < MIN_SENTENCES:
        return None

    tags = [clean_text(t) for t in (tags if isinstance(tags, list) else []) if clean_text(t)]
    tags = [t for t in dict.fromkeys(tags) if len(t) <= 15][:MAX_TAGS]
    for t in split_tags(rec.get("preference_tags", "")) + TAG_FALLBACK_POOL:
        if len(tags) >= MIN_TAGS:
            break
        if t not in tags:
            tags.append(t)

    return {
        "place_id": place_id,
        "place_name": rec["place_name"],
        "recommend_reason": reason,
        "matching_tags": tags[:MAX_TAGS],
        "image_prompt": POI.get(place_id, {}).get("image_prompt", ""),
    }


def backfill_item(place_id: str) -> Optional[dict]:
    """AI 없이 CSV 근거 문장만으로 추천 항목 생성 (AI 실패·시간초과 대비)."""
    return build_item(place_id, "", [])


# =========================================================
# 9. 추천 파이프라인
# =========================================================

def run_pipeline(user_text: str, candidate_ids: list, answers: Optional[dict] = None,
                 key: str = "") -> dict:
    """candidate_ids: 점수 높은 순서의 후보. AI 모드에서는 섞어서 보여 주고 AI가 판단해 고른다."""
    results: List[dict] = []
    seen = set()
    persona = ""
    source = "ai"
    notes_fn = (lambda p: quiz_notes(p, answers)) if answers else (lambda p: text_notes(p, user_text))
    q_scores = quiz_scores(answers) if answers else {}
    first_shown: list = []
    picked_pos: Dict[str, int] = {}

    for attempt in range(MAX_ATTEMPTS):
        if len(results) >= TARGET_COUNT:
            break
        remaining = [p for p in candidate_ids if p not in seen]
        shown = display_order(remaining, f"{key}|{attempt}")
        if attempt == 0:
            first_shown = shown
        try:
            data = call_llm(user_text, shown, notes_fn, [PLACES[p]["place_name"] for p in seen])
        except Exception as e:  # 시간초과·연결 실패 등
            print(f"[AI 오류] 시도 {attempt + 1}/{MAX_ATTEMPTS}: {e}")
            source = "fallback"
            break

        persona = persona or clean_text(data.get("persona_summary", ""))
        for item in data.get("recommendations", []) or []:
            if not isinstance(item, dict):
                continue
            pid = resolve_pick(item, shown)
            if pid is None or pid in seen:   # 후보 밖·중복 장소 제외
                continue
            if answers and q_scores.get(pid, 0) < MIN_QUIZ_SCORE:   # 답과 크게 어긋나는 장소 제외
                print(f"[성향 불일치 제외] {pid} 점수 {q_scores.get(pid)}")
                continue
            built = build_item(pid, item.get("recommend_reason", ""), item.get("matching_tags", []))
            if built:
                results.append(built)
                seen.add(pid)
                if attempt == 0:
                    picked_pos[pid] = shown.index(pid) + 1
            if len(results) >= TARGET_COUNT:
                break

    # 부족하면 점수 순위대로 CSV 근거로 채움 → 그래도 부족하면 전체 장소에서
    for pid in candidate_ids + [p for p in PLACES if p not in candidate_ids]:
        if len(results) >= TARGET_COUNT:
            break
        if pid in seen:
            continue
        built = backfill_item(pid)
        if built:
            results.append(built)
            seen.add(pid)
            if source == "ai":
                source = "ai+fallback"

    if len(results) < TARGET_COUNT:
        raise HTTPException(status_code=500, detail="추천 결과를 5개 만들지 못했습니다.")

    final = results[:TARGET_COUNT]
    return {
        "region_id": REGION_ID,
        "persona_summary": persona or fallback_persona(answers),
        "recommendations": final,
        "source": source,  # ai / ai+fallback / fallback (화면 디버깅용)
        "debug": {         # 편향·다양성 측정용 (warmup_cache.py 리포트에서 사용)
            "mode": SELECT_MODE,
            "shown_order": first_shown,
            "picked_positions": [picked_pos.get(r["place_id"]) for r in final],   # AI에게 보인 자리(1~N)
            "score_ranks": [candidate_ids.index(r["place_id"]) + 1 if r["place_id"] in candidate_ids else None
                            for r in final],                                     # 점수표 순위
        },
    }



# =========================================================
# 10. 캐시 (같은 입력은 즉시 응답)
# =========================================================

CACHE_FILE = os.path.join(CACHE_DIR, f"cache_{DATA_VERSION}.json")
CACHE_LOCK = threading.Lock()
CACHE: Dict[str, dict] = {}
if USE_CACHE and os.path.exists(CACHE_FILE):
    try:
        CACHE = load_json(CACHE_FILE)
        print(f"[LocalRise] 캐시 {len(CACHE)}건 불러옴")
    except Exception:
        CACHE = {}


def cached_run(cache_key: str, fn) -> dict:
    if USE_CACHE and cache_key in CACHE:
        return polish_result(CACHE[cache_key])
    result = polish_result(fn())
    if USE_CACHE and result.get("source") == "ai":   # AI가 정상 생성한 결과만 저장
        with CACHE_LOCK:
            CACHE[cache_key] = result
            os.makedirs(CACHE_DIR, exist_ok=True)
            with open(CACHE_FILE, "w", encoding="utf-8") as f:
                json.dump(CACHE, f, ensure_ascii=False)
    return result


LATEST_LOCK = threading.Lock()
LATEST: Optional[dict] = None


def set_latest(result: dict):
    global LATEST
    with LATEST_LOCK:
        LATEST = result


def public(result: dict) -> dict:
    """외부 연계(Re:Local)·제출용 응답 형식."""
    return {
        "region_id": result["region_id"],
        "recommendations": [
            {"place_name": r["place_name"], "place_id": r["place_id"],
             "recommend_reason": r["recommend_reason"]}
            for r in result["recommendations"]
        ],
    }


# =========================================================
# 11. 서버 / 엔드포인트
# =========================================================

def warmup():
    """서버 시작 시 AI 준비 상태 확인. Ollama는 모델을 미리 메모리에 올려 첫 관람객 대기 시간을 줄인다."""
    if LLM_BACKEND == "openai":
        if os.environ.get("OPENAI_API_KEY"):
            print(f"[LocalRise] AI 준비 완료 (OpenAI {OPENAI_MODEL})")
        else:
            print("[LocalRise] OPENAI_API_KEY가 없습니다. agent/.env 확인 (지금은 CSV 기반 대체 문장으로 동작)")
        return
    try:
        ollama_client().generate(model=OLLAMA_MODEL, prompt="안녕", options={"num_predict": 1},
                                 keep_alive=KEEP_ALIVE)
        print("[LocalRise] AI 모델 준비 완료 (Ollama)")
    except Exception as e:
        print(f"[LocalRise] AI 모델 준비 실패 (Ollama 실행 여부 확인): {e}")


@asynccontextmanager
async def lifespan(_app):
    threading.Thread(target=warmup, daemon=True).start()
    yield


app = FastAPI(title="LocalRise 김해 추천 API", version=PROMPT_VERSION, lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
os.makedirs(STATIC_DIR, exist_ok=True)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


class PreferenceRequest(BaseModel):
    preference: str


class QuizRequest(BaseModel):
    answers: Dict[str, str]


def media_urls(place_id: str) -> dict:
    cfg = POI.get(place_id, {})
    out = {}
    for kind, folder in (("image_url", "images"), ("video_url", "videos")):
        fname = cfg.get("image_file" if kind == "image_url" else "video_file", "")
        out[kind] = f"/static/{folder}/{fname}" if fname and os.path.exists(path("static", folder, fname)) else None
    return out


def with_media(result: dict) -> dict:
    out = dict(result)
    out["recommendations"] = [{**r, "image_prompt": POI.get(r["place_id"], {}).get("image_prompt", r.get("image_prompt", "")),
                                **media_urls(r["place_id"])} for r in result["recommendations"]]
    return out


import video_jobs  # noqa: E402  (시연 화면 STEP 3: 장소 영상 작업 등록·상태 확인)

video_jobs.setup(PLACES, POI, media_urls)
app.include_router(video_jobs.router)


@app.get("/", include_in_schema=False)
def index():
    page = path("static", "index.html")
    if os.path.exists(page):
        return FileResponse(page)
    return {"message": "LocalRise API", "docs": "/docs"}


@app.get("/health")
def health():
    ok = llm_ok()
    return {"status": "ok", "region_id": REGION_ID, "places": len(PLACES),
            "questions": len(QUESTIONS), "llm": LLM_BACKEND, "llm_ok": ok, "model": LLM_MODEL,
            "ollama": ok if LLM_BACKEND == "ollama" else None,
            "select_mode": SELECT_MODE,
            "cache_entries": len(CACHE), "data_version": DATA_VERSION}


@app.get("/quiz")
def get_quiz():
    """화면에 띄울 질문 목록."""
    return {"questions": [
        {"id": q["id"], "text": q["text"],
         "options": {k: {"label": v["label"]} for k, v in q["options"].items()}}
        for q in QUESTIONS]}


@app.post("/recommend_quiz")
def recommend_quiz(req: QuizRequest):
    """2지선다 답 → 성향 분석 + 추천 5곳 (현장 전시용)."""
    answers = normalize_answers(req.answers)
    key = "quiz:" + answers_key(answers)
    result = cached_run(key, lambda: run_pipeline(
        answers_to_text(answers), candidates_from_quiz(answers), answers, key))
    set_latest(result)
    return with_media({**result, "answers": answers})


@app.post("/recommend")
def recommend(req: PreferenceRequest):
    """자유 문장 → 추천 5곳 (제출용 02 JSON 생성, 테스트용)."""
    text = clean_text(req.preference)
    if not text:
        raise HTTPException(status_code=400, detail="preference를 입력해주세요.")
    key = "text:" + text
    result = cached_run(key, lambda: run_pipeline(text, candidates_from_text(text), key=key))
    set_latest(result)
    return result


@app.get("/current_region")
def current_region(region_id: str = Query("", description="요청 지역 ID (GIMHAE)")):
    """대회 공통 Re:Local 연계 API: GET http://{HOST}:5000/current_region?region_id=GIMHAE"""
    requested = clean_text(region_id)
    if requested.upper() != REGION_ID:
        return JSONResponse(status_code=404, content={
            "region_id": requested or "UNKNOWN",
            "message": "Requested region_id was not found."})
    with LATEST_LOCK:
        latest = LATEST
    if latest is None:
        latest = cached_run("text:" + DEFAULT_PREFERENCE,
                            lambda: run_pipeline(DEFAULT_PREFERENCE, candidates_from_text(DEFAULT_PREFERENCE)))
        set_latest(latest)
    return public(latest)


@app.get("/poi/{place_id}")
def poi(place_id: str):
    """장소별 LoRA·프롬프트·미디어 정보 (영상 생성 연동용)."""
    if place_id not in PLACES:
        raise HTTPException(status_code=404, detail="없는 장소입니다.")
    return {"place_id": place_id, "place_name": PLACES[place_id]["place_name"],
            **POI.get(place_id, {}), **media_urls(place_id)}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=5000)
