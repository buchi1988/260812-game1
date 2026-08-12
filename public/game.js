/**
 * Dot Rush — クライアント
 *
 * サーバー (Durable Object) が権威なので、ここでやることは 3 つだけ。
 *   1. 入力方向を送る
 *   2. 届いた状態を補間して滑らかに描く
 *   3. 自分だけは先読み (予測) して操作感を良くする
 */

'use strict';

// ------------------------------------------------------------------ DOM

const $ = (id) => document.getElementById(id);

const stage = $('stage');
const canvas = $('canvas');
const ctx = canvas.getContext('2d');

const joinOverlay = $('joinOverlay');
const joinForm = $('joinForm');
const nameInput = $('nameInput');
const roomInput = $('roomInput');
const resultOverlay = $('resultOverlay');
const resultList = $('resultList');
const resultCountdown = $('resultCountdown');
const errorOverlay = $('errorOverlay');
const errorText = $('errorText');
const retryBtn = $('retryBtn');
const boardList = $('boardList');
const boardBest = $('boardBest');
const roomChip = $('roomChip');
const roomNameEl = $('roomName');
const timerEl = $('timer');
const timerFill = $('timerFill');
const playerCountEl = $('playerCount');
const pingEl = $('ping');
const soundBtn = $('soundBtn');
const touchHint = $('touchHint');

// ------------------------------------------------------------------ 定数

/** 何 ms 過去の状態を描くか。この遅延のぶんだけ補間の余裕が生まれる。 */
const INTERP_DELAY = 110;
/** 大きく向きが変えたときの最短送信間隔 (ms)。押した瞬間を待たせない。 */
const INPUT_MIN_INTERVAL = 12;
/** 細かく向きが変わり続けるとき (スティック操作) の送信間隔 (ms)。 */
const INPUT_FINE_INTERVAL = 33;
/** 向きが変わらないときの送信間隔 (ms)。時計合わせを兼ねている。 */
const INPUT_HEARTBEAT = 100;
/** 予測位置がサーバーとこれ以上ズレたら瞬間移動で合わせる。 */
const SNAP_DISTANCE = 170;
/** 1 回の補正で誤差をどれだけ詰めるか。 */
const RECONCILE = 0.2;
/** 予測位置の履歴として持っておくフレーム数 (60fps でおよそ 3 秒)。 */
const TRAIL_MAX = 180;

const MEDALS = ['🥇', '🥈', '🥉'];

// ------------------------------------------------------------------ 状態

/** サーバーから受け取る設定 (welcome メッセージで上書きされる)。 */
const cfg = {
  world: { w: 800, h: 800 },
  playerR: 18,
  orbR: 10,
  goldR: 15,
  speed: 260,
  accel: 14,
  roundMs: 90000,
  resultMs: 8000,
};

let ws = null;
let myId = null;
let roomName = 'LOBBY';
let closedByUser = false;
let reconnectTimer = null;

/** 名前と色 (roster メッセージで更新)。 */
let roster = new Map();
/** 直近のスナップショット列。描画はこの中を時間で補間する。 */
let snapshots = [];
/** 最新スナップショット (順位表・予測の補正に使う)。 */
let latest = null;
let best = null;

/** 自分の予測位置。 */
const me = { x: 0, y: 0, vx: 0, vy: 0, ready: false };
/**
 * 自分の予測位置の履歴 [{t, x, y}]。
 * サーバーから届く位置は必ず通信の遅れぶん過去のものなので、
 * 「その時点で自分はどこにいると思っていたか」と突き合わせるために持つ。
 */
const trail = [];

/** 入力状態。 */
const keys = new Set();
const touch = { active: false, id: -1, ox: 0, oy: 0, dx: 0, dy: 0 };
let input = { x: 0, y: 0 };
let lastInputSent = 0;
let lastSentInput = { x: 0, y: 0 };

/** 描画のためのローカル演出。 */
const particles = [];
const popups = [];
const orbBirth = new Map();

/** 画面フィット用。 */
let dpr = 1;
let scale = 1;
let offX = 0;
let offY = 0;
let viewW = 0;
let viewH = 0;

