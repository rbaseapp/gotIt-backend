import assert from 'node:assert/strict';
import test from 'node:test';
import {
  lessonTeacherVoice,
  moochiVoice,
} from '../src/modules/private-lessons/private-lesson.teachers.js';

test('Moochi speaks in his own voice, other teachers keep theirs', () => {
  assert.equal(lessonTeacherVoice({ teacherName: 'Moochi', teacherVoice: 'female' }), moochiVoice);
  assert.equal(lessonTeacherVoice({ teacherName: 'Moochi', teacherVoice: 'male' }), moochiVoice);
  assert.equal(lessonTeacherVoice({ teacherVoice: 'female' }), 'marin');
  assert.equal(lessonTeacherVoice({ teacherVoice: 'male' }), 'cedar');
});

test("an admin voice override changes the teachers' voice but not Moochi's", () => {
  assert.equal(lessonTeacherVoice({ teacherVoice: 'female' }, 'ash'), 'ash');
  assert.equal(
    lessonTeacherVoice({ teacherName: 'Moochi', teacherVoice: 'female' }, 'ash'),
    moochiVoice,
  );
});
