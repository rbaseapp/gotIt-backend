import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import test from 'node:test';
import { z } from 'zod';
import { OpenAiCourseGenerator } from '../src/modules/courses/course.provider.js';
import { AppError } from '../src/shared/errors/app-error.js';
import { createLogger } from '../src/shared/logger/logger.js';
import { scope } from './helpers/course-fixtures.js';

const schema = z.object({ answer: z.string() }).strict();
const cases = [
  { status: 400, body: { error: { message: 'private provider body' } }, code: 'invalid_request' },
  { status: 401, body: { error: { message: 'secret api key' } }, code: 'authentication' },
  { status: 429, body: { error: { message: 'private provider body' } }, code: 'rate_limit' },
  { status: 503, body: { error: { message: 'private provider body' } }, code: 'upstream' },
  { status: 200, body: { status: 'incomplete', output: [] }, code: 'incomplete' },
  {
    status: 200,
    body: {
      status: 'completed',
      output: [{ content: [{ type: 'refusal', text: 'private refusal' }] }],
    },
    code: 'refusal',
  },
  {
    status: 200,
    body: {
      status: 'completed',
      output: [{ content: [{ type: 'output_text', text: '{"wrong":"private answer"}' }] }],
    },
    code: 'invalid_response',
  },
];

for (const entry of cases) {
  test(`course provider diagnoses ${entry.status}/${entry.code} without leaking data or retrying`, async () => {
    let logs = '';
    let calls = 0;
    const logger = createLogger(
      'info',
      new Writable({
        write(chunk, _encoding, done) {
          logs += chunk.toString();
          done();
        },
      }),
    );
    const provider = new OpenAiCourseGenerator(
      'secret api key',
      'test-model',
      'transcriber',
      async () => {
        calls++;
        return Response.json(entry.body, {
          status: entry.status,
          headers: { 'x-request-id': 'provider-request-id' },
        });
      },
      undefined,
      { logger, requestId: () => 'app-request-id' },
    );
    await assert.rejects(
      provider.generate(scope, schema, 'lesson_homework', 'private prompt', {
        learner: 'private learner data',
      }),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.statusCode, 503);
        assert.equal(error.code, 'COURSE_AI_UNAVAILABLE');
        assert.equal(error.details, undefined);
        assert.doesNotMatch(JSON.stringify(error), /private|secret/u);
        return true;
      },
    );
    assert.equal(calls, 1);
    const log = JSON.parse(logs);
    assert.equal(log.requestId, 'app-request-id');
    assert.equal(log.providerRequestId, 'provider-request-id');
    assert.equal(log.providerStatus, entry.status);
    assert.equal(log.failureCode, entry.code);
    assert.equal(log.operation, 'lesson_homework');
    assert.equal(log.model, 'test-model');
    assert.ok(log.durationMs >= 0);
    assert.doesNotMatch(logs, /private|secret|applicationUserId|applicationId/u);
  });
}
