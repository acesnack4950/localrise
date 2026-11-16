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
const IMG = n => `<img src="/static/brand/todeogi_${n}.png?v=tr2" alt="" onerror="this.remove()">`;
const IDLE_RESET_MS = 180000;   // 3분 동안 아무 터치 없으면 자동 초기화

function enterFullscreenIfNeeded() {
  const docEl = document.documentElement;
  if (!document.fullscreenElement && !document.webkitFullscreenElement) {
    const req = docEl.requestFullscreen || docEl.webkitRequestFullscreen;
    if (req) req.call(docEl).catch(() => {});
  }
}

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

function syncFullscreenButtons() {
  const isFs = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
  document.body.classList.toggle("is-fullscreen", isFs);
  if ($("fsBtn")) $("fsBtn").textContent = isFs ? "✕ 전체화면 종료" : "⛶ 전체화면";
  if ($("standbyFsBtn")) $("standbyFsBtn").textContent = isFs ? "✕ 전체화면 종료" : "⛶ 대기화면 전체화면";
}
document.addEventListener("fullscreenchange", syncFullscreenButtons);
document.addEventListener("webkitfullscreenchange", syncFullscreenButtons);

function syncDeviceViewport() {
  const vv = window.visualViewport;
  const vw = vv ? vv.width : window.innerWidth;
  const vh = vv ? vv.height : window.innerHeight;
  document.documentElement.style.setProperty("--app-vw", `${vw}px`);
  document.documentElement.style.setProperty("--app-vh", `${vh}px`);
  const scale = Math.min(vw / 1280, vh / 760);
  document.documentElement.style.fontSize = `${Math.max(11, Math.min(16, 15 * scale)).toFixed(2)}px`;
}
window.addEventListener("resize", syncDeviceViewport);
window.addEventListener("orientationchange", syncDeviceViewport);
if (window.visualViewport) window.visualViewport.addEventListener("resize", syncDeviceViewport);
syncDeviceViewport();

async function api(url, body) {
  const res = await fetch(url, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.status);
  return res.json();
}

let questions = [], answers = {}, idx = 0, places = [], selected = 0, sessionId = "", viewToken = 0, idleTimer = null;
let miles = 0, maxStage = 1, recoPromise = null, recoToken = 0;
let waitInterval = null, tokenSpawnInterval = null, tipIndex = 0, currentTips = [];
const tasks = {};   // place_id -> {task_id, result}
const playedPlaces = new Set(); // 메인 모니터 상영 완료된 장소 ID 기록

function updateStepPills(currentStep) {
  if (currentStep > maxStage) maxStage = currentStep;
  [1, 2, 3].forEach(n => {
    const st = $("stage" + n);
    if (st) st.classList.toggle("active", n === currentStep);
    const pill = $("stepPill" + n);
    if (!pill) return;
    pill.classList.remove("active", "done", "locked");
    if (n > maxStage) {
      pill.classList.add("locked");
    } else if (n === currentStep) {
      pill.classList.add("active");
    } else {
      pill.classList.add("done");
    }
  });
  if ($("fidsStatus")) $("fidsStatus").textContent = currentStep === 1 ? "CHECK-IN" : currentStep === 2 ? "SELECT GATE" : "IN-FLIGHT";
  const runwayBar = $("topRunwayBar");
  if (runwayBar) runwayBar.style.display = currentStep === 1 ? "" : "none";
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
  btn.textContent = btn.classList.contains("liked") ? "💖 응원 완료! 감사합니다" : "👍 LocalRise 응원";
}

let introTimer = null;
let loadingMsgInterval = null;
let kineticSwitchTimer = null;

// ---------- STANDBY / INTRO / FINALE OVERLAYS ----------
function showStandbyScreen() {
  clearTimeout(introTimer);
  clearInterval(loadingMsgInterval);
  clearTimeout(kineticSwitchTimer);
  const overlay = $("standbyOverlay");
  const intro = $("introOverlay");
  const finale = $("finaleOverlay");
  if (intro) intro.classList.add("hidden");
  if (finale) finale.classList.add("hidden");
  if (overlay) overlay.classList.remove("hidden");
  startSurvey();
}

