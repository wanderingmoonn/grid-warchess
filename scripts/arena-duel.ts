/**
 * 等金对决场：拿**同样一笔钱**的两种兵对打，看谁赢、赢多少。
 *
 * 为什么需要它（而不是只看百局跑批）：跑批里一个兵"造得多不多"由 AI 的
 * 采购偏好决定，而 AI 的估值公式有自己的盲区（比如它数 `atk` 不数 `burst`）。
 * 于是"某个兵没人造"可能只是 AI 不爱买，不是它弱。等金对决把采购这一层拿掉，
 * 只回答"同样 600 金，两边各买一堆，谁打得过谁"。
 *
 * 口径：
 *   · 全图铺平原、去掉城市：不让地形和攻城混进来，纯野战；
 *   · 两边各买 floor(预算 / 单价) 个，摆成两列，间隔 13 格；
 *   · 双方都交给 AI 走子（adopt != null 时只改一边的行为参数，默认同一个 AI）；
 *   · 打到一方全灭或 40 回合，记"剩余身价差"，同时数阵亡；
 *   · 每对组合跑 N 局，交换左右手（A/B 互换），抵消先手优势。
 *
 * 用法：
 *   node --experimental-strip-types scripts/arena-duel.ts --a berserker --b halberdier --gold 600 --games 20
 *   node --experimental-strip-types scripts/arena-duel.ts --matrix            # 跑内置的一组对照
 */
import { aiNextAction } from '../src/core/ai.ts';
import { applyAction, citiesOf, unitsOf, utype } from '../src/core/rules.ts';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import type { GameState, PlayerId } from '../src/core/types.ts';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};
const has = (n: string): boolean => args.includes(`--${n}`);

const GOLD = Number(argOf('gold', '600'));
const GAMES = Number(argOf('games', '20'));
const CAP = Number(argOf('cap', '40'));
const BASE_SEED = Number(argOf('seed', '5100'));
/**
 * `--mod berserker:atk=24,burst=1` —— 临时改一个兵种的数值，用来做"改前 / 改后"对照。
 *
 * 只改这次进程里的兵种表，不落盘、不影响正式数据；改的字段只有
 * atk / burst / armor / maxHp / cost 这五个（对比"同一套规则下换个数值"够用了）。
 */
const MOD = (() => {
  const spec = argOf('mod', '');
  const out = new Map<string, Record<string, number>>();
  if (!spec) return out;
  for (const part of spec.split(';')) {
    const [type, body] = part.split(':');
    if (!type || !body) continue;
    const fields: Record<string, number> = {};
    for (const kv of body.split(',')) {
      const [k, v] = kv.split('=');
      if (k && v !== undefined && Number.isFinite(Number(v))) fields[k.trim()] = Number(v);
    }
    out.set(type.trim(), fields);
  }
  return out;
})();

const EXPANSIONS = ['pack-contemporary', 'fantasy-core', 'fantasy-knights', 'fantasy-beasts', 'fantasy-arcane', 'fantasy-heroes'];

interface Fight {
  /** A 方剩余身价 - B 方剩余身价 */
  margin: number;
  aLeft: number;
  bLeft: number;
  turns: number;
  aCount: number;
  bCount: number;
}

