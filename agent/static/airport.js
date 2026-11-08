/**
 * TEAM LocalRise · LocalRise Airlines 키오스크 스크립트
 * - 내부 로직 설명(백엔드 API, 프리페칭, 폴링 등)은 코드 주석으로만 관리하며,
 *   관람객이 보는 UI/UX 문구에는 기술 용어를 노출하지 않고 공항·비행 컨셉 문구만 표시합니다.
 */

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const COLORS = ["#1f6e50", "#2b6cb0", "#c47f2c", "#6b46c1", "#b83280"];
const TAG_ACCENTS = ["#dc2626", "#d97706", "#059669", "#2563eb", "#7c3aed", "#db2777", "#0d9488"];
const SKY_ITEMS = [
  { icon: "👑", label: "금관가야 왕관 +100M" },
  { icon: "🦆", label: "기장 토더기 +150M" },
  { icon: "🏺", label: "가야 토기 +100M" },
  { icon: "⭐", label: "김해 별빛 +120M" },
  { icon: "🍓", label: "김해 산딸기 +100M" }
];
const DEBUG = new URLSearchParams(location.search).has("debug");
const IMG = n => `<img src="/static/brand/todeogi_${n}.png" alt="" onerror="this.remove()">`;
const IDLE_RESET_MS = 180000;   // 3분 동안 아무 터치 없으면 자동 초기화

function toggleFullscreen() {
  const docEl = document.documentElement;
  if (!document.fullscreenElement && !document.webkitFullscreenElement) {
    const req = docEl.requestFullscreen || docEl.webkitRequestFullscreen;
    if (req) req.call(docEl).catch(() => {});
  } else {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (exit) exit.call(document).catch(() => {});
  }
}
document.addEventListener("fullscreenchange", () => {
  $("fsBtn").textContent = document.fullscreenElement ? "✕ 전체화면 종료" : "⛶ 전체 화면";
});

async function api(url, body) {
  const res = await fetch(url, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.status);
  return res.json();
}

let questions = [], answers = {}, idx = 0, places = [], selected = 0, sessionId = "", viewToken = 0, idleTimer = null;
let miles = 0, maxStage = 1, recoPromise = null, recoToken = 0;
let waitInterval = null, tokenSpawnInterval = null, tipIndex = 0, currentTips = [];
const tasks = {};   // place_id -> {task_id, result}

function updateStepPills(currentStep) {
  if (currentStep > maxStage) maxStage = currentStep;
  [1, 2, 3].forEach(n => {
    $("stage" + n).classList.toggle("active", n === currentStep);
    const pill = $("stepPill" + n);
    pill.classList.remove("active", "done", "locked");
    if (n > maxStage) {
      pill.classList.add("locked");
    } else if (n === currentStep) {
      pill.classList.add("active");
    } else {
      pill.classList.add("done");
    }
  });
  $("fidsStatus").textContent = currentStep === 1 ? "CHECK-IN" : currentStep === 2 ? "SELECT GATE" : "IN-FLIGHT";
}

function setStage(step) {
  updateStepPills(step);
}

// 완료된 단계까지만 상단 탭 터치로 이동 허용 (미완료 상위 단계 진입 차단)
function navigateStep(targetStep) {
  if (targetStep > maxStage) return;
  if (targetStep === 1) {
    setStage(1);
    $("headerBubble").textContent = Object.keys(answers).length === questions.length
      ? "7개의 수하물 태그가 모두 발권되어 있습니다. 상단 STEP 버튼으로 완료된 단계 간 이동이 가능해요!"
      : "승객님 환영합니다! 기장 토더기가 김해 맞춤 비행 코스를 안내해 드릴게요 ✈️";
  } else if (targetStep === 2) {
    setStage(2);
    $("headerBubble").textContent = "보딩패스와 김해 추천 여행지 5곳입니다! 가장 가보고 싶은 곳을 골라 비행 출발을 눌러보세요.";
  } else if (targetStep === 3) {
    setStage(3);
    $("headerBubble").textContent = "목적지 도착 전까지 하늘의 아이템을 터치하며 비행을 즐겨보세요! 앞쪽 메인 모니터에 여행 풍경이 펼쳐집니다.";
  }
}

