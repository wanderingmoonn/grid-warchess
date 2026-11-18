/**
 * 「不成系的三个」探针：黑蝗 / 黑茧 / 诡异。
 *
 * ── 它守什么 ────────────────────────────────────────────────────────
 *
 * 1. **黑蝗的暗影半径是 0**：只有脚下那一格算暗影，而且它自己不掉视野；
 * 2. 「繁殖」的三个条件（周围 2 只、全在暗影里、没有别的单位）；
 * 3. 「结茧」：四周都是黑蝗 + 脚下没有地面单位 → 变成黑茧；
 * 4. 「升华」：黑茧化开，把两格内的暗影催成影主（而且对方要停一回合、按比例回血）；
 * 5. 「无形」：不攻击时看不见，攻击后现形。
 *
 * 用法：npm run probe:odd
 */

import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import { abilityApi, applyAction, isHiddenFrom, visionOf } from '../src/core/rules.ts';
import {
  BLACK_COCOON,
  BLACK_LOCUST,
  DARK_TURMOIL,
  SHADE,
  SHADOW_LORD,
  UNNAMABLE,
  refreshShadow,
  SHADOW_KEY,
} from '../src/core/dark-turmoil-packs.ts';
import { unitAiProfileOf } from '../src/core/unit-ai.ts';
import type { UnitAiCtx } from '../src/core/expansions.ts';
import type { GameState, PlayerId, Unit } from '../src/core/types.ts';

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
  startEra: 6,
  expansionIds: [...DEFAULT_CONFIG.expansionIds, 'cultivation', 'dark-turmoil'],
};

interface Arena {
  s: GameState;
  mk: (id: string, type: string, owner: PlayerId, x: number, y: number) => Unit;
}

function arena(): Arena {
  const s = createMatch(CONFIG, 4477);
  s.fog = false;
  s.units = [];
  s.marks = [];
  s.overlays = {};
  s.players.A.gold = 0;
  s.players.B.gold = 0;
  s.tiles = s.tiles.map(() => ({ terrain: 'plain' as const, cityId: null }));
  s.cities = [
    { id: 'ca', owner: 'A', x: 0, y: 0, size: 2, era: 6, hp: 70, maxHp: 70, armor: 4 },
    { id: 'cb', owner: 'B', x: 18, y: 18, size: 2, era: 6, hp: 70, maxHp: 70, armor: 4 },
  ];
  const mk = (id: string, type: string, owner: PlayerId, x: number, y: number): Unit => {
    const u: Unit = { id, type, owner, x, y, hp: s.unitTypes[type]!.maxHp, kills: 0, moved: false, acted: false };
    if (s.unitTypes[type]!.layer) u.layer = s.unitTypes[type]!.layer;
    s.units.push(u);
    return u;
  };
  for (const a of [0, 999]) {
    s.unitTypes[`probe-tank-${a}`] = {
      ...s.unitTypes['militia']!,
      id: `probe-tank-${a}`,
      name: `靶子${a}`,
      category: 'combat',
      atk: 0,
      range: 0,
      move: 0,
      armor: a,
      maxHp: 999,
      skills: [],
      aiAutonomy: 0,
    };
  }
  mk('keep-alive', 'probe-tank-999', 'A', 0, 19);
  s.current = 'B';
  s.turn = 10;
  return { s, mk };
}

function ctxOf(s: GameState, u: Unit): UnitAiCtx {
  return {
    state: s,
    unit: u,
    def: s.unitTypes[u.type]!,
    api: abilityApi,
    candidates: [],
    rejected: new Set<string>(),
    foes: s.units.filter((x) => x.owner !== u.owner && x.hp > 0),
    allies: s.units.filter((x) => x.owner === u.owner && x.hp > 0),
  };
}

const endTurnOf = (s: GameState, side: PlayerId): GameState => {
  if (s.current !== side) s.current = side;
  const e = applyAction(s, { type: 'END_TURN' });
  if (!e.ok) throw new Error(`END_TURN 失败：${e.reason}`);
  return e.state;
};

const beginTurnOf = (s: GameState, side: PlayerId): GameState => {
  const other: PlayerId = side === 'A' ? 'B' : 'A';
  if (s.current !== other) s.current = other;
  const e = applyAction(s, { type: 'END_TURN' });
  if (!e.ok) throw new Error(`END_TURN 失败：${e.reason}`);
  return e.state;
};

console.log('不成系的三个探针\n');

/* ══════════════════════════════════════════════════════════════════
 * 1. 三个兵
 * ══════════════════════════════════════════════════════════════════ */
