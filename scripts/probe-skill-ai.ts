/**
 * 技能 AI 提示探针。
 *
 * ── 为什么单独一个 ──────────────────────────────────────────────────
 *
 * `registerSkillAi` 让"这个技能什么时候值得放"回到包里。它有两个容易坏的点：
 *   1. 落点是不是**真的能落**（AI 提一个必被规则拒的点，就会白耗一步，表现是"不放技能"）；
 *   2. 没人可打的时候会不会**静默什么也不做**（陨卵就栽在这上面：规则从 11-10 起
 *      就允许落在空地上了，AI 的判断一直没跟上）。
 *
 * 这两件事在一局 20 回合的对局里看不出来（敌人多半一直在射程内），
 * 所以这里用手搭的局面直接问，并且**真的放一次**验证落点成立。
 *
 * 用法：npm run probe:skill-ai
 */

import { abilityApi, applyAction } from '../src/core/rules.ts';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import { SKILL_AI_HINTS } from '../src/core/skill-hooks.ts';
import type { SkillAiCtx } from '../src/core/skill-hooks.ts';
import type { GameState, Unit } from '../src/core/types.ts';

const KING = 'evil-dragon-king';
const EGG = 'dragon-egg';

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

const CONFIG = {
  ...DEFAULT_CONFIG,
  size: 16,
  startEra: 6,
  expansionIds: [
    ...DEFAULT_CONFIG.expansionIds,
    'fantasy-core',
    'fantasy-heroes',
    'pack-contemporary',
  ],
};

interface Board {
  s: GameState;
  king: Unit;
  ctx: SkillAiCtx;
}

/**
 * 空场：一条邪龙王站在 (8,13)，可选一个敌人在指定位置。
 * 地图全平原、没有别的单位——这样"落点在哪"完全由 AI 决定，不受干扰。
 */
function board(foeAt: { x: number; y: number } | null): Board {
  const s = createMatch(CONFIG, 4321);
  s.fog = false;
  s.units = [];
  s.marks = [];
  // 城要留一座给 B：没有城的席位会被判出局，虽然这一局不跑回合，但状态别留歪的
  s.cities = [{ id: 'cb', owner: 'B', x: 12, y: 12, size: 2, era: 6, hp: 70, maxHp: 70, armor: 4 }];
  for (let y = 0; y < s.h; y += 1) {
    for (let x = 0; x < s.w; x += 1) s.tiles[y * s.w + x] = { terrain: 'plain', cityId: null };
  }
  const mk = (id: string, type: string, owner: 'A' | 'B', x: number, y: number): Unit => {
    const u: Unit = {
      id,
      type,
      owner,
      x,
      y,
      hp: s.unitTypes[type]!.maxHp,
      kills: 0,
      moved: false,
      acted: false,
    };
    s.units.push(u);
    return u;
  };
  const king = mk('king-0', KING, 'B', 8, 13);
  if (foeAt) mk('foe-0', 'knight', 'A', foeAt.x, foeAt.y);
  s.current = 'B';
  s.turn = 5;

  const def = s.unitTypes[KING]!;
  const skill = def.skills!.find((k) => k.effect === 'dragon-egg')!;
  const enemies = s.units.filter((u) => u.owner !== 'B' && u.hp > 0);
  const ctx: SkillAiCtx = {
    state: s,
    unit: king,
    def,
    skill,
    api: abilityApi,
    foes: enemies,
    hpRatio: 1,
    allies: s.units.filter((u) => u.owner === 'B'),
  };
  return { s, king, ctx };
}

const cheb = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

console.log('技能 AI 提示探针\n');

/* ── 1. 注册表 ──────────────────────────────────────────────────── */
console.log('[1] 注册表');
const hint = SKILL_AI_HINTS[EGG];
check('dragon-egg 已经有人注册提示（不再是核心里的 case）', !!hint);
if (!hint) {
  console.log('\n没有提示，后面的用例没有意义');
  process.exit(1);
}

