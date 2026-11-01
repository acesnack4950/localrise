"""
전시 전 미리 계산 + 추천 품질 측정 스크립트

질문 답 조합 전부(2^7 = 128가지)를 AI로 미리 생성해 캐시에 저장하고,
마지막에 "다양성 / 위치 편향" 리포트를 출력·저장한다.

app.py 서버를 먼저 켜 둔 상태에서, 새 터미널에서 실행:
    python warmup_cache.py
중간에 멈춰도 다시 실행하면 이미 만든 조합은 캐시에서 바로 나온다.
"""
import collections
import itertools
import json
import time
import urllib.request

BASE = "http://localhost:5000"


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=30) as res:
        return json.loads(res.read().decode("utf-8"))


def post(path, body):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode("utf-8"),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=600) as res:
        return json.loads(res.read().decode("utf-8"))


def main():
    health = get("/health")
    mode = health.get("select_mode", "?")
    print(f"AI: {health.get('llm')} ({health.get('model')})")
    if not health.get("llm_ok"):
        print("※ AI 연결이 안 됩니다. OpenAI면 agent/.env 의 OPENAI_API_KEY, Ollama면 Ollama 실행 여부를 확인하세요. "
              "(지금 결과는 캐시에 저장되지 않음)")
    qids = [q["id"] for q in get("/quiz")["questions"]]
    combos = ["".join(c) for c in itertools.product("AB", repeat=len(qids))]
    print(f"추천 방식: {mode} / 총 {len(combos)}가지 조합 (처음 1회만, Ollama는 조합당 10~40초)")

    t_all = time.time()
    sets, place_cnt, pos_cnt, rank_cnt, src_cnt = set(), collections.Counter(), collections.Counter(), collections.Counter(), collections.Counter()
    names, not_ai, times = {}, [], []
    for i, code in enumerate(combos, 1):
        t0 = time.time()
        d = post("/recommend_quiz", {"answers": dict(zip(qids, code))})
        sec = time.time() - t0
        times.append(sec)
        recs = d["recommendations"]
        ids = [r["place_id"] for r in recs]
        for r in recs:
            names[r["place_id"]] = r["place_name"]
        sets.add(frozenset(ids))
        place_cnt.update(ids)
        dbg = d.get("debug", {})
        pos_cnt.update(p for p in dbg.get("picked_positions", []) if p)
        rank_cnt.update(r for r in dbg.get("score_ranks", []) if r)
        src_cnt[d.get("source")] += 1
        if d.get("source") != "ai":
            not_ai.append(code)
        print(f"[{i:3d}/{len(combos)}] {code} {sec:5.1f}초 {d.get('source'):12s} {', '.join(r['place_name'] for r in recs)}")

    total_pos = sum(pos_cnt.values())
    front = sum(v for k, v in pos_cnt.items() if k <= 5)
    lines = [
        "=" * 60,
        f"추천 품질 리포트  (추천 방식: {mode})",
        "=" * 60,
        f"총 소요: {(time.time() - t_all) / 60:.1f}분, 조합당 최대 {max(times):.1f}초",
        f"생성 방식: {dict(src_cnt)}",
        "",
        f"[다양성] 서로 다른 추천 조합: {len(sets)} / {len(combos)}   (기준: 80 이상이면 좋음)",
        f"[다양성] 한 번이라도 추천된 장소: {len(place_cnt)} / 20   (기준: 20)",
        "[장소별 추천 횟수]",
    ]
    for pid, n in sorted(place_cnt.items()):
        lines.append(f"   {pid} {names.get(pid, ''):14s} {n:3d}회 {'#' * (n // 2)}")
    lines.append(f"   추천 안 된 장소: {sorted(set('GIMHAE_%03d' % k for k in range(1, 21)) - set(place_cnt)) or '없음'}")
    if mode == "ai" and total_pos:
        lines += [
            "",
            "[위치 편향] AI가 고른 장소가 섞인 목록의 몇 번째 자리였나 (1~10)",
            "   " + "  ".join(f"{k}번:{pos_cnt.get(k, 0)}" for k in range(1, 11)),
            f"   앞 5자리 비율: {front / total_pos * 100:.0f}%   (편향 없으면 약 50%, 80% 넘으면 위치 편향 강함)",
        ]
    if rank_cnt:
        lines += [
            "",
            "[점수표 순위] 최종 추천이 점수표 몇 위 장소였나",
            "   " + "  ".join(f"{k}위:{rank_cnt.get(k, 0)}" for k in sorted(rank_cnt)),
            "   (1~5위만 있으면 점수표와 같은 결과 = AI 판단 거의 없음)",
        ]
    if not_ai:
        lines.append(f"\nAI 정상 생성이 아닌 조합 {len(not_ai)}개 (캐시 저장 안 됨, 다시 실행하면 재시도): {not_ai}")

    report = "\n".join(lines)
    print("\n" + report)
    out = f"report_{mode}.txt"
    with open(out, "w", encoding="utf-8") as f:
        f.write(report + "\n")
    print(f"\n리포트 저장: {out}")


if __name__ == "__main__":
    main()
