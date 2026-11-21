/**
 * 新旧 AI 对战台：同一张图、同一批种子，A 方用新版、B 方用冻结的旧版，
 * 同一颗种子两边各执一次先手——这样"图不对称"和"先手优势"都不会混进胜负差里。
 *
 * 为什么要专门写一个：balance-report 两边用的是同一个 AI，
 * 它只能测兵种平衡，测不出"新 AI 是不是更强"。而"更强"这件事必须有数，
 * 否则改完 AI 只是换了口味。
 *
 * 扩展默认跟着正式配置走（血战 + 先后手补偿）。别用空扩展：
 * 关掉血战之后城市永远回血，两边都推不动，实测未决率会从个位数涨到三成以上，
 * 剩下的样本根本不够判胜负——第一版就是栽在这上面。
 *
 * 用法：
 *   node --experimental-strip-types scripts/ai-duel.ts --era 1 --games 40 --seed 900
 *   node --experimental-strip-types scripts/ai-duel.ts --era 7 --exp armor-era7 --size 28 --games 20
 *   node --experimental-strip-types scripts/ai-duel.ts --era 2 --games 40 --no-swap
 *   node --experimental-strip-types scripts/ai-duel.ts --era 3 --games 40 --old ./baselines/ai-6c3c992.ts
 *   node --experimental-strip-types scripts/ai-duel.ts --era 7 --size 24 --symmetry mirror --games 20
 * 输出：每个种子的胜负 + 汇总胜率（平局算半分）+ 二项检验的 z + 平局率。
 * 平局的种子会额外打一行终局快照（城/兵/金），用来判断"谁其实占优"。
 *
 * `--old` 换对手：默认 ./baseline-ai.ts（冻结于 b36619a，几轮改动之前）。
 * 只想量"这一批改动本身值多少"时，用 `git show <当前 HEAD>:src/core/ai.ts` 抄一份
 * 到 scripts/baselines/ai-<sha>.ts（把 `./x.ts` 改成 `../../src/core/x.ts`），
 * 再 `--old` 指过去——拿几轮之前的基线比，前几批的收益会算进这一批里。
 */

import { applyAction } from '../src/core/rules.ts';
import { armySize } from '../src/core/rules.ts';
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import type { GameState, PlayerId } from '../src/core/types.ts';
import { AI_MAX_STEPS, DEFAULT_BUDGET, aiActionKey } from '../src/core/ai.ts';
import { buildMatchReport } from '../src/core/report.ts';
import type { LoggedAction } from '../src/core/report.ts';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};
const has = (name: string): boolean => args.includes(`--${name}`);

// 冻结的旧版 AI：用变量做 specifier，别让 tsc 把它拉进类型检查
// （它是两人局的旧代码，`players: { A, B }` 和现在的四键定义对不上）。
//
// `--old` 可以换成别的冻结副本：`scripts/baselines/ai-<sha>.ts` 是"动手之前
// 那一刻的 src/core/ai.ts"原样抄一份（只改导入路径）。想量"这一批改动本身值多少"，
// 就得跟**上一版**比，而不是跟几轮之前的基线比——否则前后几批改动的收益会混在一起。
const OLD_AI_FILE = argOf('old', './baseline-ai.ts');
/**
 * `--policy <名字>`：把"新版"那一侧换成固定打法脚本（不参与任何评分）。
 *
 *   greedy  scripts/script-ai.ts   六条常识的通用脚本（见该文件头）
 *   hold    scripts/script-hold.ts  弃城发育流：放弃一座城、攒钱升城、守到四代再总攻
 *   raid    scripts/script-raid.ts  抢经济：不围城、不抢时代，只杀对方工人
 *
 * `--script` 是 `--policy greedy` 的旧写法，留着不破坏已有命令。
 */
const POLICY = argOf('policy', has('script') ? 'greedy' : '');
/**
 * `--vs-new`：对手直接用**当前** AI，而不是冻结副本。
 *
 * 量"某条打法 vs 现在的 AI"时用它：冻结副本会随着代码演进变成"上一版"，
 * 拿它当对手，结论会悄悄变成"vs 上一版"。
 */