function arena(seed: number, typeA: string, typeB: string): Fight | null {
  let s: GameState = createMatch(
    { ...DEFAULT_CONFIG, startEra: 3, size: 20, expansionIds: EXPANSIONS, aiOpponent: false, aiAlly: false },
    seed,
  );
  for (const [type, fields] of MOD) {
    const d = s.unitTypes[type] as unknown as Record<string, number> | undefined;
    if (!d) continue;
    for (const [k, v] of Object.entries(fields)) d[k] = v;
  }
  const defA = s.unitTypes[typeA];
  const defB = s.unitTypes[typeB];
  if (!defA || !defB) return null;

  /*
   * 平地：只测野战。
   *
   * **城要留着**。AI 的推进方向是"离敌方城市多远"，把城删掉之后所有距离都是
   * 无穷远，两边就站在原地面面相觑（第一版正是这样，40 回合 0 阵亡）。
   * 城留在棋盘上只当罗盘，真正判定还是看谁的人先没了。
   */
  for (const t of s.tiles) if (t.terrain !== 'city') t.terrain = 'plain';
  s.units = [];
  s.current = 'A';

  const nA = Math.max(1, Math.floor(GOLD / defA.cost));
  const nB = Math.max(1, Math.floor(GOLD / defB.cost));
  // 两边各站在"自己城往中间走四格"的位置，中间留出 6~8 格接触距离
  const cityA = citiesOf(s, 'A')[0];
  const cityB = citiesOf(s, 'B')[0];
  if (!cityA || !cityB) return null;
  const midY = Math.floor(s.h / 2);
  const place = (owner: PlayerId, type: string, count: number, x: number): void => {
    for (let i = 0; i < count; i += 1) {
      const y = midY - Math.floor((count - 1) / 2) + i;
      s.units.push({
        id: `${owner}-${type}-${i}`,
        type,
        owner,
        x: Math.max(0, Math.min(s.w - 1, x)),
        y: Math.max(0, Math.min(s.h - 1, y)),
        hp: s.unitTypes[type].maxHp,
        kills: 0,
        moved: false,
        acted: false,
      });
    }
  };
  const dirA = cityA.x < cityB.x ? 1 : -1;
  place('A', typeA, nA, cityA.x + dirA * 4);
  place('B', typeB, nB, cityB.x - dirA * 4);

  let turns = 0;
  for (; turns < CAP; turns += 1) {
    // 一方没了就结束
    if (unitsOf(s, 'A').length === 0 || unitsOf(s, 'B').length === 0) break;
    /*
     * 双方每回合金库清零：城还在，AI 就会拿收入继续造兵，
     * 于是"5 个打 6 个"变成"一直造到 40 回合"（第一版剩余个数比开局还多）。
     * 对决场只问既定阵容谁赢，钱这条线必须掐掉。
     */
    s.players.A.gold = 0;
    s.players.B.gold = 0;
    for (let step = 0; step < 400; step += 1) {
      if (unitsOf(s, 'A').length === 0 || unitsOf(s, 'B').length === 0) break;
      const a = aiNextAction(s);
      if (!a) break;
      const r = applyAction(s, a);
      if (!r.ok) break;
      s = r.state;
    }
    const e = applyAction(s, { type: 'END_TURN' });
    if (!e.ok) break;
    s = e.state;
  }

  const aUnits = unitsOf(s, 'A');
  const bUnits = unitsOf(s, 'B');
  // 剩余身价按血量比例折算：一个还剩三成血的兵，不该和第二排满血的一个价
  const worth = (list: typeof aUnits): number =>
    list.reduce((n, u) => {
      const d = utype(s, u.type);
      return n + (d.cost * u.hp) / Math.max(1, d.maxHp);
    }, 0);
  return {
    margin: worth(aUnits) - worth(bUnits),
    aLeft: aUnits.length,
    bLeft: bUnits.length,
    turns,
    aCount: nA,
    bCount: nB,
  };
}

function duel(typeA: string, typeB: string): void {
  let aWins = 0;
  let bWins = 0;
  let marginSum = 0;
  let aLeftSum = 0;
  let bLeftSum = 0;
  let n = 0;
  let turns = 0;
  for (let g = 0; g < GAMES; g += 1) {
    // 交换左右手：同一颗种子跑两次，A/B 各执一次
    for (const swap of [false, true]) {
      const [x, y] = swap ? [typeB, typeA] : [typeA, typeB];
      const r = arena(BASE_SEED + g, x, y);
      if (!r) return;
      const m = swap ? -r.margin : r.margin;
      const aLeft = swap ? r.bLeft : r.aLeft;
      const bLeft = swap ? r.aLeft : r.bLeft;
      n += 1;
      turns += r.turns;
      marginSum += m;
      aLeftSum += aLeft;
      bLeftSum += bLeft;
      // 剩余身价高者胜；相等记平（不计入胜率分子）
      if (m > 0) aWins += 1;
      else if (m < 0) bWins += 1;
    }
  }
  const nameA = createMatch({ ...DEFAULT_CONFIG, startEra: 3, expansionIds: EXPANSIONS }, 1).unitTypes[typeA]?.name ?? typeA;
  const nameB = createMatch({ ...DEFAULT_CONFIG, startEra: 3, expansionIds: EXPANSIONS }, 1).unitTypes[typeB]?.name ?? typeB;
  const rate = n > 0 ? aWins / n : 0;
  console.log(
    `${nameA}(${typeA}) vs ${nameB}(${typeB})　${n} 场：` +
      `${aWins} 胜 / ${bWins} 负 / ${n - aWins - bWins} 平　胜率 ${(rate * 100).toFixed(1)}%　` +
      `平均剩余身价差 ${(marginSum / Math.max(1, n)).toFixed(0)}　` +
      `剩余个数 ${(aLeftSum / Math.max(1, n)).toFixed(1)} : ${(bLeftSum / Math.max(1, n)).toFixed(1)}　` +
      `均 ${(turns / Math.max(1, n)).toFixed(1)} 回合`,
  );
}

const A = argOf('a', 'berserker');
if (has('matrix')) {
  const peers = ['halberdier', 'musketeer', 'knight', 'druid', 'harpy', 'vampire', 'paladin', 'royal-cavalry', 'serpent-man'];
  for (const p of peers) duel(A, p);
} else {
  duel(A, argOf('b', 'halberdier'));
}