function finishIntroOverlay() {
  clearTimeout(introTimer);
  clearInterval(waitInterval);
  clearInterval(loadingMsgInterval);
  clearTimeout(kineticSwitchTimer);
  const intro = $("introOverlay");
  if (intro && !intro.classList.contains("hidden")) {
    intro.classList.add("hidden");
  }
  // #stage3 안내 보드가 주석 처리된 상태이므로 영상 로딩 완료 후 다른 여행지도 이어서 재생할 수 있도록 STEP 2로 자연스럽게 복귀
  if (!$("stage3")) {
    renderStage2Candidates();
    setStage(2);
    $("headerBubble").textContent = "앞쪽 메인 모니터에서 영상을 감상해 보세요! 다른 추천 여행지 4곳도 자유롭게 눌러 보실 수 있어요.";
    armIdleReset();
    return;
  }
  armIdleReset();
}

function dismissStandbyScreen() {
  const overlay = $("standbyOverlay");
  if (!overlay || overlay.classList.contains("hidden")) return;
  overlay.classList.add("hidden");
  armIdleReset();
}

function showFinaleScreen() {
  const finale = $("finaleOverlay");
  const listEl = $("finaleCourseList");
  if (listEl && places.length) {
    listEl.innerHTML = places.map((p, i) => {
      const prefix = i === selected ? "✈️ " : `${i + 1}. `;
      return `<span class="course-pill">${prefix}${esc(p.place_name)}</span>`;
    }).join("");
  }
  if (finale) finale.classList.remove("hidden");
  armIdleReset();
}

function closeFinaleToStep2() {
  const finale = $("finaleOverlay");
  if (finale) finale.classList.add("hidden");
  navigateStep(2);
  armIdleReset();
}

function finishAndReturnStandby() {
  showStandbyScreen();
}

(function initStandbyOverlay() {
  const overlay = $("standbyOverlay");
  const intro = $("introOverlay");
  const fsBtn = $("standbyFsBtn");
  if (fsBtn) {
    fsBtn.addEventListener("pointerdown", e => {
      e.stopPropagation();
    });
    fsBtn.addEventListener("click", e => {
      e.stopPropagation();
      toggleFullscreen();
    });
  }
  /* [주석 처리 - 영상 로딩 화면(#introOverlay) 터치 시 안내 보드(#stage3)로 이동하는 로직 비활성화 (stage3_inflight_info.archive.html 참고)]
  if (intro) {
    intro.addEventListener("pointerdown", e => {
      e.preventDefault();
      finishIntroOverlay();
    });
  }
  */
  if (!overlay) return;
  overlay.addEventListener("pointerdown", e => {
    if (e.target.closest("#standbyFsBtn")) return;
    e.preventDefault();
    enterFullscreenIfNeeded();
    dismissStandbyScreen();
  });
  overlay.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      enterFullscreenIfNeeded();
      dismissStandbyScreen();
    }
  });
  syncFullscreenButtons();
})();