const VS_NEW = has('vs-new');
const scriptAi =
  POLICY === 'hold'
    ? ((await import('./script-hold.ts')).holdNextAction as unknown as typeof newAi)
    : POLICY === 'raid'
      ? // 抢经济：两个 AI 都不打经济（自对弈里经济单位只吃 5.9% 伤害），
        // 所以"护经济"这类结构改动只有它能测出来。见 script-raid.ts 文件头。
        ((await import('./script-raid.ts')).raidNextAction as unknown as typeof newAi)
      : POLICY === 'greedy' || POLICY === 'script'
        ? ((await import('./script-ai.ts')).scriptNextAction as unknown as typeof newAi)
      : null;
const oldAi = (await import(OLD_AI_FILE)).aiNextAction as unknown as AiFn;

/**
 * "新版"那一侧用哪份内核。
 *
 * 以前写死 `../src/core/ai.ts`，于是这个台子只能测"老 AI 对老 AI 的冻结副本"。
 * v3 独立成文件之后必须能指过去，否则所有 v3 的数字都是假的
 * （测的一直是 v1，只是两边都是 v1 所以看不出错）。
 *
 *   --new ../src/core/ai-v3.ts        ← v3 的实验一律用这条
 *   --new ../src/core/ai.ts           ← 默认，量 v1 自己
 */
const NEW_AI_FILE = argOf('new', '../src/core/ai.ts');
const newAi = (await import(NEW_AI_FILE)).aiNextAction as unknown as AiFn;

const ERA = Number(argOf('era', '1'));
const GAMES = Number(argOf('games', '40'));
const BASE_SEED = Number(argOf('seed', '900'));
const CAP = Number(argOf('cap', '160'));
const SIZE = Number(argOf('size', String(DEFAULT_CONFIG.size)));
/**
 * 地形对称方式：`fair`（默认，两侧配额相同分布不同）/ `mirror`（完全镜像）。
 *
 * 为什么要能选：v3 的验收口径分两种——镜像图上"两边条件完全一样"，
 * 打平是合理结果；非镜像图上打平说明有一方推不动，要算问题。
 * 见 `docs/PLAN-AI-V3-2026-11-21.md` 的验收配方。
 */
const SYMMETRY = argOf('symmetry', 'fair') as 'fair' | 'mirror';
/**
 * 编制上限：`--unit-cap none` 或一个数字。不写 = 24（现状）。
 *
 * **只对 v3 生效**——v1 里这条是写死的（v1 冻结，不改）。所以想验它必须同时给
 * `--new ../src/core/ai-v3.ts`，否则这个参数是空的。
 * 见 `docs/PLAN-AI-V3-2026-11-21.md` 第二节。
 */
const UNIT_CAP_ARG = argOf('unit-cap', '');
const UNIT_CAP: number | 'none' | undefined =
  UNIT_CAP_ARG === '' ? undefined : UNIT_CAP_ARG === 'none' ? 'none' : Number(UNIT_CAP_ARG);

/**
 * 导出一局回放：`--replay <文件路径>`。
 *
 * 复盘文件就是一份普通的对局报告（种子 + 完整 config + 动作序列），
 * 界面里拖进去就能逐帧看——同一个 `buildReplayFromText`，不另写一套。
 *
 * 为什么要有它：有些问题（"它为什么把兵堆在这儿""为什么整局没往对面走"）
 * 人看一眼就知道，机器得写一堆探针才摸到边。所以每个结论都该能**看一眼**。
 *
 * 挑哪一局：
 *   --replay x.json                 → 默认第一颗种子的第一局（新先手）
 *   --replay x.json --replay-seed 906
 *   --replay x.json --replay-seed 906 --replay-first old   → 新后手那一局
 */
/**
 * 战略层用哪一档"决战时代"模型（`const` / `foe`）。
 *
 * **只对 v3 生效**，而且两档现在都只算不用：算出来写进 `aiDecisions`，
 * 没有任何消费方。所以开了也只是多一份日志，棋还是同一盘。
 */
const ERA_MODEL_ARG = argOf('era-model', '');
const ERA_MODEL: 'const' | 'foe' | undefined =
  ERA_MODEL_ARG === 'const' || ERA_MODEL_ARG === 'foe' ? ERA_MODEL_ARG : undefined;

const REPLAY_PATH = argOf('replay', '');
const REPLAY_SEED = argOf('replay-seed', '');
const REPLAY_FIRST = argOf('replay-first', 'new') === 'old' ? 'old' : 'new';
/**
 * 台子上测哪一档。
 *
 * 默认 `tactic`：这里量的是中级 AI（三套战术全开）对冻结旧版，不是高级档。
 * 想复核"战术层有没有拖累高级档"，用 `--level advanced`——那一档三战术是关的，
 * 跑出来就是"除战术外的一切改动"的净效果。
 */
