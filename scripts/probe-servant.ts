/**
 * 仆从探针：青铜卫 + 两条跟城市有关的词条（断传承 / 痴愚）。
 *
 * ── 它守什么 ────────────────────────────────────────────────────────
 *
 * 这两条都动"城市易手"这件事，而核心全代码只有**一处**易手点（`doMove` 里入驻废墟）。
 * 所以这里要验的不只是"效果对不对"，还有"没有把特例写进核心"：
 * 核心只问能力，不认兵种。
 *
 * 用法：npm run probe:servant
 */

import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import { applyAction } from '../src/core/rules.ts';
import {
  BRONZE_GUARD,
  DARK_TURMOIL,
  SHADE,
  UNNAMABLE,
} from '../src/core/dark-turmoil-packs.ts';
import type { City, GameState, PlayerId, Unit } from '../src/core/types.ts';

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
  expansionIds: [...DEFAULT_CONFIG.expansionIds, 'cultivation', 'dark-turmoil'],
};

interface Arena {
  s: GameState;
  mk: (id: string, type: string, owner: PlayerId, x: number, y: number) => Unit;
}

/**
 * 一张干净的场：中间一座**已成废墟**的城（A 走进去就能接管），
 * 两块空地留给"动手的那个兵"。
 */
function arena(era = 4): Arena & { ruin: City } {
  const s = createMatch(CONFIG, 7788);
  s.fog = false;
  s.units = [];
  s.marks = [];
  s.overlays = {};
  s.players.A.gold = 9999; // 重建费要给得起
  s.players.B.gold = 9999;
  s.tiles = s.tiles.map(() => ({ terrain: 'plain' as const, cityId: null }));
  const ruin: City = {
    id: 'ruin',
    owner: 'B',
    x: 6,
    y: 6,
    size: 2,
    era,
    hp: 0,
    maxHp: 70,
    armor: 4,
    ruined: true,
  };
  s.cities = [
    { id: 'ca', owner: 'A', x: 0, y: 0, size: 2, era: 6, hp: 70, maxHp: 70, armor: 4 },
    ruin,
  ];
  // 废墟占 2×2 格，每格都要挂上 cityId（走进去才知道"这是那座城"）
  for (let dy = 0; dy < 2; dy += 1) {
    for (let dx = 0; dx < 2; dx += 1) {
      const t = s.tiles[(6 + dy) * s.w + (6 + dx)];
      if (t) t.cityId = 'ruin';
    }
  }
  const mk = (id: string, type: string, owner: PlayerId, x: number, y: number): Unit => {
    const u: Unit = { id, type, owner, x, y, hp: s.unitTypes[type]!.maxHp, kills: 0, moved: false, acted: false };
    if (s.unitTypes[type]!.layer) u.layer = s.unitTypes[type]!.layer;
    s.units.push(u);
    return u;
  };
  // 远处留个活口，别让"对面没人"提前判胜
  mk('keep-alive', 'militia', 'B', 0, 15);
  s.current = 'A';
  s.turn = 10;
  return { s, mk, ruin };
}

console.log('仆从探针\n');

/* ══════════════════════════════════════════════════════════════════
 * 1. 青铜卫
 * ══════════════════════════════════════════════════════════════════ */
console.log('[1] 青铜卫');
{
  const { s } = arena();
  const d = s.unitTypes[BRONZE_GUARD];
  check('在表里', !!d);
  check('不可建造（只由关卡生成）', d?.summonedOnly === true);
  check('不听"诡异那套"自主动（自主分 0）', (d?.aiAutonomy ?? 0) === 0);
  check('挂了「断传承」', (d?.abilities ?? []).includes('break-lineage'));
  check('没有「痴愚」（它认城市）', !(d?.abilities ?? []).includes('dull-wit'));
  check('不带暗影半径（它不是诡异）', d?.shadowRadius === undefined);
}

