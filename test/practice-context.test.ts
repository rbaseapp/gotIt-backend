import assert from 'node:assert/strict';
import test from 'node:test';
import { hideAnswers } from '../src/modules/practice/practice.service.js';

test('cloze hides whole words instead of fragments inside names or longer words', () => {
  assert.equal(
    hideAnswers('Hello my name is Noa. No, thanks.', ['no']),
    'Hello my name is Noa. _____, thanks.',
  );
  assert.equal(hideAnswers('Hello my name is Noa.', ['no']), 'Hello my name is Noa.');
  assert.equal(
    hideAnswers('The chair is on the staircase.', ['chair']),
    'The _____ is on the staircase.',
  );
});

test('cloze replaces complete expressions together, longest first, in every occurrence', () => {
  assert.equal(
    hideAnswers('New York is not York. NEW YORK!', ['York', 'New York']),
    '_____ is not _____. _____!',
  );
  assert.equal(
    hideAnswers('Take it easy, then take it easy.', ['take it easy']),
    '_____, then _____.',
  );
  assert.equal(hideAnswers('Learn C++ (today).', ['C++', '(today)']), 'Learn _____ _____.');
});

test('cloze respects Unicode words, combining marks, contractions and Chinese word boundaries', () => {
  assert.equal(hideAnswers('שמש בשמש. שמש!', ['שמש']), '_____ בשמש. _____!');
  assert.equal(hideAnswers('cafe\u0301 cafe.', ['cafe']), 'cafe\u0301 _____.');
  assert.equal(hideAnswers("I don't know. I do know.", ['do']), "I don't know. I _____ know.");
  assert.equal(hideAnswers('我喜欢学习中文。', ['学习']), '我喜欢_____中文。');
});

test('cloze leaves absent, empty and null contexts safe', () => {
  assert.equal(hideAnswers(null, ['word']), null);
  assert.equal(hideAnswers('A normal sentence.', ['', 'missing']), 'A normal sentence.');
  assert.equal(hideAnswers('x'.repeat(5000), []), 'x'.repeat(4000));
});