let lastFrame = performance.now();
let pingMs = null;
let lastPingSent = 0;
let resultShownFor = null;

// ------------------------------------------------------------------ 接続

function connect() {
  clearTimeout(reconnectTimer);
  closedByUser = false;

  const name = (nameInput.value || '').trim().slice(0, 12);
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/api/ws?room=${encodeURIComponent(roomName)}&name=${encodeURIComponent(name)}`;

  try {
    ws = new WebSocket(url);
  } catch {
    showError('接続を開始できませんでした。');
    return;
  }

  ws.addEventListener('open', () => {
    errorOverlay.classList.add('hidden');
    sendInput(true);
  });

  ws.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    handleMessage(msg);
  });

  ws.addEventListener('close', () => {
    if (closedByUser) return;
    showError('サーバーとの接続が切れました。ルームが満員の可能性もあります。');
    // 自動で 1 度だけ繋ぎ直す。それでも駄目ならボタンで手動再接続。
    reconnectTimer = setTimeout(connect, 2000);
  });

  ws.addEventListener('error', () => {
    /* close が続けて飛ぶのでここでは何もしない */
  });
}

function handleMessage(msg) {
  switch (msg.t) {
    case 'welcome': {
      myId = msg.id;
      cfg.world = msg.world;
      cfg.playerR = msg.playerR;
      cfg.orbR = msg.orbR;
      cfg.goldR = msg.goldR;
      cfg.speed = msg.speed;
      cfg.accel = msg.accel;
      cfg.roundMs = msg.roundMs;
      cfg.resultMs = msg.resultMs;
      best = msg.best;
      me.ready = false;
      snapshots = [];
      trail.length = 0;
      resize();
      break;
    }

    case 'me': {
      reconcile(msg);
      break;
    }

    case 'roster': {
      roster = new Map(msg.players.map((p) => [p.id, p]));
      playerCountEl.textContent = String(msg.players.length);
      renderBoard();
      break;
    }

    case 'state': {
      onState(msg);
      break;
    }

    case 'pong': {
      pingMs = Math.round(performance.now() - msg.ts);
      pingEl.textContent = String(pingMs);
      break;
    }
  }
}

function onState(msg) {
  const now = performance.now();
  const players = new Map();
  for (const [id, x, y, score, hot] of msg.p) {
    players.set(id, { id, x, y, score, hot: hot === 1 });
  }

  const snap = {
    t: now,
    phase: msg.ph,
    timeLeft: msg.tl,
    players,
    orbs: msg.o.map(([id, x, y, gold]) => ({ id, x, y, gold: gold === 1 })),
  };

  snapshots.push(snap);
  // 補間に必要なぶんだけ残す。
  while (snapshots.length > 40) snapshots.shift();
  latest = snap;
  best = msg.best;

  // 新しく現れたオーブは出現アニメーションを付ける。
  const alive = new Set();
  for (const orb of snap.orbs) {
    alive.add(orb.id);
    if (!orbBirth.has(orb.id)) orbBirth.set(orb.id, now);
  }
  for (const id of orbBirth.keys()) {
    if (!alive.has(id)) orbBirth.delete(id);
  }

  // 誰かがオーブを取った演出。
  for (const [x, y, gold] of msg.f) {
    burst(x, y, gold === 1);
  }

  // 最初の 1 通で自分の位置を置く。以降の補正は 'me' メッセージで行う。
  const mine = players.get(myId);
  if (mine && !me.ready) {
    me.x = mine.x;
    me.y = mine.y;
    me.ready = true;
  }

  renderBoard();
  updateTimer(snap);
  updateResultOverlay(snap);
}

function showError(text) {
  errorText.textContent = text;
  errorOverlay.classList.remove('hidden');
}

// ------------------------------------------------------------------ 入力

function readKeyboard() {
  let x = 0;
  let y = 0;
  if (keys.has('a') || keys.has('arrowleft')) x -= 1;
  if (keys.has('d') || keys.has('arrowright')) x += 1;
  if (keys.has('w') || keys.has('arrowup')) y -= 1;
  if (keys.has('s') || keys.has('arrowdown')) y += 1;
  return { x, y };
}

function updateInput() {
  let v = touch.active ? { x: touch.dx, y: touch.dy } : readKeyboard();
  const len = Math.hypot(v.x, v.y);
  if (len > 1) v = { x: v.x / len, y: v.y / len };
  input = v;
}

function sendInput(force) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const now = performance.now();
  const change = Math.hypot(input.x - lastSentInput.x, input.y - lastSentInput.y);
  const since = now - lastInputSent;

  // 向きを変えた瞬間は待たせない。待たせたぶんがそのまま操作の重さになる。
  // 細かい変化 (スティック操作) は 30Hz、変化がなければ 100ms ごとに送る。
  const due =
    change > 0.3
      ? since >= INPUT_MIN_INTERVAL
      : change > 0.02
        ? since >= INPUT_FINE_INTERVAL
        : since >= INPUT_HEARTBEAT;
  if (!force && !due) return;

  lastInputSent = now;
  lastSentInput = { x: input.x, y: input.y };
  // ts はサーバーが時計の差を測るために使い、'me' メッセージで戻ってくる。
  ws.send(JSON.stringify({ t: 'input', dx: input.x, dy: input.y, ts: now }));
}

addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) e.preventDefault();
  keys.add(k);
});

addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
addEventListener('blur', () => keys.clear());

canvas.addEventListener('pointerdown', (e) => {
  if (touch.active) return;
  touch.active = true;
  touch.id = e.pointerId;
  touch.ox = e.clientX;
  touch.oy = e.clientY;
  touch.dx = 0;
  touch.dy = 0;
  canvas.setPointerCapture(e.pointerId);
  touchHint.classList.add('hidden');
});

canvas.addEventListener('pointermove', (e) => {
  if (!touch.active || e.pointerId !== touch.id) return;
  // 指の移動量をそのまま方向に。半径 56px でフルスピード。
  const max = 56;
  const dx = e.clientX - touch.ox;
  const dy = e.clientY - touch.oy;
  const len = Math.hypot(dx, dy) || 1;
  const mag = Math.min(len, max) / max;
  touch.dx = (dx / len) * mag;
  touch.dy = (dy / len) * mag;
});

function endTouch(e) {
  if (!touch.active || e.pointerId !== touch.id) return;
  touch.active = false;
  touch.id = -1;
  touch.dx = 0;
  touch.dy = 0;
}

canvas.addEventListener('pointerup', endTouch);
canvas.addEventListener('pointercancel', endTouch);

// ------------------------------------------------------------------ 予測

function predict(dt) {
  if (!me.ready) return;

  // サーバーと同じ解析解で進める。「更新後の速度 × dt」ではなくこの式を使うことで、
  // 60fps のここと 20Hz のサーバーで進む距離が厳密に一致する。
  const k = 1 - Math.exp(-cfg.accel * dt);
  const tx = input.x * cfg.speed;
  const ty = input.y * cfg.speed;
  me.x = clamp(me.x + tx * dt + ((me.vx - tx) * k) / cfg.accel, cfg.playerR, cfg.world.w - cfg.playerR);
  me.y = clamp(me.y + ty * dt + ((me.vy - ty) * k) / cfg.accel, cfg.playerR, cfg.world.h - cfg.playerR);
  me.vx += (tx - me.vx) * k;
  me.vy += (ty - me.vy) * k;

  trail.push({ t: performance.now(), x: me.x, y: me.y });
  if (trail.length > TRAIL_MAX) trail.shift();
}

/**
 * サーバーから届いた自分の位置で予測を補正する。
 *
 * msg.et は「この位置はあなたの時計で何時に相当するか」。同じ時点の自分の予測と
 * 比べるので、差として出てくるのは通信の遅れではなく本物のズレ (壁ぎわの丸め、
 * 他プレイヤーとの押し合いなど) だけになる。今の予測位置と直接比べてしまうと
 * 往復時間ぶんの差をズレと誤認し、先読みを打ち消してしまう。
 */
function reconcile(msg) {
  if (!me.ready || trail.length === 0) return;
  if (msg.et < trail[0].t) return; // 履歴がまだ足りない

  let past = trail[0];
  for (const entry of trail) {
    if (entry.t <= msg.et) past = entry;
    else break;
  }

  const ex = msg.x - past.x;
  const ey = msg.y - past.y;
  const k = Math.hypot(ex, ey) > SNAP_DISTANCE ? 1 : RECONCILE;
  const dx = ex * k;
  const dy = ey * k;

  me.x = clamp(me.x + dx, cfg.playerR, cfg.world.w - cfg.playerR);
  me.y = clamp(me.y + dy, cfg.playerR, cfg.world.h - cfg.playerR);

  // 履歴も同じだけずらす。ずらさないと、直したはずのズレを次の補正でも
  // もう一度数えてしまい、何度も同じ補正がかかる。
  for (const entry of trail) {
    entry.x += dx;
    entry.y += dy;
  }
}

// ------------------------------------------------------------------ 補間

/** INTERP_DELAY だけ過去の時刻における各プレイヤー位置を求める。 */
function interpolate(renderTime) {
  const out = new Map();
  if (snapshots.length === 0) return out;

  let a = snapshots[0];
  let b = snapshots[snapshots.length - 1];
  for (let i = snapshots.length - 1; i >= 0; i--) {
    if (snapshots[i].t <= renderTime) {
      a = snapshots[i];
      b = snapshots[i + 1] ?? snapshots[i];
      break;
    }
  }

  const span = b.t - a.t;
  const f = span > 0 ? clamp((renderTime - a.t) / span, 0, 1) : 0;

  for (const [id, pa] of a.players) {
    const pb = b.players.get(id) ?? pa;
    out.set(id, {
      id,
      x: pa.x + (pb.x - pa.x) * f,
      y: pa.y + (pb.y - pa.y) * f,
      score: pb.score,
      hot: pb.hot,
    });
  }
  return out;
}

// ------------------------------------------------------------------ 演出

function burst(x, y, gold) {
  const color = gold ? '#ffd166' : '#4dd0ff';
  const count = gold ? 20 : 12;
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.5;
    const speed = 60 + Math.random() * (gold ? 190 : 120);
    particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 0,
      maxLife: 0.5 + Math.random() * 0.3,
      size: gold ? 3.5 : 2.6,
      color,
    });
  }
  popups.push({ x, y, text: gold ? '+3' : '+1', color, life: 0, maxLife: 0.9 });
  playBlip(gold);
}

function updateEffects(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life += dt;
    if (p.life >= p.maxLife) {
      particles.splice(i, 1);
      continue;
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vx *= 0.92;
    p.vy *= 0.92;
  }
  for (let i = popups.length - 1; i >= 0; i--) {
    const p = popups[i];
    p.life += dt;
    if (p.life >= p.maxLife) popups.splice(i, 1);
    else p.y -= 34 * dt;
  }
}

// ------------------------------------------------------------------ 描画

/** 光る円のスプライトを色ごとにキャッシュする (毎フレームのグラデーション生成を避ける)。 */
const glowCache = new Map();

function glowSprite(color, radius) {
  const key = `${color}|${radius}`;
  const hit = glowCache.get(key);
  if (hit) return hit;

  const size = Math.ceil(radius * 6);
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, hexToRgba(color, 0.55));
  grad.addColorStop(0.4, hexToRgba(color, 0.2));
  grad.addColorStop(1, hexToRgba(color, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);

  glowCache.set(key, c);
  return c;
}

function drawGlow(color, radius, x, y, scaleFactor = 1) {
  const sprite = glowSprite(color, radius);
  const size = sprite.width * scaleFactor;
  ctx.drawImage(sprite, x - size / 2, y - size / 2, size, size);
}

function resize() {
  const rect = stage.getBoundingClientRect();
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  viewW = rect.width;
  viewH = rect.height;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  canvas.style.width = `${rect.width}px`;
  canvas.style.height = `${rect.height}px`;

  const pad = rect.width < 600 ? 8 : 18;
  scale = Math.min(
    (rect.width - pad * 2) / cfg.world.w,
    (rect.height - pad * 2) / cfg.world.h
  );
  offX = (rect.width - cfg.world.w * scale) / 2;
  offY = (rect.height - cfg.world.h * scale) / 2;
}

function draw(players) {
  const w = cfg.world.w;
  const h = cfg.world.h;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, viewW, viewH);
  ctx.save();
  ctx.translate(offX, offY);
  ctx.scale(scale, scale);

  drawArena(w, h);
  if (latest) drawOrbs(latest.orbs);
  drawParticles();
  drawPlayers(players);
  drawPopups();

  ctx.restore();
  drawJoystick();
}

function drawArena(w, h) {
  const grad = ctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, '#101733');
  grad.addColorStop(0.5, '#0d1329');
  grad.addColorStop(1, '#141033');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = 'rgba(140, 165, 255, 0.07)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 80; x < w; x += 80) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
  }
  for (let y = 80; y < h; y += 80) {
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();

  ctx.strokeStyle = 'rgba(77, 208, 255, 0.35)';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, w - 2, h - 2);
}

function drawOrbs(orbs) {
  const now = performance.now();
  for (const orb of orbs) {
    const base = orb.gold ? cfg.goldR : cfg.orbR;
    const color = orb.gold ? '#ffd166' : '#4dd0ff';
    // 出現直後は小さく、そこから弾んで元のサイズになる。
    const age = (now - (orbBirth.get(orb.id) ?? now)) / 1000;
    const grow = age < 0.3 ? age / 0.3 : 1;
    const pulse = 1 + Math.sin(now / 300 + orb.id) * 0.08;
    const r = base * grow * pulse;

    drawGlow(color, base, orb.x, orb.y, orb.gold ? 1.25 : 1);

    ctx.beginPath();
    ctx.arc(orb.x, orb.y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    // 中心のハイライト
    ctx.beginPath();
    ctx.arc(orb.x - r * 0.25, orb.y - r * 0.3, r * 0.32, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
    ctx.fill();

    if (orb.gold) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(orb.x, orb.y, r + 5 + Math.sin(now / 200 + orb.id) * 2, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

function drawPlayers(players) {
  const R = cfg.playerR;
  const leaderId = leadingPlayerId();
  const now = performance.now();

  // 自分を最後に描いて手前に出す。
  const list = [...players.values()].sort((a, b) => (a.id === myId ? 1 : b.id === myId ? -1 : 0));

  for (const p of list) {
    const info = roster.get(p.id);
    if (!info) continue;
    const isMe = p.id === myId;
    const x = isMe && me.ready ? me.x : p.x;
    const y = isMe && me.ready ? me.y : p.y;

    drawGlow(info.color, R, x, y, 1);

    // 得点した直後は広がるリング。
    if (p.hot) {
      const t = (now % 400) / 400;
      ctx.beginPath();
      ctx.arc(x, y, R + 6 + t * 18, 0, Math.PI * 2);
      ctx.strokeStyle = hexToRgba(info.color, 0.6 * (1 - t));
      ctx.lineWidth = 3;
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(x, y, R, 0, Math.PI * 2);
    const body = ctx.createLinearGradient(x, y - R, x, y + R);
    body.addColorStop(0, lighten(info.color, 0.28));
    body.addColorStop(1, info.color);
    ctx.fillStyle = body;
    ctx.fill();

    ctx.lineWidth = isMe ? 3.5 : 2;
    ctx.strokeStyle = isMe ? '#ffffff' : 'rgba(255, 255, 255, 0.5)';
    ctx.stroke();

    // 名前 (自分は色付き)
    ctx.font = '600 15px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.strokeText(info.name, x, y - R - 9);
    ctx.fillStyle = isMe ? '#ffffff' : 'rgba(233, 237, 255, 0.9)';
    ctx.fillText(info.name, x, y - R - 9);

    if (p.id === leaderId) {
      ctx.font = '17px system-ui, sans-serif';
      ctx.fillText('👑', x, y - R - 26);
    }
  }
}

function drawParticles() {
  for (const p of particles) {
    const alpha = 1 - p.life / p.maxLife;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * alpha, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawPopups() {
  ctx.textAlign = 'center';
  ctx.font = '800 20px system-ui, sans-serif';
  for (const p of popups) {
    const alpha = 1 - p.life / p.maxLife;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.strokeText(p.text, p.x, p.y);
    ctx.fillStyle = p.color;
    ctx.fillText(p.text, p.x, p.y);
  }
  ctx.globalAlpha = 1;
}

/** タッチ操作中だけ、指の位置にバーチャルスティックを描く (画面座標)。 */
function drawJoystick() {
  if (!touch.active) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const rect = canvas.getBoundingClientRect();
  const cx = touch.ox - rect.left;
  const cy = touch.oy - rect.top;
  const radius = 56;

  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx + touch.dx * radius, cy + touch.dy * radius, 22, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
  ctx.fill();
}

// ------------------------------------------------------------------ HUD

function sortedPlayers() {
  if (!latest) return [];
  return [...latest.players.values()]
    .map((p) => ({ ...p, info: roster.get(p.id) }))
    .filter((p) => p.info)
    .sort((a, b) => b.score - a.score || a.id - b.id);
}

function leadingPlayerId() {
  const top = sortedPlayers()[0];
  return top && top.score > 0 ? top.id : null;
}

function renderBoard() {
  const rows = sortedPlayers().slice(0, 8);
  boardList.replaceChildren(
    ...rows.map((p, i) => {
      const li = document.createElement('li');
      li.className = `board__row${p.id === myId ? ' board__row--me' : ''}`;

      const rank = document.createElement('span');
      rank.className = 'board__rank';
      rank.textContent = String(i + 1);

      const dot = document.createElement('span');
      dot.className = 'board__dot';
      dot.style.background = p.info.color;

      const name = document.createElement('span');
      name.className = 'board__name';
      name.textContent = p.info.name;

      const score = document.createElement('span');
      score.className = 'board__score';
      score.textContent = String(p.score);

      li.append(rank, dot, name, score);
      return li;
    })
  );

  if (best && best.score > 0) {
    boardBest.replaceChildren(
      document.createTextNode('この部屋の最高記録 '),
      Object.assign(document.createElement('b'), { textContent: String(best.score) }),
      document.createTextNode(` (${best.name})`)
    );
  } else {
    boardBest.textContent = '';
  }
}

function updateTimer(snap) {
  const seconds = Math.ceil(snap.timeLeft / 1000);
  timerEl.textContent = String(seconds);
  const total = snap.phase === 'playing' ? cfg.roundMs : cfg.resultMs;
  timerFill.style.width = `${clamp((snap.timeLeft / total) * 100, 0, 100)}%`;
  timerEl.classList.toggle('timer--urgent', snap.phase === 'playing' && seconds <= 10);
}

function updateResultOverlay(snap) {
  if (snap.phase !== 'result') {
    resultOverlay.classList.add('hidden');
    resultShownFor = null;
    return;
  }

  resultCountdown.textContent = String(Math.ceil(snap.timeLeft / 1000));
  // 順位はラウンド終了時点で固定したいので、初回だけ組み立てる。
  if (resultShownFor !== null) return;
  resultShownFor = Date.now();
  resultOverlay.classList.remove('hidden');

  const rows = sortedPlayers().slice(0, 8);
  resultList.replaceChildren(
    ...rows.map((p, i) => {
      const li = document.createElement('li');
      li.className = `result-row${p.id === myId ? ' result-row--me' : ''}`;

      const rank = document.createElement('span');
      rank.className = 'result-row__rank';
      rank.textContent = MEDALS[i] ?? String(i + 1);

      const dot = document.createElement('span');
      dot.className = 'result-row__dot';
      dot.style.background = p.info.color;

      const name = document.createElement('span');
      name.className = 'result-row__name';
      name.textContent = p.info.name + (p.id === myId ? '（あなた）' : '');

      const score = document.createElement('span');
      score.className = 'result-row__score';
      score.textContent = `${p.score} 点`;

      li.append(rank, dot, name, score);
      return li;
    })
  );
}

// ------------------------------------------------------------------ 効果音

let audio = null;
let soundOn = localStorage.getItem('dotrush.sound') !== 'off';
soundBtn.classList.toggle('is-off', !soundOn);
soundBtn.textContent = soundOn ? '🔊' : '🔇';

soundBtn.addEventListener('click', () => {
  soundOn = !soundOn;
  localStorage.setItem('dotrush.sound', soundOn ? 'on' : 'off');
  soundBtn.classList.toggle('is-off', !soundOn);
  soundBtn.textContent = soundOn ? '🔊' : '🔇';
});

function playBlip(gold) {
  if (!soundOn) return;
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = gold ? 'triangle' : 'sine';
    osc.frequency.setValueAtTime(gold ? 660 : 880, audio.currentTime);
    osc.frequency.exponentialRampToValueAtTime(gold ? 1320 : 1180, audio.currentTime + 0.12);
    gain.gain.setValueAtTime(gold ? 0.09 : 0.05, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.22);
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.24);
  } catch {
    // 音が出せない環境でもゲームは続ける
  }
}

// ------------------------------------------------------------------ メインループ

function frame() {
  const now = performance.now();
  const dt = Math.min((now - lastFrame) / 1000, 0.05);
  lastFrame = now;

  updateInput();
  predict(dt);
  sendInput(false);
  updateEffects(dt);

  if (ws && ws.readyState === WebSocket.OPEN && now - lastPingSent > 2000) {
    lastPingSent = now;
    ws.send(JSON.stringify({ t: 'ping', ts: now }));
  }

  draw(interpolate(now - INTERP_DELAY));
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ 起動

function randomRoom() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 4; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

joinForm.addEventListener('submit', (e) => {
  e.preventDefault();

  const raw = (roomInput.value || '').trim().toUpperCase();
  roomName = /^[A-Z0-9]{1,12}$/.test(raw) ? raw : 'LOBBY';
  roomNameEl.textContent = roomName;
  localStorage.setItem('dotrush.name', nameInput.value.trim());

  const url = new URL(location.href);
  url.searchParams.set('room', roomName);
  history.replaceState(null, '', url);

  joinOverlay.classList.add('hidden');
  if (matchMedia('(pointer: coarse)').matches) {
    touchHint.classList.remove('hidden');
    setTimeout(() => touchHint.classList.add('hidden'), 6000);
  }
  connect();
});

retryBtn.addEventListener('click', () => {
  errorOverlay.classList.add('hidden');
  connect();
});

roomChip.addEventListener('click', async () => {
  const url = new URL(location.href);
  url.searchParams.set('room', roomName);
  try {
    await navigator.clipboard.writeText(url.toString());
    roomNameEl.textContent = 'コピーしました';
    setTimeout(() => (roomNameEl.textContent = roomName), 1400);
  } catch {
    prompt('このリンクを共有してください', url.toString());
  }
});

addEventListener('resize', resize);
addEventListener('orientationchange', () => setTimeout(resize, 200));
addEventListener('beforeunload', () => {
  closedByUser = true;
  ws?.close();
});

// 初期値: URL のルーム名と、前回使った名前を復元する。
{
  const params = new URLSearchParams(location.search);
  const fromUrl = (params.get('room') || '').toUpperCase();
  roomInput.value = /^[A-Z0-9]{1,12}$/.test(fromUrl) ? fromUrl : randomRoom();
  nameInput.value = localStorage.getItem('dotrush.name') || '';
  roomNameEl.textContent = roomInput.value;
}

resize();
requestAnimationFrame(frame);

// ------------------------------------------------------------------ 小物

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

function hexToRgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function lighten(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c) => Math.round(c + (255 - c) * amount);
  return `rgb(${mix((n >> 16) & 255)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
}
