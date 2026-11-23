/* LocalRise 태블릿 시연 화면 (김해시보 컨셉) — 초안 v2
   흐름: 시작 → 로고 연출 → 질문 7개 → 김해시보(인쇄 → 추천 5곳) → 잠시만 기다려 주세요(리볼버 5곳 + 영상 진행) → 마무리
   영상은 태블릿이 아니라 옆 모니터(display.html)에서 재생된다.
   API: GET /quiz, POST /recommend_quiz, POST /api/videos/prefetch, POST /api/videos, GET /api/video-status/{task_id}
   ?mock=1 : 서버 없이 예시 데이터로 리허설 (같은 브라우저에서 display.html?mock=1 을 열면 모니터 화면도 따라 움직임)
   ?debug=1: 왼쪽 아래 상태 표시 */
const qs = new URLSearchParams(location.search);
const MOCK = qs.has("mock"), DEBUG = qs.has("debug");
const VIDEO_TARGET_SEC = +(qs.get("target") || 60), END_RESET_SEC = 30;   // 자동으로 처음으로 가는 건 마무리 화면(30초)만
const $ = id => document.getElementById(id);
/* 태블릿 크기에 맞춰 800x1280 화면을 통째로 확대/축소 */
function fitApp() { document.documentElement.style.setProperty("--s", Math.min(innerWidth / 800, innerHeight / 1280)); }
addEventListener("resize", fitApp); fitApp();
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const B = n => `/static/brand/${n}.png`;

const QUIZ_LOOK = { with: "k_heart", theme: "k_pottery", mood: "k_read", fun: "k_curious", move: "k_hike", time: "k_v", keep: "k_camera" };
const STAGES = [[0, "토더기가 여행 가방을 챙기는 중"], [15, "{p}(으)로 촬영하러 가는 중"], [35, "찍은 장면을 편집하는 중"], [52, "모니터로 보내는 중"]];

let questions = [], answers = {}, qi = 0, places = [], persona = "", sessionId = "";
let recoPromise = null, current = null, videoTask = null, pollTimer = null, idleTimer = null, endTimer = null, readyTimer = null;

