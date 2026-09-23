const masteryProjection = `
  WITH projected AS (
    SELECT
      application_id,
      application_user_id,
      learning_item_id,
      round(
        sum(mastery_score * CASE skill_type WHEN 'recall' THEN 1.5 ELSE 1 END) /
        sum(CASE skill_type WHEN 'recall' THEN 1.5 ELSE 1 END),
        2
      ) AS mastery_score
    FROM product_gotit.item_skill_progress
    WHERE attempt_count > 0
    GROUP BY application_id, application_user_id, learning_item_id
  )
`;

export const up = (pgm) => {
  pgm.sql(`${masteryProjection}
    UPDATE product_gotit.learning_items item
    SET overall_mastery_score = projected.mastery_score,
        system_difficulty = round((1 - projected.mastery_score / 100)::numeric, 4),
        updated_at = clock_timestamp()
    FROM projected
    WHERE item.application_id = projected.application_id
      AND item.application_user_id = projected.application_user_id
      AND item.id = projected.learning_item_id
      AND item.mastery_source IS DISTINCT FROM 'user';
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    UPDATE product_gotit.learning_items item
    SET overall_mastery_score = COALESCE(progress.mastery_score, 0),
        system_difficulty = round((1 - COALESCE(progress.mastery_score, 0) / 100)::numeric, 4),
        updated_at = clock_timestamp()
    FROM (
      SELECT learning_item_id, max(mastery_score) AS mastery_score
      FROM product_gotit.item_skill_progress
      WHERE skill_type = 'recall'
      GROUP BY learning_item_id
    ) progress
    WHERE item.id = progress.learning_item_id
      AND item.mastery_source IS DISTINCT FROM 'user';
  `);
};