function toggleCheer(btn) {
  btn.classList.toggle("liked");
  btn.textContent = btn.classList.contains("liked") ? "💖 응원 완료! 감사합니다" : "👍 응원하기";
}

// ---------- STAGE 1: 셀프 체크인 설문 ----------
async function startSurvey() {
  clearTimeout(idleTimer);
  clearInterval(waitInterval);
  clearInterval(tokenSpawnInterval);
  answers = {}; idx = 0; places = []; viewToken++; miles = 0; maxStage = 1; recoToken++; recoPromise = null;
  for (const k in tasks) delete tasks[k];
  sessionId = "s_" + Math.random().toString(36).slice(2, 10);
  setStage(1);
  $("headerBubble").textContent = "승객님 환영합니다! 기장 토더기가 김해 맞춤 비행 코스를 안내해 드릴게요 ✈️";
  renderProfileTags();
  try {
    if (!questions.length) questions = (await api("/quiz")).questions;
    renderQuestion();
  } catch (e) {
    $("surveyBox").innerHTML = `<div style="text-align:center;padding:40px 10px;color:var(--muted)">체크인 질문을 불러오지 못했어요.<br>잠시 후 다시 시도해 주세요.</div><button class="restart-btn" onclick="startSurvey()">다시 시도</button>`;
  }
}

function updateRunway(doneCount, total) {
  const pct = Math.round((doneCount / total) * 100);
  $("runwayFill").style.width = `${pct}%`;
  $("planeIcon").style.left = `${Math.max(4, Math.min(96, pct))}%`;
  $("runwayPct").textContent = `CHECK-IN ${pct}%`;
  $("qCounter").textContent = `${Math.min(doneCount + 1, total)} / ${total}`;
  const dots = $("runwayDots");
  if (dots) {
    dots.innerHTML = Array.from({ length: total }, (_, i) => {
      const cls = i < doneCount ? "done" : i === doneCount ? "curr" : "";
      return `<span class="${cls}">${i < doneCount ? "✓" : "Q" + (i + 1)}</span>`;
    }).join("");
  }
}

function renderQuestion() {
  const q = questions[idx];
  updateRunway(idx, questions.length);
  $("surveyBox").innerHTML = `
    <div class="q-card">
      ${IMG("curious")}
      <div>
        <div class="q-num">CHECK-IN QUESTION 0${idx + 1}</div>
        <div class="q-text">${esc(q.text)}</div>
      </div>
    </div>
    <div class="opts-grid">
      <button class="opt-btn" data-v="A">
        <span class="opt-gate">GATE A</span>
        <div class="opt-label">${esc(q.options.A.label)}</div>
        <div class="opt-sub">${esc(q.options.A.phrase || "클릭하여 수하물 태그 부착")}</div>
      </button>
      <button class="opt-btn" data-v="B">
        <span class="opt-gate">GATE B</span>
        <div class="opt-label">${esc(q.options.B.label)}</div>
        <div class="opt-sub">${esc(q.options.B.phrase || "클릭하여 수하물 태그 부착")}</div>
      </button>
    </div>
    ${idx ? '<button class="back-btn" id="back">← 이전 질문 다시 고르기</button>' : ""}
  `;
  $("surveyBox").querySelectorAll(".opt-btn").forEach(b => b.onclick = () => pick(q.id, b.dataset.v));
  if (idx) $("back").onclick = () => { idx--; delete answers[questions[idx].id]; renderProfileTags(); renderQuestion(); };
}

function renderProfileTags() {
  const picked = questions.filter(q => answers[q.id]);
  $("tagCountText").textContent = `${picked.length} / ${questions.length || 7} 태그 발권됨`;
  if (!picked.length) {
    $("profile").innerHTML = '<div class="luggage-empty">왼쪽 체크인 질문을 선택하면<br>실제 공항 수하물 태그(IATA 규격) 7개가<br>파도처럼 일렁이며 한눈에 부착됩니다!</div>';
    return;
  }
  $("profile").innerHTML = picked.map((q, i) => {
    const choice = answers[q.id];
    const accent = TAG_ACCENTS[i % TAG_ACCENTS.length];
    const serial = `016-G${i + 1}${choice}`;
    return `
      <div class="iata-bag-tag" style="--tag-accent:${accent}; animation-delay: 0s, ${i * 0.18}s">
        <div class="iata-hole-strip">
          <span class="iata-grommet"></span>
        </div>
        <div class="iata-body">
          <div class="iata-meta">
            <span><b>KWJ</b> ➔ <b>PUS</b></span>
            <span>GATE ${choice} · 0${i + 1}</span>
          </div>
          <div class="iata-label">#${esc(q.options[choice].label)}</div>
        </div>
        <div class="iata-barcode-stub">
          <div class="iata-barcode-lines"></div>
          <span class="iata-serial">${serial}</span>
        </div>
      </div>
    `;
  }).join("");
}

