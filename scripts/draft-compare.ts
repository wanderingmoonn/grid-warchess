/**
 * 选卡新旧对比：同一批种子，老评分 vs 新评分，看选出来的队伍差在哪。
 *
 * 老的 `draftValueOf` 只算数值（`攻 + 0.4×血 + 3×甲 + 3×射程`），
 * 而数值和时代几乎单调相关，于是 AI 把名额全砸在最高时代的大件上；
 * 可城市是从 startEra 起步的，那些兵几十个回合内根本造不出来。
 *
 *   node --experimental-strip-types scripts/draft-compare.ts --games 6
 */
import { aiDraftPick } from '../src/core/draft.ts';
import { remainingUnits } from '../src/core/draft.ts';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import type { GameState, PlayerId, UnitTypeDef } from '../src/core/types.ts';

const args = process.argv.slice(2);
const argOf = (n: string, d: string): string => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : d;
};
const GAMES = Number(argOf('games', '6'));
const START_ERA = Number(argOf('era', '1'));
const EXP = ['fantasy-core', 'fantasy-knights', 'bloodbath', 'turn-order-comp',
  'pack-antiquity', 'pack-medieval', 'pack-gunpowder', 'pack-industry', 'pack-modern'];

/** 老口径：纯数值 */
function oldPick(state: GameState, side: PlayerId): string | null {
  const left = remainingUnits(state);
  if (left.length === 0) return null;
  const mine = new Set(state.draft?.picks[side] ?? []);
  const has = {
    siege: [...mine].some((id) => (state.unitTypes[id]?.splash ?? 0) > 0),
    ranged: [...mine].some((id) => (state.unitTypes[id]?.range ?? 0) >= 3),
    tank: [...mine].some((id) => (state.unitTypes[id]?.maxHp ?? 0) >= 140),
    any: mine.size > 0,
  };
  let best: { id: string; score: number } | null = null;
  for (const id of left) {
    const def = state.unitTypes[id];
    if (!def) continue;
    let score = def.atk + 0.4 * def.maxHp + 3 * def.armor + 3 * def.range;
    if (def.category === 'building') score *= 0.55;
    if (!has.siege && (def.splash ?? 0) > 0) score += 18;
    if (!has.ranged && (def.range ?? 0) >= 3) score += 14;
    if (!has.tank && (def.maxHp ?? 0) >= 140) score += 12;
    if (!has.any && def.era <= 2) score += 8;
    if (!best || score > best.score) best = { id, score };
  }
  return best?.id ?? left[0]!;
}

const stats = {
  old: { era: 0, cost: 0, ready: 0, n: 0 },
  new: { era: 0, cost: 0, ready: 0, n: 0 },
};

for (let g = 0; g < GAMES; g += 1) {
  const seed = 5100 + g * 173;
  for (const which of ['old', 'new'] as const) {
    let s: GameState = createMatch(
      { ...DEFAULT_CONFIG, draftMode: true, aiOpponent: true, startEra: START_ERA, expansionIds: EXP } as never,
      seed,
    );
    // 只模拟"乙方"的选人：甲方那个坑用同样名单顺序跳过，保证池子消耗一致
    const view = remainingUnits(s);
    void view;
    const picks: string[] = [];
    const slots = s.draft!.pickSlots;
    for (let i = 0; i < slots; i += 1) {
      s.current = 'B';
      const id = which === 'old' ? oldPick(s, 'B') : aiDraftPick(s, 'B');
      if (!id) break;
      s.draft!.picks.B = [...s.draft!.picks.B, id];
      s.draft!.order.splice(0, 0);
      picks.push(id);
    }
    for (const id of picks) {
      const d = s.unitTypes[id] as UnitTypeDef;
      const rec = stats[which];
      rec.n += 1;
      rec.era += d.era;
      rec.cost += d.cost ?? 0;
      if (d.era <= START_ERA) rec.ready += 1;
    }
  }
}

for (const which of ['old', 'new'] as const) {
  const r = stats[which];
  console.log(
    `${which === 'old' ? '老评分' : '新评分'}：平均时代 ${(r.era / r.n).toFixed(2)}` +
      `  平均单价 ${(r.cost / r.n).toFixed(0)}` +
      `  开局就能造 ${r.ready}/${r.n}（${((r.ready / r.n) * 100).toFixed(0)}%）`,
  );
}
