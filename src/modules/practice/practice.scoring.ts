import { lookupText } from '../capture/capture.validation.js';
import type { Skill } from '../learning/learning.policy.js';
import { AppError } from '../../shared/errors/app-error.js';
import type { AttemptInput } from './practice.validation.js';
export type AnswerSpec = {
  kind: 'typed' | 'multiple_choice' | 'self_rating' | 'provider';
  accepted: string[];
  choices?: { id: string; correct: boolean }[];
  skills: { skill: Skill; weight: number }[];
};
export function distance(a: string, b: string) {
  const left = [...a],
    right = [...b];
  let previous = right.map((_c, i) => i + 1);
  previous.unshift(0);
  for (let i = 0; i < left.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < right.length; j++)
      next.push(
        Math.min(next[j]! + 1, previous[j + 1]! + 1, previous[j]! + (left[i] === right[j] ? 0 : 1)),
      );
    previous = next;
  }
  return previous.at(-1)!;
}
export function scoreAnswer(spec: AnswerSpec, input: AttemptInput) {
  if (input.skipped)
    return { score: 0, result: 'skipped', expectedAnswer: spec.accepted[0] ?? null };
  let score: number, result: string;
  if (spec.kind === 'self_rating') {
    if (!input.selfRating || input.answerText || input.choiceId)
      throw new AppError(400, 'VALIDATION_ERROR', 'Flashcards require a self-rating');
    score = { again: 0, hard: 60, good: 100 }[input.selfRating];
    result = 'self_rated';
  } else if (spec.kind === 'multiple_choice') {
    if (!input.choiceId || input.answerText || input.selfRating)
      throw new AppError(400, 'VALIDATION_ERROR', 'This exercise requires a choice');
    const choice = spec.choices?.find((c) => c.id === input.choiceId);
    if (!choice) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid exercise choice');
    score = choice.correct ? 100 : 0;
    result = score === 100 ? 'correct' : 'incorrect';
  } else if (spec.kind === 'typed') {
    if (!input.answerText || input.choiceId || input.selfRating)
      throw new AppError(400, 'VALIDATION_ERROR', 'This exercise requires typed text');
    const answer = lookupText(input.answerText),
      accepted = spec.accepted.map(lookupText);
    score = accepted.includes(answer)
      ? 100
      : accepted.some((a) => [...a].length >= 4 && distance(a, answer) === 1)
        ? 70
        : 0;
    result = score === 100 ? 'correct' : score > 0 ? 'partially_correct' : 'incorrect';
  } else
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'This exercise requires a verified pronunciation assessment',
    );
  if (input.hintsUsed > 0) score = Math.min(score, 70);
  if (result === 'correct' && score < 100) result = 'partially_correct';
  return { score, result, expectedAnswer: spec.accepted[0] ?? null };
}