function pick(id, v) {
  answers[id] = v;
  idx++;
  renderProfileTags();
  if (idx < questions.length) {
    renderQuestion();
  } else {
    updateRunway(questions.length, questions.length);
    $("qCounter").textContent = `7 / 7 완료`;
    $("headerBubble").textContent = "7개의 수하물 태그가 모두 부착되었습니다! 오른쪽 태그를 확인하시고 보딩패스를 발권해 보세요.";
    // 7번째 문항 선택 완료 시 추천 후보지 5곳을 미리 요청해 두어 Step 2 전환 속도를 높인다.
    prefetchRecommendations();
    renderCheckinComplete();
  }
}

function prefetchRecommendations() {
  const myToken = ++recoToken;
  const t0 = performance.now();
  recoPromise = (async () => {
    const d = await api("/recommend_quiz", { answers });
    if (myToken !== recoToken) return null;
    places = d.recommendations;
    const pickedLabels = questions.filter(q => answers[q.id]).map(q => q.options[answers[q.id]].label);
    $("bpPersona").textContent = d.persona_summary;
    $("bpTags").innerHTML = pickedLabels.map(lbl => `<span class="tag">#${esc(lbl)}</span>`).join("");
    $("bpSession").textContent = sessionId.toUpperCase();
    $("restart").onclick = startSurvey;
    if (DEBUG) {
      $("debug").hidden = false;
      $("debug").textContent = `생성 방식: ${d.source} · 응답 ${((performance.now() - t0) / 1000).toFixed(1)}초 · 답: ${Object.values(answers).join("")}`;
    }
    return d;
  })();
}

function renderCheckinComplete() {
  $("surveyBox").innerHTML = `
    <div class="checkin-complete-box">
      <span class="checkin-complete-badge">✓ ALL 7 BAGGAGE TAGS CHECKED</span>
      <h3>7가지 취향 수하물 태그가 모두 발권되었습니다!</h3>
      <p>오른쪽 수하물 보드에서 내가 고른 <b>7개의 IATA 러기지 태그</b>를 한눈에 확인해 보세요.<br>아래 버튼을 누르면 나만의 <b>보딩패스와 김해 맞춤 여행지 5곳</b>을 만나보실 수 있습니다.</p>
      <button class="board-now-btn" id="goStage2Btn" type="button">
        <span>🎫 보딩패스 발권 & 김해 추천 여행지 5곳 보기</span>
      </button>
    </div>
    <button class="back-btn" id="backFromComplete">← 7번 질문 다시 고르기</button>
  `;
  $("goStage2Btn").onclick = async () => {
    const btn = $("goStage2Btn");
    btn.disabled = true;
    btn.innerHTML = "<span>⏳ 승객님께 꼭 맞는 김해 여행지 5곳을 준비하고 있습니다...</span>";
    try {
      if (!places.length && recoPromise) await recoPromise;
      if (!places.length) throw new Error("추천 결과 없음");
      selected = 0;
      renderStage2Candidates();
      setStage(2);
      $("headerBubble").textContent = "보딩패스가 발권되었습니다! 추천 여행지 5곳 중 가장 마음에 드는 곳으로 비행 출발을 눌러 주세요.";
      armIdleReset();
    } catch (e) {
      btn.disabled = false;
      btn.innerHTML = "<span>🔄 다시 시도하기</span>";
    }
  };
  $("backFromComplete").onclick = () => {
    recoToken++;
    recoPromise = null;
    maxStage = 1;
    idx = questions.length - 1;
    delete answers[questions[idx].id];
    updateStepPills(1);
    renderProfileTags();
    renderQuestion();
  };
}

