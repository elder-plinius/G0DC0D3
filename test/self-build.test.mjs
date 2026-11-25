import test from 'node:test';
import assert from 'node:assert/strict';
import { compareRubrics } from '../scripts/self-build.mjs';

const score = entries => ({ results: Object.entries(entries).map(([id, pass]) => ({ id, pass })) });

test('self-build accepts a new target only while every previous success survives', () => {
  const before = score({ stable: true, target: false, extra: false });
  assert.equal(compareRubrics(before, score({ stable: true, target: true, extra: false }), 'target').pass, true);
  const regression = compareRubrics(before, score({ stable: false, target: true, extra: true }), 'target');
  assert.equal(regression.pass, false);
  assert.deepEqual(regression.lost, ['stable']);
  assert.equal(compareRubrics(before, score({ stable: true, target: false, extra: true }), 'target').pass, false);
  assert.equal(compareRubrics(before, score({ stable: true, target: true }), 'target').pass, false);
  assert.equal(compareRubrics(before, before, 'target').pass, false);
});
