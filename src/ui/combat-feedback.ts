import type { PlayerView } from '../core/fog.ts';
import type { Action, City, GameState, PlayerId, Unit } from '../core/types.ts';
import { boardIdOf, boardOf } from '../core/board.ts';
import { cityName, simulateCombat, utype } from '../core/rules.ts';

export type CombatAction = Extract<Action, { type: 'ATTACK' | 'SIEGE' }>;

export interface CombatHealth {
  name: string;
  before: number;
  after: number;
  removed: boolean;
  extraBefore?: number;
  extraAfter?: number;
}

export interface CombatForecast {
  action: CombatAction;
  attacker: CombatHealth;
  target: CombatHealth;
  collateral: number;
  city: boolean;
  cues: CombatCue[];
}

export interface CombatCue {
  x: number;
  y: number;
  size: number;
  text: string;
  self: boolean;
  below: boolean;
  inset: boolean;
  edge: 'left' | 'right' | '';
  tone: 'loss' | 'gain' | 'neutral';
}

function cue(s: GameState, piece: Unit | City, text: string, self: boolean, below: boolean, delta: number): CombatCue {
  const { x, y } = piece;
  const size = 'type' in piece ? utype(s, piece.type).footprint ?? 1 : piece.size;
  const { w, h } = boardOf(s, boardIdOf(piece));
  const inset = below ? y + size >= h : y === 0;
  const edge = x === 0 ? 'left' : x + size >= w ? 'right' : '';
  return { x, y, size, text, self, below, inset, edge, tone: delta < 0 ? 'loss' : delta > 0 ? 'gain' : 'neutral' };
}

function combatCues(
  s: GameState, attacker: Unit, target: Unit | City, self: CombatHealth, enemy: CombatHealth, forecast: boolean,
): CombatCue[] {
  // 额外生命会先吸收伤害，棋盘上的数字计入这部分。
  const change = (item: CombatHealth): number => item.after - item.before + (item.extraAfter ?? 0) - (item.extraBefore ?? 0);
  const signed = (delta: number): string => delta < 0 ? `−${-delta}` : delta > 0 ? `+${delta}` : '0';
  const targetDelta = change(enemy);
  const selfDelta = change(self);
  const targetText = enemy.removed
    ? forecast ? ('type' in target ? '预计击破' : '预计破城') : ('type' in target ? '离开视野' : '城墙已破')
    : signed(targetDelta);
  const cues = [cue(s, target, targetText, false, false, targetDelta)];
  if (selfDelta || self.removed) {
    cues.push(cue(s, attacker, self.removed ? '本方离场' : `本方 ${signed(selfDelta)}`, true, true, selfDelta));
  }
  return cues;
}

function combatHealth(
  before: GameState, after: GameState, attacker: Unit, target: Unit | City,
): { attacker: CombatHealth; target: CombatHealth } {
  const cityAfter = 'type' in target ? undefined : after.cities.find((entry) => entry.id === target.id);
  return {
    attacker: health(before, attacker, after.units.find((entry) => entry.id === attacker.id)),
    target: 'type' in target ? health(before, target, after.units.find((entry) => entry.id === target.id)) : {
      name: cityName(target), before: target.hp,
      after: Math.max(0, cityAfter?.hp ?? 0), removed: !cityAfter || cityAfter.ruined === true,
    },
  };
}

function health(s: GameState, before: Unit, after?: Unit): CombatHealth {
  return {
    name: utype(s, before.type).name,
    before: before.hp,
    after: Math.max(0, after?.hp ?? 0),
    removed: !after,
    extraBefore: before.extraHp ?? 0,
    extraAfter: after?.extraHp ?? 0,
  };
}

function combatTarget(s: GameState, action: CombatAction): Unit | City | undefined {
  return action.type === 'ATTACK'
    ? s.units.find((entry) => entry.id === action.targetId)
    : s.cities.find((entry) => entry.id === action.cityId);
}

export function forecastCombat(view: PlayerView, me: PlayerId, action: CombatAction): CombatForecast | null {
  const s = view.state;
  const attacker = s.units.find((unit) => unit.id === action.unitId);
  if (!attacker || attacker.owner !== me || s.current !== me) return null;
  const target = combatTarget(s, action);
  if (!target) return null;
  const result = simulateCombat(s, action);
  if (!result.ok) return null;
  const after = result.state;
  const hp = combatHealth(s, after, attacker, target);
  return {
    action,
    ...hp,
    collateral: s.units.filter((unit) => unit.id !== attacker.id && (action.type === 'SIEGE' || unit.id !== target.id) &&
      (after.units.find((entry) => entry.id === unit.id)?.hp ?? 0) < unit.hp).length,
    city: action.type === 'SIEGE',
    cues: combatCues(s, attacker, target, hp.attacker, hp.target, true),
  };
}

export function combatResultCues(before: PlayerView, after: PlayerView, action: CombatAction): CombatCue[] {
  const attacker = before.state.units.find((unit) => unit.id === action.unitId);
  const target = combatTarget(before.state, action);
  if (!attacker || !target) return [];
  const hp = combatHealth(before.state, after.state, attacker, target);
  return combatCues(before.state, attacker, target, hp.attacker, hp.target, false);
}

