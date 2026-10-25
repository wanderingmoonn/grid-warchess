/** Offline regressions for saves, imports and room payloads. Never contacts the cloud. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyAction } from '../src/core/rules.ts';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import type { GameState } from '../src/core/types.ts';
import { isRoomSeat, readRoomSnapshot, sameSubmittedState, submissionPlayer } from '../src/net/protocol.ts';
import { clearMatch, exportMatch, importMatch, loadMatch, loadMeta, saveMatch, setSaveScope } from '../src/storage/save.ts';
import { isValidState } from '../src/storage/validation.ts';
import { normalizeState } from '../src/storage/migrate.ts';

const fixture = (): GameState => createMatch(DEFAULT_CONFIG, 20261025);

test('all eras and era packs produce restorable states', () => {
  const packs = ['pack-antiquity', 'pack-medieval', 'pack-gunpowder', 'pack-industry', 'pack-modern'];
  for (let startEra = 1; startEra <= 5; startEra++) {
    const state = createMatch({ ...DEFAULT_CONFIG, startEra, expansionIds: [...DEFAULT_CONFIG.expansionIds, packs[startEra - 1]!] }, 20261025);
    assert.ok(isValidState(state), `era ${startEra}`);
    assert.deepEqual(importMatch(exportMatch(state)), state);
    const next = applyAction(state, { type: 'END_TURN' });
    assert.ok(next.ok);
    assert.ok(isValidState(next.state));
  }
});

test('older v4 saves without optional fields still load', () => {
  const state = fixture();
  state.version = 4;
  delete state.turnProduction;
  delete state.config.aiLevel;
  delete state.config.commanderMode;
  delete state.config.mapStyle;
  delete state.config.mapSymmetry;
  delete state.aiControl;
  delete state.orders;
  for (const city of state.cities) delete city.capturedTurn;
  const restored = importMatch(exportMatch(state));
  assert.ok(restored);
  assert.equal(restored.version, 5);
  assert.deepEqual(restored.turnProduction, { turn: state.turn, player: state.current, recruited: 0, upgraded: 0 });
  assert.equal(restored.config.aiLevel, undefined);
  assert.equal(restored.orders, undefined);
  assert.equal(state.version, 4, 'migration must not mutate its input');
});

test('import checks both envelope and state versions', () => {
  assert.equal(importMatch('{'), null);
  assert.equal(importMatch('null'), null);
  assert.equal(importMatch(JSON.stringify({ kind: 'warchess-match', version: 2, state: fixture() })), null);
  const state = fixture();
  state.version = 3;
  assert.equal(importMatch(exportMatch(state)), null);
});

test('malformed nested values never pass the persistence boundary', () => {
  const changes: Array<[string, (state: GameState) => void]> = [
    ['missing tiles', (s) => { s.tiles.pop(); }],
    ['invalid board width', (s) => { s.w = 1.5; }],
    ['invalid turn', (s) => { s.turn = 0; }],
    ['wrong player', (s) => { s.current = 'C' as 'A'; }],
    ['invalid gold', (s) => { s.players.A.gold = NaN; }],
    ['missing player', (s) => { delete (s.players as Partial<typeof s.players>).B; }],
    ['missing memory', (s) => { delete (s.memory as Partial<typeof s.memory>).A; }],
    ['wrong config shape', (s) => { s.config.expansionIds = null as unknown as string[]; }],
    ['missing unit definition', (s) => { delete s.unitTypes[s.units[0]!.type]; }],
    ['out of bounds unit', (s) => { s.units[0]!.x = s.w; }],
    ['duplicate unit', (s) => { s.units.push(structuredClone(s.units[0]!)); }],
    ['overlapping board units', (s) => { s.units[1]!.x = s.units[0]!.x; s.units[1]!.y = s.units[0]!.y; }],
    ['unit sequence reuse', (s) => { s.nextUnitSeq = Number(s.units[0]!.id.slice(1)); }],
    ['invalid unit health', (s) => { s.units[0]!.hp = -1; }],
    ['invalid unit cost', (s) => { s.unitTypes[s.units[0]!.type]!.cost = -1; }],
    ['invalid city', (s) => { s.cities[0]!.size = 0; }],
    ['unknown city', (s) => { s.tiles.find((t) => t.terrain === 'city')!.cityId = 'missing'; }],
    ['incorrect city footprint', (s) => { s.cities[0]!.x += 1; }],
    ['invalid orders', (s) => { s.orders = { A: ['missing-unit'] }; }],
  ];
  for (const [name, mutate] of changes) {
    const state = fixture();
    mutate(state);
    assert.equal(isValidState(state), false, name);
    assert.equal(importMatch(exportMatch(state)), null, name);
  }
});

test('cargo is validated and IDs remain unique across board and cargo', () => {
  const state = fixture();
  const unit = state.units[0]!;
  const cargo = structuredClone(unit);
  cargo.id = 'cargo-unit';
  unit.cargo = [cargo];
  assert.ok(isValidState(state));
  cargo.id = state.units[1]!.id;
  assert.equal(isValidState(state), false);
  cargo.id = 'cargo-unit';
  cargo.cargo = [{ ...cargo, id: 'nested' }];
  assert.equal(isValidState(state), false);
});

class MemoryStorage implements Storage {
  values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

test('local game and room drafts isolate both state and metadata', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  try {
    setSaveScope(null);
    const local = fixture();
    saveMatch(local);
    const localMeta = loadMeta();
    assert.ok(localMeta);
    const next = applyAction(local, { type: 'END_TURN' });
    assert.ok(next.ok);
    setSaveScope('ABCDEF');
    assert.equal(loadMatch(), null);
    assert.equal(loadMeta(), null);
    saveMatch(next.state);
    assert.equal(loadMeta()?.pendingFor, 'B');
    setSaveScope('BCDEFG');
    saveMatch(local);
    clearMatch();
    setSaveScope('ABCDEF');
    assert.deepEqual(loadMatch(), next.state);
    assert.equal(loadMeta()?.pendingFor, 'B');
    clearMatch();
    assert.equal(loadMatch(), null);
    assert.equal(loadMeta(), null);
    setSaveScope(null);
    assert.deepEqual(loadMatch(), local);
    assert.deepEqual(loadMeta(), localMeta);

    const restored = loadMatch()!;
    restored.players.A.gold = 0;
    assert.deepEqual(loadMatch(), local, 'loaded states do not share mutable references');
    const invalid = fixture();
    invalid.turn = 0;
    saveMatch(invalid);
    assert.deepEqual(loadMatch(), local, 'invalid state must not overwrite a good save');
    storage.setItem('warchess:match:v1', '{');
    assert.equal(loadMatch(), null);
    storage.setItem('warchess:meta:v1', JSON.stringify({ pendingFor: 'C', createdAt: 1, updatedAt: 2 }));
    assert.equal(loadMeta(), null);
  } finally {
    setSaveScope(null);
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('unavailable browser storage degrades without throwing', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('blocked'); } });
  try {
    assert.doesNotThrow(() => saveMatch(fixture()));
    assert.equal(loadMatch(), null);
    assert.equal(loadMeta(), null);
    assert.doesNotThrow(clearMatch);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

function roomRow() {
  const state = fixture();
  return { code: 'ABCDEF', state, turn: state.turn, current: state.current,
    seat_a: 'token-a', seat_b: null, updated_at: '2026-10-25T00:00:00.000Z' };
}

test('room snapshots accept object and JSON states and detach the local draft', () => {
  const row = roomRow();
  const snapshot = readRoomSnapshot(row);
  assert.deepEqual(readRoomSnapshot({ ...row, state: JSON.stringify(row.state) }), snapshot);
  snapshot.state.players.A.gold = 0;
  assert.notEqual(row.state.players.A.gold, 0);
});

test('room snapshots reject inconsistent turn/current and malformed payloads', () => {
  const row = roomRow();
  for (const invalid of [null, { ...row, state: '{' }, { ...row, turn: row.turn + 1 },
    { ...row, current: 'B' }, { ...row, seat_b: 42 }, { ...row, updated_at: 'bad' }]) {
    assert.throws(() => readRoomSnapshot(invalid));
  }
});

test('seat records require a known side and a nonempty token', () => {
  assert.ok(isRoomSeat({ code: 'ABCDEF', seat: 'A', token: 'token-a' }));
  assert.equal(isRoomSeat({ code: 'ABCDEF', seat: 'C', token: 'token-a' }), false);
  assert.equal(isRoomSeat({ code: 'ABCDEF', seat: 'B', token: '' }), false);
  assert.equal(isRoomSeat({ code: '', seat: 'B', token: 'token-b' }), false);
});

test('submission requires one completed turn or a same-turn victory', () => {
  const state = fixture();
  assert.throws(() => submissionPlayer(state, state.turn));
  const next = applyAction(state, { type: 'END_TURN' });
  assert.ok(next.ok);
  assert.equal(submissionPlayer(next.state, state.turn), 'A');
  assert.throws(() => submissionPlayer(next.state, state.turn + 1));
  assert.throws(() => submissionPlayer(next.state, state.turn - 1));
  state.winner = 'A';
  assert.equal(submissionPlayer(state, state.turn), 'A');
  next.state.winner = 'A';
  assert.equal(submissionPlayer(next.state, state.turn), 'A', 'victory during turn-start hooks may also advance the turn');
});

test('lost-response retries compare full state independent of jsonb key order', () => {
  const state = fixture();
  const reordered = JSON.parse(JSON.stringify(state, (_key, value: unknown) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).reverse());
    }
    return value;
  })) as GameState;
  assert.ok(sameSubmittedState(state, reordered));
  reordered.players.A.gold += 1;
  assert.equal(sameSubmittedState(state, reordered), false);
  const reorderedUnits = structuredClone(state);
  reorderedUnits.units.reverse();
  assert.equal(sameSubmittedState(state, reorderedUnits), false, 'unit ordering remains significant');
});

test('v5 production ledger is mandatory, current and bounded in commander mode', () => {
  const changes: Array<(s: GameState) => void> = [
    (s) => { delete s.turnProduction; },
    (s) => { s.turnProduction!.turn += 1; },
    (s) => { s.turnProduction!.player = 'B'; },
    (s) => { s.turnProduction!.recruited = -1; },
    (s) => { s.turnProduction!.upgraded = 0.5; },
    (s) => { s.turnProduction!.recruited = Infinity; },
    (s) => { s.turnProduction!.recruited = 1; s.turnProduction!.upgraded = 1; },
    (s) => { s.turnProduction!.legacyLocked = true; },
  ];
  for (const mutate of changes) {
    const state = createMatch({ ...DEFAULT_CONFIG, commanderMode: true }, 35);
    mutate(state);
    assert.equal(isValidState(state), false);
    assert.equal(importMatch(exportMatch(state)), null);
  }
  const normal = fixture();
  normal.turnProduction!.recruited = 10;
  normal.turnProduction!.upgraded = 4;
  assert.ok(isValidState(normal), 'normal-mode ledger does not invent a production cap');
});

test('successful commander production survives export/import and cannot be repeated', () => {
  const state = createMatch({ ...DEFAULT_CONFIG, commanderMode: true }, 36);
  state.players.A.gold = 10000;
  const city = state.cities.find((c) => c.owner === 'A')!;
  const first = applyAction(state, { type: 'RECRUIT', cityId: city.id, unitType: 'militia' });
  assert.ok(first.ok);
  const restored = importMatch(exportMatch(first.state));
  assert.ok(restored);
  assert.deepEqual(restored.turnProduction, { turn: state.turn, player: 'A', recruited: 1, upgraded: 0 });
  assert.equal(applyAction(restored, { type: 'RECRUIT', cityId: city.id, unitType: 'militia' }).ok, false);
  assert.equal(applyAction(restored, { type: 'UPGRADE', cityId: city.id }).ok, false);
  const handed = applyAction(restored, { type: 'END_TURN' });
  assert.ok(handed.ok);
  assert.deepEqual(handed.state.turnProduction, { turn: state.turn + 1, player: 'B', recruited: 0, upgraded: 0 });
});

test('legacy commander saves lock only the unknown current production turn', () => {
  const old = createMatch({ ...DEFAULT_CONFIG, commanderMode: true }, 37);
  old.version = 4;
  delete old.turnProduction;
  old.log = [];
  const before = structuredClone(old);
  const migrated = normalizeState(old);
  assert.ok(migrated);
  assert.equal(migrated.version, 5);
  assert.deepEqual(migrated.turnProduction, {
    turn: old.turn, player: old.current, recruited: 1, upgraded: 0, legacyLocked: true,
  });
  assert.deepEqual(normalizeState(migrated), migrated, 'repeated load must preserve the same ledger');
  assert.deepEqual(old, before);
  const city = old.cities.find((c) => c.owner === 'A')!;
  assert.equal(applyAction(migrated, { type: 'RECRUIT', cityId: city.id, unitType: 'militia' }).ok, false);
  const handed = applyAction(migrated, { type: 'END_TURN' });
  assert.ok(handed.ok);
  assert.equal(handed.state.turnProduction!.legacyLocked, undefined);
  const returned = applyAction(handed.state, { type: 'END_TURN' });
  assert.ok(returned.ok);
  assert.equal(applyAction(returned.state, { type: 'RECRUIT', cityId: city.id, unitType: 'militia' }).ok, true);
});

test('legacy completed results are preserved without reviving the game', () => {
  const old = fixture();
  old.version = 4;
  delete old.turnProduction;
  old.winner = 'B';
  const migrated = normalizeState(old)!;
  assert.equal(migrated.winner, 'B');
  assert.equal(migrated.resultReason, 'legacy');
  assert.equal(applyAction(migrated, { type: 'END_TURN' }).ok, false);
  const ongoing = { ...old, winner: null };
  assert.equal(normalizeState(ongoing)!.winner, null);
});

test('local storage and cloud snapshots use the same immutable legacy migration', () => {
  const row = roomRow();
  row.state.version = 4;
  row.state.config.commanderMode = true;
  delete row.state.turnProduction;
  const before = structuredClone(row);
  const expected = normalizeState(row.state)!;
  assert.deepEqual(readRoomSnapshot(row).state, expected);
  assert.ok(sameSubmittedState(row.state, expected), 'migrated snapshots support response-loss comparison');
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  try {
    setSaveScope(null);
    storage.setItem('warchess:match:v1', JSON.stringify(row.state));
    assert.deepEqual(loadMatch(), expected);
    saveMatch(row.state);
    assert.deepEqual(JSON.parse(storage.getItem('warchess:match:v1')!), expected);
    assert.deepEqual(loadMatch(), expected);
    const invalid = structuredClone(expected);
    delete invalid.turnProduction;
    saveMatch(invalid);
    assert.deepEqual(loadMatch(), expected, 'missing v5 ledger cannot replace a valid save');
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
  assert.deepEqual(row, before);
});

test('draw results roundtrip and submit within the final player turn', () => {
  const state = fixture();
  state.turn = 200;
  state.current = 'B';
  state.turnProduction = { turn: 200, player: 'B', recruited: 0, upgraded: 0 };
  state.winner = 'draw';
  state.resultReason = 'turn-limit';
  assert.deepEqual(importMatch(exportMatch(state)), state);
  assert.equal(submissionPlayer(state, 200), 'B');
  const snapshot = readRoomSnapshot({ ...roomRow(), state, turn: 200, current: 'B' });
  assert.equal(snapshot.state.winner, 'draw');
  assert.ok(sameSubmittedState(snapshot.state, state));
  const old = { ...state, version: 4 };
  assert.equal(normalizeState(old), null, 'v4 never represented draws');
});

test('result reasons cannot contradict ongoing games or the result type', () => {
  const invalid: Array<[GameState['winner'], unknown]> = [
    [null, 'turn-limit'], ['A', 'no-cities'], ['draw', 'conquest'], ['draw', 'legacy'], ['A', 'unknown'],
  ];
  for (const [winner, reason] of invalid) {
    const state = fixture();
    state.winner = winner;
    (state as unknown as Record<string, unknown>).resultReason = reason;
    assert.equal(normalizeState(state), null, `${winner}/${String(reason)}`);
  }
  for (const [winner, resultReason] of [
    ['A', 'conquest'], ['B', 'turn-limit'], ['draw', 'turn-limit'], ['draw', 'no-cities'],
  ] as const) assert.ok(normalizeState({ ...fixture(), winner, resultReason }));
});

test('a real 100-round game ends on B and survives all persistence boundaries', () => {
  let state = createMatch({ ...DEFAULT_CONFIG, commanderMode: true }, 38);
  for (let completedTurns = 0; completedTurns < 200; completedTurns++) {
    assert.equal(state.winner, null);
    const result = applyAction(state, { type: 'END_TURN' });
    assert.ok(result.ok);
    state = result.state;
    assert.ok(isValidState(state), `after player turn ${completedTurns + 1}`);
    if (completedTurns === 198) {
      assert.equal(state.turn, 200);
      assert.equal(state.current, 'B');
      assert.equal(state.winner, null, 'B must still receive its last action');
    }
  }
  assert.equal(state.winner, 'draw');
  assert.equal(state.resultReason, 'turn-limit');
  assert.equal(state.turn, 200);
  assert.equal(state.current, 'B');
  assert.deepEqual(state.turnProduction, { turn: 200, player: 'B', recruited: 0, upgraded: 0 });
  assert.deepEqual(importMatch(exportMatch(state)), state);
  const snapshot = readRoomSnapshot({ ...roomRow(), state: JSON.stringify(state), turn: 200, current: 'B' });
  assert.deepEqual(snapshot.state, state);
  assert.equal(submissionPlayer(snapshot.state, 200), 'B');
  assert.ok(sameSubmittedState(snapshot.state, state));
});

test('migrated final-turn commander result remains distinct from an uncommitted cloud state', () => {
  const old = createMatch({ ...DEFAULT_CONFIG, commanderMode: true }, 39);
  old.version = 4;
  old.turn = 200;
  old.current = 'B';
  delete old.turnProduction;
  const migrated = normalizeState(old)!;
  assert.ok(sameSubmittedState(old, migrated));
  const ended = applyAction(migrated, { type: 'END_TURN' });
  assert.ok(ended.ok);
  assert.equal(ended.state.winner, 'draw');
  assert.deepEqual(ended.state.turnProduction, migrated.turnProduction, 'final turn does not reset a spent ledger');
  assert.ok(isValidState(ended.state));
  const cloudBeforeCommit = readRoomSnapshot({ ...roomRow(), state: old, turn: 200, current: 'B' });
  assert.equal(sameSubmittedState(cloudBeforeCommit.state, ended.state), false,
    'same turn and player do not prove that the final result was submitted');
  const cloudAfterCommit = readRoomSnapshot({ ...roomRow(), state: ended.state, turn: 200, current: 'B' });
  assert.ok(sameSubmittedState(cloudAfterCommit.state, ended.state));
  assert.equal(submissionPlayer(ended.state, 200), 'B');
});