// ---------- STAGE 2: 비행기 창문 뷰 5개 추천지 셔플 카드 덱 ----------
const PLACE_THEMES = {
  GIMHAE_001: { grad: "linear-gradient(135deg, #1b4d3e 0%, #2d7a5e 60%, #f5b324 100%)", icon: "👑", label: "금관가야 시조 왕릉 공원" },
  GIMHAE_002: { grad: "linear-gradient(135deg, #2d3a6e 0%, #525799 60%, #e8a598 100%)", icon: "🏛️", label: "아유타국 왕비 설화 능역" },
  GIMHAE_003: { grad: "linear-gradient(135deg, #3b2d54 0%, #7c5295 55%, #f29f67 100%)", icon: "🌄", label: "금관가야 고분군 구릉 산책" },
  GIMHAE_004: { grad: "linear-gradient(135deg, #1a2a3a 0%, #2c4c6b 65%, #8ca8be 100%)", icon: "🏺", label: "가야 철기·문화유산 박물관" },
  GIMHAE_005: { grad: "linear-gradient(135deg, #245943 0%, #438a68 60%, #98d8b6 100%)", icon: "🌿", label: "가야 시대 생활 유적 공원" },
  GIMHAE_006: { grad: "linear-gradient(135deg, #7c3848 0%, #c85a53 55%, #f5b324 100%)", icon: "🎨", label: "도자·건축 돔하우스 미술관" },
  GIMHAE_007: { grad: "linear-gradient(135deg, #6e2639 0%, #b84242 55%, #f5b324 100%)", icon: "🏹", label: "가야 왕궁 체험 테마파크" },
  GIMHAE_008: { grad: "linear-gradient(135deg, #12355b 0%, #26679e 55%, #66d9e8 100%)", icon: "⛲", label: "호수 분수 & 야경 산책 공원" },
  GIMHAE_009: { grad: "linear-gradient(135deg, #1e3c58 0%, #3d7399 55%, #f4a261 100%)", icon: "🏯", label: "김해평야 전망 산성 성곽길" },
  GIMHAE_010: { grad: "linear-gradient(135deg, #1b4332 0%, #2d6a4f 60%, #95d5b2 100%)", icon: "⛰️", label: "신어산 숲길 고즈넉한 산사" },
  GIMHAE_011: { grad: "linear-gradient(135deg, #6a1b4d 0%, #c93b76 55%, #ff9ebb 100%)", icon: "🌸", label: "신어산 진분홍 철쭉 군락지" },
  GIMHAE_012: { grad: "linear-gradient(135deg, #1d3557 0%, #457b9d 55%, #e63946 100%)", icon: "🚂", label: "낙동강변 레일바이크 & 와인동굴" },
  GIMHAE_013: { grad: "linear-gradient(135deg, #1f4e46 0%, #3c8dad 60%, #a8dadc 100%)", icon: "🦢", label: "화포천 습지 갈대숲 생태공원" },
  GIMHAE_014: { grad: "linear-gradient(135deg, #0b132b 0%, #1c2541 55%, #f5b324 100%)", icon: "🔭", label: "밤하늘 별자리 관측 천문대" },
  GIMHAE_015: { grad: "linear-gradient(135deg, #005082 0%, #00a8cc 60%, #80ffdb 100%)", icon: "🌊", label: "시원한 파도풀 워터테마파크" },
  GIMHAE_016: { grad: "linear-gradient(135deg, #134e5e 0%, #2a9d8f 60%, #a8e6cf 100%)", icon: "🏞️", label: "청량한 숲그늘 대청계곡" },
  GIMHAE_017: { grad: "linear-gradient(135deg, #3d2c8d 0%, #7c5295 55%, #f5b324 100%)", icon: "🏮", label: "원도심 가야테마 미식 거리" },
  GIMHAE_018: { grad: "linear-gradient(135deg, #1e4d2b 0%, #3a7d44 55%, #9fd3c7 100%)", icon: "⛰️", label: "낙동강 파노라마 조망 무척산" },
  GIMHAE_019: { grad: "linear-gradient(135deg, #2b193d 0%, #723d46 55%, #f5b324 100%)", icon: "🎡", label: "활기찬 진영 바람개비 야시장" },
  GIMHAE_020: { grad: "linear-gradient(135deg, #2f3e46 0%, #52796f 60%, #cad2c5 100%)", icon: "🪨", label: "봉화산 암벽 고려시대 마애불" }
};

