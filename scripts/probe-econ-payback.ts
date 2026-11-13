/**
 * 经济单位的"回本回合"实测。
 *
 * ── 为什么不用 cost ÷ 产出 算 ──────────────────────────────────────
 *
 * 那个除法少算了一件事：**经济单位得先走到地形上才能开始挣**。
 * 新造出来的单位当回合动不了（`moved` 是 true），下一回合走出去，
 * 再下一回合才按地形结算——中间那两轮它是 0 收入（城市不在它的产出表里）。
 *
 * 只有一类单位不受这个影响：产出表里**城市**就是它最好的地形。
 * 城市里造、城市里站，第一轮就按满额结算。实测就是用来量这个差值的。
 *
 * ── 量法 ─────────────────────────────────────────────────────────
 *
 * 真跑 `applyAction`：每轮在"自己回合开始"读一次收入，然后让单位往最好的
 * 地形走（走不动就原地），再交回合。控制组（不放这个单位）跑一遍，
 * 两边的差额就是这个单位这一轮真正贡献的金币——包括它站着不挣的那几轮。
 *
 * 用法：
 *   node --experimental-strip-types scripts/probe-econ-payback.ts
 *   node --experimental-strip-types scripts/probe-econ-payback.ts --era 3 --rounds 16
 *   node --experimental-strip-types scripts/probe-econ-payback.ts --qm 20      # 试算军需官城市产出
 */

import { applyAction, reachableTiles, tileAt, unitYield, utype } from '../src/core/rules.ts';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import { placeUnit } from '../src/core/sandbox.ts';
import type { GameState, PlayerId } from '../src/core/types.ts';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};

const ERA = Number(argOf('era', '3'));
const ROUNDS = Number(argOf('rounds', '16'));
const SIZE = Number(argOf('size', '16'));
/** 试算用：临时改军需官的城市产出，不落盘 */
const QM = Number(argOf('qm', '0'));

interface Curve {
  type: string;
  name: string;
  cost: number;
  /** 每一轮这个单位贡献的金币（下标 0 = 造出来的下一轮） */
  perRound: number[];
  /** 第几轮累计收入 ≥ 造价（-1 表示 rounds 内没回本） */
  payback: number;
  /** 稳态收入（最后三轮的平均） */
  steady: number;
}