// ---------- STAGE 1: 셀프 체크인 설문 ----------
async function startSurvey() {
  clearTimeout(idleTimer);
  clearInterval(waitInterval);
  clearInterval(tokenSpawnInterval);
  answers = {}; idx = 0; places = []; viewToken++; miles = 0; maxStage = 1; recoToken++; recoPromise = null;
  playedPlaces.clear();
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
  const steps = Math.max(1, total);
  const slotPos = k => (k / steps) * 100; // k=0(START 0%) ~ k=7(Q7 100%) 활주로 끝까지 동일 좌표계
  const clampedDone = Math.max(0, Math.min(doneCount, total));
  const planePct = slotPos(clampedDone);
  const fillPct = planePct;
  const pctText = Math.round((clampedDone / steps) * 100);

  $("runwayFill").style.width = `${fillPct}%`;
  $("planeIcon").style.left = `${planePct}%`;
  $("runwayPct").textContent = `CHECK-IN ${pctText}% (${clampedDone}/${total})`;
  if ($("qCounter")) $("qCounter").textContent = `QUESTION ${Math.min(clampedDone + 1, total)} / ${total}`;
  const dots = $("runwayDots");
  if (dots) {
    const startCls = clampedDone === 0 ? "curr" : "done";
    const startSpan = `<span class="${startCls}" style="left:${slotPos(0).toFixed(2)}%">START</span>`;
    const qSpans = Array.from({ length: total }, (_, i) => {
      const k = i + 1;
      const cls = k <= clampedDone ? "done" : i === clampedDone ? "curr" : "";
      const leftPct = slotPos(k).toFixed(2);
      return `<span class="${cls}" style="left:${leftPct}%">${k <= clampedDone ? "✓ Q" + k : "Q" + k}</span>`;
    }).join("");
    dots.innerHTML = startSpan + qSpans;
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
  const totalSlots = questions.length || 7;
  const pickedCount = questions.filter(q => answers[q.id]).length;
  $("tagCountText").textContent = `${pickedCount} / ${totalSlots} 태그 발권됨`;

  if (!pickedCount) {
    $("profile").innerHTML = '<div class="luggage-empty">왼쪽 체크인 질문을 선택하면<br>흩어진 취향 데이터가 공항 수하물 태그(IATA)로<br>하나씩 모여 나만의 김해 여행을 완성합니다!</div>';
    return;
  }

  $("profile").innerHTML = Array.from({ length: totalSlots }, (_, i) => {
    const q = questions[i];
    const choice = q && answers[q.id];
    const accent = TAG_ACCENTS[i % TAG_ACCENTS.length];
    if (choice) {
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
    }
    return `<div class="iata-bag-slot" aria-hidden="true"></div>`;
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

// ---------- 리볼버 실린더 3D 연속 회전 & 관성 스와이프 엔진 ----------
let deckPosition = 0;      // 실수형 연속 실린더 위치 (예: 0.0, 1.35, 4.82 ...)
let targetDeckPos = 0;     // 목표 스냅 인덱스
let deckAnimId = null;     // requestAnimationFrame 핸들
let deckLastFrameTime = 0;

function updateCylinderLayout() {
  if (!places.length) return;
  const total = places.length;
  const activeIdx = ((Math.round(deckPosition) % total) + total) % total;
  selected = activeIdx;

  const cards = $("recoBox")?.querySelectorAll(".cabin-window-card");
  if (cards && cards.length) {
    const half = total / 2;
    cards.forEach((card, i) => {
      // 위·아래(상하) 수직 카드 덱 순환 오프셋 (3D 교차 X 현상 없는 깔끔한 세로 셔플)
      let rel = (((i - deckPosition) % total) + total) % total;
      if (rel > half) rel -= total;
      const absRel = Math.abs(rel);

      const yPct = rel * 42;                                      // 카드 중심 간 수직 간격 (%)
      const scale = Math.max(0.84, 1 - absRel * 0.11);            // 원근 스케일 (정면 1.0, 위/아래 0.89)
      const opacity = absRel >= 1.25 ? 0 : Math.max(0, 1 - absRel * 0.62);
      const zIdx = Math.round(100 - absRel * 40);

      card.style.transform = `translate3d(0px, ${yPct.toFixed(2)}%, 0px) scale(${scale.toFixed(3)})`;
      card.style.opacity = opacity.toFixed(3);
      card.style.zIndex = String(zIdx);
      card.style.pointerEvents = absRel >= 1.25 ? "none" : "auto";
      card.classList.toggle("is-center", absRel < 0.35);
    });
  }

  const dots = $("deckDots")?.querySelectorAll(".deck-dot");
  if (dots && dots.length) {
    dots.forEach((dot, i) => dot.classList.toggle("active", i === activeIdx));
  }
}

function stopCylinderAnim() {
  if (deckAnimId !== null) {
    cancelAnimationFrame(deckAnimId);
    deckAnimId = null;
  }
}

function animateCylinderToTarget(now) {
  const dt = Math.min(0.05, Math.max(0.004, (now - deckLastFrameTime) / 1000));
  deckLastFrameTime = now;

  const diff = targetDeckPos - deckPosition;
  if (Math.abs(diff) < 0.0025) {
    deckPosition = targetDeckPos;
    updateCylinderLayout();
    deckAnimId = null;
    return;
  }

  // 리볼버 실린더가 휘리릭 돌다가 목표 슬롯에 부드럽게 감속하며 안착하는 지수 감쇠 곡선
  const decay = 1 - Math.exp(-7.8 * dt);
  deckPosition += diff * decay;
  updateCylinderLayout();
  deckAnimId = requestAnimationFrame(animateCylinderToTarget);
}

function spinDeckBy(deltaSteps) {
  if (!places.length) return;
  targetDeckPos = Math.round(deckPosition + deltaSteps);
  if (deckAnimId === null) {
    deckLastFrameTime = performance.now();
    deckAnimId = requestAnimationFrame(animateCylinderToTarget);
  }
  armIdleReset();
}

function selectDeckCard(newIndex) {
  if (!places.length) return;
  const total = places.length;
  const normTarget = ((newIndex % total) + total) % total;
  const currMod = ((deckPosition % total) + total) % total;
  let shortestDiff = normTarget - currMod;
  if (shortestDiff > total / 2) shortestDiff -= total;
  if (shortestDiff < -total / 2) shortestDiff += total;
  targetDeckPos = Math.round(deckPosition + shortestDiff);
  if (deckAnimId === null) {
    deckLastFrameTime = performance.now();
    deckAnimId = requestAnimationFrame(animateCylinderToTarget);
  }
  armIdleReset();
}

function renderStage2Candidates() {
  const total = places.length;
  stopCylinderAnim();
  deckPosition = selected;
  targetDeckPos = selected;

  $("recoBox").innerHTML = places.map((p, i) => {
    const tagsHtml = (p.matching_tags || []).map(t => `<span class="tag">#${esc(t)}</span>`).join("");
    const isPlayed = playedPlaces.has(p.place_id);
    return `
      <article class="cabin-window-card ${i === selected ? "is-center" : ""}" data-idx="${i}">
        <div class="window-card-top">
          <span class="window-seat-pill">${isPlayed ? "✅ 상영 완료 · " : ""}WINDOW SEAT 0${i + 1} · 추천 0${i + 1} / 0${total}</span>
          <span style="font-size:0.72rem;color:#6f8675;font-weight:800">▲ 위·아래로 밀어 셔플 ▼</span>
        </div>

        <div class="window-card-body">
          <div class="airplane-window-frame">
            <div class="airplane-window-glass">
              ${windowVisual(p, i)}
            </div>
          </div>

          <div class="window-card-info">
            <div class="window-place-header">
              <h3 class="window-place-title">✈️ ${esc(p.place_name)}</h3>
              <span class="window-place-code">PUS · GIMHAE</span>
            </div>

            <div class="window-tags-row">${tagsHtml}</div>

            <div class="window-reason-box">${esc(p.recommend_reason)}</div>
          </div>
        </div>

        <button class="launch-video-btn${isPlayed ? " played" : ""}" type="button" data-launch="${i}">
          ${isPlayed ? "📺 메인 모니터 상영 완료 · 다시 재생하기" : "🛫 이곳으로 비행하시겠습니까? (비행 출발!)"}
        </button>
      </article>
    `;
  }).join("");

  $("deckDots").innerHTML = places.map((_, i) =>
    `<button type="button" class="deck-dot ${i === selected ? "active" : ""}" data-dot="${i}" aria-label="추천지 ${i + 1}"></button>`
  ).join("");

  updateCylinderLayout();

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

  $("prevCardBtn").onclick = () => spinDeckBy(-1);
  $("nextCardBtn").onclick = () => spinDeckBy(1);
}

// 터치(Touch) 및 포인터(Pointer) 상하(위·아래) 드래그 실시간 반응 + 수직 카드 덱 관성 스핀
(function initDeckSwipe() {
  let isDragging = false;
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastY = 0;
  let lastTime = 0;
  let dragStartDeckPos = 0;
  let velocityCardsPerMs = 0; // 밀리초당 회전 카드 속도
  const PIXELS_PER_CARD = 260; // 260px 상하 드래그 당 1칸 회전
  const MIN_SWIPE_PX = 42;     // 가벼운 터치 흔들림 방지 최소 스와이프 거리

  function handleStart(x, y, target) {
    if (!target.closest("#deckViewport")) return;
    if (target.closest("[data-launch]")) return;
    stopCylinderAnim();
    isDragging = true;
    startX = x;
    startY = y;
    lastX = x;
    lastY = y;
    lastTime = performance.now();
    dragStartDeckPos = deckPosition;
    velocityCardsPerMs = 0;
  }

  function handleMove(x, y) {
    if (!isDragging) return;
    const dx = x - startX;
    const dy = y - startY;
    // 위·아래(dy) 드래그를 기본으로 하되, 좌우로 밀어도 반응하도록 주 이동축(primaryDelta) 사용
    const primaryDelta = Math.abs(dy) >= Math.abs(dx) ? dy : dx;
    if (Math.abs(primaryDelta) < 8) return;

    const now = performance.now();
    const dt = Math.max(8, now - lastTime);
    const stepDelta = Math.abs(dy) >= Math.abs(dx) ? (y - lastY) : (x - lastX);
    const instVel = (-stepDelta / PIXELS_PER_CARD) / dt; // 위로 밀면(+) 다음 창문 방향으로 회전
    velocityCardsPerMs = velocityCardsPerMs * 0.6 + instVel * 0.4;

    lastX = x;
    lastY = y;
    lastTime = now;

    // 손가락 상하 이동 거리만큼 실시간으로 세로 덱 회전
    deckPosition = dragStartDeckPos - primaryDelta / PIXELS_PER_CARD;
    updateCylinderLayout();
  }

  function handleEnd() {
    if (!isDragging) return;
    isDragging = false;
    const totalDx = lastX - startX;
    const totalDy = lastY - startY;
    const totalDelta = Math.abs(totalDy) >= Math.abs(totalDx) ? totalDy : totalDx;
    const elapsedSinceMove = performance.now() - lastTime;
    const rawVel = (elapsedSinceMove < 80 ? velocityCardsPerMs * 1000 : 0);

    // 일반 스와이프는 정확히 1칸씩 넘어가고, 빠르게 세게 튕겼을 때만 2~4칸 회전
    const effectiveVel = Math.abs(rawVel) < 1.35 ? 0 : rawVel;
    const momentumCards = Math.max(-4, Math.min(4, effectiveVel * 0.22));
    let nextTarget = Math.round(deckPosition + momentumCards);

    if (nextTarget === Math.round(dragStartDeckPos) && Math.abs(totalDelta) >= MIN_SWIPE_PX) {
      nextTarget = Math.round(dragStartDeckPos) + (totalDelta < 0 ? 1 : -1);
    }

    targetDeckPos = nextTarget;
    deckLastFrameTime = performance.now();
    deckAnimId = requestAnimationFrame(animateCylinderToTarget);
    armIdleReset();
  }

  // 모바일/태블릿 터치 이벤트 (덱 영역 내 상하 스와이프 시 화면 스크롤 방지)
  document.addEventListener("touchstart", e => {
    if (!e.touches.length) return;
    handleStart(e.touches[0].clientX, e.touches[0].clientY, e.target);
  }, { passive: true });

  document.addEventListener("touchmove", e => {
    if (!isDragging || !e.touches.length) return;
    e.preventDefault();
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
  if ($("hudAlt")) $("hudAlt").textContent = `ALTITUDE · ${(10500 + Math.min(miles, 4500)).toLocaleString()} FT`;
  if ($("hudSpeed")) $("hudSpeed").textContent = `SPEED · ${780 + Math.min(Math.round(miles / 5), 240)} KM/H`;
  const jet = $("flyingJet");
  if (jet) {
    jet.classList.remove("boost");
    void jet.offsetWidth;
    jet.classList.add("boost");
  }
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

function buildLoadingRotationSteps(p) {
  const sentences = String(p.recommend_reason || "")
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean);
  const tags = (p.matching_tags || []).slice(0, 3).map(t => `#${t}`).join(" ");
  return [
    {
      headlineHtml: `&ldquo;검색은 줄이고, <span>설렘만 남기다.</span>&rdquo;`,
      subHtml: `잘 알려지지 않은 김해의 숨겨진 매력 속에서, 오직 <b>당신만을 위한 '${esc(p.place_name)}' 여행 영상</b>을 깨우고 있습니다.`,
      stageTag: `STEP 01 · 맞춤 여정 분석`,
      flapText: sentences[0] || `'${p.place_name}'의 숨은 풍경과 추천 코스를 불러오는 중입니다.`,
      hintText: `🎬 '${p.place_name}' AI 여행 영상을 생성 중입니다... 완료 즉시 앞쪽 메인 모니터에 상영됩니다!`
    },
    {
      headlineHtml: `&ldquo;스쳐 지나가던 지역이, <span>특별한 목적지로.</span>&rdquo;`,
      subHtml: tags
        ? `선택하신 취향 키워드(<b>${esc(tags)}</b>)와 가장 깊이 맞닿은 <b>${esc(p.place_name)}</b>의 장면을 담고 있습니다.`
        : `잘 알려지지 않은 김해의 구석구석에서 <b>${esc(p.place_name)}</b>만의 고유한 순간을 엮고 있습니다.`,
      stageTag: `STEP 02 · 추천 이유 01`,
      flapText: sentences[1] || sentences[0] || `'${p.place_name}' 맞춤형 비행 장면을 렌더링하고 있습니다.`,
      hintText: `✈️ 기장 토더기가 '${p.place_name}' 상공의 시선을 영상으로 다듬고 있어요...`
    },
    {
      headlineHtml: `&ldquo;흩어진 데이터를 모아, <span>당신만의 여행을 완성하다.</span>&rdquo;`,
      subHtml: `숨겨진 관광지의 생생한 이야기에 <b>${esc(p.place_name)}</b>만의 다채로운 매력을 더하고 있습니다.`,
      stageTag: `STEP 03 · 추천 이유 02`,
      flapText: sentences[2] || sentences[1] || `흩어진 데이터를 모아, 당신만의 김해 여행을 완성하고 있습니다.`,
      hintText: `🎥 고화질 AI 여행 영상 송출을 준비하는 중입니다... 잠시만 기다려 주세요!`
    },
    {
      headlineHtml: `&ldquo;잠시 후, <span>나만의 김해가 펼쳐집니다.</span>&rdquo;`,
      subHtml: `곧 <b>앞쪽 메인 모니터</b>에서 기장 토더기와 함께하는 <b>${esc(p.place_name)}</b> 비행이 시작됩니다!`,
      stageTag: `STEP 04 · 메인 모니터 송출`,
      flapText: `잠시 후 앞쪽 메인 모니터에서 '${p.place_name}' 영상이 상영됩니다!`,
      hintText: `📺 곧 앞쪽의 전용 전시 모니터에서 영상이 시작됩니다!`
    }
  ];
}

function renderKineticMessage(stageTag, messageText, placeName, animate) {
  const pillEl = $("introStepPill");
  const lineEl = $("introKineticLine");
  if (!lineEl) return;

  const words = String(messageText || "").trim().split(/\s+/).filter(Boolean);
  const paintKinetic = () => {
    if (pillEl) {
      pillEl.textContent = `✦ ${stageTag}`;
      pillEl.classList.remove("text-switching");
    }
    lineEl.innerHTML = words.map((w, i) => {
      const isHighlight = (placeName && w.includes(placeName)) || w.startsWith("#") || /(김해|완료|상영|매력|풍경|여행|특별)/.test(w);
      return `<span class="k-word-mask"><span class="k-word${isHighlight ? " highlight" : ""}" style="animation-delay:${i * 32}ms">${esc(w)}</span></span>`;
    }).join("");
    lineEl.classList.remove("text-switching");
  };

  if (!animate) {
    paintKinetic();
    return;
  }

  if (pillEl) pillEl.classList.add("text-switching");
  lineEl.classList.add("text-switching");
  clearTimeout(kineticSwitchTimer);
  kineticSwitchTimer = setTimeout(paintKinetic, 210);
}

function applyLoadingStep(stepObj, placeName, animate) {
  const headline = $("introHeadline");
  const sub = $("introSubcopy");
  const hint = $("introSkipHint");
  renderKineticMessage(stepObj.stageTag, stepObj.flapText, placeName, animate);

  // 상단 헤드라인·서브카피·하단 힌트는 초기 1회만 세팅하고 고정하여 화면 전체가 깜빡이는 느낌 제거
  if (!animate) {
    if (headline) headline.innerHTML = stepObj.headlineHtml;
    if (sub) sub.innerHTML = stepObj.subHtml;
    if (hint) hint.textContent = stepObj.hintText;
  }
}

async function startInflightVideoStage(p) {
  const token = ++viewToken;
  clearInterval(waitInterval);
  clearInterval(tokenSpawnInterval);
  clearTimeout(introTimer);
  clearInterval(loadingMsgInterval);
  clearTimeout(kineticSwitchTimer);
  setStage(3);
  armIdleReset();

  $("headerBubble").textContent = `기장 토더기가 '${p.place_name}' 맞춤형 여행 영상을 준비하고 있어요! 앞쪽 메인 모니터를 주목해 주세요.`;
  if ($("inflightTitle")) $("inflightTitle").textContent = `${p.place_name} 맞춤형 여행 영상 준비 중`;
  if ($("hudRoute")) $("hudRoute").textContent = `ROUTE · KWJ ➔ PUS`;

  // STEP 3 진입 시 영상이 생성되기 전까지 LocalRise 브랜드 로딩 화면(#introOverlay) + SANKOU! 키네틱 문구 로테이션 표시
  const intro = $("introOverlay");
  const introBar = $("introProgressBar");
  const introBadge = $("introBadge");
  const introHint = $("introSkipHint");
  if (introBadge) introBadge.textContent = `✈️ AI VIDEO RENDERING · ${p.place_name}`;
  if (intro) {
    intro.classList.remove("hidden");
    if (introBar) {
      introBar.style.transition = "none";
      introBar.style.width = "8%";
    }
  }

  const rotationSteps = buildLoadingRotationSteps(p);
  let rotIdx = 0;
  applyLoadingStep(rotationSteps[0], p.place_name, false);

  loadingMsgInterval = setInterval(() => {
    if (token !== viewToken) { clearInterval(loadingMsgInterval); return; }
    rotIdx = (rotIdx + 1) % rotationSteps.length;
    applyLoadingStep(rotationSteps[rotIdx], p.place_name, true);
  }, 2400);

  /* [주석 처리 - 안내 보드(#stage3) 관련 마일리지·매거진·모니터 보드 UI 바인딩 (stage3_inflight_info.archive.html 분리 보관)]
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

  // 모니터 상태 및 60초 비행 카운트다운 게이지 시작
  const tvBadge = $("tvStatusBadge");
  tvBadge.classList.remove("ready");
  tvBadge.textContent = "📡 MAIN MONITOR · 영상 생성 및 송출 준비 중";
  $("tvHeadline").textContent = "앞쪽의 전용 모니터를 주목해 주세요!";
  $("tvSubtext").innerHTML = `기장 토더기가 <b>${esc(p.place_name)}</b>의 생생한 여행 풍경을 준비하고 있습니다.<br>생성이 완료되는 즉시 <b>앞쪽 메인 모니터</b>에서 나만의 김해 여행이 펼쳐집니다.`;
  */

  const startedAt = performance.now();
  const MIN_SHOWCASE_MS = 6800; // 캐시 응답이 즉시 와도 공항 플립보드 순환 문구를 충분히 감상할 시간 확보
  let elapsed = 0;
  const maxSeconds = 60;
  let videoReady = false;

  const updateTimerUI = () => {
    const pct = (videoReady && performance.now() - startedAt >= MIN_SHOWCASE_MS)
      ? 100
      : Math.min(96, Math.max(8, Math.round(((elapsed + 0.6) / 7.5) * 90)));
    if (introBar) {
      introBar.style.transition = "width 0.9s ease";
      introBar.style.width = `${pct}%`;
    }
    /* [주석 처리 - 안내 보드(#stage3) 카운트다운 & 마일리지 게이지]
    const remain = Math.max(0, maxSeconds - elapsed);
    $("renderBarFill").style.width = `${pct}%`;
    $("renderPctText").textContent = `${pct}%`;
    $("countdownPill").textContent = videoReady
      ? `✅ 영상 준비 완료! · 누적 마일리지 ${miles.toLocaleString()} M`
      : `⏱ 영상 생성 중 (약 ${remain}초) · 마일리지 ${miles.toLocaleString()} M`;
    if (!videoReady) {
      $("renderStatusText").textContent = `🎬 '${p.place_name}' AI 맞춤 여행 영상을 생성하여 메인 모니터로 전송하고 있습니다... (${pct}%)`;
    }
    */
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
      playedPlaces.add(p.place_id);
      const waitRemaining = Math.max(0, MIN_SHOWCASE_MS - (performance.now() - startedAt));
      clearTimeout(introTimer);
      introTimer = setTimeout(() => {
        if (token !== viewToken) return;
        clearInterval(loadingMsgInterval);
        updateTimerUI();
        renderKineticMessage("ARRIVAL READY · 상영 준비 완료", `'${p.place_name}' 영상 준비 완료! 앞쪽 메인 모니터를 확인해 주세요!`, p.place_name, true);
        if (introHint) {
          introHint.textContent = `🎉 '${p.place_name}' 영상 생성 완료! 지금 앞쪽 메인 모니터에서 영상을 확인해 주세요!`;
        }
        setTimeout(() => {
          if (token === viewToken) finishIntroOverlay();
        }, 1400);
      }, waitRemaining);

      /* [주석 처리 - 안내 보드(#stage3) 완료 상태 텍스트]
      $("renderStatusText").textContent = `🎉 '${p.place_name}' 영상 준비 완료! 지금 앞쪽 메인 모니터를 확인해 주세요!`;
      tvBadge.classList.add("ready");
      tvBadge.textContent = "✅ MAIN MONITOR · 여행 풍경 상영 중";
      $("tvHeadline").textContent = `🎬 '${p.place_name}' 영상이 상영 중입니다!`;
      $("tvSubtext").innerHTML = `지금 고개를 들어 <b>앞쪽의 전시 모니터</b>에서 토더기가 여행하는 모습을 감상해 보세요!<br>다른 여행지도 떠나보고 싶다면 아래 버튼으로 언제든 이동할 수 있습니다.`;
      */
    } else {
      const waitRemaining = Math.max(0, MIN_SHOWCASE_MS - (performance.now() - startedAt));
      clearTimeout(introTimer);
      introTimer = setTimeout(() => {
        if (token !== viewToken) return;
        if (introHint) {
          introHint.textContent = `📺 앞쪽 메인 모니터에서 '${p.place_name}' 여행 안내가 준비되고 있습니다.`;
        }
        setTimeout(() => {
          if (token === viewToken) finishIntroOverlay();
        }, 1400);
      }, waitRemaining);
    }
  } catch (e) {
    // 네트워크·서버 지연 시에도 관람객 체험 흐름 유지
    clearTimeout(introTimer);
    introTimer = setTimeout(() => {
      if (token === viewToken) finishIntroOverlay();
    }, 3500);
  }
}

function armIdleReset() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(showStandbyScreen, IDLE_RESET_MS);
}
document.addEventListener("pointerdown", () => {
  const overlay = $("standbyOverlay");
  if (overlay && overlay.classList.contains("hidden")) armIdleReset();
});

startSurvey();
