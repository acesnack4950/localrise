"""
02_LocalRise_지역추천지.json 생성 스크립트 (실제 API 호출 결과를 그대로 저장)

app.py 서버를 먼저 켜 둔 상태에서, 새 터미널에서 실행:
    python make_submission_json.py --quiz AAAAAAA        # 질문 7개 답(A/B)으로 생성 (추천)
    python make_submission_json.py "성향 문장"            # 문장으로 생성

저장 형식은 대회 규격 그대로: {region_id, recommendations[{place_name, place_id, recommend_reason}]}
"""
import json
import sys
import urllib.request

BASE = "http://localhost:5000"
OUT_FILE = "02_LocalRise_지역추천지.json"
DEFAULT = "가족과 함께 김해의 가야 역사와 자연을 여유롭게 둘러보고 싶어요."


def post(path, body):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode("utf-8"),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=600) as res:
        return json.loads(res.read().decode("utf-8"))


def main():
    args = sys.argv[1:]
    if args and args[0] == "--quiz":
        code = (args[1] if len(args) > 1 else "").upper()
        with urllib.request.urlopen(BASE + "/quiz", timeout=30) as res:
            qids = [q["id"] for q in json.loads(res.read().decode("utf-8"))["questions"]]
        if len(code) != len(qids) or set(code) - {"A", "B"}:
            sys.exit(f"답은 A/B {len(qids)}글자여야 합니다. 예: --quiz {'A' * len(qids)}")
        data = post("/recommend_quiz", {"answers": dict(zip(qids, code))})
        print(f"입력(질문 답): {code}")
    else:
        pref = args[0] if args else DEFAULT
        data = post("/recommend", {"preference": pref})
        print(f"입력(문장): {pref}")

    out = {"region_id": data["region_id"],
           "recommendations": [{"place_name": r["place_name"], "place_id": r["place_id"],
                                "recommend_reason": r["recommend_reason"]}
                               for r in data["recommendations"]]}
    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

    print(f"성향 분석: {data.get('persona_summary', '')}")
    for i, r in enumerate(out["recommendations"], 1):
        print(f"{i}. {r['place_id']} {r['place_name']}")
    if data.get("source") != "ai":
        print(f"※ 생성 방식이 '{data.get('source')}' 입니다. AI 연결(.env의 OPENAI_API_KEY 또는 Ollama)을 확인 후 다시 실행하세요.")
    print(f"저장 완료: {OUT_FILE}")


if __name__ == "__main__":
    main()
