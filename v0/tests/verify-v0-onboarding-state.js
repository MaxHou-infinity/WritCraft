'use strict';

const assert = require('assert');
const mainOnboarding = require('../src/main/project-onboarding-v2-service');
const state = require('../src/renderer/onboarding-state');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

console.log('\nProject onboarding state verification');

test('renderer question order stays identical to the Main proposal contract', () => {
  assert.deepStrictEqual(state.QUESTION_IDS, [...mainOnboarding.QUESTION_ORDER]);
  assert.strictEqual(mainOnboarding.REQUEST_SCHEMA, 'writcraft.onboarding-request/v2');
});

test('creates a serializable empty question session', () => {
  assert.deepStrictEqual(state.createSession(), {
    schema: state.SCHEMA, currentIndex: 0, status: 'questions', answers: {}, skipped: [],
  });
});

test('answers are trimmed, bounded and replace skipped state', () => {
  let session = state.skip(state.createSession(), 'premise');
  session = state.updateAnswer(session, 'premise', '  核心观点  ');
  assert.deepStrictEqual(session.answers, { premise: '核心观点' });
  assert.deepStrictEqual(session.skipped, []);
  assert.throws(() => state.updateAnswer(session, 'premise', 'x'.repeat(state.MAX_ANSWER_CHARS + 1)), error => error.code === 'ANSWER_TOO_LONG');
});

test('advance requires an explicit answer or skip', () => {
  const session = state.createSession();
  assert.throws(() => state.advance(session), error => error.code === 'QUESTION_UNRESOLVED');
  const answered = state.advance(state.updateAnswer(session, 'premise', '观点'));
  assert.strictEqual(answered.currentIndex, 1);
});

test('skip advances and the last question enters review', () => {
  let session = state.createSession({ currentIndex: state.QUESTION_IDS.length - 1 });
  session = state.skip(session);
  assert.strictEqual(session.status, 'review');
  assert(session.skipped.includes('openQuestions'));
});

test('review can return to the last or any named question', () => {
  const review = state.skip(state.createSession({ currentIndex: state.QUESTION_IDS.length - 1 }));
  assert.strictEqual(state.goBack(review).currentIndex, state.QUESTION_IDS.length - 1);
  const edited = state.editQuestion(review, 'audience');
  assert.strictEqual(edited.status, 'questions');
  assert.strictEqual(edited.currentIndex, 1);
});

test('progress distinguishes resolved and answered questions', () => {
  let session = state.updateAnswer(state.createSession(), 'premise', '观点');
  session = state.skip(session, 'audience');
  assert.deepStrictEqual(state.progress(session), { resolved: 2, answered: 1, total: 10 });
});

test('submission contains only explicit answers and rejects an all-skipped project', () => {
  let session = state.updateAnswer(state.createSession(), 'premise', '观点');
  session = state.skip(session, 'audience');
  assert.deepStrictEqual(state.submission(session), { premise: '观点' });
  assert.throws(() => state.submission(state.skip(state.createSession(), 'premise')), error => error.code === 'EMPTY_ANSWERS');
});

console.log(`\n${passed}/8 onboarding-state checks passed.`);
