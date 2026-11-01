LocalRise 김해 관광지 추천 API v2  (2026 AIM 챌린지 본선)
=====================================================

[폴더 구성]
  app.py                  추천 API 서버 (실행 파일)
  gimhae_places.csv       김해 관광지 20곳 데이터 (01 제출 CSV와 동일 내용)
  quiz.json               2지선다 질문 7개 (문구·가중치 수정 가능)
  place_traits.json       장소별 질문 성향표 (A / B / N=상관없음)
  poi_config.json         장소별 LoRA 파일명·트리거·이미지 프롬프트·미디어 파일명
  static/index.html       질문 테스트 화면 (http://localhost:5000/)
  static/images/          장소 이미지 넣는 곳 (GIMHAE_001.png ...)
  static/videos/          장소 영상 넣는 곳 (GIMHAE_001.mp4 ...)
  warmup_cache.py         질문 답 128가지 미리 생성 + 추천 품질 리포트 (전시 전 1회)
  make_submission_json.py 02 제출 JSON 생성
  requirements.txt        필요한 파이썬 패키지 목록
  cache/                  (자동 생성) 미리 만든 추천 결과 저장


1. 처음 설치 (Windows, 한 번만)
-------------------------------
  준비물: Python 3.12, Ollama (qwen2.5:7b 받아 둔 상태)

  PowerShell에서 이 폴더로 이동 후:
    py -3.12 -m venv .venv
    Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
    .\.venv\Scripts\Activate.ps1
    pip install -r requirements.txt

  ※ 기존 v1 폴더를 쓰고 있었다면: .venv 폴더는 그대로 두고 나머지 파일만 덮어쓰기.
     그 다음 활성화 → pip install -r requirements.txt 한 번 더.


2. 실행
-------
    .\.venv\Scripts\Activate.ps1
    python app.py

  "Uvicorn running on http://0.0.0.0:5000" 이 보이면 성공.
  "[LocalRise] AI 모델 준비 완료" 가 뜨면 AI도 메모리에 올라간 상태.

  확인할 주소 (브라우저)
    http://localhost:5000/                              질문 테스트 화면
    http://localhost:5000/docs                          API 직접 테스트
    http://localhost:5000/health                        상태 점검 (ollama: true 여야 함)
    http://localhost:5000/current_region?region_id=GIMHAE   Re:Local 연계 API


3. 전시 전 준비 (강력 추천)
---------------------------
  서버를 켠 상태에서 새 PowerShell 창:
    .\.venv\Scripts\Activate.ps1
    python warmup_cache.py

  - 질문 답 조합 128가지를 모두 AI로 미리 만들어 cache 폴더에 저장.
  - 끝나면 "추천 품질 리포트"가 출력되고 report_ai.txt 로 저장됨 (아래 6-⑥ 참고).
  - 시간: 조합당 10~40초 → 전체 약 30분~1시간 (처음 1회만).
  - 끝나면 전시 당일 어떤 답이 와도 1초 안에 결과가 나옴.
  - 노트북을 옮길 때 cache 폴더도 같이 복사.
  - CSV / quiz.json / place_traits.json 을 고치면 캐시가 자동으로 새로 만들어짐(다시 실행 필요).


4. 02 제출 JSON 만들기
----------------------
  서버를 켠 상태에서:
    python make_submission_json.py --quiz AAAAAAA       (질문 답 7글자, A/B)
    또는
    python make_submission_json.py "가족과 함께 가야 역사를 둘러보고 싶어요"

  → 02_LocalRise_지역추천지.json 생성 (대회 규격: region_id + 추천 5곳)
  → 끝에 "생성 방식이 ..." 경고가 뜨면 Ollama 확인 후 다시 실행.


5. API 목록
-----------
  GET  /                  질문 테스트 화면
  GET  /quiz              질문 7개 (프론트엔드가 화면에 띄울 내용)
  POST /recommend_quiz    질문 답 → 성향 분석 + 추천 5곳   (전시용)
         보내는 값: {"answers": {"with":"A","theme":"B","mood":"A","fun":"B","move":"A","time":"A","keep":"B"}}
  POST /recommend         문장 → 추천 5곳 (테스트·제출용)
         보내는 값: {"preference": "가족과 함께 역사 여행"}
  GET  /current_region?region_id=GIMHAE   가장 최근 추천 결과 (대회 공통 규격)
  GET  /poi/GIMHAE_001    장소별 LoRA·트리거·이미지 프롬프트 (영상 생성 연동용)
  GET  /health            서버·AI 상태

  /recommend_quiz 응답 예시
  {
    "region_id": "GIMHAE",
    "persona_summary": "가야의 역사를 차분히 배우고 싶은 가족 여행자예요.",
    "recommendations": [
      {"place_id": "GIMHAE_001", "place_name": "수로왕릉",
       "recommend_reason": "3~4문장", "matching_tags": ["가야역사","가족"],
       "image_prompt": "LoRA 이미지 프롬프트", "image_url": null, "video_url": null}, ... 5개
    ],
    "source": "ai",          (ai / ai+fallback / fallback)
    "answers": {...},
    "debug": {...}           (측정용. 프론트에서는 무시해도 됨)
  }


6. 동작 방식 (기능 설명)
------------------------
  한 줄 요약: "점수표는 후보를 좁히고, AI가 성향을 분석해 코스를 구성한다."

  ① 점수표로 후보 10곳 선정
     place_traits.json 표로 장소마다 점수 계산 (맞으면 +2, 상관없음 +0.7, 반대 -1, 질문별 가중치).

  ② 후보를 섞고 번호를 숨겨서 AI에게 전달 (위치 편향 줄이기)
     - 점수 순서를 숨기려고 순서를 섞음 (섞는 방식은 고정 → 같은 답이면 같은 순서)
     - GIMHAE_001 같은 장소ID 대신 "후보 1~10"으로만 보여 주고, 코드에서 원래 ID로 되돌림
     - 장소마다 "성향 비교"를 글로 줌. 예) 맞는 점: ✔ 가족·아이와 함께, ✔ 역사…
                                            안 맞는 점: ✘ 분위기 있는 저녁·밤 (이곳은 '햇살 좋은 낮' 쪽)

  ③ AI 성향 분석 + 코스 구성
     qwen2.5:7b가 ✔/✘와 근거를 읽고
       - 어떤 여행자인지 요약 (persona_summary)
       - 10곳 중 5곳 선택. 5곳이 한 종류(유적만 등)로 몰리면 다른 성격 장소를 섞어 코스를 다채롭게
       - CSV 근거 문장만으로 추천 이유 작성
     temperature 0, seed 42 → 같은 답은 항상 같은 결과 (재현성).

  ④ 자동 검증·보정 (평가 기준 대응)
     - 후보에 없는 장소, 중복 장소 제거
     - AI가 골라도 질문 점수가 0 미만(답과 반대가 많은 곳)이면 제외
     - 그 장소 데이터에 없는 사실 단어(예: 다른 장소의 '청동기')가 든 문장 삭제
     - 3문장 미만이면 그 장소 CSV 근거 원문으로 채움, 최대 5문장
     - 문장 끝 마침표 자동 보정, 태그 2~3개 보장

  ⑤ 안전장치
     - AI가 꺼져 있거나 90초 넘게 걸리면 CSV 근거 문장으로 즉시 5곳 생성 (화면이 멈추지 않음)
     - 잘못된 답(A/B 외) → 400 오류 메시지
     - 다른 region_id → 대회 규격 오류 JSON
     - 서버 시작 시 AI 모델 미리 로드 (첫 관람객 대기 제거)
     - AI가 정상 생성한 결과만 캐시에 저장

  ⑥ 추천 품질 리포트 (warmup_cache.py 끝에 출력)
     [다양성]     서로 다른 추천 조합 수 → 80 이상이면 좋음 / 20곳 모두 추천되는지
     [위치 편향]  AI가 고른 장소가 섞인 목록의 몇 번째였는지
                  앞 5자리 비율이 50% 근처면 내용 보고 판단, 80% 넘으면 위치 편향 강함
     [점수표 순위] 최종 추천이 점수표 몇 위였는지 (6~10위가 섞여 있어야 AI가 실제로 판단한 것)

  ⑦ 미디어 연결
     static/images/GIMHAE_001.png, static/videos/GIMHAE_001.mp4 처럼 파일을 넣으면
     응답의 image_url / video_url 에 자동으로 주소가 들어가고 테스트 화면에 표시됨.

  ⑧ 추천 방식 바꾸기 (비교용)
     기본은 AI 방식. 이전 방식(점수 상위 8곳 순서대로, AI는 위쪽 위주로 선택)으로 바꾸려면:
       $env:LOCALRISE_SELECT_MODE="score"
       python app.py
     두 방식의 캐시는 따로 저장되므로 바꿔도 섞이지 않음. 리포트도 report_ai.txt / report_score.txt 로 따로 저장.
     다시 AI 방식:  $env:LOCALRISE_SELECT_MODE="ai"  (또는 PowerShell 창을 새로 열기)


7. 자주 바꿀 설정
-----------------
  - 질문 문구: quiz.json 의 text / label / phrase (id는 바꾸지 말 것)
  - 장소 성향: place_traits.json (A/B/N)
  - 캐시 끄기: PowerShell에서  $env:LOCALRISE_CACHE="0"  후 python app.py
  - AI 대기 시간: $env:LOCALRISE_LLM_TIMEOUT="60"
  - 다른 PC의 Ollama 사용: $env:OLLAMA_HOST="http://IP:11434"


8. 문제 해결
------------
  ModuleNotFoundError        → .venv 활성화 확인 후 pip install -r requirements.txt
  /health 에서 ollama:false  → Ollama 앱 실행, "ollama list"에 qwen2.5:7b 있는지 확인
  source 가 fallback 만 나옴 → 위와 동일 (AI 연결 안 됨)
  같은 PC 다른 기기에서 접속 → http://노트북IP:5000 , Windows 방화벽에서 5000 포트 허용
