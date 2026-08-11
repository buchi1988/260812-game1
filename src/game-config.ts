/** ゲームバランスを一箇所にまとめた設定値。 */

/**
 * アリーナの論理サイズ。クライアントは接続時にこの値を受け取って描画をスケールする。
 * 正方形にしてあるのは、横長のモニタでも縦持ちのスマホでも
 * 同じくらいの大きさで全体が見えるようにするため。
 */
export const WORLD_W = 800;
export const WORLD_H = 800;

/** サーバーのシミュレーション頻度 (20Hz)。 */
export const TICK_MS = 50;

/** 1 ルームあたりの最大同時接続数。 */
export const MAX_PLAYERS = 16;

/** プレイヤーの見た目・挙動。 */
export const PLAYER_R = 18;
export const MAX_SPEED = 260;
/** 速度の追従係数。大きいほどキビキビ動く (フレームレート非依存)。 */
export const ACCEL = 14;

/** オーブ (得点アイテム)。 */
export const ORB_COUNT = 14;
export const ORB_R = 10;
export const GOLD_R = 15;
/** 出現するオーブがゴールドになる確率。 */
export const GOLD_CHANCE = 0.14;
export const ORB_SCORE = 1;
export const GOLD_SCORE = 3;

/** ラウンドの長さと、結果表示 (次ラウンドまでの待ち時間)。 */
export const ROUND_MS = 90_000;
export const RESULT_MS = 8_000;

/** 名前の最大文字数。 */
export const MAX_NAME_LEN = 12;

/**
 * プレイヤーに割り当てる色のパレット。
 * オーブの色 (水色 #4dd0ff / 金 #ffd166) と紛らわしくならないよう、
 * 水色系と黄色系はあえて外している。
 */
export const COLORS = [
  '#ff5c8a',
  '#b07aff',
  '#ff9a5c',
  '#a8e85b',
  '#5ce8a0',
  '#7a9dff',
  '#ff6b6b',
  '#ff7ae0',
  '#e02a63',
  '#8a3ce0',
  '#e06a1f',
  '#74c22a',
  '#23c47a',
  '#3f68e0',
  '#e03535',
  '#e03cb4',
] as const;