const LEVEL = argOf('level', 'tactic') as 'basic' | 'advanced' | 'tactic';
/**
 * `--script` 见下面 SCRIPT 那一行：把"新版"那一侧换成 scripts/script-ai.ts 的剧本。
 */
/** 同一颗种子两边各打一局：paired，方差最小 */
const SWAP = !has('no-swap');
/** 空扩展开关：只在排查"是不是规则把对局拖进拉锯"时才用 */
const EXP = has('bare')
  ? []
  : argOf('exp', '')
      .split(',')
      .filter(Boolean)
      .concat([...DEFAULT_CONFIG.expansionIds])
      .filter((id, i, a) => a.indexOf(id) === i);

type AiFn = (typeof import('../src/core/ai.ts'))['aiNextAction'];
type Ai = AiFn;

function playOne(
  seed: number,
  aIsNew: boolean,
): { winner: PlayerId | null; turns: number; final: GameState; actions: LoggedAction[] } {
  let s: GameState = createMatch(
    {
      ...DEFAULT_CONFIG,
      startEra: ERA,
      aiLevel: LEVEL,
      expansionIds: EXP,
      /*
       * 地图尺寸。默认 12×12 是 `DEFAULT_CONFIG` 的值，**对高时代不合适**：
       * 时代越高作战半径越大，小图上"造出来的兵一回合就到对面城下"，
       * 一切投资（电站、坞、素体）都没有回报空间，测出来的只是短兵相接。
       * 验 5 代以上的内容请显式给 --size 24 或 28。
       */
      size: SIZE,
      mapSymmetry: SYMMETRY,
      ...(UNIT_CAP === undefined ? {} : { unitCap: UNIT_CAP }),
      ...(ERA_MODEL === undefined ? {} : { aiEraModel: ERA_MODEL }),
    },
    seed,
  );

  const aiFor = (p: PlayerId): Ai =>
    (p === 'A') === aIsNew ? (scriptAi ?? newAi) : VS_NEW ? newAi : oldAi;

  /** 只记**被接受**的动作：被拒的那几步重放时也走不通，记进去只会让复盘提前分叉 */
  const actions: LoggedAction[] = [];

  while (!s.winner && s.turn <= CAP) {
    const ai = aiFor(s.current);
    const budget = { ...DEFAULT_BUDGET };
    /*
     * 被拒的动作记一笔、**接着找下一个**，不掐掉这一回合。
     *
     * 2026-11-20 改：原来是 `if (!r.ok) break`，一被拒就提前交棒。而实机
     * （main.ts 的 runAiTurn）从 2026-11-19 起就是 `rejected.add(...) + continue`。
     * 两边口径不一致的后果很实在：AI 在雾里朝"看不见的敌人"那格架桥会被拒，
     * 实测 4 局就有 14 次——实机只是白费一步，跑批却直接少打半回合。
     * 拿这种数去比胜率，比的是"谁更倒霉撞上这个 bug"。
     */
    const rejected = new Set<string>();
    for (let i = 0; i < AI_MAX_STEPS && !s.winner; i++) {
      const a = ai(s, budget, rejected);
      if (!a) break;
      const r = applyAction(s, a);
      if (!r.ok) {
        rejected.add(aiActionKey(a));
        continue;
      }
      rejected.clear();
      actions.push({ ...a, by: s.current });
      s = r.state;
      if (a.type === 'RECRUIT') budget.recruited += 1;
      if (a.type === 'UPGRADE') budget.upgraded += 1;
    }
    if (s.winner) break;
    const endTurn = { type: 'END_TURN' as const };
    const r = applyAction(s, endTurn);
    if (!r.ok) break;
    // END_TURN 也要记：复盘是一步步 applyAction 重放，少了它回合永远不换手
    actions.push({ ...endTurn, by: s.current });
    s = r.state;
  }

  return { winner: s.winner ?? null, turns: s.turn, final: s, actions };
}

/**
 * 终局快照：撞回合上限时，"谁其实占优"。
 *
 * 只数不判：城数、兵力、金币、编制是否顶满。平局的成因分几种，光看"平"这个字
 * 分不出来——是两边都推不动（城多兵多但打不进去），还是钱花不出去（编制满），
 * 还是一方早就该赢只是收不了尾。这份快照是为了让 S1 的诊断有据可依，
 * 不参与胜负判定（不要用它把平局改判成胜）。
 */
