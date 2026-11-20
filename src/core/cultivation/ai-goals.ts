/**
 * 修真的 AI 产业链目标（2026-11-20）。
 *
 * ⚠️ 写之前读过 `docs/GUIDE-AI-GOAL-2026-11-20.md`。规矩：**不往 ai.ts 里塞 if**，
 * 这条链的全部内容（值不值、缺哪段、多少钱、哪些兵）都在这个文件里声明。
 *
 * ── 这条链长什么样 ──────────────────────────────────────────────
 *
 *   灵田 ×2  →  宗门大殿  →  藏经阁  →  研发第一门法术
 *   （产灵石）   （200金+20灵） （120金+10灵）  （60灵）
 *
 * 顺序是真的硬前置：没有灵田就没有灵石，没有宗门藏经阁就贴着建不了，
 * 没有藏经阁就没有研发额度。所以这里用**一个目标的四段**，不是四个目标。
 * （装甲那条反过来是并行支线，别照抄。）
 *
 * ── 灵石为什么不用"攒钱表" ────────────────────────────────────
 *
 * 攒钱表（`saveScore`）只认**金币**，而灵石的来源是灵田的**每回合产出**，
 * 不是"少花就能攒下来"。所以这一条链的第一个动作是**建灵田**——
 * 把"攒灵石"翻译成"先把水龙头拧大"，这比给核心加一套多资源存钱简单得多，
 * 也更接近玩家实际的玩法。
 */
import type { AiGoal } from '../ai-goal.ts';
import type { GameState, PlayerId, UnitTypeDef } from '../types.ts';
import { UNIT_IDS } from './identity.ts';
import { researchedOf, SPELLS, RESEARCH_STONE_COST } from './spells.ts';
import { SPIRIT_STONE } from './resources.ts';

/** 这条链要几座灵田才够养下面的开销：宗门 20 + 藏经阁 10 + 一门研发 60 */
const WANT_FIELDS = 2;

/** 一次建造的通用底分：和海军/装甲那几条一个量级（40~110） */
function buildScoreFor(c: Parameters<NonNullable<AiGoal['steps'][number]['buildScore']>>[0],
  spot: { x: number; y: number }, def: UnitTypeDef): number {
  return 46 - (c.inDanger(spot.x, spot.y) ? 30 : 0) - def.cost * 0.02;
}

const isField = (d: UnitTypeDef): boolean => d.id === UNIT_IDS.SPIRIT_FIELD;
const isSect = (d: UnitTypeDef): boolean => d.id === UNIT_IDS.SECT;
const isLibrary = (d: UnitTypeDef): boolean => d.id === UNIT_IDS.SCRIPTURE_PAVILION;

/** 本方（或任一方）有多少座某种建筑 */
function countOf(c: Parameters<AiGoal['value']>[0], pred: (d: UnitTypeDef) => boolean): number {
  return c.count(pred);
}

/** 这一方研发了几门法术 */
function researchedCount(c: { state: GameState; me: PlayerId }): number {
  return researchedOf(c.state, c.me).length;
}

export const CULTIVATION_AI_GOALS: AiGoal[] = [
  {
    id: 'cultivation',
    /*
     * 第 2 代才有灵田、第 3 代才有宗门。开得太早只是白抢分数。
     * 这一条**同时是"激活条件"**：没到 2 代，整条链不存在。
     */
    value: (c) => (c.era >= 2 ? 1 : 0),
    steps: [
      {
        id: 'fields',
        done: (c) => countOf(c, isField) >= WANT_FIELDS,
        /*
         * **不认领灵田的建造**（2026-11-20 改）。
         *
         * 灵田是"经济建筑"，通用的经济评分比我能写的好得多：
         * `rawBuildScore` 会拿一个探针单位试算 `unitYield`，
         * 挑**这一格真能产多少**——森林产灵石、平原产金币，它自己会选；
         * 一格产出为 0 的地直接 -999。
         *
         * 我一开始认领了它，用的是"46 − 危险×30 − 造价"，等于把那套
         * 地形判断**盖掉**了：两块地同分，AI 可能把灵田盖在只产金币的平原上。
         *
         * 这一步只保留"完成判据"：链要知道有没有两座田，但怎么盖、盖哪、
         * 值多少，交给本来就擅长这件事的那条线。
         */
      },
      {
        id: 'sect',
        done: (c) => countOf(c, isSect) >= 1,
        claimsBuild: isSect,
        // 宗门是 2×2 的大件，值高一点：没有它后面两步都不存在
        buildScore: (c, _id, spot, def) => buildScoreFor(c, spot, def) + 26,
        cost: (c) => c.state.unitTypes[UNIT_IDS.SECT]?.cost ?? 0,
        saveScore: 13,
      },
      {
        id: 'library',
        done: (c) => countOf(c, isLibrary) >= 1,
        claimsBuild: isLibrary,
        // 藏经阁必须贴着宗门，选址由规则判；分数给中等
        buildScore: (c, _id, spot, def) => buildScoreFor(c, spot, def) + 18,
        cost: (c) => c.state.unitTypes[UNIT_IDS.SCRIPTURE_PAVILION]?.cost ?? 0,
        saveScore: 11,
      },
      {
        id: 'research',
        done: (c) => researchedCount(c) >= 1,
        /*
         * 研发不是建造，是 `UNIT_ACTION`（规则层只认人、其余交给修真包）。
         * 发在**宗门**身上：`researchProblem` 会替我们判"额度够不够、灵石够不够"。
         */
        actions: (c) => {
          const sect = c.state.units.find((u) => u.owner === c.me && u.type === UNIT_IDS.SECT);
          if (!sect) return [];
          // 挑一门"现在就能研发"的、最便宜的
          const stones = c.state.players[c.me].res?.[SPIRIT_STONE] ?? 0;
          const cand = SPELLS
            .map((sp) => ({ sp, cost: sp.researchCost ?? RESEARCH_STONE_COST }))
            .filter((x) => researchedCount(c) === 0 && stones >= x.cost)
            .sort((a, b) => a.cost - b.cost)[0];
          if (!cand) return [];
          return [{
            action: { type: 'UNIT_ACTION', unitId: sect.id, actionId: `research:${cand.sp.skill.id}` },
            score: 58,
          }];
        },
      },
    ],
  },
];
