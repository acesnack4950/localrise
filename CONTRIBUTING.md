# 팀 작업 규칙 (처음이면 이것만 읽으세요)

## 한 줄 요약
> **main에 직접 올리지 않는다. 이슈 → 브랜치 → PR → 팀장 확인 → 합치기.**

---

## 0. 처음 한 번만
```bash
git clone https://github.com/acesnack4950/localrise.git
cd localrise
cp .env.example .env     # 비밀값은 .env에만 적기 (GitHub에 안 올라감)
```

## 1. 할 일 고르기
- GitHub **Projects 보드**에서 내 이름이 붙은 이슈 확인
- 없으면 **Issues → New issue**로 만들고 팀장에게 슬랙으로 알리기
- 이슈 번호 기억하기 (예: `#7`)

## 2. 작업 시작 (매번)
```bash
git switch main
git pull                          # 최신 받기 (꼭!)
git switch -c feat/7-quiz-page    # 브랜치 이름: 종류/이슈번호-짧은설명
```

| 종류 | 언제 |
|---|---|
| `feat/` | 새 기능 |
| `fix/` | 버그 수정 |
| `docs/` | 문서 |
| `chore/` | 설정·정리 |

## 3. 저장하고 올리기
```bash
git status                        # 뭐가 바뀌었는지 먼저 확인
git add 파일이름
git commit -m "성향 문항 화면 추가 (#7)"   # 무엇을 했는지 + 이슈 번호
git push -u origin feat/7-quiz-page
```

## 4. PR 만들기
1. GitHub에서 **Compare & pull request**
2. `base: main ← compare: 내 브랜치` 확인
3. 체크리스트 채우고, 설명에 `Closes #7`
4. **Reviewers**에 팀장 지정 → Create

## 5. 합쳐진 뒤
```bash
git switch main
git pull
git branch -d feat/7-quiz-page
```

---

## 🚫 절대 하지 말 것
- API 키·토큰을 코드, 이슈, PR, 커밋 메시지에 쓰기 → **`.env`에만**
- `.safetensors` 모델, 생성 영상, 데이터셋 올리기 → **공유 드라이브에 두고 링크만**
- `main`에 직접 push
- 모르는 에러를 무시하고 넘어가기 → 슬랙에 에러 메시지 그대로 붙여서 질문

## 💬 막히면
슬랙에 **① 무엇을 하려다 ② 어떤 명령어를 쳤고 ③ 어떤 메시지가 나왔는지** 그대로 붙여 주세요.
