'use strict';

const assert = require('assert');
const State = require('../src/renderer/daily-workspace-state');

const state = State.create();
State.bind(state, 'instance_a', 'chapter.md');
const first = State.begin(state);
const second = State.begin(state);
assert.strictEqual(State.settle(state, first, { status: 'ready', items: [{ locationId: 'old' }] }), false);
assert.strictEqual(State.settle(state, second, { status: 'partial', items: [
  { locationId: 'one' }, { locationId: 'two' }, { locationId: 'three' },
] }), true);
assert.strictEqual(state.status, 'partial');
assert.strictEqual(state.selectedIndex, 0);
assert.strictEqual(State.move(state, -1), 2);
assert.strictEqual(State.move(state, 'home'), 0);
assert.strictEqual(State.move(state, 'end'), 2);

const oldProject = State.begin(state);
State.bind(state, 'instance_b', 'other.md');
assert.strictEqual(State.fail(state, oldProject), false);
assert.strictEqual(state.projectInstanceId, 'instance_b');
assert.strictEqual(state.status, 'closed');

const empty = State.begin(state);
assert.strictEqual(State.settle(state, empty, { status: 'empty', items: [] }), true);
assert.strictEqual(state.status, 'empty');
assert.strictEqual(State.move(state, 1), -1);

assert.deepStrictEqual(State.KINDS, ['file', 'heading', 'entity', 'issue', 'pending_review']);
console.log('verify-v0-daily-workspace-renderer-state: ok');
