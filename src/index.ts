import type { Env } from './env';
import { GameRoom } from './game-room';

export { GameRoom };

/** ルーム名は英数字のみ。同じ名前 = 同じ Durable Object = 同じ試合。 */
const ROOM_PATTERN = /^[A-Z0-9]{1,12}$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/ws') {
      const room = (url.searchParams.get('room') || 'LOBBY').toUpperCase();
      if (!ROOM_PATTERN.test(room)) {
        return new Response('ルーム名は英数字 1〜12 文字にしてください', { status: 400 });
      }
      // ルーム名から決まる ID なので、世界中のどこから繋いでも同じ部屋に入る。
      const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(room));
      return stub.fetch(request);
    }

    // 静的アセット (public/) は Workers Assets が先に処理するので、
    // ここに来るのは未知のパスだけ。
    return new Response('Not Found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
