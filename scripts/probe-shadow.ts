/**
 * 暗影领域探针（最小验证）。
 *
 * ── 它守的规则 ──────────────────────────────────────────────────────
 *
 *   1. 每回合末重铺一次（不跟着诡异走）；
 *   2. 站在暗影里（视野菱形内超过一半是暗影）→ 视野和射程减半，向上取整；
 *   3. 分母只数地图内的格子；正好一半**不**触发；
 *   4. 界面、AI、规则读的是同一份（`overlays.shadow`），所以不会"显示能打、
 *      点下去说不行"；
 *   5. 场上没有诡异时，这两条钩子一次都不该改变任何数值。
 *
 * 场上的"影系怪物"是这里临时捏的（`probe-shade`），不是正式内容——
 * 正式的影/血/骨三系列等作者列完再进包。
 *
 * 用法：npm run probe:shadow
 */

import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import { applyAction, effectiveRange, visionOf } from '../src/core/rules.ts';
import { playerView } from '../src/core/fog.ts';
import { refreshShadow, shadowCoverage } from '../src/core/dark-turmoil-packs.ts';
import type { GameState, Unit, UnitTypeDef } from '../src/core/types.ts';

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
  size: 20,
  startEra: 3,
  expansionIds: [...DEFAULT_CONFIG.expansionIds, 'cultivation', 'dark-turmoil'],
};

interface Arena {
  s: GameState;
  shade: Unit;
  eye: Unit;
}

/**
 * 20×20 全平地。中间一条"影系怪物"（暗影半径 8），旁边一个 9 视野 / 4 射程的观察者。
 * 半径 8 在 (10,10) 刚好不贴边，菱形面积可算死，方便断言。
 */
function arena(): Arena {
  const s = createMatch(CONFIG, 5566);
  s.fog = false;
  s.units = [];
  s.marks = [];
  s.overlays = {};
  s.players.A.gold = 0;
  s.players.B.gold = 0;
  s.tiles = s.tiles.map(() => ({ terrain: 'plain' as const, cityId: null }));
  s.cities = [
    { id: 'ca', owner: 'A', x: 0, y: 0, size: 2, era: 3, hp: 70, maxHp: 70, armor: 4 },
    { id: 'cb', owner: 'B', x: 18, y: 18, size: 2, era: 3, hp: 70, maxHp: 70, armor: 4 },
  ];
  // 探针兵种（只在探针里存在）
  const shadeDef: UnitTypeDef = {
    ...s.unitTypes['sword-cultivator']!,
    id: 'probe-shade',
    name: '影探针',
    short: '影',
    category: 'combat',
    move: 3,
    atk: 20,
    armor: 4,
    maxHp: 100,
    range: 1,
    vision: 5,
    shadowRadius: 8,
    skills: [],
  };
  const eyeDef: UnitTypeDef = {
    ...s.unitTypes['archer']!,
    id: 'probe-eye',
    name: '观察者',
    short: '眼',
    category: 'combat',
    move: 2,
    atk: 10,
    armor: 2,
    maxHp: 100,
    range: 4,
    vision: 9,
    skills: [],
  };
  s.unitTypes[shadeDef.id] = shadeDef;
  s.unitTypes[eyeDef.id] = eyeDef;

  const mk = (id: string, type: string, owner: 'A' | 'B', x: number, y: number): Unit => {
    const u: Unit = { id, type, owner, x, y, hp: s.unitTypes[type]!.maxHp, kills: 0, moved: false, acted: false };
    s.units.push(u);
    return u;
  };
  const shade = mk('shade', 'probe-shade', 'B', 10, 10);
  const eye = mk('eye', 'probe-eye', 'A', 9, 10);
  s.current = 'A';
  s.turn = 5;
  return { s, shade, eye };
}

/** 以 u 为中心、半径 r 的菱形里**地图内**的格号（和 shadowCoverage 同一个口径） */
function diamond(state: GameState, u: { x: number; y: number }, r: number): number[] {
  const out: number[] = [];
  for (let dy = -r; dy <= r; dy += 1) {
    const span = r - Math.abs(dy);
    for (let dx = -span; dx <= span; dx += 1) {
      const x = u.x + dx;
      const y = u.y + dy;
      if (x < 0 || y < 0 || x >= state.w || y >= state.h) continue;
      out.push(y * state.w + x);
    }
  }
  return out;
}

console.log('暗影领域探针\n');

/* ══════════════════════════════════════════════════════════════════
 * 1. 铺得对
 * ══════════════════════════════════════════════════════════════════ */
console.log('[1] 铺设范围');
{
  const { s } = arena();
  refreshShadow(s);
  const cells = s.overlays?.['shadow'] ?? [];
  // 半径 8 的菱形：2*64+16+1 = 145
  check('半径 8 铺出 145 格（菱形，和视野同一套度量）', cells.length === 145, `实际 ${cells.length}`);
  check('中心格在暗影里', cells.includes(10 * s.w + 10));
  check('半径外一格不在', !cells.includes(10 * s.w + 19));
}

