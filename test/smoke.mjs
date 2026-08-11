/**
 * サーバー (Durable Object) の動作確認。
 *
 *   npm test
 *
 * wrangler dev を自分で起動し、素の WebSocket クライアントを何体か繋いで
 * 実際に遊ばせ、終わったら片付ける。
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = Number(process.env.PORT ?? 8788);
const BASE = `http://127.0.0.1:${PORT}`;
const WS_BASE = `ws://127.0.0.1:${PORT}/api/ws`;

const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `  — ${detail}` : ''}`);
}

// ---------------------------------------------------------------- dev サーバー

const server = spawn(
  'npx',
  ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1'],
  { stdio: ['ignore', 'pipe', 'pipe'] }
);
const serverLog = [];
server.stdout.on('data', (b) => serverLog.push(String(b)));
server.stderr.on('data', (b) => serverLog.push(String(b)));

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(BASE, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return true;
    } catch {
      // まだ起動していない
    }
    await sleep(1000);
  }
  return false;
}

function shutdown(code) {
  server.kill('SIGTERM');
  process.exit(code);
}

if (!(await waitForServer())) {
  console.error('wrangler dev が起動しませんでした:\n' + serverLog.join(''));
  shutdown(1);
}

// ------------------------------------------------------------------ ボット

/** 一番近いオーブへ向かって動き続けるだけのクライアント。 */
function spawnBot(room, name) {
  const bot = { name, id: null, cfg: null, roster: null, score: 0, last: null, ticks: 0, pongs: 0 };
  const ws = new WebSocket(`${WS_BASE}?room=${room}&name=${encodeURIComponent(name)}`);
  bot.ws = ws;

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.t === 'welcome') {
      bot.id = msg.id;
      bot.cfg = msg;
      ws.send(JSON.stringify({ t: 'ping', ts: 1 }));
      return;
    }
    if (msg.t === 'roster') {
      bot.roster = msg.players;
      return;
    }
    if (msg.t === 'pong') {
      bot.pongs++;
      return;
    }
    if (msg.t !== 'state') return;

    bot.ticks++;
    bot.last = msg;
    const mine = msg.p.find((p) => p[0] === bot.id);
    if (!mine) return;
    bot.score = mine[3];

    const [, mx, my] = mine;
    let target = null;
    let best = Infinity;
    for (const [, ox, oy] of msg.o) {
      const d = Math.hypot(ox - mx, oy - my);
      if (d < best) {
        best = d;
        target = [ox, oy];
      }
    }
    if (!target) return;
    const dx = target[0] - mx;
    const dy = target[1] - my;
    const len = Math.hypot(dx, dy) || 1;
    ws.send(JSON.stringify({ t: 'input', dx: dx / len, dy: dy / len }));
  });
  return bot;
}

const openSocket = (room, name) =>
  new Promise((resolve) => {
    const ws = new WebSocket(`${WS_BASE}?room=${room}&name=${encodeURIComponent(name)}`);
    ws.addEventListener('open', () => resolve({ ws, ok: true }));
    ws.addEventListener('error', () => resolve({ ws, ok: false }));
  });

const room = (prefix) => prefix + Date.now().toString(36).toUpperCase().slice(-5);

// ------------------------------------------------------------------ テスト

console.log('\n■ ルーティングと入口');
check('トップページが配信される', (await fetch(BASE)).status === 200);
check(
  'WebSocket でないアクセスは 426',
  (await fetch(`${BASE}/api/ws?room=LOBBY`)).status === 426
);
check(
  '英数字以外のルーム名は 400',
  (await fetch(`${BASE}/api/ws?room=${encodeURIComponent('あ')}`)).status === 400
);
check('未知の API パスは 404', (await fetch(`${BASE}/api/nope`)).status === 404);

console.log('\n■ 対戦');
const playRoom = room('PLAY');
const a = spawnBot(playRoom, 'ボットA');
const b = spawnBot(playRoom, 'ボットB');
await sleep(1500);

check('2 人とも接続できた', a.id !== null && b.id !== null && a.id !== b.id);
check('ping に pong が返る', a.pongs > 0);
check(
  '物理パラメータが配られる',
  a.cfg.speed > 0 && a.cfg.accel > 0 && a.cfg.roundMs > 0,
  `speed=${a.cfg.speed} accel=${a.cfg.accel} round=${a.cfg.roundMs / 1000}秒`
);
check('お互いが名簿に載る', a.roster?.length === 2 && b.roster?.length === 2);
check('色が重ならない', new Set(a.roster.map((p) => p.color)).size === 2);
check('日本語の名前が通る', a.roster.some((p) => p.name === 'ボットA'));

await sleep(6000);
const rate = a.ticks / 7.5;
check('20Hz 前後で配信される', rate > 14 && rate < 26, `${rate.toFixed(1)} 通/秒`);
check('どちらも得点した', a.score > 0 && b.score > 0, `A=${a.score} B=${b.score}`);
check('スコアが両者で一致する', JSON.stringify(a.last.p) === JSON.stringify(b.last.p));

const { w, h } = a.cfg.world;
const r = a.cfg.playerR;
check(
  '全員アリーナの内側にいる',
  a.last.p.every(([, x, y]) => x >= r && x <= w - r && y >= r && y <= h - r)
);
check(
  'プレイヤー同士がめり込まない',
  Math.hypot(a.last.p[0][1] - a.last.p[1][1], a.last.p[0][2] - a.last.p[1][2]) >= r * 2 - 2
);
check('状態メッセージが十分小さい', JSON.stringify(a.last).length < 1500, `${JSON.stringify(a.last).length} バイト`);

console.log('\n■ 不正な入力');
a.ws.send(JSON.stringify({ t: 'input', dx: 99999, dy: 99999 }));
a.ws.send('JSON ではない文字列');
a.ws.send(JSON.stringify({ t: '知らない種類' }));
a.ws.send(JSON.stringify({ t: 'input', dx: 'ずる', dy: null }));
await sleep(1000);
check('壊れた入力を投げても接続が続く', a.ws.readyState === WebSocket.OPEN);
check(
  '巨大な入力値でも壁を越えない',
  a.last.p.every(([, x, y]) => x >= r && x <= w - r && y >= r && y <= h - r)
);

console.log('\n■ 退出');
b.ws.close();
await sleep(900);
check('退出した人が名簿から消える', a.roster.length === 1);
check('残った人への配信は続く', a.last.p.length === 1);
a.ws.close();

console.log('\n■ 定員');
const capRoom = room('CAP');
const sockets = [];
for (let i = 0; i < 16; i++) sockets.push(await openSocket(capRoom, `P${i}`));
check('16 人まで入れる', sockets.every((s) => s.ok));
check('17 人目は断られる', !(await openSocket(capRoom, 'P16')).ok);
const otherRoom = await openSocket(capRoom + 'X', '別室');
check('別のルームには入れる', otherRoom.ok);
otherRoom.ws.close();
for (const s of sockets) s.ws.close();
await sleep(600);
check('空きが出れば入れる', (await openSocket(capRoom, '入り直し')).ok);

// ------------------------------------------------------------------ 結果

await sleep(300);
const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} 件 成功`);
shutdown(failed.length === 0 ? 0 : 1);
