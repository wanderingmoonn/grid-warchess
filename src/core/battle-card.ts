/**
 * 战报卡：一局打完，把"这局到底发生了什么"压成一张能存、能发的卡。
 *
 * 为什么要有它：结算卡（右侧那块"要不要捐数据"）是给系统看的，字段是种子、
 * 扩展数、packSize；玩家打完一局真正想记住的是另外三件事——**第几回合破的城、
 * 哪个兵最猛、转折在哪**。这两件事的目标不同，硬凑在一张卡上谁都不满意。
 *
 * 数据全部来自 GameState，不依赖录制器：关掉"详细记录"的局也要能出卡。
 * 唯一借用的历史信息是 `city.capturedTurn`（攻陷回合），那是规则自己写的。
 */
import { citiesOf, cityName, unitsOf, utype } from './rules.ts';
import { seatsOf } from './types.ts';
import type { GameState, PlayerId } from './types.ts';

export interface BattleCardSide {
  side: PlayerId;
  name: string;
  units: number;
  cities: number;
  /** 终局总血量：一万个残血兵和一队满血兵不是一回事 */
  hp: number;
  era: number;
}

export interface BattleCardData {
  winner: PlayerId | null;
  /** 看这张卡的人是哪一席（决定"我方/对方"的口径） */
  me: PlayerId;
  /** 你赢了没有 */
  iWon: boolean;
  board: string;
  /** 总共推了多少回合 */
  turns: number;
  /** 破城回合：最早一座被夺走的敌城。没破城就是 null */
  winTurn: number | null;
  /** 我方击杀最多的兵种 */
  mvp: { type: string; name: string; kills: number; alive: number } | null;
  /** 关键三步：开局 / 破城 / 定局 */
  steps: string[];
  sides: BattleCardSide[];
  seed: number;
  build: string;
}

const sideStats = (s: GameState, p: PlayerId): BattleCardSide => {
  const us = unitsOf(s, p).filter((u) => utype(s, u.type).category !== 'building');
  const cities = citiesOf(s, p).filter((c) => !c.ruined);
  return {
    side: p,
    name: s.players[p]?.name ?? `${p} 方`,
    units: us.length,
    cities: cities.length,
    hp: us.reduce((n, u) => n + Math.max(0, u.hp), 0),
    era: cities.length > 0 ? Math.max(...cities.map((c) => c.era)) : 0,
  };
};

/**
 * 敌方席位（两人局就一个，多人局取全部）。
 *
 * 必须走 `seatsOf` 而不是 `Object.keys(s.players)`：状态里的 players 恒有
 * A/B/C/D 四个键（存档结构固定），两人局照样四键齐全，直接遍历会凭空多出
 * 两个 0 兵 0 城的"幽灵席位"，卡面统计和"我方打对方几个"全会错。
 */
const foesOf = (s: GameState, me: PlayerId): PlayerId[] =>
  seatsOf(s).filter((p) => p !== me && s.players[p]);

/**
 * 破城回合：**某一方**最早一次夺城的回合。
 *
 * 用 `capturedTurn` 而不是去扫战报文本：战报里有"归你"这类人话，
 * 文案一改这个数就没了；`capturedTurn` 是规则在接管那一刻写进去的，改文案不影响它。
 *
 * 注意找的是"现在归他"的城——城一旦被夺，owner 就换成他了，所以从 `owner === by`
 * 这一侧找才对得上（第一版从"owner !== 我"找，破城那一刻城已经归我了，永远是 null）。
 */
function firstCaptureTurn(
  s: GameState,
  by: PlayerId | null,
): { turn: number; city: string } | null {
  if (!by) return null;
  let best: { turn: number; city: string } | null = null;
  for (const c of s.cities) {
    if (c.owner !== by || c.capturedTurn === undefined) continue;
    if (!best || c.capturedTurn < best.turn) {
      best = { turn: c.capturedTurn, city: cityName(c) };
    }
  }
  return best;
}