/* ══════════════════════════════════════════════════════════════════
 * 2. 视野 / 射程减半
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[2] 站在暗影里');
{
  const { s, eye } = arena();
  refreshShadow(s);
  const cov = shadowCoverage(s, eye, 9)!;
  check(
    '观察者的视野菱形超过一半被覆盖（场景成立）',
    cov.covered * 2 > cov.total,
    `${cov.covered}/${cov.total}`,
  );
  check('视野 9 → 5（减半向上取整）', visionOf(s, eye) === 5, String(visionOf(s, eye)));
  check('射程 4 → 2', effectiveRange(s, eye) === 2, String(effectiveRange(s, eye)));
}

/* ══════════════════════════════════════════════════════════════════
 * 3. 走出暗影就恢复
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[3] 走出暗影');
{
  const { s, eye } = arena();
  refreshShadow(s);
  eye.x = 0;
  eye.y = 0; // 挪到角落，离中心 20 格
  const cov = shadowCoverage(s, eye, 9)!;
  check('覆盖不到一半（场景成立）', !(cov.covered * 2 > cov.total), `${cov.covered}/${cov.total}`);
  check('视野恢复成 9', visionOf(s, eye) === 9, String(visionOf(s, eye)));
  check('射程恢复成 4', effectiveRange(s, eye) === 4, String(effectiveRange(s, eye)));
}

/* ══════════════════════════════════════════════════════════════════
 * 4. 边界：正好一半不触发
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[4] 一半的边界');
{
  const { s, eye } = arena();
  const cells = diamond(s, eye, 9);
  const total = cells.length;
  const half = Math.floor(total / 2);
  s.overlays = { shadow: cells.slice(0, half).sort((a, b) => a - b) };
  check(
    `正好 ${half}/${total}（不超过一半）→ 不减半`,
    visionOf(s, eye) === 9,
    `视野 ${visionOf(s, eye)}`,
  );
  s.overlays = { shadow: cells.slice(0, half + 1).sort((a, b) => a - b) };
  check(
    `${half + 1}/${total}（过半）→ 减半`,
    visionOf(s, eye) === 5,
    `视野 ${visionOf(s, eye)}`,
  );
}

/* ══════════════════════════════════════════════════════════════════
 * 5. 回合末才刷新
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[5] 刷新时机');
{
  const { s, shade } = arena();
  refreshShadow(s);
  const before = [...(s.overlays?.['shadow'] ?? [])];

  // 怪物走 2 格：这一回合黑雾**不该**跟着动
  shade.x = 12;
  const midTurn = [...(s.overlays?.['shadow'] ?? [])];
  check('它走了，当回合黑雾不动（这是故意的）', midTurn.length === before.length && midTurn[0] === before[0]);

  // 回合末重铺：走真的 END_TURN，顺带验"钩子确实挂在交棒时"
  const end = applyAction(s, { type: 'END_TURN' });
  check('交棒成功', end.ok, end.ok ? '' : end.reason);
  const after = [...((end.ok ? end.state : s).overlays?.['shadow'] ?? [])];
  check('回合末重铺：位置变了', after.join(',') !== before.join(','));
  check('重铺后中心跟着新位置', after.includes(12 * s.w + 10));
}

/* ══════════════════════════════════════════════════════════════════
 * 6. 界面 / AI / 规则读的是同一份
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[6] 三方一致');
{
  const { s, eye } = arena();
  s.fog = true;
  refreshShadow(s);
  const view = playerView(s, 'A').state;
  check(
    '雾图里带着同一份暗影（AI 和界面不会算出更宽的视野）',
    JSON.stringify(view.overlays?.['shadow'] ?? []) === JSON.stringify(s.overlays?.['shadow'] ?? []),
  );
  const viewEye = view.units.find((u) => u.id === 'eye');
  check('用雾图算出来的视野 = 真局算出来的视野', !!viewEye && visionOf(view, viewEye) === visionOf(s, eye), `view ${viewEye ? visionOf(view, viewEye) : '?'} / 真局 ${visionOf(s, eye)}`);
}

/* ══════════════════════════════════════════════════════════════════
 * 7. 没有诡异时零影响
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[7] 场上没有诡异');
{
  const { s, eye } = arena();
  s.overlays = {};
  check('没铺过暗影：视野原样', visionOf(s, eye) === 9, String(visionOf(s, eye)));
  check('没铺过暗影：射程原样', effectiveRange(s, eye) === 4, String(effectiveRange(s, eye)));

  // 诡异出局之后，下一次重铺应当把黑雾清干净
  s.units = s.units.filter((u) => u.id !== 'shade');
  refreshShadow(s);
  check('诡异没了，重铺后黑雾清空', (s.overlays?.['shadow'] ?? []).length === 0);
  check('视野随黑雾一起恢复', visionOf(s, eye) === 9, String(visionOf(s, eye)));
}

/* ══════════════════════════════════════════════════════════════════
 * 8. 不干扰普通对局（没开这个包）
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[8] 没开这个包');
{
  const s = createMatch({ ...DEFAULT_CONFIG, size: 12, startEra: 2 }, 1);
  const u = s.units.find((x) => x.owner === 'A');
  check('普通对局里 overlays 是空的', !s.overlays || Object.keys(s.overlays).length === 0);
  check('视野没有被任何东西改（= 兵种表的值）', !!u && visionOf(s, u) === s.unitTypes[u.type]!.vision);
}

/* ══════════════════════════════════════════════════════════════════
 * 9. 投下暗影的单位自己不受影响
 *
 * 不修这条的话：影主站在自己半径 7 的黑雾正中间，视野 8→4、射程 4→2，
 * 等于自己把自己废掉。语义上也对——影子是它们的介质，不是它们的雾。
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[9] 诡异免疫自己的暗影');
{
  const { s } = arena();
  // 把"影探针"放在自己暗影的正中间
  const shade = s.units.find((u) => u.id === 'shade')!;
  refreshShadow(s);
  const cov = shadowCoverage(s, shade, 5)!;
  check('它确实站在暗影里（场景成立）', cov.covered * 2 > cov.total, `${cov.covered}/${cov.total}`);
  check('视野不因暗影减半（5 → 仍是 5）', visionOf(s, shade) === 5, String(visionOf(s, shade)));
  check('射程不因暗影减半（1 → 仍是 1）', effectiveRange(s, shade) === 1, String(effectiveRange(s, shade)));
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
if (failed > 0) process.exit(1);
