'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/context-autocomplete.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/index.html'), 'utf8');
const navigation = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/writing-navigation-view.js'), 'utf8');

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`✓ ${name}`); }
console.log('\nContext autocomplete verification');
test('keeps input identity and caret while inserting a Main candidate', () => {
  assert.match(source, /input\.value = next/);
  assert.match(source, /input\.setSelectionRange\(caret, caret\)/);
  assert.match(source, /input\.dispatchEvent\(new Event\('input'/);
  assert.match(source, /candidate\.referenceToken/);
  assert(!source.includes('innerHTML'));
});
test('uses bounded project-aware candidates and keyboard dismissal', () => {
  assert.match(source, /listCandidates\(projectInstanceId/);
  assert.match(source, /response\.projectInstanceId !== projectInstanceId/);
  assert.match(source, /event\.key === 'Escape'/);
  assert.match(html, /id="chat-input" data-context-input="true"/);
  assert.match(html, /id="changes-instruction" data-context-input="true"/);
  assert.match(navigation, /goal\.dataset\.contextInput = 'true'/);
});
console.log(`\n${passed}/${passed} context autocomplete checks passed.`);
