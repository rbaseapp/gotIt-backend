export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE product_gotit.item_translations
      DROP CONSTRAINT item_translations_source_kind_check,
      ADD CONSTRAINT item_translations_source_kind_check
        CHECK(source_kind IN('user','dictionary','translation_api','ai','import','catalog'));
    ALTER TABLE product_gotit.item_examples
      DROP CONSTRAINT item_examples_source_kind_check,
      ADD CONSTRAINT item_examples_source_kind_check
        CHECK(source_kind IN('captured_context','user','dictionary','ai','import','catalog'));

    CREATE TABLE product_gotit.word_topics (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slug text NOT NULL UNIQUE,
      title text NOT NULL,
      description text NOT NULL,
      sort_order integer NOT NULL DEFAULT 0,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT word_topics_slug_check CHECK(slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
    );

    CREATE TABLE product_gotit.word_tracks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      topic_id uuid NOT NULL REFERENCES product_gotit.word_topics(id),
      slug text NOT NULL UNIQUE,
      title text NOT NULL,
      description text NOT NULL,
      level_code text NOT NULL CHECK(level_code IN('beginner','intermediate','advanced')),
      cefr_from text NOT NULL CHECK(cefr_from IN('A1','A2','B1','B2','C1','C2')),
      cefr_to text NOT NULL CHECK(cefr_to IN('A1','A2','B1','B2','C1','C2')),
      source_language_code text NOT NULL,
      translation_language_code text NOT NULL,
      sort_order integer NOT NULL DEFAULT 0,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT word_tracks_slug_check CHECK(slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
      CONSTRAINT word_tracks_language_check CHECK(source_language_code<>translation_language_code)
    );
    CREATE INDEX word_tracks_topic_idx ON product_gotit.word_tracks(topic_id,sort_order,id);

    CREATE TABLE product_gotit.word_packs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      track_id uuid NOT NULL REFERENCES product_gotit.word_tracks(id),
      slug text NOT NULL UNIQUE,
      module_number integer NOT NULL CHECK(module_number>0),
      title text NOT NULL,
      description text NOT NULL,
      version integer NOT NULL DEFAULT 1 CHECK(version>0),
      sort_order integer NOT NULL DEFAULT 0,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT word_packs_slug_check CHECK(slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
      CONSTRAINT word_packs_track_module_unique UNIQUE(track_id,module_number)
    );
    CREATE INDEX word_packs_track_idx ON product_gotit.word_packs(track_id,sort_order,id);

    CREATE TABLE product_gotit.word_pack_entries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      pack_id uuid NOT NULL REFERENCES product_gotit.word_packs(id) ON DELETE CASCADE,
      source_text text NOT NULL,
      normalized_source_text text NOT NULL,
      translation_text text NOT NULL,
      normalized_translation_text text NOT NULL,
      item_type text NOT NULL DEFAULT 'word'
        CHECK(item_type IN('word','phrase','expression','phrasal_verb','other')),
      part_of_speech text,
      example_text text,
      sort_order integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT word_pack_entries_scoped_identity UNIQUE(pack_id,id),
      CONSTRAINT word_pack_entries_sense_unique
        UNIQUE(pack_id,normalized_source_text,normalized_translation_text)
    );
    CREATE INDEX word_pack_entries_pack_idx ON product_gotit.word_pack_entries(pack_id,sort_order,id);

    CREATE TABLE product_gotit.user_word_packs (
      application_id uuid NOT NULL,
      application_user_id uuid NOT NULL,
      pack_id uuid NOT NULL REFERENCES product_gotit.word_packs(id),
      status text NOT NULL CHECK(status IN('active','removed')),
      installed_version integer NOT NULL CHECK(installed_version>0),
      added_at timestamptz NOT NULL DEFAULT now(),
      removed_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(application_id,application_user_id,pack_id),
      CONSTRAINT user_word_packs_application_user_fkey
        FOREIGN KEY(application_id,application_user_id)
        REFERENCES core.application_users(application_id,id) ON DELETE CASCADE,
      CONSTRAINT user_word_packs_removed_check
        CHECK((status='active' AND removed_at IS NULL) OR status='removed')
    );
    CREATE INDEX user_word_packs_user_status_idx
      ON product_gotit.user_word_packs(application_id,application_user_id,status,pack_id);

    CREATE TABLE product_gotit.learning_item_pack_entries (
      application_id uuid NOT NULL,
      application_user_id uuid NOT NULL,
      pack_id uuid NOT NULL,
      entry_id uuid NOT NULL,
      learning_item_id uuid NOT NULL,
      excluded_at timestamptz,
      kept_by_user boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(application_id,application_user_id,pack_id,entry_id),
      CONSTRAINT learning_item_pack_entries_user_pack_fkey
        FOREIGN KEY(application_id,application_user_id,pack_id)
        REFERENCES product_gotit.user_word_packs(application_id,application_user_id,pack_id)
        ON DELETE CASCADE,
      CONSTRAINT learning_item_pack_entries_entry_fkey
        FOREIGN KEY(pack_id,entry_id)
        REFERENCES product_gotit.word_pack_entries(pack_id,id) ON DELETE CASCADE,
      CONSTRAINT learning_item_pack_entries_learning_item_fkey
        FOREIGN KEY(application_id,application_user_id,learning_item_id)
        REFERENCES product_gotit.learning_items(application_id,application_user_id,id)
        ON DELETE CASCADE
    );
    CREATE INDEX learning_item_pack_entries_item_idx
      ON product_gotit.learning_item_pack_entries(application_id,application_user_id,learning_item_id)
      WHERE excluded_at IS NULL;
    CREATE INDEX learning_item_pack_entries_pack_idx
      ON product_gotit.learning_item_pack_entries(application_id,application_user_id,pack_id)
      WHERE excluded_at IS NULL;

    INSERT INTO product_gotit.word_topics(id,slug,title,description,sort_order) VALUES
      ('10000000-0000-4000-8000-000000000001','business','עסקים','אוצר מילים לעבודה, תקשורת, פגישות ומשא ומתן',10);

    INSERT INTO product_gotit.word_tracks
      (id,topic_id,slug,title,description,level_code,cefr_from,cefr_to,source_language_code,translation_language_code,sort_order)
    VALUES
      ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',
       'business-beginner-en-he','עסקים — מתחילים','יסודות האנגלית העסקית לעבודה יומיומית','beginner','A1','A2','en','he',10),
      ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001',
       'business-advanced-en-he','עסקים — מתקדמים','אנגלית עסקית למשא ומתן, אסטרטגיה ופיננסים','advanced','C1','C2','en','he',30);

    INSERT INTO product_gotit.word_packs
      (id,track_id,slug,module_number,title,description,version,sort_order)
    VALUES
      ('30000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',
       'business-beginner-1-en-he',1,'יחידה 1: המשרד והצוות','מילים בסיסיות על מקום העבודה, אנשים ותפקידים',1,10),
      ('30000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000001',
       'business-beginner-2-en-he',2,'יחידה 2: פגישות ולקוחות','מילים שימושיות לפגישות, משימות ושירות לקוחות',1,20),
      ('30000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000002',
       'business-advanced-1-en-he',1,'יחידה 1: משא ומתן ואסטרטגיה','מושגים מתקדמים לקבלת החלטות, צמיחה והסכמים',1,10);

    INSERT INTO product_gotit.word_pack_entries
      (id,pack_id,source_text,normalized_source_text,translation_text,normalized_translation_text,item_type,part_of_speech,example_text,sort_order)
    VALUES
      ('40000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','office','office','משרד','משרד','word','noun','Our office is on the third floor.',10),
      ('40000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000001','employee','employee','עובד','עובד','word','noun','Every employee receives an access card.',20),
      ('40000000-0000-4000-8000-000000000003','30000000-0000-4000-8000-000000000001','manager','manager','מנהל','מנהל','word','noun','The manager leads the weekly meeting.',30),
      ('40000000-0000-4000-8000-000000000004','30000000-0000-4000-8000-000000000001','team','team','צוות','צוות','word','noun','Our team works well together.',40),
      ('40000000-0000-4000-8000-000000000005','30000000-0000-4000-8000-000000000001','colleague','colleague','עמית לעבודה','עמית לעבודה','word','noun','Ask your colleague for help.',50),
      ('40000000-0000-4000-8000-000000000006','30000000-0000-4000-8000-000000000001','department','department','מחלקה','מחלקה','word','noun','She works in the sales department.',60),
      ('40000000-0000-4000-8000-000000000007','30000000-0000-4000-8000-000000000001','salary','salary','משכורת','משכורת','word','noun','The salary is paid every month.',70),
      ('40000000-0000-4000-8000-000000000008','30000000-0000-4000-8000-000000000001','task','task','משימה','משימה','word','noun','I completed the task before lunch.',80),
      ('40000000-0000-4000-8000-000000000009','30000000-0000-4000-8000-000000000001','schedule','schedule','לוח זמנים','לוח זמנים','word','noun','Check the schedule for tomorrow.',90),
      ('40000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000001','deadline','deadline','מועד אחרון','מועד אחרון','word','noun','The deadline is Friday afternoon.',100),
      ('40000000-0000-4000-8000-000000000011','30000000-0000-4000-8000-000000000001','project','project','פרויקט','פרויקט','word','noun','This project will take three months.',110),
      ('40000000-0000-4000-8000-000000000012','30000000-0000-4000-8000-000000000001','workplace','workplace','מקום עבודה','מקום עבודה','word','noun','A safe workplace benefits everyone.',120),

      ('40000000-0000-4000-8000-000000000101','30000000-0000-4000-8000-000000000002','meeting','meeting','פגישה','פגישה','word','noun','The meeting starts at nine.',10),
      ('40000000-0000-4000-8000-000000000102','30000000-0000-4000-8000-000000000002','agenda','agenda','סדר יום','סדר יום','word','noun','Please read the agenda before the meeting.',20),
      ('40000000-0000-4000-8000-000000000103','30000000-0000-4000-8000-000000000002','client','client','לקוח','לקוח','word','noun','The client approved our proposal.',30),
      ('40000000-0000-4000-8000-000000000104','30000000-0000-4000-8000-000000000002','customer service','customer service','שירות לקוחות','שירות לקוחות','phrase',NULL,'Customer service answered quickly.',40),
      ('40000000-0000-4000-8000-000000000105','30000000-0000-4000-8000-000000000002','email','email','דואר אלקטרוני','דואר אלקטרוני','word','noun','I sent the details by email.',50),
      ('40000000-0000-4000-8000-000000000106','30000000-0000-4000-8000-000000000002','appointment','appointment','פגישה מתוכננת','פגישה מתוכננת','word','noun','We have an appointment with the supplier.',60),
      ('40000000-0000-4000-8000-000000000107','30000000-0000-4000-8000-000000000002','proposal','proposal','הצעה','הצעה','word','noun','They presented a new proposal.',70),
      ('40000000-0000-4000-8000-000000000108','30000000-0000-4000-8000-000000000002','feedback','feedback','משוב','משוב','word','noun','Thank you for your helpful feedback.',80),
      ('40000000-0000-4000-8000-000000000109','30000000-0000-4000-8000-000000000002','confirm','confirm','לאשר','לאשר','word','verb','Please confirm the delivery date.',90),
      ('40000000-0000-4000-8000-000000000110','30000000-0000-4000-8000-000000000002','cancel','cancel','לבטל','לבטל','word','verb','We need to cancel the afternoon call.',100),
      ('40000000-0000-4000-8000-000000000111','30000000-0000-4000-8000-000000000002','follow up','follow up','לבצע מעקב','לבצע מעקב','phrasal_verb','verb','I will follow up with the customer tomorrow.',110),
      ('40000000-0000-4000-8000-000000000112','30000000-0000-4000-8000-000000000002','available','available','זמין','זמין','word','adjective','Are you available for a short meeting?',120),

      ('40000000-0000-4000-8000-000000000201','30000000-0000-4000-8000-000000000003','negotiation','negotiation','משא ומתן','משא ומתן','word','noun','The negotiation continued for several weeks.',10),
      ('40000000-0000-4000-8000-000000000202','30000000-0000-4000-8000-000000000003','leverage','leverage','מנוף לחץ','מנוף לחץ','word','noun','Market demand gave the company more leverage.',20),
      ('40000000-0000-4000-8000-000000000203','30000000-0000-4000-8000-000000000003','counteroffer','counteroffer','הצעה נגדית','הצעה נגדית','word','noun','The buyer submitted a counteroffer.',30),
      ('40000000-0000-4000-8000-000000000204','30000000-0000-4000-8000-000000000003','concession','concession','ויתור','ויתור','word','noun','Both sides made a small concession.',40),
      ('40000000-0000-4000-8000-000000000205','30000000-0000-4000-8000-000000000003','stakeholder','stakeholder','בעל עניין','בעל עניין','word','noun','Every stakeholder received the updated plan.',50),
      ('40000000-0000-4000-8000-000000000206','30000000-0000-4000-8000-000000000003','revenue','revenue','הכנסות','הכנסות','word','noun','Revenue increased in the final quarter.',60),
      ('40000000-0000-4000-8000-000000000207','30000000-0000-4000-8000-000000000003','profit margin','profit margin','שולי רווח','שולי רווח','phrase',NULL,'The new process improved our profit margin.',70),
      ('40000000-0000-4000-8000-000000000208','30000000-0000-4000-8000-000000000003','forecast','forecast','תחזית','תחזית','word','noun','The annual forecast predicts steady growth.',80),
      ('40000000-0000-4000-8000-000000000209','30000000-0000-4000-8000-000000000003','acquisition','acquisition','רכישה עסקית','רכישה עסקית','word','noun','The acquisition expanded the company into Asia.',90),
      ('40000000-0000-4000-8000-000000000210','30000000-0000-4000-8000-000000000003','competitive advantage','competitive advantage','יתרון תחרותי','יתרון תחרותי','phrase',NULL,'Customer trust is our competitive advantage.',100),
      ('40000000-0000-4000-8000-000000000211','30000000-0000-4000-8000-000000000003','due diligence','due diligence','בדיקת נאותות','בדיקת נאותות','phrase',NULL,'The investors completed their due diligence.',110),
      ('40000000-0000-4000-8000-000000000212','30000000-0000-4000-8000-000000000003','scalable','scalable','ניתן להרחבה','ניתן להרחבה','word','adjective','We need a scalable business model.',120);
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE product_gotit.learning_item_pack_entries;
    DROP TABLE product_gotit.user_word_packs;
    DROP TABLE product_gotit.word_pack_entries;
    DROP TABLE product_gotit.word_packs;
    DROP TABLE product_gotit.word_tracks;
    DROP TABLE product_gotit.word_topics;
    UPDATE product_gotit.item_examples SET source_kind='import' WHERE source_kind='catalog';
    UPDATE product_gotit.item_translations SET source_kind='import' WHERE source_kind='catalog';
    ALTER TABLE product_gotit.item_examples
      DROP CONSTRAINT item_examples_source_kind_check,
      ADD CONSTRAINT item_examples_source_kind_check
        CHECK(source_kind IN('captured_context','user','dictionary','ai','import'));
    ALTER TABLE product_gotit.item_translations
      DROP CONSTRAINT item_translations_source_kind_check,
      ADD CONSTRAINT item_translations_source_kind_check
        CHECK(source_kind IN('user','dictionary','translation_api','ai','import'));
  `);
};
