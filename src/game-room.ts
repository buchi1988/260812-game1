import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import {
  ACCEL,
  COLORS,
  GOLD_CHANCE,
  GOLD_R,
  GOLD_SCORE,
  MAX_NAME_LEN,
  MAX_PLAYERS,
  MAX_SPEED,
  ORB_COUNT,
  ORB_R,
  ORB_SCORE,
  PLAYER_R,
  RESULT_MS,
  ROUND_MS,
  TICK_MS,
  WORLD_H,
  WORLD_W,
} from './game-config';

type Phase = 'playing' | 'result';

interface Player {
  id: number;
  name: string;
  color: string;
  x: number;
  y: number;
  /** 現在の速度 */
  vx: number;
  vy: number;
  /** クライアントから届いた入力方向 (長さ 0〜1 に正規化済み) */
  ix: number;
  iy: number;
  score: number;
  /** 得点した瞬間の時刻。クライアント側の演出に使う */
  lastScoreAt: number;
}

interface Orb {
  id: number;
  x: number;
  y: number;
  gold: boolean;
}

interface Session {
  ws: WebSocket;
  player: Player;
}

/** 得点エフェクト (その tick で拾われたオーブ) */
interface Fx {
  x: number;
  y: number;
  gold: boolean;
}

interface BestRecord {
  name: string;
  score: number;
  at: number;
}

/**
 * 1 ルーム分のゲームサーバー。
 *
 * - 全プレイヤーの WebSocket をこの 1 インスタンスが保持する
 * - 20Hz でシミュレーションを進め、権威ある状態を全員にブロードキャストする
 * - クライアントから受け取るのは「入力方向」だけなので、座標の改ざんができない
 */