/* ---------- 공통 ---------- */
async function api(url, body) {
  if (MOCK) return mockApi(url, body);
  const res = await fetch(url, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return res.json();
}
function show(id) {
  const prev = document.querySelector(".screen.active");
  if (prev && prev.id !== id) { prev.classList.add("leave"); prev.classList.remove("active"); setTimeout(() => prev.classList.remove("leave"), 520); }
  $(id).classList.add("active");
  document.body.dataset.screen = id.slice(2);
  debug(id);
}
function debug(msg) { if (DEBUG) { $("debug").hidden = false; $("debug").textContent = `${msg} · 답 ${Object.values(answers).join("")}`; } }
function bumpIdle() {
  clearTimeout(idleTimer);
}
["pointerdown", "keydown"].forEach(e => addEventListener(e, bumpIdle, { passive: true }));
addEventListener("contextmenu", e => e.preventDefault());
const sentences = t => (String(t).match(/[^.!?]+[.!?]+/g) || [t]).map(s => s.trim());
const placeImg = p => p.image_url || `/static/images/${p.place_id}.jpg`;
const CROP_Y = { GIMHAE_001: 58, GIMHAE_002: 50, GIMHAE_003: 62, GIMHAE_004: 50, GIMHAE_005: 42, GIMHAE_006: 60, GIMHAE_007: 45, GIMHAE_008: 42, GIMHAE_009: 50, GIMHAE_010: 45,
  GIMHAE_011: 55, GIMHAE_012: 55, GIMHAE_013: 58, GIMHAE_014: 50, GIMHAE_015: 60, GIMHAE_016: 60, GIMHAE_017: 55, GIMHAE_018: 40, GIMHAE_019: 55, GIMHAE_020: 78 };
const imgTag = (p, cls) => `<img class="${cls}" style="object-position:50% ${CROP_Y[p.place_id] ?? 50}%" src="${esc(placeImg(p))}" alt="${esc(p.place_name)}" draggable="false" onerror="this.style.visibility='hidden'">`;

/* ---------- 0. 시작 → 1. 로고 연출 ---------- */
$("btnStart").onclick = async () => {
  try { if (document.documentElement.requestFullscreen && !document.fullscreenElement) await document.documentElement.requestFullscreen(); } catch (_) {}
  sessionId = "S" + Math.random().toString(36).slice(2, 8).toUpperCase();
  answers = {}; qi = 0; places = []; recoPromise = null;
  const loadQ = questions.length ? Promise.resolve() : api("/quiz").then(d => { questions = d.questions || d; });
  await splash();
  try { await loadQ; } catch (e) { alert("질문을 불러오지 못했어요. 서버를 확인해 주세요."); return reset(); }
  renderQuestion(); show("s-quiz");
};
/* 한 줄 설명을 LocalRise 글자 폭과 똑같은 길이로 맞춘다 */
function fitSub() {
  const w = $("splashWord"), s = $("splashSub");
  s.style.fontSize = "24px";
  const ww = w.scrollWidth, sw = s.scrollWidth;
  if (ww && sw) s.style.fontSize = (24 * ww / sw).toFixed(1) + "px";
}
addEventListener("resize", () => { if (document.body.dataset.screen === "splash") fitSub(); });
/* 글꼴을 미리 받아 둔다: 처음 로고가 다른 글꼴로 떴다가 바뀌며 깜빡이는 것 방지 */
const FONTS_READY = Promise.all(["700 10px LatoB", "10px Jua", "500 10px IBMPlexKR", "700 10px IBMPlexKR", "800 10px NanumMyeongjo", "10px BlackHanSans"]
  .map(f => document.fonts.load(f).catch(() => {}))).then(() => sleep(50));
async function splash() {
  const w = $("splashWord");
  w.className = "splash-word";
  w.innerHTML = [..."LocalRise"].map((c, i) => `<span class="${i >= 5 ? "g" : ""}" style="animation-delay:${i * 130}ms">${c}</span>`).join("");
  $("splashSub").classList.remove("show");
  await FONTS_READY;                                  // 글꼴이 다 받아진 뒤 시작 (깜빡임 방지)
  show("s-splash");
  await document.fonts.ready; fitSub();
  await sleep(300); w.classList.add("in");          // 천천히 한 글자씩
  await sleep(2200); $("splashSub").classList.add("show");
  await sleep(1600);                                 // 로고+문구를 충분히 보여 준 뒤 바로 다음 화면
}

/* ---------- 2. 질문 ---------- */
function renderQuestion() {
  const q = questions[qi];
  $("qCount").textContent = `${qi + 1} / ${questions.length}`;
  $("qSegs").innerHTML = questions.map((_, i) => `<i class="${i <= qi ? "on" : ""}"></i>`).join("");
  $("qNo").textContent = `Q${qi + 1}`;
  $("qText").textContent = q.text;
  const m = $("qMascot"); m.classList.remove("pop"); void m.offsetWidth; m.src = B(QUIZ_LOOK[q.id] || "k_main"); m.classList.add("pop");
  $("qOpts").innerHTML = ["A", "B"].map(k => `
    <button class="opt ${answers[q.id] === k ? "picked" : ""}" data-v="${k}" type="button">
      <span class="opt-letter">${k}</span>
      <span class="opt-label">${esc(q.options[k].label)}</span>
      <span class="opt-sub">${esc(q.options[k].phrase || "")}</span>
      <span class="stamp">선택</span>
    </button>`).join("");
  $("qOpts").querySelectorAll(".opt").forEach(b => (b.onclick = () => pick(q.id, b.dataset.v, b)));
  $("qBack").style.visibility = qi ? "visible" : "hidden";
}
let picking = false;
async function pick(id, v, btn) {
  if (picking) return; picking = true;
  answers[id] = v;
  $("qOpts").querySelectorAll(".opt").forEach(b => b.classList.toggle("picked", b === btn));
  await sleep(380);
  picking = false;
  if (qi < questions.length - 1) { qi++; renderQuestion(); return; }
  openPaper();
}
$("qBack").onclick = () => { if (qi > 0) { qi--; renderQuestion(); } };

/* ---------- 3. 김해시보: 인쇄 중 → 기사 5편 ---------- */
async function openPaper() {
  const d = new Date();
  $("mhDate").textContent = `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 ${"일월화수목금토"[d.getDay()]}요일`;
  $("mhPersona").textContent = "당신만을 위한 김해 여행 특별판을 인쇄하고 있어요…";
  $("mhKeywords").innerHTML = questions.map(q => `<span>#${esc(q.options[answers[q.id]].label)}</span>`).join("");
  $("npHint").innerHTML = "<b>인쇄 중</b> 김해 곳곳을 취재한 기사가 곧 나와요";
  const grid = $("npGrid"); grid.className = "np-grid printing";
  grid.innerHTML = [0, 1, 2, 3, 4].map(i => `<div class="np-art ${i ? "" : "lead"}"><span class="sk s" style="width:30%"></span><div class="np-photo"></div><span class="sk t"></span><span class="sk"></span><span class="sk s"></span></div>`).join("");
  show("s-paper");
  const t0 = performance.now();
  recoPromise = api("/recommend_quiz", { answers });
  try {
    const r = await recoPromise;          // 캐시에서 바로 나오므로 일부러 기다리지 않음
    places = (r.recommendations || []).slice(0, 5); persona = r.persona_summary || "";
    // 추천 5곳 영상을 지금 바로 동시에 만들기 시작 (관람객마다 새 시드). 고르면 그 작업을 그대로 이어서 씀
    api("/api/videos/prefetch", { session_id: sessionId, place_ids: places.map(p => p.place_id) }).catch(() => {});
    debug(`추천 ${((performance.now() - t0) / 1000).toFixed(1)}s · ${r.source || ""}`);
  } catch (e) {
    $("mhPersona").textContent = "기사를 받아 오지 못했어요. 잠시 후 다시 시도해 주세요.";
    await sleep(2500); return reset();
  }
  renderPaper();
}
let lastPaperScroll = 0;
$("npGrid").addEventListener("scroll", () => { lastPaperScroll = Date.now(); }, { passive: true });
function renderPaper() {
  $("mhPersona").textContent = persona || "당신만을 위한 김해 여행 코스가 발행되었습니다";
  $("npHint").innerHTML = "<b>토더기 기자의 한마디</b> 기사를 눌러 보세요. 그곳을 여행하는 영상을 만들어 드려요! <span class=\"np-scroll-hint\">아래로 넘기면 더 있어요 ↓</span>";
  $("npGrid").scrollTop = 0;
  const grid = $("npGrid"); grid.className = "np-grid";
  grid.innerHTML = places.map((p, i) => {
    const s = sentences(p.recommend_reason);
    return `<button class="np-art ${i === 0 ? "lead" : ""}" data-i="${i}" type="button" style="animation-delay:${i * 110}ms">
      <span class="np-rank">${i === 0 ? "추천 1위" : `추천 ${i + 1}위`}</span>
      ${imgTag(p, "np-photo")}
      <h3 class="np-title">${esc(p.place_name)}</h3>
      <p class="np-lede">${esc(i === 0 ? s.slice(0, 2).join(" ") : s[0])}</p>
    </button>`;
  }).join("");
  grid.querySelectorAll(".np-art").forEach(b => (b.onclick = () => { if (Date.now() - lastPaperScroll > 350) openWait(+b.dataset.i); }));
}
$("paperRestart").onclick = () => reset();

/* ---------- 4. 잠시만 기다려 주세요: 리볼버(세로 회전) ---------- */
const drum = { idx: 0, n: 5, step: 72, H: 0, R: 0 };
function buildDrum(start) {
  const box = $("drum"), cyl = $("cyl");
  drum.n = places.length || 5; drum.step = 360 / drum.n;
  drum.H = Math.min(box.clientHeight * 0.88, 780);
  drum.R = Math.round(drum.H / 2 / Math.tan(Math.PI / drum.n)) + 8;
  cyl.innerHTML = places.map((p, i) => `
    <div class="card" data-i="${i}" style="height:${drum.H}px;margin-top:${-drum.H / 2}px;transform:rotateX(${-i * drum.step}deg) translateZ(${drum.R}px)">
      ${imgTag(p, "")}
      <div class="card-body">
        <span class="card-rank">추천 ${i + 1}위</span>
        <h3 class="card-title">${esc(p.place_name)}</h3>
        <div class="card-tags">${(p.matching_tags || []).map(t => `<span>#${esc(t)}</span>`).join("")}</div>
        <p class="card-text">${esc(p.recommend_reason)}</p>
      </div>
      <span class="card-badge idle">▶ 눌러서 영상 보기</span>
    </div>`).join("");
  $("drumDots").innerHTML = places.map(() => "<i></i>").join("");
  drum.idx = start; turn(0); badges();
}
const mod = i => ((i % drum.n) + drum.n) % drum.n;
/* 카드 배지: 지금 영상 만드는/재생 중인 장소 표시, 나머지는 "눌러서 영상 보기" */
function badges() {
  $("cyl").querySelectorAll(".card").forEach(c => {
    const b = c.querySelector(".card-badge"), on = current && places[+c.dataset.i].place_id === current.place_id;
    b.className = "card-badge " + (on ? (videoTask && videoTask.done ? "play" : "") : "idle");
    b.textContent = on ? (videoTask && videoTask.done ? "✓ 모니터 재생 중" : "🎬 영상 촬영 중") : "▶ 눌러서 영상 보기";
  });
  scheduleFlat(0);
}
/* 리볼버에서 카드를 누르면: 앞 카드면 그 장소 영상 시작, 뒤 카드면 앞으로 돌리기 */
function tapCard(i) {
  const cur = mod(drum.idx);
  if (i !== cur) { drum.idx += ((i - cur + drum.n + 2) % drum.n) - 2; turn(0); }
  current = { ...places[i], rank: i + 1 };   // 같은 곳을 다시 눌러도 모니터에서 다시 보여 줌
  startVideo(current);
}
/* 앞 카드 선명하게: 3D로 돌아간 카드는 브라우저가 흐리게 그려 두는 경우가 있어서,
   멈춰 있을 때는 앞 카드와 똑같은 '평평한 복사본'을 그 위에 겹쳐 보여 준다 (돌리는 동안엔 숨김) */
let flatTimer = 0;
function hideFlat() { clearTimeout(flatTimer); const f = $("drum").querySelector(".card-flat"); if (f) f.remove(); }
function scheduleFlat(ms = 560) {
  hideFlat();
  flatTimer = setTimeout(() => {
    if ($("cyl").classList.contains("dragging")) return;
    const front = $("cyl").querySelector(`.card[data-i="${mod(drum.idx)}"]`); if (!front) return;
    const f = front.cloneNode(true); f.classList.add("card-flat"); f.style.transform = "none"; f.style.opacity = 1;
    $("drum").appendChild(f);
  }, ms);
}
function turn(dragDeg) {
  scheduleFlat();
  const ang = drum.idx * drum.step + dragDeg;
  $("cyl").style.transform = `translateZ(${-drum.R}px) rotateX(${ang}deg)`;
  $("cyl").querySelectorAll(".card").forEach(c => {
    const i = +c.dataset.i; let d = Math.abs(((i * drum.step - ang) % 360 + 540) % 360 - 180);
    c.style.opacity = d < 20 ? 1 : d < 90 ? 0.55 : 0;
  });
  $("drumDots").querySelectorAll("i").forEach((d, i) => d.classList.toggle("on", i === mod(drum.idx)));
}
(() => {
  const box = $("drum"); let y0 = null, dy = 0, lastWheel = 0;
  box.addEventListener("pointerdown", e => { y0 = e.clientY; dy = 0; $("cyl").classList.add("dragging"); hideFlat(); box.setPointerCapture(e.pointerId); });
  box.addEventListener("pointermove", e => { if (y0 === null) return; dy = e.clientY - y0; turn(-dy / drum.H * drum.step); });
  const end = e => {
    if (y0 === null) return; $("cyl").classList.remove("dragging");
    if (Math.abs(dy) < 10 && e && e.type === "pointerup") {          // 살짝 누른 것 = 탭
      y0 = null; turn(0);
      const hits = document.elementsFromPoint(e.clientX, e.clientY);
      const el = hits.find(x => x.classList && x.classList.contains("card"));
      if (!el) return;
      const i = +el.dataset.i, cur = mod(drum.idx);
      if (i !== cur) { drum.idx += ((i - cur + drum.n + 2) % drum.n) - 2; turn(0); return; }   // 뒤 카드: 앞으로 돌리기만
      if (hits.some(x => x.classList && x.classList.contains("card-badge"))) tapCard(i);        // 앞 카드의 "영상 보기" 버튼만 영상 시작
      return;
    }
    const n = Math.round(-dy / (drum.H * 0.55)) || (Math.abs(dy) > 36 ? (dy < 0 ? 1 : -1) : 0);
    drum.idx += n; y0 = null; turn(0);
  };
  box.addEventListener("pointerup", end); box.addEventListener("pointercancel", end);
  box.addEventListener("wheel", e => { e.preventDefault(); const t = Date.now(); if (t - lastWheel < 380) return; lastWheel = t; drum.idx += e.deltaY > 0 ? 1 : -1; turn(0); }, { passive: false });
})();

function openWait(i) {
  current = { ...places[i], rank: i + 1 };
  $("vDest").textContent = current.place_name;

  $("btnFinish").hidden = true;
  setProgress(0, "잠시만 기다려 주세요", "토더기가 여행 가방을 챙기는 중", 1);
  show("s-wait");
  requestAnimationFrame(() => buildDrum(i));
  startVideo(current);
}
function setProgress(pct, title, sub, stepNow) {
  $("flight").style.setProperty("--p", pct);
  $("vPct").textContent = `${Math.round(pct)}%`;
  $("vTitle").textContent = title; $("vSub").textContent = sub;
  $("vSteps").querySelectorAll("li").forEach((li, k) => { li.className = k < stepNow ? "done" : k === stepNow ? "now" : ""; });
}
async function startVideo(p) {
  stopVideo();
  const my = videoTask = { place: p, t0: Date.now() };
  $("waitPanel").classList.remove("ready"); $("btnFinish").hidden = true; $("vSteps").hidden = false;
  $("vSay").hidden = true; $("flight").hidden = false; $("vHint").hidden = false;
  $("vDest").textContent = p.place_name;
  setProgress(0, "잠시만 기다려 주세요", "토더기가 여행 가방을 챙기는 중", 1);
  if ($("cyl").children.length) badges();
  let task;
  try { task = await api("/api/videos", { place_id: p.place_id, session_id: sessionId }); }
  catch (e) { setProgress(0, "영상 요청 실패", "잠시 후 다른 기사를 골라 주세요", 0); return; }
  const tick = async () => {
    if (videoTask !== my) return;
    let st = {};
    try { st = await api(`/api/video-status/${task.task_id}`); } catch (_) {}
    if (videoTask !== my) return;
    if (st.status === "succeeded") return ready();
    if (st.status === "failed") return setProgress(0, "영상 생성 실패", "다른 기사를 골라 주세요", 1);
    const el = (Date.now() - my.t0) / 1000;
    const pct = typeof st.progress === "number" ? st.progress : Math.min(95, (el / VIDEO_TARGET_SEC) * 100);
    const k = STAGES.filter(s => el >= s[0]).length - 1;
    setProgress(pct, "잠시만 기다려 주세요", STAGES[k][1].replace("{p}", p.place_name), Math.min(3, k + 1));
    pollTimer = setTimeout(tick, 1500);
  };
  tick();
}
function ready() {
  if (videoTask) videoTask.done = true; badges();
  $("waitPanel").classList.add("ready");
  setProgress(100, "영상 완성!", "", 4);
  $("flight").hidden = true; $("vHint").hidden = true; $("vSay").hidden = false;
  $("vPct").textContent = "100%";
  $("vSteps").hidden = true; $("btnFinish").hidden = false;
  badges();
}
function stopVideo() { clearTimeout(pollTimer); clearTimeout(readyTimer); videoTask = null; }
$("btnFinish").onclick = () => finish();

/* ---------- 5. 마무리 ---------- */
function finish() {
  stopVideo();
  api("/api/display/finish", { session_id: sessionId }).catch(() => {});   // 옆 모니터도 마무리 멘트로
  if (current) { $("endPlace").textContent = current.place_name; $("endPhoto").src = placeImg(current); }
  show("s-end");
  let left = END_RESET_SEC; $("endCount").textContent = left;
  clearInterval(endTimer);
  endTimer = setInterval(() => { left--; $("endCount").textContent = left; if (left <= 0) reset(); }, 1000);
}
$("endRestart").onclick = () => reset();

function reset() {
  clearInterval(endTimer); stopVideo();
  answers = {}; qi = 0; places = []; current = null; recoPromise = null;
  show("s-intro");
}

/* ---------- 리허설용 예시 데이터 (?mock=1) ---------- */
async function mockApi(url, body) {
  await sleep(250);
  if (url === "/quiz") return (await fetch("/static/kiosk/mock_quiz.json")).json();
  if (url === "/recommend_quiz") { await sleep(150); return (await fetch("/static/kiosk/mock_reco.json")).json(); }
  if (url === "/api/videos/prefetch") return { tasks: [] };
  if (url === "/api/display/finish") {
    try { const t = JSON.parse(localStorage.getItem("lr_mock_task")); if (t) { t.finished = true; localStorage.setItem("lr_mock_task", JSON.stringify(t)); } } catch (_) {}
    return { ok: true };
  }
  if (url === "/api/videos") {
    const t = { task_id: "mock_" + Date.now(), place_id: body.place_id, place_name: current?.place_name || "", t0: Date.now() };
    try { localStorage.setItem("lr_mock_task", JSON.stringify(t)); } catch (_) {}
    mockApi.t = t; return { task_id: t.task_id };
  }
  if (url.startsWith("/api/video-status")) {
    const sec = +(qs.get("mocksec") || 12);
    return Date.now() - mockApi.t.t0 > sec * 1000 ? { status: "succeeded", result: {} } : { status: "running" };
  }
}
