import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adversarialCases } from '../bench/cases.mjs';

test('adversarial harness suite passes all cases', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'g0dc0d3-adversarial-test-'));
  try {
    for (const definition of adversarialCases) {
      await t.test(`${definition.id}: ${definition.title}`, async () => {
        const caseDir = await fs.mkdtemp(path.join(root, `${definition.id}-`));
        const evidence = await definition.run(caseDir);
        assert.ok(evidence !== undefined);
      });
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
