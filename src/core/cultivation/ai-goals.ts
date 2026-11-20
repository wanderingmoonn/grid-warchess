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
import { UNIT_IDS, isCultivatorDef } from './identity.ts';
import { researchedOf, SPELLS, RESEARCH_STONE_COST, knownSpells, spellSlotsOf } from './spells.ts';
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

/** 自己人（不 import rules 的 `unitsOf`：那会形成 EXPANSIONS 的循环依赖） */
function ownUnits(c: { state: GameState; me: PlayerId }) {
  return c.state.units.filter((u) => u.owner === c.me && u.hp > 0);
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
        claimsBuild: isField,
        /*
         * **带地形判断地认领**（2026-11-20 第二版）。
         *
         * 第一版我给的是"46 − 危险×30 − 造价"——两块地同分，等于把核心
         * 那套 `unitYield` 地形判断盖掉了（森林产灵石、平原产金币）。
         * 第二版直接**不算**，交给通用经济评分——结果灵田根本不造
         * （通用分不够高，被炼器炉挤掉）。
         *
         * 现在这一版：自己调 `unitYield` 问"这一格真能产多少"，
         * 把灵石按 3 倍金折价（它更稀缺），再给一点链上的加成。
         * 既没盖掉地形，也能让链的第一步真的动起来。
         */
        buildScore: (_c, _buildId, spot, def) => {
          /*
           * 自己算这一格能产多少，**不 import rules 的 `unitYield`**：
           * 那会把 rules 拖进扩展的初始化链，形成 EXPANSIONS 未初始化的环
           * （2026-11-20 实撞：`Cannot access 'EXPANSIONS' before initialization`）。
           * 算法和 `unitYield` 的前两段一致——有 `yieldByTerrain` 就按地形，
           * 否则用固定 `yield`。灵田正好走的是地形那一段。
           */
          const per = def.yieldByTerrain?.[spot.terrain] ?? def.yield ?? {};
          const gold = (per.gold ?? 0) + (def.incomeByTerrain?.[spot.terrain] ?? def.income ?? 0);
          const stone = per[SPIRIT_STONE] ?? 0;
          // 一格产出都没有的地盖上也是白盖（和通用经济评分同一条口径）
          if (gold + stone <= 0) return null;
          return (gold + stone * 3) * 4 + 10 - def.cost * 0.02;
        },
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
        /*
         * 宗门是这条链的闸门：没有它，后面两步都不存在。
         * 加成给到 +40 是因为实测（seed 8100）它会被"灵塔"挤掉——
         * 塔的防御分本来就高，而链的下一步没有别处可以去。
         */
        buildScore: (c, _id, spot, def) => buildScoreFor(c, spot, def) + 40,
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
      {
        id: 'learn',
        /**
         * 研读：修士**站在藏经阁旁边**把书读进脑子里（`UNIT_ACTION learn:<法术>`）。
         *
         * 这是链上第一次需要"会走路的人"：
         *   · 没站在藏经阁旁边 → 先发一条 MOVE 走过去（核心不知道藏经阁是什么，
         *     这里只是"朝某一格移动"，和 T11 的思路一致）；
         *   · 站到了 → 挑一门**已研发、自己没学、还有法术位**的，发 learn。
         *
         * 法术位由境界决定（`spellSlotsOf`），满了就学不进去——这时候返回空，
         * 让链停在这一步，而不是白发一条必被拒的动作。
         */
        done: (c) =>
          ownUnits(c).some(
            (u) => isCultivatorDef(c.state.unitTypes[u.type]) && knownSpells(u).length > 0,
          ),
        actions: (c) => {
          const lib = ownUnits(c).find((u) => isLibrary(c.state.unitTypes[u.type]));
          if (!lib) return [];
          const learned = new Set(researchedOf(c.state, c.me));
          if (learned.size === 0) return [];
          const out: Array<{ action: any; score: number }> = [];
          for (const u of ownUnits(c)) {
            const def = c.state.unitTypes[u.type];
            if (!isCultivatorDef(def)) continue;
            const near = Math.max(Math.abs(u.x - lib.x), Math.abs(u.y - lib.y)) <= 1;
            if (!near) {
              /*
               * 走过去：目标是藏经阁**旁边**的空格，不是藏经阁本身
               * （那格被建筑占着，走上去必然被拒）。
               */
              // 目标格：藏经阁周围 2 格内**最近的空格**（8 向，含对角）
              let spot: { x: number; y: number } | null = null;
              let bestD = Infinity;
              for (let dy = -2; dy <= 2; dy += 1) {
                for (let dx = -2; dx <= 2; dx += 1) {
                  if (dx === 0 && dy === 0) continue;
                  const px = lib.x + dx;
                  const py = lib.y + dy;
                  if (px < 0 || py < 0 || px >= c.state.w || py >= c.state.h) continue;
                  if (c.state.units.some((o) => o.hp > 0 && o.x === px && o.y === py)) continue;
                  const d = Math.max(Math.abs(dx), Math.abs(dy));
                  if (d < bestD) {
                    bestD = d;
                    spot = { x: px, y: py };
                  }
                }
              }
              if (spot) out.push({ action: { type: 'MOVE', unitId: u.id, x: spot.x, y: spot.y }, score: 34 });
              continue;
            }
            const known = new Set(knownSpells(u).map((k) => k.id));
            if (known.size >= spellSlotsOf(u)) continue; // 法术位满了，学不进去
            const pick = [...learned].find((id) => !known.has(id));
            if (!pick) continue;
            out.push({
              action: { type: 'UNIT_ACTION', unitId: u.id, actionId: `learn:${pick}` },
              score: 56,
            });
            break; // 一次只教一个，发多了同一步会重复
          }
          return out;
        },
      },
    ],
  },
];