export function combatCuesHtml(cues: readonly CombatCue[]): string {
  return cues.map(({ x, y, size, text, self, below, inset, edge, tone }) =>
    `<span class="combat-cue ${tone}" data-side="${self ? 'self' : 'target'}" data-below="${below}" data-edge="${edge}" ${inset ? 'data-inset' : ''} style="grid-area:${y + 1}/${x + 1}/span ${size}/span ${size}"><b>${escapeHtml(text)}</b></span>`,
  ).join('');
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function healthHtml(label: string, item: CombatHealth, city = false): string {
  const delta = item.after - item.before;
  return `<div class="combat-health"><span>${label} · ${escapeHtml(item.name)}</span>
    <div><b>${item.before} → ${item.after}</b><strong class="${delta < 0 ? 'loss' : delta > 0 ? 'gain' : 'neutral'}">${delta > 0 ? '+' : ''}${delta}</strong></div>
    ${(item.extraBefore ?? 0) > 0 || (item.extraAfter ?? 0) > 0 ? `<small>额外生命 ${item.extraBefore ?? 0} → ${item.extraAfter ?? 0}</small>` : ''}
    ${item.removed ? `<small>${city ? '城破后需派兵接管' : '预计离场'}</small>` : ''}</div>`;
}

export function combatForecastHtml(forecast: CombatForecast, pinned: boolean, compact = false): string {
  if (compact) {
    const currentHealth = (label: string, item: CombatHealth): string =>
      `<div><span>${label} · ${escapeHtml(item.name)}</span><b>${item.before} → ${item.after}</b>${
        (item.extraBefore ?? 0) > 0 || (item.extraAfter ?? 0) > 0
          ? `<small>额外生命 ${item.extraBefore ?? 0} → ${item.extraAfter ?? 0}</small>` : ''
      }</div>`;
    return `<div class="combat-summary" aria-label="${forecast.city ? '攻城预估' : '攻击预估'}">
      ${currentHealth('本方', forecast.attacker)}
      ${currentHealth(forecast.city ? '城墙' : '目标', forecast.target)}
    </div>
    ${forecast.collateral ? `<small class="combat-collateral">预计波及 ${forecast.collateral} 个可见单位</small>` : ''}
    <div class="combat-buttons">
      <button class="btn" data-combat="cancel">取消</button>
      <button class="btn btn-primary" data-combat="confirm">确认${forecast.city ? '攻城' : '攻击'}</button>
    </div>`;
  }
  return `<div class="combat-preview-head"><b>${forecast.city ? '攻城预览' : '交锋预览'}</b>
    <button class="btn btn-sm" data-combat="cancel" aria-label="关闭攻击预览">关闭</button></div>
    ${healthHtml(forecast.city ? '目标耐久' : '目标生命', forecast.target, forecast.city)}
    ${healthHtml('本方生命', forecast.attacker)}
    <p class="combat-preview-note">${forecast.collateral > 0 ? `波及 ${forecast.collateral} 个可见单位。` : ''}含反击；伏兵与事件可能影响结果。</p>
    <button class="btn btn-primary btn-block" data-combat="confirm">${pinned ? '确认' : '执行'}${forecast.city ? '攻城' : '攻击'}</button>`;
}

export function actionFeedback(before: PlayerView, after: PlayerView, action: Action): string | null {
  const unit = 'unitId' in action ? before.state.units.find((entry) => entry.id === action.unitId) : undefined;
  const name = unit ? utype(before.state, unit.type).name : '单位';
  if (action.type === 'MOVE') return `${name} 已移动到 ${String.fromCharCode(65 + action.x)}${action.y + 1}`;
  if (action.type === 'ATTACK' || action.type === 'SIEGE') {
    const target = combatTarget(before.state, action);
    if (!target) return '攻击已结算';
    const remaining = combatTarget(after.state, action);
    const targetName = 'type' in target ? utype(before.state, target.type).name : cityName(target);
    const current = remaining ? Math.max(0, remaining.hp) : '当前不可见';
    const self = unit ? after.state.units.find((entry) => entry.id === unit.id) : undefined;
    const selfLoss = unit ? Math.max(0, unit.hp - (self?.hp ?? 0)) : 0;
    const extraBefore = 'type' in target ? target.extraHp ?? 0 : 0;
    const extraAfter = remaining && 'type' in remaining ? remaining.extraHp ?? 0 : extraBefore;
    return `${name} → ${targetName}：${target.hp} → ${current}${extraBefore !== extraAfter ? `；额外生命 ${extraBefore} → ${extraAfter}` : ''}${selfLoss > 0 ? `；本方损失 ${selfLoss} 生命` : ''}${!remaining ? '；目标已离开当前视图' : 'ruined' in remaining && remaining.ruined ? '；城墙已破，派兵接管' : ''}`;
  }
  if (action.type === 'RECRUIT') return `${before.state.unitTypes[action.unitType]?.name ?? '新兵'} 已生产，本回合不能行动`;
  if (action.type === 'BUILD') return `${before.state.unitTypes[action.unitType]?.name ?? '建筑'} 已下达建造指令`;
  if (action.type === 'UPGRADE') return '城市时代已升级，可在生产列表查看新兵种';
  return null;
}
