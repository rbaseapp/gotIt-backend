import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { OpenAiCourseGenerator } from '../src/modules/courses/course.provider.js';
import { scope } from './helpers/course-fixtures.js';

test('bounded adaptive repair forwards low reasoning to the provider while keeping normal plan and answer policies', async () => {
  const observed: string[] = [];
  const generator = new OpenAiCourseGenerator(
    'fixture-key',
    'fixture-model',
    'fixture-transcription',
    async (_url, init) => {
      observed.push(JSON.parse(String(init?.body)).reasoning.effort);
      assert.ok(init?.signal instanceof AbortSignal);
      return Response.json({
        status: 'completed',
        output: [{ content: [{ type: 'output_text', text: '{"ok":true}' }] }],
      });
    },
  );
  const schema = z.object({ ok: z.boolean() }).strict();
  await generator.generate(scope, schema, 'private_lesson_plan', 'Synthetic', {});
  await generator.generate(
    scope,
    schema,
    'private_lesson_plan',
    'Synthetic repair',
    {},
    { deadlineMs: Date.now() + 1000, reasoningEffort: 'low' },
  );
  await generator.generate(scope, schema, 'private_lesson_answer', 'Synthetic', {});
  assert.deepEqual(observed, ['medium', 'low', 'none']);
});