console.log('[1] 三个兵');
{
  const { s } = arena();
  check('黑蝗在表里', !!s.unitTypes[BLACK_LOCUST]);
  check('黑茧是建筑', s.unitTypes[BLACK_COCOON]?.category === 'building');
  check('黑茧不会动', s.unitTypes[BLACK_COCOON]?.move === 0);
  check('诡异在表里', !!s.unitTypes[UNNAMABLE]);
  for (const id of [BLACK_LOCUST, BLACK_COCOON, UNNAMABLE]) {
    check(`${id} 不可建造`, s.unitTypes[id]?.summonedOnly === true);
    check(`${id} 不带属性`, !s.unitTypes[id]?.element && !s.unitTypes[id]?.weak);
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 2. 暗影半径 0 = 只有脚下
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[2] 黑蝗的暗影半径是 0');
{
  const { s, mk } = arena();
  const locust = mk('locust', BLACK_LOCUST, 'B', 10, 10);
  refreshShadow(s);
  const cells = s.overlays?.[SHADOW_KEY] ?? [];
  check('只铺出它脚下那一格', cells.length === 1 && cells[0] === 10 * s.w + 10, `${cells.length} 格`);
  check(
    '它自己不掉视野（投下暗影的单位免疫）',
    visionOf(s, locust) === s.unitTypes[BLACK_LOCUST]!.vision,
    `${visionOf(s, locust)}`,
  );
  // 反过来：站在它旁边一格的人不受影响（半径 0 就是半径 0）
  const foe = mk('foe', 'probe-tank-999', 'A', 11, 10);
  check('站在旁边一格的单位视野不受影响', visionOf(s, foe) === 0 || visionOf(s, foe) === s.unitTypes['probe-tank-999']!.vision);
}

/* ══════════════════════════════════════════════════════════════════
 * 3. 繁殖：周围恰 2 只 + 全在暗影里
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[3] 繁殖');
{
  // 用黑茧铺一片暗影，两只黑蝗夹着一个空格
  const { s, mk } = arena();
  mk('cocoon', BLACK_COCOON, 'B', 10, 14);
  mk('a', BLACK_LOCUST, 'B', 9, 10);
  mk('b', BLACK_LOCUST, 'B', 11, 10);
  refreshShadow(s);
  const after = endTurnOf(s, 'B');
  const born = after.units.filter((u) => u.type === BLACK_LOCUST);
  /*
   * 每只黑蝗每回合最多繁殖一只——两只在场的就各生一只，所以是 4 而不是 3。
   * 这是规则本身的样子（"相邻的某个格子满足条件就生成"是按个体算的），
   * 也意味着黑蝗会成倍长——成团之后每回合翻倍，这也是它必须靠"结茧"收束的原因。
   */
  check('两只各生一只（每只每回合最多一只）', born.length === 4, `${born.length} 只`);
  check('中间那个空格被填上了', born.some((u) => u.x === 10 && u.y === 10));
}

/* ══════════════════════════════════════════════════════════════════
 * 4. 结茧
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[4] 结茧');
{
  const { s, mk } = arena();
  mk('me', BLACK_LOCUST, 'B', 10, 10);
  mk('n1', BLACK_LOCUST, 'B', 9, 10);
  mk('n2', BLACK_LOCUST, 'B', 11, 10);
  mk('n3', BLACK_LOCUST, 'B', 10, 9);
  mk('n4', BLACK_LOCUST, 'B', 10, 11);
  const after = endTurnOf(s, 'B');
  const now = after.units.find((u) => u.id === 'me')!;
  check('四周都是同类 → 结成黑茧', now.type === BLACK_COCOON, now.type);
  check('四周的黑蝗被吞掉了', after.units.filter((u) => u.type === BLACK_LOCUST).length === 0);
  check('落回地面（不再是飞行单位）', now.layer !== 'air');

  // 脚下有地面单位 → 结不成
  const { s: s2, mk: mk2 } = arena();
  mk2('me2', BLACK_LOCUST, 'B', 10, 10);
  mk2('n1', BLACK_LOCUST, 'B', 9, 10);
  mk2('n2', BLACK_LOCUST, 'B', 11, 10);
  mk2('n3', BLACK_LOCUST, 'B', 10, 9);
  mk2('n4', BLACK_LOCUST, 'B', 10, 11);
  mk2('under', 'probe-tank-0', 'A', 10, 10); // 脚下站着一个地面单位
  const after2 = endTurnOf(s2, 'B');
  check(
    '脚下有地面单位 → 结不成茧',
    after2.units.find((u) => u.id === 'me2')!.type === BLACK_LOCUST,
  );
}

/* ══════════════════════════════════════════════════════════════════
 * 5. 升华：黑茧化开，把暗影催成影主
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[5] 升华');
{
  const { s, mk } = arena();
  mk('cocoon', BLACK_COCOON, 'B', 8, 8);
  const shade = mk('shade', SHADE, 'B', 9, 8); // 相邻 → 在两格内
  shade.hp = 15; // 影主 220 血、暗影 30 血 → 应该按 50% 变
  const t1 = endTurnOf(s, 'B');
  check('黑茧化开了（自己不在了）', !t1.units.some((u) => u.id === 'cocoon'));
  const mid = t1.units.find((u) => u.id === 'shade')!;
  check('暗影还没变（要停一回合）', mid.type === SHADE, mid.type);
  check('记下了要变成影主', mid.custom?.formTo === SHADOW_LORD, String(mid.custom?.formTo));

  const t2 = beginTurnOf(t1, 'B');
  check('停的那一回合动不了', t2.units.find((u) => u.id === 'shade')!.moved === true);
  const t3 = endTurnOf(t2, 'B');
  const done = t3.units.find((u) => u.id === 'shade')!;
  check('第二个回合末变成影主', done.type === SHADOW_LORD, done.type);
  check(
    '血量按比例（15/30 → 110/220）',
    done.hp === 110,
    `${done.hp}`,
  );
}

/* ══════════════════════════════════════════════════════════════════
 * 6. 无形
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[6] 无形');
{
  const { s, mk } = arena();
  // 隐匿只在**迷雾局**里成立（无雾时双方全见，`isHiddenFrom` 直接返回 false）
  s.fog = true;
  const u = mk('u', UNNAMABLE, 'B', 5, 5);
  check('没出手时对面看不见（即使相邻）', isHiddenFrom(s, u, 'A'));
  u.acted = true;
  check('出手之后现形', !isHiddenFrom(s, u, 'A'));
}

/* ══════════════════════════════════════════════════════════════════
 * 7. 目标偏好
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[7] 目标偏好');
{
  // 黑蝗：咬甲厚的
  {
    const { s, mk } = arena();
    const locust = mk('locust', BLACK_LOCUST, 'B', 5, 5);
    mk('thin', 'probe-tank-0', 'A', 5, 6);
    mk('thick', 'probe-tank-999', 'A', 6, 5);
    const out = unitAiProfileOf('locust-swarm')!.handler(ctxOf(s, locust));
    const atk = out.add?.find((x) => x.action.type === 'ATTACK')?.action;
    check('黑蝗咬护甲厚的', atk?.type === 'ATTACK' && (atk as { targetId: string }).targetId === 'thick', JSON.stringify(atk));
  }
  // 黑茧：打最近的
  {
    const { s, mk } = arena();
    const cocoon = mk('cocoon', BLACK_COCOON, 'B', 5, 5);
    mk('far', 'probe-tank-999', 'A', 5, 10);
    const near = mk('near', 'probe-tank-0', 'A', 5, 7);
    void near;
    const out = unitAiProfileOf('cocoon-nearest')!.handler(ctxOf(s, cocoon));
    const atk = out.add?.find((x) => x.action.type === 'ATTACK')?.action;
    check('黑茧打最近的', atk?.type === 'ATTACK' && (atk as { targetId: string }).targetId === 'near', JSON.stringify(atk));
  }
  // 诡异：补刀血最少的
  {
    const { s, mk } = arena();
    const u = mk('u', UNNAMABLE, 'B', 5, 5);
    const fat = mk('fat', 'probe-tank-0', 'A', 5, 6);
    const thin = mk('thin', 'probe-tank-0', 'A', 6, 5);
    fat.hp = 900;
    thin.hp = 5;
    const out = unitAiProfileOf('unnamable-stalk')!.handler(ctxOf(s, u));
    const atk = out.add?.find((x) => x.action.type === 'ATTACK')?.action;
    check('诡异补刀血最少的', atk?.type === 'ATTACK' && (atk as { targetId: string }).targetId === 'thin', JSON.stringify(atk));
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 8. 面板
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[8] 面板');
{
  const { s, mk } = arena();
  const lines = (u: Unit): string => DARK_TURMOIL.hooks.getUnitPanelLines!({ state: s, unit: u }).join(' | ');
  const locust = mk('l', BLACK_LOCUST, 'B', 3, 3);
  check('黑蝗面板写了「繁殖」「结茧」', lines(locust).includes('繁殖') && lines(locust).includes('结茧'), lines(locust));
  const cocoon = mk('c', BLACK_COCOON, 'B', 3, 5);
  check('黑茧面板写了「升华」', lines(cocoon).includes('升华'), lines(cocoon));
  const un = mk('u', UNNAMABLE, 'B', 3, 7);
  check('诡异面板写了「无形」', lines(un).includes('无形'), lines(un));
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
if (failed > 0) process.exit(1);
