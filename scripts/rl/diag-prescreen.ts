/**
 * 诊断：**策略为什么不会运营**（造兵之外的动作几乎不出现）。
 *
 * ── 要回答的问题 ────────────────────────────────────────────────────────
 *
 * 复盘看得很清楚：策略一局能堆 18 个弓箭手、0 座建筑、时代停在 1；
 * 对面的手写 AI 有 5~7 座建筑、时代 4~5。两条完全不同的发展路线，
 * 而"拖下去"这条路上老 AI 赢。
 *
 * 但"不运营"有两种完全不同的原因，修法也完全不同：
 *
 *   H1（候选问题，欠账 B2）：预筛是随机初始化、冻结、取 top-64。
 *      如果 BUILD / UPGRADE 连**候选集**都挤不进去，策略再准也选不到；
 *      这时候要做的是按类型保底名额，或者解冻预筛。
 *
 *   H2（视野问题，欠账 B4/B9）：候选里有，但策略不选。
 *      因为"造建筑 → 3 回合后多产出 → 8 回合后能出高级兵"这种回报太远，
 *      折扣之后接近 0，而"再造一个弓箭手"当回合就有战力。
 *      这时候要做的是提高折扣因子、奖励塑形，或者加推理期搜索。
 *
 * 这个脚本就是分辨两者的：对每一步决策，统计
 *   · 这类动作有多少个**合法**
 *   · 其中多少个进了**候选集**（预筛 top-K）
 *   · 最后**被选中**了几次
 *
 * 判据很干脆：
 *   · BUILD 的"进候选率"很低（<30%）而合法量不少 → H1 成立，改预筛。
 *   · BUILD 的进候选率不低、但"被选率"接近 0 → H2 成立，改视野/奖励，别动预筛。
 *
 * 用法：
 *   node --experimental-strip-types scripts/rl/diag-prescreen.ts \
 *        --weights .tmp/mix2/weights-12.json --games 12 --size 12 --seed0 5000
 */
import path from 'node:path';

import { Policy, weightsFromJson } from '../../src/rl/policy.ts';
import { legalActions } from '../../src/rl/legal.ts';
import { playMatch } from './play.ts';
import { TRAIN } from './config.ts';
import fs from 'node:fs';
import type { Action, PlayerId } from '../../src/core/types.ts';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};

const WEIGHTS = argOf('weights', path.join('scripts', 'rl', 'weights', 'v2-specialist.json'));
const GAMES = Number(argOf('games', '12'));
const SIZE = Number(argOf('size', String(TRAIN.size)));
const SEED0 = Number(argOf('seed0', '5000'));
const CAP = Number(argOf('cap', String(TRAIN.capTurns)));

const policy = new Policy(weightsFromJson(JSON.parse(fs.readFileSync(WEIGHTS, 'utf8'))));

/** 动作类型 → 统计桶（HERO_SKILL 之类先按原样分，别合并——合并会看不出是哪一类） */
const kinds = new Map<string, { legal: number; cand: number; chosen: number; stepsWithLegal: number; stepsNoneCand: number }>();
const recruitUnits = new Map<string, number>();
const bucket = (k: string) => {
  let b = kinds.get(k);
  if (!b) {
    b = { legal: 0, cand: 0, chosen: 0, stepsWithLegal: 0, stepsNoneCand: 0 };
    kinds.set(k, b);
  }
  return b;
};

let decisions = 0;
let legalTotal = 0;

/** 一局的策略可能坐 A 也可能坐 B——座位交替的口径，诊断也照做 */
for (let i = 0; i < GAMES; i++) {
  const seed = SEED0 + (i >> 1);
  const seat: PlayerId = i & 1 ? 'B' : 'A';
  playMatch({
    seed,
    size: SIZE,
    expansionIds: TRAIN.expansions,
    aiLevel: TRAIN.aiLevel,
    aiHandicap: 0,
    capTurns: CAP,
    drivers:
      seat === 'A' ? [{ kind: 'policy', policy }, { kind: 'ai' }] : [{ kind: 'ai' }, { kind: 'policy', policy }],
    onStep: (info) => {
      const dec = info.decision;
      if (!dec) return; // 对手（手写 AI）那边不记
      decisions += 1;
      // 重新枚举一遍：候选集里的下标记的是"这一次 decide 拿到的那个数组"
      const acts: Action[] = legalActions(info.state, info.seat);
      legalTotal += acts.length;
      const inCand = new Set(dec.candidates);

      const perKind = new Map<string, { legal: number; cand: number }>();
      acts.forEach((a, idx) => {
        const k = a.type;
        const rec = perKind.get(k) ?? { legal: 0, cand: 0 };
        rec.legal += 1;
        if (inCand.has(idx)) rec.cand += 1;
        perKind.set(k, rec);
      });
      for (const [k, rec] of perKind) {
        const b = bucket(k);
        b.legal += rec.legal;
        b.cand += rec.cand;
        b.stepsWithLegal += 1;
        if (rec.cand === 0) b.stepsNoneCand += 1;
      }
      const chosenKind = info.action.type;
      bucket(chosenKind).chosen += 1;
      if (chosenKind === 'RECRUIT') {
        const id = (info.action as { unitType?: string }).unitType ?? '?';
        recruitUnits.set(id, (recruitUnits.get(id) ?? 0) + 1);
      }
    },
  });
}

const pct = (a: number, b: number) => (b > 0 ? `${((100 * a) / b).toFixed(1)}%` : '—');
const rows = [...kinds.entries()].sort((a, b) => b[1].legal - a[1].legal);

console.log(
  `\n${path.basename(WEIGHTS)} · ${SIZE}×${SIZE} · ${GAMES} 局 · 决策 ${decisions} 步 · ` +
    `平均每步 ${(legalTotal / Math.max(1, decisions)).toFixed(0)} 个合法动作（候选上限 ${policy.spec.topK ?? '?'}）`,
);
console.log('\n| 动作类型 | 合法个数 | 进候选 | 进候选率 | 被选次数 | 被选占决策 | 有合法但候选里一个都没有 |');
console.log('|---|---:|---:|---:|---:|---:|---:|');
for (const [k, b] of rows) {
  console.log(
    `| ${k} | ${b.legal} | ${b.cand} | ${pct(b.cand, b.legal)} | ${b.chosen} | ${pct(b.chosen, decisions)} | ` +
      `${b.stepsWithLegal > 0 ? `${b.stepsNoneCand} 步（${pct(b.stepsNoneCand, b.stepsWithLegal)}）` : '—'} |`,
  );
}

if (recruitUnits.size > 0) {
  const total = [...recruitUnits.values()].reduce((a, b) => a + b, 0);
  console.log('\n招募构成（按兵种）：');
  for (const [id, n] of [...recruitUnits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`  ${id.padEnd(14)} ${String(n).padStart(4)} 次  ${pct(n, total)}`);
  }
  console.log(`  合计 ${total} 次招募`);
}