function snapshotOf(s: GameState): string {
  const side = (p: PlayerId): string => {
    const cities = s.cities.filter((c) => c.owner === p).length;
    const units = s.units.filter((u) => u.owner === p).length;
    // 战斗单位单独数：编制上限只卡这一档，全数会把工人算进去，看不出"顶满"
    const combat = armySize(s, p);
    const gold = Math.round(s.players[p].gold);
    return `${cities}城/${combat}战+${units - combat}工/${gold}金`;
  };
  return `A ${side('A')} · B ${side('B')}`;
}

/** 复盘只导一局：第一颗匹配到的那局，别把二十局都写出去 */
const wantReplaySeed = REPLAY_SEED === '' ? BASE_SEED : Number(REPLAY_SEED);
let replayWritten = false;

let newWins = 0;
let oldWins = 0;
let draws = 0;
let turnsSum = 0;
let played = 0;

for (let i = 0; i < GAMES; i++) {
  const seed = BASE_SEED + i;
  // 有 swap 时，一颗种子打两局（新先 / 新后各一次），否则按奇偶分先手
  const layouts = SWAP ? [true, false] : [i % 2 === 0];

  for (const aIsNew of layouts) {
    const { winner, turns, final, actions } = playOne(seed, aIsNew);
    turnsSum += turns;
    played += 1;

    /*
     * 导出这一局（见 `--replay`）：默认取第一颗种子的"新先手"那局。
     * 报告格式和界面里"结束后上传"的完全一样，所以拖进游戏就能看。
     */
    if (REPLAY_PATH && !replayWritten && seed === wantReplaySeed && aIsNew === (REPLAY_FIRST === 'new')) {
      const report = buildMatchReport(final, new Date(), null, actions);
      mkdirSync(dirname(REPLAY_PATH), { recursive: true });
      writeFileSync(REPLAY_PATH, JSON.stringify(report));
      replayWritten = true;
      process.stderr.write(`  已导出复盘：${REPLAY_PATH}（${actions.length} 步）\n`);
      /*
       * 判决日志跟着回放一起写：回放只能看"做了什么"，这一列补"为什么"。
       * 没有开 `--era-model` 就是空文件，干脆不写。
       */
      const decisions = final.aiDecisions ?? [];
      if (decisions.length > 0) {
        const sidecar = REPLAY_PATH.replace(/\.json$/i, '.decisions.jsonl');
        writeFileSync(sidecar, decisions.map((d) => JSON.stringify(d)).join('\n') + '\n');
        process.stderr.write(`  判决日志：${sidecar}（${decisions.length} 条）\n`);
      }
    }

    let tag: string;
    if (winner === null) {
      draws += 1;
      tag = 'draw';
    } else {
      const winnerIsNew = (winner === 'A') === aIsNew;
      if (winnerIsNew) newWins += 1;
      else oldWins += 1;
      tag = winnerIsNew ? 'NEW' : 'old';
    }
    process.stderr.write(
      `era${ERA} seed=${seed} ${aIsNew ? '新先手' : '新后手'} → ${tag} (${turns} 回合)` +
        (winner === null ? `  [终端快照 ${snapshotOf(final)}]` : '') +
        '\n',
    );
  }
}

const decided = newWins + oldWins;
const rate = decided > 0 ? newWins / decided : 0;
// 平局算半分：这是"这一局谁更有利"的标准口径，比"只数分出的局"稳
const score = played > 0 ? (newWins + draws * 0.5) / played : 0;
// 单尾二项检验的近似：z = (p̂ - 0.5) / (0.5 / sqrt(n))
const zDecided = decided > 0 ? (rate - 0.5) / Math.sqrt(0.25 / decided) : 0;
const zScore = played > 0 ? (score - 0.5) / Math.sqrt(0.25 / played) : 0;
console.log(
  `era${ERA} ${played} 局：新 AI ${newWins} 胜 / 旧 AI ${oldWins} 胜 / 平 ${draws}` +
    ` → 新胜率 ${(rate * 100).toFixed(1)}% (z=${zDecided.toFixed(2)})` +
    ` 计分 ${(score * 100).toFixed(1)}% (z=${zScore.toFixed(2)})` +
    ` 平局率 ${((draws / Math.max(1, played)) * 100).toFixed(0)}%` +
    ` 均 ${(turnsSum / Math.max(1, played)).toFixed(0)} 回合` +
    ` ${SIZE}×${SIZE}/${SYMMETRY} cap=${CAP} exp=[${EXP.join(',')}]`,
);
