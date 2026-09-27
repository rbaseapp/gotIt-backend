export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE product_gotit.private_lesson_sessions
      DROP CONSTRAINT private_lesson_sessions_speech_rate_check,
      ADD CONSTRAINT private_lesson_sessions_speech_rate_check
        CHECK(speech_rate IN ('very_slow','slow','normal','fast','very_fast'));

    ALTER TABLE product_gotit.private_lesson_preferences
      DROP CONSTRAINT private_lesson_preferences_speech_rate_check,
      ADD CONSTRAINT private_lesson_preferences_speech_rate_check
        CHECK(speech_rate IN ('very_slow','slow','normal','fast','very_fast'));
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    UPDATE product_gotit.private_lesson_sessions
      SET speech_rate = CASE speech_rate
        WHEN 'very_slow' THEN 'slow'
        WHEN 'very_fast' THEN 'fast'
        ELSE speech_rate
      END
      WHERE speech_rate IN ('very_slow','very_fast');

    UPDATE product_gotit.private_lesson_preferences
      SET speech_rate = CASE speech_rate
        WHEN 'very_slow' THEN 'slow'
        WHEN 'very_fast' THEN 'fast'
        ELSE speech_rate
      END
      WHERE speech_rate IN ('very_slow','very_fast');

    ALTER TABLE product_gotit.private_lesson_sessions
      DROP CONSTRAINT private_lesson_sessions_speech_rate_check,
      ADD CONSTRAINT private_lesson_sessions_speech_rate_check
        CHECK(speech_rate IN ('slow','normal','fast'));

    ALTER TABLE product_gotit.private_lesson_preferences
      DROP CONSTRAINT private_lesson_preferences_speech_rate_check,
      ADD CONSTRAINT private_lesson_preferences_speech_rate_check
        CHECK(speech_rate IN ('slow','normal','fast'));
  `);
};