function windowVisual(p, i) {
  const theme = PLACE_THEMES[p.place_id] || {
    grad: `linear-gradient(135deg, ${COLORS[i % 5]} 0%, #0f2537 100%)`,
    icon: "✈️",
    label: "김해 대표 추천 명소"
  };
  if (p.image_url) {
    return `<img src="${esc(p.image_url)}" alt="${esc(p.place_name)}">`;
  }
  return `
    <div class="window-fallback-art" style="background:${theme.grad}">
      <div class="window-fallback-icon">${theme.icon}</div>
      <div style="font-size:1.35rem;font-weight:900;margin-bottom:6px;text-shadow:0 2px 8px rgba(0,0,0,0.35)">${esc(p.place_name)}</div>
      <span class="window-fallback-sub">WINDOW VIEW · ${esc(theme.label)}</span>
    </div>
  `;
}

function getDeckPositionClass(cardIndex, activeIndex, total) {
  const diff = (cardIndex - activeIndex + total) % total;
  if (diff === 0) return "is-center";
  if (diff === 1) return "is-next";
  if (diff === total - 1) return "is-prev";
  if (diff === 2) return "is-far-next";
  return "is-far-prev";
}

function selectDeckCard(newIndex) {
  if (!places.length) return;
  const total = places.length;
  selected = ((newIndex % total) + total) % total;
  const cards = $("recoBox").querySelectorAll(".cabin-window-card");
  cards.forEach((card, i) => {
    card.className = `cabin-window-card ${getDeckPositionClass(i, selected, total)}`;
  });
  const dots = $("deckDots").querySelectorAll(".deck-dot");
  dots.forEach((dot, i) => dot.classList.toggle("active", i === selected));
  armIdleReset();
}

function renderStage2Candidates() {
  const total = places.length;
  $("recoBox").innerHTML = places.map((p, i) => {
    const posClass = getDeckPositionClass(i, selected, total);
    const tagsHtml = (p.matching_tags || []).map(t => `<span class="tag">#${esc(t)}</span>`).join("");
    return `
      <article class="cabin-window-card ${posClass}" data-idx="${i}">
        <div>
          <div class="window-card-top">
            <span class="window-seat-pill">WINDOW SEAT 0${i + 1} · 추천 0${i + 1} / 0${total}</span>
            <span style="font-size:0.76rem;color:#9ec0de;font-weight:700">◀ 스와이프하여 넘기기 ▶</span>
          </div>

          <div class="airplane-window-frame">
            <div class="airplane-window-glass">
              ${windowVisual(p, i)}
            </div>
          </div>

          <div class="window-place-header">
            <h3 class="window-place-title">✈️ ${esc(p.place_name)}</h3>
            <span class="window-place-code">SELECTED DESTINATION</span>
          </div>

          <div class="window-tags-row">${tagsHtml}</div>

          <div class="window-reason-box">${esc(p.recommend_reason)}</div>
        </div>

        <div>
          <p class="window-ask-prompt">✨ 이곳으로 떠나실래요? 창밖의 풍경이 앞쪽 메인 모니터에 펼쳐집니다!</p>
          <button class="launch-video-btn" type="button" data-launch="${i}">
            🛫 이곳으로 비행하시겠습니까? (비행 출발!)
          </button>
        </div>
      </article>
    `;
  }).join("");

  $("deckDots").innerHTML = places.map((_, i) =>
    `<button type="button" class="deck-dot ${i === selected ? "active" : ""}" data-dot="${i}" aria-label="추천지 ${i + 1}"></button>`
  ).join("");

  $("recoBox").querySelectorAll(".cabin-window-card").forEach(card => {
    card.onclick = e => {
      if (e.target.closest("[data-launch]")) return;
      const idxNum = Number(card.dataset.idx);
      if (idxNum !== selected) selectDeckCard(idxNum);
    };
  });

  $("recoBox").querySelectorAll("[data-launch]").forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const idxNum = Number(btn.dataset.launch);
      selected = idxNum;
      selectDeckCard(idxNum);
      startInflightVideoStage(places[idxNum]);
    };
  });

  $("deckDots").querySelectorAll(".deck-dot").forEach(dot => {
    dot.onclick = () => selectDeckCard(Number(dot.dataset.dot));
  });

  $("prevCardBtn").onclick = () => selectDeckCard(selected - 1);
  $("nextCardBtn").onclick = () => selectDeckCard(selected + 1);
}

