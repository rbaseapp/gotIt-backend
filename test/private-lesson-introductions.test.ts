import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { z } from 'zod';
import {
  privateLessonBriefInput,
  privateLessonBriefInstruction,
} from '../src/modules/private-lessons/private-lesson.content.js';
import { AdaptiveLessonPlanner } from '../src/modules/private-lessons/private-lesson.planner.js';
import { buildRealtimeLessonContract } from '../src/modules/private-lessons/private-lesson.realtime.js';
import {
  initialActivity,
  LessonActivityService,
  type ActivityRecord,
} from '../src/modules/private-lessons/private-lesson.activity.js';
import { adaptiveLesson, adaptiveCurriculum } from './helpers/adaptive-lesson-fixtures.js';

const scope = { applicationId: randomUUID(), applicationUserId: randomUUID() };
const teachers = { male: 'Mike', female: 'Rachel' } as const;

test('briefs and legacy/adaptive Realtime overrides retain the selected introduction participants', () => {
  for (const teacherVoice of ['male', 'female'] as const) {
    const plan = { ...adaptiveLesson(), teacherVoice };
    assert.equal(privateLessonBriefInput(plan).teacherName, teachers[teacherVoice]);
    assert.match(privateLessonBriefInstruction, /learner speaks as themselves/);
    assert.match(privateLessonBriefInstruction, /If their name is unknown, ask them/);
    for (const interactionProtocol of [undefined, 'adaptive-v1'] as const) {
      const contract = buildRealtimeLessonContract(
        { ...plan, interactionProtocol },
        { model: 'test-realtime', transcriptionModel: 'test-transcription' },
        { mode: 'replace', instructions: 'Use the authored introduction examples.' },
      );
      for (const instructions of [
        contract.session.instructions,
        ...Object.values(contract.events).map((event) => event?.response.instructions ?? ''),
      ]) {
        assert.ok(instructions.includes(`teacherName is ${teachers[teacherVoice]}.`));
        assert.match(instructions, /learner speaks as themselves/);
        assert.match(instructions, /second named person.*same tutor and teacherName/);
      }
    }
  }
});

test('semantic rejection of a forced identity reaches focused repair with the selected teacher', async () => {
  for (const teacherVoice of ['male', 'female'] as const) {
    const plan = { ...adaptiveLesson(), teacherVoice };
    const bank = adaptiveCurriculum(plan);
    bank.activities[0]!.prompt = 'Pretend your name is Noa and introduce yourself.';
    const repaired = {
      ...bank.activities[0]!,
      prompt: 'Introduce yourself using your own name.',
      criterion: "An appropriate self-introduction using the learner's own name.",
    };
    const calls: string[] = [];
    const planner = new AdaptiveLessonPlanner({
      async generate<T>(
        _scope: unknown,
        schema: z.ZodType<T>,
        name: string,
        instruction: string,
        data: unknown,
      ) {
        calls.push(name);
        assert.equal((data as { teacherName: string }).teacherName, teachers[teacherVoice]);
        assert.match(
          instruction,
          /Reject introduction prompts or criteria that force an invented learner identity/,
        );
        if (name === 'private_lesson_plan') return schema.parse(bank);
        if (name === 'private_lesson_plan_repair') {
          assert.match((data as { revisionFeedback: string }).revisionFeedback, /forced identity/);
          return schema.parse({
            opening: null,
            exhaustedMessage: null,
            removeIds: [],
            replacements: [repaired],
          });
        }
        const candidate = (data as { candidate: typeof bank }).candidate;
        const valid = candidate.activities[0]!.prompt === repaired.prompt;
        return schema.parse({
          valid,
          excludeIds: [],
          feedback: valid ? 'Participants fit.' : 'Repair the forced identity.',
        });
      },
    });
    const approved = await planner.prepare(scope, plan, 'guided');
    assert.equal(approved.activities[0]!.prompt, repaired.prompt);
    assert.deepEqual(approved.activities.slice(1), bank.activities.slice(1));
    assert.deepEqual(calls, [
      'private_lesson_plan',
      'private_lesson_plan_review',
      'private_lesson_plan_repair',
      'private_lesson_plan_review',
    ]);
  }
});

test('answer assessment receives own-name acceptance despite a different authored sample name', async () => {
  const plan = adaptiveLesson();
  const curriculum = adaptiveCurriculum(plan);
  curriculum.activities[0] = {
    ...curriculum.activities[0]!,
    prompt: 'Introduce yourself using your own name.',
    criterion: 'A self-introduction. Sample: My name is Noa.',
    independent: true,
  };
  const record: ActivityRecord = {
    plan,
    curriculum,
    state: initialActivity(plan, curriculum, 'guided'),
    active: true,
    remainingSeconds: 600,
  };
  const service = new LessonActivityService(
    {
      async create() {},
      async get() {
        return structuredClone(record);
      },
      async replay() {
        return null;
      },
      async save(_scope, _id, _command, state) {
        return state;
      },
    },
    {
      async generate<T>(
        _scope: unknown,
        schema: z.ZodType<T>,
        name: string,
        instruction: string,
        data: unknown,
      ) {
        assert.equal(name, 'private_lesson_answer');
        assert.match(instruction, /never mark it wrong for differing from a sample name/);
        assert.equal((data as { teacherName: string }).teacherName, 'Rachel');
        assert.equal((data as { learnerAnswer: string }).learnerAnswer, 'My name is Ori.');
        return schema.parse({
          result: 'independent',
          feedback: 'A clear self-introduction.',
          retryQuestion: 'Ask your teacher for their name.',
          evidenceQuote: 'My name is Ori.',
        });
      },
    },
  );
  const result = await service.act(scope, plan.id, {
    eventId: randomUUID(),
    revision: 0,
    activityId: curriculum.activities[0]!.id,
    action: 'answer',
    channel: 'text',
    answer: 'My name is Ori.',
  });
  assert.equal(result.state.outcomes[0]!.outcome, 'independent');
  assert.notEqual(result.state.view.activityId, curriculum.activities[0]!.id);
});