/* ══════════════════════════════════════════════════════════════════
 * 2. 痴愚：十二只诡异全都挂上
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[2] 痴愚');
{
  const all = DARK_TURMOIL.units ?? [];
  const weirdos = all.filter((u) => u.id !== 'corpse-emperor' && u.id !== 'slumber-site' && u.id !== BRONZE_GUARD);
  check(`诡异一共 ${weirdos.length} 只`, weirdos.length === 12, String(weirdos.length));
  const missing = weirdos.filter((u) => !(u.abilities ?? []).includes('dull-wit')).map((u) => u.id);
  check('十二只都挂了「痴愚」', missing.length === 0, missing.join(','));
  check('尸骸仙帝不挂（他不是"污染物"）', !(all.find((u) => u.id === 'corpse-emperor')?.abilities ?? []).includes('dull-wit'));
}

/* ══════════════════════════════════════════════════════════════════
 * 3. 断传承：仆从占城，城的时代掉一级
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[3] 断传承');
{
  const { s, mk } = arena(4);
  mk('guard', BRONZE_GUARD, 'A', 5, 6); // 贴着废墟
  const r = applyAction(s, { type: 'MOVE', unitId: 'guard', x: 6, y: 6 });
  check('能走进废墟（它有资格占城）', r.ok, r.ok ? '' : r.reason);
  if (r.ok) {
    const city = r.state.cities.find((c) => c.id === 'ruin')!;
    check('城市归了仆从那一方', city.owner === 'A', city.owner);
    check('不再是废墟', city.ruined !== true, String(city.ruined));
    check('时代从 4 掉到 3', city.era === 3, String(city.era));
  }

  // 已经是最低时代：不再往下掉
  const low = arena(1);
  low.mk('guard2', BRONZE_GUARD, 'A', 5, 6);
  const r2 = applyAction(low.s, { type: 'MOVE', unitId: 'guard2', x: 6, y: 6 });
  const c2 = r2.ok ? r2.state.cities.find((c) => c.id === 'ruin')! : low.ruin;
  check('1 级的城不会再掉', r2.ok && c2.era === 1, String(c2.era));
}

/* ══════════════════════════════════════════════════════════════════
 * 4. 痴愚：诡异占不了城
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[4] 痴愚');
{
  const { s, mk } = arena(4);
  s.current = 'B'; // 诡异是 B 的兵：不在它的回合，动作会被"这不是你的单位"先挡掉
  mk('shade', SHADE, 'B', 5, 6); // 诡异，贴着废墟
  const r = applyAction(s, { type: 'MOVE', unitId: 'shade', x: 6, y: 6 });
  check('走不进去', !r.ok, r.ok ? '居然进去了' : '');
  check('理由是「痴愚」', !r.ok && r.reason.includes('痴愚'), r.ok ? '' : r.reason);
  check('城还在原地（没被它占）', s.cities.find((c) => c.id === 'ruin')!.owner === 'B');

  // 同一个诡异，走别的空地没问题（拦的只是"占城"这一个动作）
  const r2 = applyAction(s, { type: 'MOVE', unitId: 'shade', x: 5, y: 7 });
  check('走普通空地不受影响', r2.ok, r2.ok ? '' : r2.reason);

  // 另一只也验一下：不一样的诡异，同样的结论
  const other = arena(4);
  other.s.current = 'B';
  other.mk('unn', UNNAMABLE, 'B', 5, 6);
  const r3 = applyAction(other.s, { type: 'MOVE', unitId: 'unn', x: 6, y: 6 });
  check('「诡异」这一只也进不去', !r3.ok && r3.reason.includes('痴愚'), r3.ok ? '' : r3.reason);
}

/* ══════════════════════════════════════════════════════════════════
 * 5. 面板
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[5] 面板');
{
  const { s, mk } = arena();
  const lines = (u: Unit): string => DARK_TURMOIL.hooks.getUnitPanelLines!({ state: s, unit: u }).join(' | ');
  const guard = mk('g', BRONZE_GUARD, 'A', 2, 2);
  check('青铜卫面板写了「断传承」', lines(guard).includes('断传承'), lines(guard));
  const shade = mk('sh', SHADE, 'B', 2, 4);
  check('诡异面板写了「痴愚」', lines(shade).includes('痴愚'), lines(shade));
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
if (failed > 0) process.exit(1);