/* ── 2. 有人可砸：给分，不指定落点 ────────────────────────────────── */
console.log('\n[2] 射程内有敌人');
{
  const { ctx } = board({ x: 8, y: 10 }); // 距离 3，远在 11 格内
  const r = hint(ctx);
  check('返回分数', typeof r === 'number' && r > 0, JSON.stringify(r));
  check('不指定落点（交给规则层挑"砸到人最多"的那格）', typeof r === 'number');
}

/* ── 3. 没人可砸：挑最近的空地 ────────────────────────────────────── */
console.log('\n[3] 射程内没有敌人');
{
  const { s, king, ctx } = board(null);
  const r = hint(ctx);
  const obj = r !== null && typeof r === 'object' ? r : null;
  check('返回了带落点的建议', !!obj && typeof obj.x === 'number' && typeof obj.y === 'number', JSON.stringify(r));
  if (obj && typeof obj.x === 'number' && typeof obj.y === 'number') {
    const spot = { x: obj.x, y: obj.y };
    check('落点在射程内（≤ 11 格）', cheb(king, spot) <= 11, `距离 ${cheb(king, spot)}`);
    check(
      '落点是**最近**的空地（紧贴自己一格，且不在自己脚下）',
      cheb(king, spot) === 1,
      `距离 ${cheb(king, spot)}`,
    );
    check('落点能站下卵（规则层的同一套判断）', abilityApi.canStandAt(s, spot.x, spot.y, EGG));
    check('分数是正的', obj.score > 0, String(obj.score));

    /* 真的放一次：这是最硬的一条——AI 提的点必须点得下去 */
    const before = s.units.filter((u) => u.type === EGG).length;
    const res = applyAction(s, {
      type: 'HERO_SKILL',
      unitId: king.id,
      skillId: 'dragon-egg',
      targetX: spot.x,
      targetY: spot.y,
    });
    const after = res.ok ? res.state.units.filter((u) => u.type === EGG).length : before;
    check('按这个落点真的放得下去（不是必被拒的建议）', res.ok, res.ok ? '' : res.reason);
    check('盘上真的多了一枚卵', after === before + 1, `${before} → ${after}`);
  }
}

/* ── 4. 敌人在射程外：也走空地分支 ────────────────────────────────── */
console.log('\n[4] 有敌人，但在 11 格之外');
{
  const { ctx } = board({ x: 8, y: 4 }); // 距离 9 —— 其实在射程内，先用它确认边界
  const r = hint(ctx);
  check('距离 9（射程内）仍然按"有人可砸"处理', typeof r === 'number', JSON.stringify(r));
}
{
  const { king, ctx } = board({ x: 0, y: 0 }); // 距离 21，射程外
  const r = hint(ctx);
  check(
    '距离 21（射程外）改为落在空地上',
    r !== null && typeof r === 'object',
    `王在 ${king.x},${king.y}，返回 ${JSON.stringify(r)}`,
  );
}

/* ── 5. 出错也不能崩 ─────────────────────────────────────────────── */
console.log('\n[5] 兜底');
{
  // 要有敌人才会走到 distance：没有敌人时 `some` 会短路，测不到这条
  const { ctx } = board({ x: 8, y: 10 });
  const broken: SkillAiCtx = {
    ...ctx,
    api: { ...abilityApi, distance: () => { throw new Error('探针故意抛错'); } },
  };
  let threw = false;
  try {
    hint(broken);
  } catch {
    threw = true;
  }
  // 抛错本身由核心的 try/catch 兜（记一次、按"不放"处理），这里只确认"确实会抛"这个前提，
  // 真正的兜底在 ai.ts 的 heroSkillCandidate 里
  check('坏掉的 api 会抛错——核心那边要靠 try/catch 兜（不是靠提示自己容错）', threw);
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
if (failed > 0) process.exit(1);
