// Unit completion is successful practice evidence, separate from long-term mastery.
// Both catalog display and curriculum selection use the same owned, current-revision evidence.
export function unitLearnedPredicate(itemAlias: string, packExpression: string) {
  return `EXISTS (
    SELECT 1 FROM product_gotit.practice_attempts unit_attempt
    JOIN product_gotit.practice_sessions unit_session
      ON unit_session.application_id=unit_attempt.application_id
      AND unit_session.application_user_id=unit_attempt.application_user_id
      AND unit_session.id=unit_attempt.practice_session_id
    WHERE unit_attempt.application_id=${itemAlias}.application_id
      AND unit_attempt.application_user_id=${itemAlias}.application_user_id
      AND unit_attempt.learning_item_id=${itemAlias}.id
      AND COALESCE(unit_attempt.learning_revision,1)=${itemAlias}.learning_revision
      AND unit_attempt.result='correct' AND unit_attempt.score>=85
      AND unit_attempt.exercise_type<>'flashcards'
      AND unit_session.selection->'scope'->>'type'='pack'
      AND unit_session.selection->'scope'->>'id'=(${packExpression})::text
  )`;
}