// 터치(Touch) 및 포인터(Pointer) 드래그 실시간 반응 + 고감도 무한 순환 스와이프 지원
(function initDeckSwipe() {
  let startX = null;
  let startY = null;
  let currentDx = 0;
  let swipedInGesture = false;
  const SWIPE_THRESHOLD = 18; // 가벼운 스와이프에도 즉시 넘어가도록 민감도 대폭 향상

  function applyLiveDrag(dx) {
    const centerCard = $("recoBox")?.querySelector(".cabin-window-card.is-center");
    if (!centerCard) return;
    const clamped = Math.max(-140, Math.min(140, dx));
    const rot = (clamped / 140) * 4.5;
    centerCard.style.transition = "none";
    centerCard.style.transform = `translateX(${clamped * 0.55}px) scale(1) rotate(${rot}deg)`;
  }

  function clearLiveDrag() {
    const cards = $("recoBox")?.querySelectorAll(".cabin-window-card");
    if (!cards) return;
    cards.forEach(c => {
      c.style.transition = "";
      c.style.transform = "";
    });
  }

  function handleStart(x, y, target) {
    if (!target.closest("#deckViewport")) return;
    if (target.closest("[data-launch]")) return;
    startX = x;
    startY = y;
    currentDx = 0;
    swipedInGesture = false;
  }

  function handleMove(x, y) {
    if (startX === null || swipedInGesture) return;
    const dx = x - startX;
    const dy = y - startY;
    if (Math.abs(dx) < Math.abs(dy) && Math.abs(dy) > 25) return;
    currentDx = dx;
    applyLiveDrag(dx);

    // 손가락을 떼기 전이라도 일정 거리(55px) 이상 밀면 즉시 다음/이전 카드로 무한 순환 전환
    if (Math.abs(dx) > 55) {
      swipedInGesture = true;
      clearLiveDrag();
      if (dx < 0) selectDeckCard(selected + 1); // 5번에서 왼쪽으로 밀면 1번으로 즉시 순환
      else selectDeckCard(selected - 1);        // 1번에서 오른쪽으로 밀면 5번으로 즉시 순환
    }
  }

  function handleEnd() {
    if (startX === null) return;
    const dx = currentDx;
    startX = null;
    startY = null;
    currentDx = 0;
    clearLiveDrag();
    if (!swipedInGesture && Math.abs(dx) > SWIPE_THRESHOLD) {
      if (dx < 0) selectDeckCard(selected + 1);
      else selectDeckCard(selected - 1);
    }
    swipedInGesture = false;
  }

  // 모바일/태블릿 터치 이벤트 (브라우저 가로 제스처 가로채기 방지 포함)
  document.addEventListener("touchstart", e => {
    if (!e.touches.length) return;
    handleStart(e.touches[0].clientX, e.touches[0].clientY, e.target);
  }, { passive: true });

  document.addEventListener("touchmove", e => {
    if (startX === null || !e.touches.length) return;
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    if (Math.abs(dx) > Math.abs(dy)) e.preventDefault();
    handleMove(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: false });

  document.addEventListener("touchend", handleEnd, { passive: true });
  document.addEventListener("touchcancel", handleEnd, { passive: true });

  // 마우스/펜 포인터 이벤트 호환
  document.addEventListener("pointerdown", e => {
    if (e.pointerType === "touch") return;
    handleStart(e.clientX, e.clientY, e.target);
  });
  document.addEventListener("pointermove", e => {
    if (e.pointerType === "touch") return;
    handleMove(e.clientX, e.clientY);
  });
  document.addEventListener("pointerup", e => {
    if (e.pointerType === "touch") return;
    handleEnd();
  });
})();

// ---------- STAGE 3: 상공 비행 체험 (내부적으로 최대 60초 영상 생성 요청 및 폴링 수행) ----------
async function ensureTask(p) {
  let t = tasks[p.place_id];
  if (!t) {
    const res = await api("/api/videos", { place_id: p.place_id, session_id: sessionId });
    t = tasks[p.place_id] = { task_id: res.task_id, result: null };
  }
  return t;
}

function triggerJetBoost(bonusMiles) {
  miles += bonusMiles;
  $("hudAlt").textContent = `ALTITUDE · ${(10500 + Math.min(miles, 4500)).toLocaleString()} FT`;
  $("hudSpeed").textContent = `SPEED · ${780 + Math.min(Math.round(miles / 5), 240)} KM/H`;
  const jet = $("flyingJet");
  jet.classList.remove("boost");
  void jet.offsetWidth;
  jet.classList.add("boost");
}

function spawnSkyToken() {
  const layer = $("skyTokenLayer");
  if (!layer || !document.getElementById("stage3").classList.contains("active")) return;
  const item = SKY_ITEMS[Math.floor(Math.random() * SKY_ITEMS.length)];
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "sky-token";
  btn.style.top = `${22 + Math.floor(Math.random() * 58)}%`;
  btn.innerHTML = `${item.icon} <span>${item.label}</span>`;
  btn.onclick = () => {
    btn.remove();
    triggerJetBoost(120);
  };
  btn.addEventListener("animationend", () => btn.remove());
  layer.appendChild(btn);
}

function setupMagazineTips(p) {
  const sentences = String(p.recommend_reason || "")
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean);
  currentTips = sentences.length ? sentences : [p.recommend_reason || "나만의 맞춤 김해 여행지입니다."];
  tipIndex = 0;
  const renderTip = () => {
    $("magStepLabel").textContent = `📖 IN-FLIGHT MAGAZINE · 알고 가면 2배 재밌는 ${p.place_name} 포인트 (${tipIndex + 1}/${currentTips.length})`;
    $("magFactText").textContent = currentTips[tipIndex];
  };
  renderTip();
  $("nextTipBtn").onclick = () => {
    tipIndex = (tipIndex + 1) % currentTips.length;
    renderTip();
    triggerJetBoost(50);
  };
}