/**
 * 我方击杀最多的兵种。
 *
 * 数据源分两层，顺序不能反：
 *   1. `state.killTally` —— 规则层在 `fireKilled` 里按"击杀方 × 击杀者兵种"累计的，
 *      单位死了也不丢。这是主路径。
 *   2. 活着的单位身上攒的 `unit.kills` —— 只有旧存档/旧复盘才缺 killTally。
 *      兜底而已：这个数以前只有「老兵不死」在维护，拿它当主数据源的话，
 *      没开那个包的对局里 MVP 永远是空的（这就是这个字段最初坏掉的原因）。
 *
 * 并列时取终局存活多的（"还站着"的更值得吹）。
 *
 * 不按 category 过滤掉建筑：军营、箭塔真的会杀人。把建筑排除掉会出现
 * "营地砍了 6 个，卡面却写没有击杀"——那比让建筑上榜更难看。
 */
function bestUnit(s: GameState, me: PlayerId): BattleCardData['mvp'] {
  const kills = new Map<string, number>();
  const tally = s.killTally?.[me];
  const hasTally = !!tally && Object.keys(tally).length > 0;

  if (hasTally) {
    for (const [type, n] of Object.entries(tally!)) {
      if (!n || n <= 0 || !s.unitTypes[type]) continue;
      kills.set(type, n);
    }
  } else {
    for (const u of unitsOf(s, me)) {
      if (!u.kills) continue;
      kills.set(u.type, (kills.get(u.type) ?? 0) + u.kills);
    }
  }

  const aliveByType = new Map<string, number>();
  for (const u of unitsOf(s, me)) {
    aliveByType.set(u.type, (aliveByType.get(u.type) ?? 0) + 1);
  }

  let best: { type: string; kills: number; alive: number } | null = null;
  for (const [type, n] of kills) {
    const alive = aliveByType.get(type) ?? 0;
    if (!best || n > best.kills || (n === best.kills && alive > best.alive)) {
      best = { type, kills: n, alive };
    }
  }
  if (!best || best.kills <= 0) return null;
  return { ...best, name: s.unitTypes[best.type]?.name ?? best.type };
}

export function buildBattleCard(s: GameState, me: PlayerId, build: string): BattleCardData {
  const foes = foesOf(s, me);
  const mine = sideStats(s, me);
  const theirs = foes.map((p) => sideStats(s, p));
  // 破城回合按**赢家**算：输了也要能说清"对方第几回合破的城"
  const by = s.winner ?? me;
  const cap = firstCaptureTurn(s, by);
  const mvp = bestUnit(s, me);
  const winTurn = cap?.turn ?? null;

  const steps: string[] = [];
  steps.push(
    `开局：${s.w}×${s.h}，第 ${s.config.startEra ?? 1} 代起手` +
      ((s.config.expansionIds?.length ?? 0) > 0 ? `，${s.config.expansionIds!.length} 个扩展` : ''),
  );
  if (cap) {
    steps.push(`第 ${cap.turn} 回合${by === me ? '你' : '对方'}拿下第一座城：${cap.city}`);
  } else {
    steps.push('整局没破城——赢的方式不是攻城');
  }
  const foeUnits = theirs.reduce((n, x) => n + x.units, 0);
  steps.push(`第 ${s.turn} 回合定局：${mine.units} 兵对 ${foeUnits} 兵，血量 ${mine.hp} 对 ${theirs.reduce((n, x) => n + x.hp, 0)}`);

  return {
    winner: s.winner,
    me,
    iWon: s.winner === me,
    board: `${s.w}×${s.h}`,
    turns: s.turn,
    winTurn,
    mvp,
    steps,
    sides: [mine, ...theirs],
    seed: s.seed,
    build,
  };
}

/** 卡面文案（复制到聊天框的那一份，和图上写的一致） */
export function battleCardText(d: BattleCardData): string {
  // 「胜利/失败」而不是「我赢了/我输了」：这段文字是拿去转发的，
  // 第一人称在别人手里会被读成他自己赢了/输了。
  const head = d.winner
    ? d.iWon
      ? `胜利 · 第 ${d.winTurn ?? d.turns} 回合破城`
      : `失败 · 撑到第 ${d.turns} 回合`
    : `平局 · 打了 ${d.turns} 回合`;
  const lines = [
    `【战报】${head}`,
    `${d.board} · 种子 ${d.seed} · v${d.build}`,
    d.mvp ? `MVP：${d.mvp.name}（击杀 ${d.mvp.kills}）` : 'MVP：这一局没有击杀',
    ...d.steps.map((x) => `· ${x}`),
    d.sides.map((x) => `${x.name} ${x.units} 兵 / ${x.cities} 城 / 时代 ${x.era}`).join('　'),
  ];
  return lines.join('\n');
}
