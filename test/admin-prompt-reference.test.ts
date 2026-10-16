import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promptKeys } from '../src/modules/admin/admin.schemas.js';
import { promptReference } from '../src/modules/admin/admin.prompt-reference.generated.js';
test('admin base prompt references match provider source and cover every configured workload', async () => {
  assert.deepEqual(Object.keys(promptReference).sort(), [...promptKeys].sort());
  for (const entry of Object.values(promptReference)) {
    assert.ok(entry.templates.length > 0);
    assert.ok(entry.templates.every((t) => t.text.length > 20));
  }
  await promisify(execFile)(process.execPath, [
    'scripts/build-admin-prompt-reference.mjs',
    '--check',
  ]);
});