async function startInflightVideoStage(p) {
  const token = ++viewToken;
  clearInterval(waitInterval);
  clearInterval(tokenSpawnInterval);
  setStage(3);
  armIdleReset();

  $("headerBubble").textContent = `기장 토더기와 함께 '${p.place_name}' 상공을 비행하고 있어요! 하늘의 아이템을 터치해 마일리지를 모아보세요.`;
  $("inflightTitle").textContent = `${p.place_name} 상공 순항 중`;
  $("hudRoute").textContent = `ROUTE · KWJ ➔ PUS`;

  // 여권 스탬프 초기화
  const stampBtn = $("passportStampBtn");
  stampBtn.classList.remove("stamped");
  stampBtn.textContent = `🛂 여기를 터치해 디지털 김해 여권에 '${p.place_name}' 입국 도장 찍기! (쾅!)`;
  stampBtn.onclick = () => {
    if (!stampBtn.classList.contains("stamped")) {
      stampBtn.classList.add("stamped");
      stampBtn.textContent = `★ GIMHAE PASSPORT STAMPED · ${p.place_name} 방문 승인 완료! (+200M)`;
      triggerJetBoost(200);
    }
  };

  // 취향 키워드 부스트 칩 세팅
  const pickedLabels = questions.filter(q => answers[q.id]).map(q => q.options[answers[q.id]].label);
  $("floatingTags").innerHTML = pickedLabels.map((lbl, i) =>
    `<button class="pop-chip" style="animation-delay:${i * 0.15}s" type="button">✈️ #${esc(lbl)}</button>`
  ).join("");
  $("floatingTags").querySelectorAll(".pop-chip").forEach(chip => {
    chip.onclick = () => {
      if (!chip.classList.contains("popped")) {
        chip.classList.add("popped");
        chip.textContent = "🚀 " + chip.textContent.replace("✈️ ", "");
        triggerJetBoost(100);
      }
    };
  });

  // 기내 매거진 포인트 세팅
  setupMagazineTips(p);

  // 하늘 위 날아다니는 황금 아이템 주기적 스폰
  $("skyTokenLayer").innerHTML = "";
  spawnSkyToken();
  tokenSpawnInterval = setInterval(spawnSkyToken, 2400);

  // 모니터 상태 및 60초 비행 카운트다운 게이지 시작
  const tvBadge = $("tvStatusBadge");
  tvBadge.classList.remove("ready");
  tvBadge.textContent = "📡 MAIN MONITOR · 착륙 및 여행 안내 준비 중";
  $("tvHeadline").textContent = "앞쪽의 전용 모니터를 주목해 주세요!";
  $("tvSubtext").innerHTML = `기장 토더기가 <b>${esc(p.place_name)}</b>의 생생한 여행 풍경을 준비하고 있습니다.<br>착륙과 동시에 <b>앞쪽 메인 모니터</b>에서 나만의 김해 여행이 펼쳐집니다.`;

  let elapsed = 0;
  const maxSeconds = 60;
  let videoReady = false;

  const updateTimerUI = () => {
    const remain = Math.max(0, maxSeconds - elapsed);
    const pct = videoReady ? 100 : Math.min(96, Math.round((elapsed / maxSeconds) * 100));
    $("renderBarFill").style.width = `${pct}%`;
    $("renderPctText").textContent = `${pct}%`;
    $("countdownPill").textContent = videoReady
      ? `✅ 목적지 도착 완료! · 누적 마일리지 ${miles.toLocaleString()} M`
      : `⏱ 도착까지 약 ${remain}초 · 마일리지 ${miles.toLocaleString()} M`;
    if (!videoReady) {
      $("renderStatusText").textContent = elapsed < 20
        ? `✈️ [이륙 및 상승] KWJ를 출발해 '${p.place_name}' 항로로 순항하고 있습니다...`
        : elapsed < 45
        ? `☁️ [안정 순항] 기장 토더기가 '${p.place_name}' 상공의 구름 위를 날고 있습니다...`
        : `🛬 [착륙 준비] 곧 목적지에 도착합니다! 앞쪽 메인 모니터를 확인해 주세요...`;
    }
  };
  updateTimerUI();

  waitInterval = setInterval(() => {
    if (token !== viewToken) { clearInterval(waitInterval); return; }
    elapsed++;
    updateTimerUI();
  }, 1000);

  // 내부 비동기 영상 생성 요청 및 완료 상태 폴링 (최대 60초)
  try {
    const t = await ensureTask(p);
    for (let tries = 0; tries < 30 && !t.result; tries++) {
      const s = await api(`/api/video-status/${t.task_id}`);
      if (s.status === "succeeded") { t.result = s.result; break; }
      if (s.status === "not_ready") break;
      if (token !== viewToken) return;
      await new Promise(r => setTimeout(r, 2000));
    }
    if (token !== viewToken) return;
    if (t.result && (t.result.video_url || t.result.image_url)) {
      videoReady = true;
      updateTimerUI();
      $("renderStatusText").textContent = `🎉 '${p.place_name}' 도착 완료! 지금 앞쪽 메인 모니터를 확인해 주세요!`;
      tvBadge.classList.add("ready");
      tvBadge.textContent = "✅ MAIN MONITOR · 여행 풍경 상영 중";
      $("tvHeadline").textContent = `🎬 '${p.place_name}'에 도착했습니다!`;
      $("tvSubtext").innerHTML = `지금 고개를 들어 <b>앞쪽의 전시 모니터</b>에서 토더기가 여행하는 모습을 감상해 보세요!<br>다른 여행지도 떠나보고 싶다면 상단 <b>STEP 2</b> 탭을 눌러 언제든 이동할 수 있습니다.`;
    }
  } catch (e) {
    // 네트워크·서버 지연 시에도 관람객 비행 체험은 끊김 없이 유지
  }
}

function armIdleReset() { clearTimeout(idleTimer); idleTimer = setTimeout(startSurvey, IDLE_RESET_MS); }
document.addEventListener("pointerdown", () => { if (places.length) armIdleReset(); });

startSurvey();