function playGame(typeId: string, seed: number): Curve | null {
  const s0 = createMatch(
    {
      ...DEFAULT_CONFIG,
      size: SIZE,
      startEra: ERA,
      playerCount: 2,
      aiOpponent: false,
      aiAlly: false,
      // 「时代军备」：军需官、种植园主那一批都在这个包里，不开就查不到
      expansionIds: ['era-arms'],
    } as never,
    seed,
  );
  if (QM > 0 && s0.unitTypes['gp_quartermaster']) {
    s0.unitTypes['gp_quartermaster'] = {
      ...s0.unitTypes['gp_quartermaster'],
      incomeByTerrain: {
        city: QM,
        plain: Math.round(QM * 0.55),
        hill: Math.round(QM * 0.31),
        forest: Math.round(QM * 0.25),
      },
    };
  }
  const def = s0.unitTypes[typeId];
  if (!def) return null;

  // 清场：只留城市，避免别人的兵干扰收入和走位
  s0.units = [];
  s0.winner = null;
  const me: PlayerId = 'A';
  const city = s0.cities.find((c) => c.owner === me);
  if (!city) return null;

  const spot = { x: city.x, y: city.y };
  // placeUnit 是纯函数：它把新单位放进**返回的那份 state**，不改入参
  const placed = placeUnit(s0, me, typeId, spot.x, spot.y);
  if (!placed.ok || !placed.state) return null;
  let s: GameState = placed.state;

  // 目标地形：产出表里最高的那一格
  const table = utype(s, typeId).incomeByTerrain ?? {};
  let bestTerrain = '';
  let bestIncome = -1;
  for (const [t, n] of Object.entries(table)) {
    if ((n ?? 0) > bestIncome) {
      bestIncome = n ?? 0;
      bestTerrain = t;
    }
  }

  /** 找一个离城最近的、属于目标地形的空格 */
  const target = (() => {
    if (!bestTerrain || bestTerrain === 'city') return null;
    let best: { x: number; y: number } | null = null;
    let bestD = Infinity;
    for (let y = 0; y < s.h; y++) {
      for (let x = 0; x < s.w; x++) {
        const t = tileAt(s, x, y);
        if (!t || t.terrain !== bestTerrain || t.cityId) continue;
        if (s.units.some((u) => u.x === x && u.y === y)) continue;
        const d = Math.abs(x - spot.x) + Math.abs(y - spot.y);
        if (d < bestD) {
          bestD = d;
          best = { x, y };
        }
      }
    }
    return best;
  })();

  const perRound: number[] = [];
  let unitId: string | null = s.units[s.units.length - 1]?.id ?? null;
  let cumulative = 0;
  let payback = -1;

  for (let r = 0; r < ROUNDS; r++) {
    // 保证轮到自己
    for (let guard = 0; s.current !== me && guard < 4; guard += 1) {
      const e = applyAction(s, { type: 'END_TURN' });
      if (!e.ok) break;
      s = e.state;
      s.winner = null;
    }
    if (s.current !== me) break;

    const unit = unitId ? s.units.find((u) => u.id === unitId) : undefined;
    if (!unit) break;

    // ① 回合开始结算：这个单位这一轮贡献多少
    const gain = unitYield(s, unit).gold ?? 0;
    perRound.push(gain);
    cumulative += gain;
    if (payback < 0 && cumulative >= def.cost) payback = r + 1;

    // ② 然后才轮到它行动：往目标地形走
    if (target && !unit.moved) {
      const u = unit;
      if (u.x !== target.x || u.y !== target.y) {
        const reach = reachableTiles(s, u);
        let pick: { x: number; y: number } | null = null;
        let pickD = Math.abs(u.x - target.x) + Math.abs(u.y - target.y);
        for (const i of reach.keys()) {
          const x = i % s.w;
          const y = Math.floor(i / s.w);
          if (x === u.x && y === u.y) continue;
          const d = Math.abs(x - target.x) + Math.abs(y - target.y);
          if (d < pickD) {
            pickD = d;
            pick = { x, y };
          }
        }
        if (pick) {
          const m = applyAction(s, { type: 'MOVE', unitId: u.id, x: pick.x, y: pick.y });
          if (m.ok) {
            s = m.state;
            s.winner = null;
          }
        }
      }
    }

    // ③ 交回合再回来
    const e1 = applyAction(s, { type: 'END_TURN' });
    if (!e1.ok) break;
    s = e1.state;
    s.winner = null;
    if (s.current === me) continue;
    const e2 = applyAction(s, { type: 'END_TURN' });
    if (!e2.ok) break;
    s = e2.state;
    s.winner = null;
  }

  const tail = perRound.slice(-3);
  const steady = tail.length ? tail.reduce((a, b) => a + b, 0) / tail.length : 0;
  return { type: typeId, name: def.name, cost: def.cost, perRound, payback, steady };
}

const TYPES = argOf(
  'types',
  'farmer,herder,lumberjack,planter,quarryman,gp_quartermaster,factory',
).split(',');

const rows: Curve[] = [];
for (const t of TYPES) {
  // 跑三局取中位（地图不同，走到的地形距离也不同）
  const runs = [11, 12, 13].map((seed) => playGame(t, seed)).filter((c): c is Curve => !!c);
  if (runs.length === 0) continue;
  runs.sort((a, b) => a.payback - b.payback);
  rows.push(runs[Math.floor(runs.length / 2)]!);
}

rows.sort((a, b) => a.payback - b.payback);
console.log(`时代 ${ERA} · 全程真跑 applyAction · 取三局中位\n`);
console.log('单位          造价  第1轮  第2轮  第3轮  稳态  回本轮次  各轮收入');
for (const r of rows) {
  const head = r.perRound.slice(0, 6).map((n) => String(n).padStart(4)).join(' ');
  console.log(
    `${r.name.padEnd(7, '　')} ${String(r.cost).padStart(5)} ${head}  ${r.steady.toFixed(1).padStart(4)}  ` +
      `${String(r.payback).padStart(6)}    ${r.perRound.join(',')}`,
  );
}