export class GameRoom extends DurableObject<Env> {
  private sessions = new Map<WebSocket, Session>();
  private orbs: Orb[] = [];
  private phase: Phase = 'playing';
  private phaseEndsAt = 0;
  private nextPlayerId = 1;
  private nextOrbId = 1;
  private lastTickAt = 0;
  private loop: ReturnType<typeof setInterval> | null = null;
  private fx: Fx[] = [];
  /** このルームの歴代最高スコア (Durable Object のストレージに永続化) */
  private best: BestRecord | null = null;
  private bestLoaded = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.spawnOrbs();
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('WebSocket へのアップグレードが必要です', { status: 426 });
    }
    if (this.sessions.size >= MAX_PLAYERS) {
      return new Response('このルームは満員です', { status: 503 });
    }

    await this.loadBest();

    const url = new URL(request.url);
    const name = sanitizeName(url.searchParams.get('name'));

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();

    const player: Player = {
      id: this.nextPlayerId++,
      name,
      color: this.pickColor(),
      x: rand(PLAYER_R * 2, WORLD_W - PLAYER_R * 2),
      y: rand(PLAYER_R * 2, WORLD_H - PLAYER_R * 2),
      vx: 0,
      vy: 0,
      ix: 0,
      iy: 0,
      score: 0,
      lastScoreAt: 0,
    };
    const session: Session = { ws: server, player };
    this.sessions.set(server, session);

    server.addEventListener('message', (event) => this.onMessage(session, event));
    server.addEventListener('close', () => this.onLeave(server));
    server.addEventListener('error', () => this.onLeave(server));

    // 物理パラメータもここで配ることで、クライアント側の予測が
    // サーバーのシミュレーションと必ず一致するようにしている。
    this.send(server, {
      t: 'welcome',
      id: player.id,
      world: { w: WORLD_W, h: WORLD_H },
      tickMs: TICK_MS,
      playerR: PLAYER_R,
      orbR: ORB_R,
      goldR: GOLD_R,
      speed: MAX_SPEED,
      accel: ACCEL,
      roundMs: ROUND_MS,
      resultMs: RESULT_MS,
      best: this.best,
    });
    this.broadcastRoster();
    this.ensureLoop();

    return new Response(null, { status: 101, webSocket: client });
  }

  // ---------------------------------------------------------------- 接続まわり

  private onMessage(session: Session, event: MessageEvent): void {
    if (typeof event.data !== 'string' || event.data.length > 512) return;

    let msg: unknown;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (typeof msg !== 'object' || msg === null) return;
    const data = msg as Record<string, unknown>;

    switch (data.t) {
      case 'input': {
        // クライアントは方向だけを送る。長さは 1 に丸めて速度上限を保証する。
        let dx = Number(data.dx);
        let dy = Number(data.dy);
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
        const len = Math.hypot(dx, dy);
        if (len > 1) {
          dx /= len;
          dy /= len;
        }
        session.player.ix = dx;
        session.player.iy = dy;
        break;
      }
      case 'ping': {
        // 往復時間の計測用にそのまま送り返す。
        this.send(session.ws, { t: 'pong', ts: data.ts });
        break;
      }
      case 'rename': {
        const name = sanitizeName(typeof data.name === 'string' ? data.name : null);
        if (name !== session.player.name) {
          session.player.name = name;
          this.broadcastRoster();
        }
        break;
      }
    }
  }

  private onLeave(ws: WebSocket): void {
    if (!this.sessions.delete(ws)) return;
    try {
      ws.close();
    } catch {
      // すでに閉じている場合は無視
    }
    this.broadcastRoster();
    if (this.sessions.size === 0) this.stopLoop();
  }

  /** 使われていない色を優先して割り当てる。 */
  private pickColor(): string {
    const used = new Set([...this.sessions.values()].map((s) => s.player.color));
    return COLORS.find((c) => !used.has(c)) ?? COLORS[this.nextPlayerId % COLORS.length];
  }

  // ------------------------------------------------------------ ゲームループ

  /**
   * 誰かが居る間だけループを回す。無人になったら止め、再び人が来たら
   * 新しいラウンドを始める (誰も居ない間に時間が進んでしまわないように)。
   */
  private ensureLoop(): void {
    if (this.loop !== null) return;
    this.startRound();
    this.lastTickAt = Date.now();
    this.loop = setInterval(() => this.tick(), TICK_MS);
  }

  private stopLoop(): void {
    if (this.loop === null) return;
    clearInterval(this.loop);
    this.loop = null;
  }

  private tick(): void {
    if (this.sessions.size === 0) {
      this.stopLoop();
      return;
    }

    const now = Date.now();
    // 実際の経過時間で積分する。長すぎるフレームは 100ms に丸めて安定させる。
    const dt = Math.min((now - this.lastTickAt) / 1000, 0.1);
    this.lastTickAt = now;

    if (this.phase === 'playing') {
      this.movePlayers(dt);
      this.separatePlayers();
      this.collectOrbs(now);
      if (now >= this.phaseEndsAt) this.endRound(now);
    } else if (now >= this.phaseEndsAt) {
      this.startRound();
    }

    this.broadcastState(now);
    this.fx.length = 0;
  }

  private movePlayers(dt: number): void {
    // 指数補間なので tick 間隔が揺れても挙動が変わらない。
    const k = 1 - Math.exp(-ACCEL * dt);
    for (const { player: p } of this.sessions.values()) {
      p.vx += (p.ix * MAX_SPEED - p.vx) * k;
      p.vy += (p.iy * MAX_SPEED - p.vy) * k;
      p.x = clamp(p.x + p.vx * dt, PLAYER_R, WORLD_W - PLAYER_R);
      p.y = clamp(p.y + p.vy * dt, PLAYER_R, WORLD_H - PLAYER_R);
    }
  }

  /** プレイヤー同士が重ならないよう押し出す。体で進路をふさげるのが楽しい。 */
  private separatePlayers(): void {
    const players = [...this.sessions.values()].map((s) => s.player);
    const minDist = PLAYER_R * 2;
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        const a = players[i];
        const b = players[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        if (d >= minDist) continue;
        if (d === 0) {
          // 完全に重なったときは適当な向きに散らす。
          dx = Math.random() - 0.5;
          dy = Math.random() - 0.5;
          d = Math.hypot(dx, dy) || 1;
        }
        const push = (minDist - d) / 2;
        const nx = (dx / d) * push;
        const ny = (dy / d) * push;
        a.x = clamp(a.x - nx, PLAYER_R, WORLD_W - PLAYER_R);
        a.y = clamp(a.y - ny, PLAYER_R, WORLD_H - PLAYER_R);
        b.x = clamp(b.x + nx, PLAYER_R, WORLD_W - PLAYER_R);
        b.y = clamp(b.y + ny, PLAYER_R, WORLD_H - PLAYER_R);
      }
    }
  }

  private collectOrbs(now: number): void {
    for (const { player: p } of this.sessions.values()) {
      for (const orb of this.orbs) {
        const r = PLAYER_R + (orb.gold ? GOLD_R : ORB_R);
        if (Math.hypot(orb.x - p.x, orb.y - p.y) > r) continue;

        p.score += orb.gold ? GOLD_SCORE : ORB_SCORE;
        p.lastScoreAt = now;
        this.fx.push({ x: orb.x, y: orb.y, gold: orb.gold });
        this.respawnOrb(orb);
      }
    }
  }

  // ------------------------------------------------------------ ラウンド進行

  private startRound(): void {
    this.phase = 'playing';
    this.phaseEndsAt = Date.now() + ROUND_MS;
    for (const { player: p } of this.sessions.values()) {
      p.score = 0;
    }
    this.spawnOrbs();
  }

  private endRound(now: number): void {
    this.phase = 'result';
    this.phaseEndsAt = now + RESULT_MS;

    const top = [...this.sessions.values()]
      .map((s) => s.player)
      .sort((a, b) => b.score - a.score)[0];
    if (top && top.score > 0 && (!this.best || top.score > this.best.score)) {
      this.best = { name: top.name, score: top.score, at: now };
      // 永続化は待たない (ゲームループを止めないため)。
      void this.ctx.storage.put('best', this.best);
    }
  }

  private spawnOrbs(): void {
    this.orbs = [];
    for (let i = 0; i < ORB_COUNT; i++) {
      this.orbs.push({ id: this.nextOrbId++, x: 0, y: 0, gold: false });
      this.respawnOrb(this.orbs[i]);
    }
  }

  /**
   * 拾われたオーブを別の場所に出し直す。
   * 他のオーブに重なったり、プレイヤーの目の前にタダで湧いたりしないよう、
   * 何度か引き直して一番マシな場所を選ぶ。
   */
  private respawnOrb(orb: Orb): void {
    const margin = 40;
    const others = this.orbs.filter((o) => o !== orb);
    const players = [...this.sessions.values()].map((s) => s.player);

    let bestX = 0;
    let bestY = 0;
    let bestGap = -1;

    for (let attempt = 0; attempt < 12; attempt++) {
      const x = rand(margin, WORLD_W - margin);
      const y = rand(margin, WORLD_H - margin);

      let gap = Infinity;
      for (const o of others) gap = Math.min(gap, Math.hypot(o.x - x, o.y - y));
      // プレイヤーからはオーブ同士よりも大きく離したいので、距離を割り引いて評価する。
      for (const p of players) gap = Math.min(gap, Math.hypot(p.x - x, p.y - y) * 0.7);

      if (gap > bestGap) {
        bestGap = gap;
        bestX = x;
        bestY = y;
      }
      if (gap >= 70) break;
    }

    orb.id = this.nextOrbId++;
    orb.gold = Math.random() < GOLD_CHANCE;
    orb.x = bestX;
    orb.y = bestY;
  }

  private async loadBest(): Promise<void> {
    if (this.bestLoaded) return;
    this.bestLoaded = true;
    this.best = (await this.ctx.storage.get<BestRecord>('best')) ?? null;
  }

  // -------------------------------------------------------------- 送信まわり

  /** 名前と色は変化が少ないので、入退室時だけ別メッセージで配る。 */
  private broadcastRoster(): void {
    const players = [...this.sessions.values()].map(({ player: p }) => ({
      id: p.id,
      name: p.name,
      color: p.color,
    }));
    this.broadcast({ t: 'roster', players });
  }

  /**
   * 毎 tick の状態配信。20Hz で流れるので配列化して短くしている。
   * p: [id, x, y, score, 直近に得点したか]
   * o: [id, x, y, ゴールドか]
   * f: [x, y, ゴールドか]  (この tick に発生した取得エフェクト)
   */
  private broadcastState(now: number): void {
    const payload = JSON.stringify({
      t: 'state',
      ph: this.phase,
      tl: Math.max(0, this.phaseEndsAt - now),
      best: this.best,
      p: [...this.sessions.values()].map(({ player: p }) => [
        p.id,
        Math.round(p.x),
        Math.round(p.y),
        p.score,
        now - p.lastScoreAt < 400 ? 1 : 0,
      ]),
      o: this.orbs.map((o) => [o.id, Math.round(o.x), Math.round(o.y), o.gold ? 1 : 0]),
      f: this.fx.map((f) => [Math.round(f.x), Math.round(f.y), f.gold ? 1 : 0]),
    });
    for (const ws of this.sessions.keys()) {
      this.sendRaw(ws, payload);
    }
  }

  private broadcast(msg: unknown): void {
    const payload = JSON.stringify(msg);
    for (const ws of this.sessions.keys()) {
      this.sendRaw(ws, payload);
    }
  }

  private send(ws: WebSocket, msg: unknown): void {
    this.sendRaw(ws, JSON.stringify(msg));
  }

  private sendRaw(ws: WebSocket, payload: string): void {
    try {
      ws.send(payload);
    } catch {
      // 送信できない接続は切れているので回収する。
      this.onLeave(ws);
    }
  }
}

// ------------------------------------------------------------------ ユーティリティ

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** 制御文字を落として長さを制限する。空なら「ゲスト」。 */
function sanitizeName(raw: string | null): string {
  const name = (raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, MAX_NAME_LEN);
  return name.length > 0 ? name : 'ゲスト';
}
