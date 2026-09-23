const id = (kind, sequence) =>
  `${kind}0000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;

const sqlValue = (value) => {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
};

const insertRows = (pgm, table, columns, rows) => {
  pgm.sql(
    `INSERT INTO product_gotit.${table} (${columns.join(',')}) VALUES\n${rows
      .map((row) => `  (${row.map(sqlValue).join(',')})`)
      .join(',\n')};`,
  );
};

const topics = [
  ['sports', 'ספורט', 'מילים וביטויים מעולם הספורט, האימונים והתחרויות'],
  ['fruits-and-vegetables', 'ירקות ופירות', 'שמות שימושיים של פירות, ירקות ומוצרים טריים'],
  ['everyday-words', 'מילים של יום־יום', 'אוצר מילים שימושי לבית, לסידורים ולשיחות יומיומיות'],
  ['software-development', 'פיתוח תוכנה', 'מונחים מעשיים לתכנות, עבודת צוות ומערכות תוכנה'],
  ['current-events', 'אקטואליה', 'מילים וביטויים להבנת חדשות, מדיניות ואירועים בעולם'],
];

const tracks = [
  [
    0,
    'sports-beginner-en-he',
    'ספורט — מתחילים',
    'מושגי יסוד במשחקים, קבוצות ואימונים',
    'beginner',
    'A1',
    'A2',
  ],
  [
    0,
    'sports-advanced-en-he',
    'ספורט — מתקדמים',
    'מונחים מתקדמים לתחרות, ביצועים וטקטיקה',
    'advanced',
    'C1',
    'C2',
  ],
  [
    1,
    'fruits-and-vegetables-beginner-en-he',
    'ירקות ופירות — מתחילים',
    'פירות וירקות נפוצים לקניות ולאכילה יומיומית',
    'beginner',
    'A1',
    'A2',
  ],
  [
    1,
    'fruits-and-vegetables-advanced-en-he',
    'ירקות ופירות — מתקדמים',
    'שמות מגוונים ומדויקים יותר של תוצרת טרייה',
    'advanced',
    'C1',
    'C2',
  ],
  [
    2,
    'everyday-words-beginner-en-he',
    'מילים של יום־יום — מתחילים',
    'מילים בסיסיות לשגרה, לבית ולסידורים',
    'beginner',
    'A1',
    'A2',
  ],
  [
    2,
    'everyday-words-advanced-en-he',
    'מילים של יום־יום — מתקדמים',
    'ביטויים מדויקים לשיחות ולמצבים יומיומיים מורכבים',
    'advanced',
    'C1',
    'C2',
  ],
  [
    3,
    'software-development-beginner-en-he',
    'פיתוח תוכנה — מתחילים',
    'מושגי יסוד בקוד, יישומים ועבודת פיתוח',
    'beginner',
    'A1',
    'A2',
  ],
  [
    3,
    'software-development-advanced-en-he',
    'פיתוח תוכנה — מתקדמים',
    'ארכיטקטורה, אמינות, אבטחה ותהליכי מסירה',
    'advanced',
    'C1',
    'C2',
  ],
  [
    4,
    'current-events-beginner-en-he',
    'אקטואליה — מתחילים',
    'מילים בסיסיות לקריאת חדשות ולהבנת אירועים',
    'beginner',
    'A1',
    'A2',
  ],
  [
    4,
    'current-events-advanced-en-he',
    'אקטואליה — מתקדמים',
    'שפה מתקדמת למדיניות, דיפלומטיה ושיח ציבורי',
    'advanced',
    'C1',
    'C2',
  ],
];

const packs = [
  [0, 1, 'sports-beginner-1-en-he', 'יחידה 1: יסודות הספורט', 'אנשים, ציוד ותוצאות במשחקי ספורט'],
  [
    1,
    1,
    'sports-advanced-1-en-he',
    'יחידה 1: תחרות וביצועים',
    'טקטיקה, הישגים ומצבים מקצועיים בספורט',
  ],
  [
    2,
    1,
    'fruits-and-vegetables-beginner-1-en-he',
    'יחידה 1: בשוק',
    'פירות וירקות נפוצים שפוגשים בחנות ובמטבח',
  ],
  [
    3,
    1,
    'fruits-and-vegetables-advanced-1-en-he',
    'יחידה 1: תוצרת מגוונת',
    'שמות של פירות וירקות פחות בסיסיים',
  ],
  [
    4,
    1,
    'everyday-words-beginner-1-en-he',
    'יחידה 1: בבית ובבוקר',
    'פעולות וחפצים של שגרת הבוקר והבית',
  ],
  [
    4,
    2,
    'everyday-words-beginner-2-en-he',
    'יחידה 2: סידורים ותנועה',
    'קניות, תחבורה וסידורים מחוץ לבית',
  ],
  [
    5,
    1,
    'everyday-words-advanced-1-en-he',
    'יחידה 1: שיחה ויחסים',
    'ביטויים מדויקים למצבים חברתיים יומיומיים',
  ],
  [
    5,
    2,
    'everyday-words-advanced-2-en-he',
    'יחידה 2: ניהול החיים',
    'התנהלות, התחייבויות ושינויים בשגרה',
  ],
  [
    6,
    1,
    'software-development-beginner-1-en-he',
    'יחידה 1: יסודות הקוד',
    'רכיבים ופעולות בסיסיים בפיתוח תוכנה',
  ],
  [
    6,
    2,
    'software-development-beginner-2-en-he',
    'יחידה 2: יישום ועבודת צוות',
    'כלים, בדיקות ושיתוף פעולה בפרויקט תוכנה',
  ],
  [
    7,
    1,
    'software-development-advanced-1-en-he',
    'יחידה 1: ארכיטקטורה ואמינות',
    'מושגים לתכנון מערכות יציבות וניתנות להרחבה',
  ],
  [
    7,
    2,
    'software-development-advanced-2-en-he',
    'יחידה 2: מסירה ואבטחה',
    'תהליכי פריסה, תפעול והגנת מערכות',
  ],
  [
    8,
    1,
    'current-events-beginner-1-en-he',
    'יחידה 1: חדשות ותקשורת',
    'מילים בסיסיות לקריאת כתבות ודיווחים',
  ],
  [
    8,
    2,
    'current-events-beginner-2-en-he',
    'יחידה 2: ממשל וכלכלה',
    'מושגי יסוד בבחירות, הנהגה וכלכלה',
  ],
  [
    9,
    1,
    'current-events-advanced-1-en-he',
    'יחידה 1: דיפלומטיה ומשברים',
    'מונחים ליחסים בין מדינות ולניהול משברים',
  ],
  [
    9,
    2,
    'current-events-advanced-2-en-he',
    'יחידה 2: מדיניות ושיח ציבורי',
    'מושגים מורכבים במדיניות, חברה וסביבה',
  ],
];

const entriesByPack = [
  [
    ['player', 'שחקן', 'noun', 'The player scored in the final minute.'],
    ['team', 'קבוצה', 'noun', 'Our team practices twice a week.'],
    ['game', 'משחק', 'noun', 'The game starts at eight o’clock.'],
    ['score', 'תוצאה', 'noun', 'The final score was two to one.'],
    ['coach', 'מאמן', 'noun', 'The coach explained the new exercise.'],
    ['ball', 'כדור', 'noun', 'She kicked the ball across the field.'],
    ['win', 'לנצח', 'verb', 'They hope to win the next match.'],
    ['lose', 'להפסיד', 'verb', 'It is never easy to lose a game.'],
    ['practice', 'אימון', 'noun', 'Basketball practice ends at six.'],
    ['referee', 'שופט', 'noun', 'The referee stopped the game.'],
    ['stadium', 'אצטדיון', 'noun', 'Thousands of fans filled the stadium.'],
    ['match', 'תחרות', 'noun', 'We watched the tennis match together.'],
  ],
  [
    ['championship', 'אליפות', 'noun', 'The club qualified for the national championship.'],
    ['tournament', 'טורניר', 'noun', 'The tournament attracts elite players.'],
    ['opponent', 'יריב', 'noun', 'She studied her opponent before the match.'],
    ['endurance', 'סיבולת', 'noun', 'Long-distance running requires exceptional endurance.'],
    ['agility', 'זריזות', 'noun', 'The drill is designed to improve agility.'],
    ['strategy', 'אסטרטגיה', 'noun', 'Their defensive strategy changed after halftime.'],
    ['formation', 'מערך', 'noun', 'The team adopted a more attacking formation.'],
    ['possession', 'החזקה בכדור', 'noun', 'Maintaining possession helped control the pace.'],
    ['penalty', 'עונש', 'noun', 'A late penalty decided the outcome.'],
    ['comeback', 'מהפך', 'noun', 'The second-half comeback surprised the crowd.'],
    ['undefeated', 'בלתי מנוצח', 'adjective', 'The champion remained undefeated all season.'],
    ['sportsmanship', 'רוח ספורטיבית', 'noun', 'Both athletes showed admirable sportsmanship.'],
  ],
  [
    ['apple', 'תפוח', 'noun', 'I packed an apple for lunch.'],
    ['banana', 'בננה', 'noun', 'The banana is ripe and sweet.'],
    ['orange', 'תפוז', 'noun', 'She squeezed an orange for breakfast.'],
    ['grape', 'ענב', 'noun', 'Each grape was cold and crisp.'],
    ['strawberry', 'תות שדה', 'noun', 'He added a strawberry to the yogurt.'],
    ['tomato', 'עגבנייה', 'noun', 'Slice the tomato for the salad.'],
    ['cucumber', 'מלפפון', 'noun', 'The cucumber is fresh and crunchy.'],
    ['carrot', 'גזר', 'noun', 'Cut the carrot into thin pieces.'],
    ['potato', 'תפוח אדמה', 'noun', 'We baked a potato with olive oil.'],
    ['onion', 'בצל', 'noun', 'Chop the onion carefully.'],
    ['lettuce', 'חסה', 'noun', 'Wash the lettuce before serving it.'],
    ['pepper', 'פלפל', 'noun', 'This red pepper tastes slightly sweet.'],
  ],
  [
    ['avocado', 'אבוקדו', 'noun', 'The avocado has a smooth, creamy texture.'],
    ['pomegranate', 'רימון', 'noun', 'Pomegranate seeds add color to the dish.'],
    ['apricot', 'משמש', 'noun', 'The ripe apricot had a delicate aroma.'],
    ['blueberry', 'אוכמנית', 'noun', 'A blueberry can stain the pale fabric.'],
    ['zucchini', 'קישוא', 'noun', 'Grilled zucchini complements the main course.'],
    ['eggplant', 'חציל', 'noun', 'Roasted eggplant absorbs the spices well.'],
    ['cauliflower', 'כרובית', 'noun', 'The cauliflower was divided into small florets.'],
    ['beetroot', 'סלק', 'noun', 'Beetroot gives the salad an earthy flavor.'],
    ['celery', 'סלרי', 'noun', 'Finely chopped celery adds a crisp texture.'],
    ['spinach', 'תרד', 'noun', 'Fresh spinach wilts quickly in the pan.'],
    ['radish', 'צנונית', 'noun', 'The sliced radish has a peppery taste.'],
    ['artichoke', 'ארטישוק', 'noun', 'Preparing an artichoke requires some patience.'],
  ],
  [
    ['wake up', 'להתעורר', 'verb', 'I wake up at seven every morning.'],
    ['breakfast', 'ארוחת בוקר', 'noun', 'Breakfast is ready on the table.'],
    ['shower', 'מקלחת', 'noun', 'He takes a quick shower before work.'],
    ['towel', 'מגבת', 'noun', 'The clean towel is in the bathroom.'],
    ['kitchen', 'מטבח', 'noun', 'We drink coffee in the kitchen.'],
    ['bedroom', 'חדר שינה', 'noun', 'Her bedroom has a large window.'],
    ['keys', 'מפתחות', 'noun', 'My keys are next to the door.'],
    ['wallet', 'ארנק', 'noun', 'I keep my card in my wallet.'],
    ['clean', 'לנקות', 'verb', 'We clean the apartment on Friday.'],
    ['cook', 'לבשל', 'verb', 'They cook dinner together.'],
    ['laundry', 'כביסה', 'noun', 'The laundry is still wet.'],
    ['leave home', 'לצאת מהבית', 'verb', 'I leave home before eight.'],
  ],
  [
    ['bus stop', 'תחנת אוטובוס', 'noun', 'The bus stop is across the street.'],
    ['ticket', 'כרטיס', 'noun', 'Keep your ticket until the end of the trip.'],
    ['grocery store', 'מכולת', 'noun', 'The grocery store closes at nine.'],
    ['shopping list', 'רשימת קניות', 'noun', 'Milk is at the top of my shopping list.'],
    ['cash', 'מזומן', 'noun', 'Do you want to pay in cash?'],
    ['receipt', 'קבלה', 'noun', 'She put the receipt in her bag.'],
    ['pharmacy', 'בית מרקחת', 'noun', 'The pharmacy is open today.'],
    ['appointment', 'תור', 'noun', 'I have a dentist appointment tomorrow.'],
    ['traffic', 'תנועה', 'noun', 'Morning traffic is very slow.'],
    ['crosswalk', 'מעבר חצייה', 'noun', 'Use the crosswalk to cross safely.'],
    ['on time', 'בזמן', 'adverb', 'The train arrived on time.'],
    ['run errands', 'לעשות סידורים', 'verb', 'I need to run errands after work.'],
  ],
  [
    ['catch up', 'להשלים פערים', 'verb', 'We met for coffee to catch up.'],
    [
      'misunderstanding',
      'אי־הבנה',
      'noun',
      'A brief conversation cleared up the misunderstanding.',
    ],
    ['considerate', 'מתחשב', 'adjective', 'It was considerate of her to call first.'],
    ['reluctant', 'מסויג', 'adjective', 'He seemed reluctant to change the arrangement.'],
    ['reassure', 'להרגיע', 'verb', 'I called to reassure them that everything was fine.'],
    ['compromise', 'פשרה', 'noun', 'We reached a compromise about the schedule.'],
    ['set boundaries', 'להציב גבולות', 'verb', 'It is healthy to set boundaries at work.'],
    ['make amends', 'לתקן את המעוות', 'verb', 'She apologized sincerely to make amends.'],
    ['take for granted', 'לקבל כמובן מאליו', 'verb', 'Do not take reliable friends for granted.'],
    [
      'thoughtful',
      'מתחשב ואכפתי',
      'adjective',
      'His thoughtful message arrived at the right moment.',
    ],
    ['awkward', 'מביך', 'adjective', 'There was an awkward silence after the question.'],
    ['get along', 'להסתדר', 'verb', 'The new neighbors get along very well.'],
  ],
  [
    ['reschedule', 'לקבוע מחדש', 'verb', 'We had to reschedule the appointment.'],
    ['overdue', 'באיחור', 'adjective', 'The electricity bill is already overdue.'],
    ['subscription', 'מינוי', 'noun', 'I canceled a subscription I no longer use.'],
    ['maintenance', 'תחזוקה', 'noun', 'Regular maintenance keeps the air conditioner efficient.'],
    ['declutter', 'לפנות חפצים מיותרים', 'verb', 'We decided to declutter the storage room.'],
    ['stock up', 'להצטייד', 'verb', 'They stock up on groceries before the holiday.'],
    [
      'make ends meet',
      'לגמור את החודש',
      'verb',
      'Careful budgeting helps the family make ends meet.',
    ],
    ['unexpected expense', 'הוצאה בלתי צפויה', 'noun', 'The repair became an unexpected expense.'],
    ['prioritize', 'לתעדף', 'verb', 'I prioritize urgent tasks in the morning.'],
    ['keep track of', 'לעקוב אחר', 'verb', 'This calendar helps me keep track of deadlines.'],
    ['fall behind', 'לפגר', 'verb', 'It is easy to fall behind during a busy week.'],
    ['adjustment', 'הסתגלות', 'noun', 'Working from home required a gradual adjustment.'],
  ],
  [
    ['code', 'קוד', 'noun', 'The developer wrote a short piece of code.'],
    ['program', 'תוכנית', 'noun', 'This program organizes the files.'],
    ['variable', 'משתנה', 'noun', 'The variable stores the user’s name.'],
    ['function', 'פונקציה', 'noun', 'The function calculates the total price.'],
    ['bug', 'תקלה', 'noun', 'We found a bug in the login screen.'],
    ['fix', 'לתקן', 'verb', 'She will fix the error today.'],
    ['file', 'קובץ', 'noun', 'Save the file before closing the editor.'],
    ['folder', 'תיקייה', 'noun', 'The images are in a separate folder.'],
    ['database', 'מסד נתונים', 'noun', 'The database stores customer details.'],
    ['server', 'שרת', 'noun', 'The server sends data to the application.'],
    ['user', 'משתמש', 'noun', 'The user enters an email address.'],
    ['application', 'יישום', 'noun', 'The application runs on mobile phones.'],
  ],
  [
    ['browser', 'דפדפן', 'noun', 'Open the page in your browser.'],
    ['website', 'אתר אינטרנט', 'noun', 'The new website loads quickly.'],
    ['button', 'כפתור', 'noun', 'Click the blue button to continue.'],
    ['login', 'התחברות', 'noun', 'The login requires a password.'],
    ['test', 'בדיקה', 'noun', 'This test checks the payment flow.'],
    ['version', 'גרסה', 'noun', 'We released a new version yesterday.'],
    ['update', 'עדכון', 'noun', 'The update includes several small fixes.'],
    ['repository', 'מאגר קוד', 'noun', 'The repository contains the project files.'],
    ['commit', 'שמירת שינוי בקוד', 'noun', 'Each commit should describe one clear change.'],
    ['branch', 'ענף פיתוח', 'noun', 'Create a branch for the new feature.'],
    ['code review', 'סקירת קוד', 'noun', 'A teammate completed the code review.'],
    ['deploy', 'לפרוס', 'verb', 'The team will deploy the update tonight.'],
  ],
  [
    [
      'scalability',
      'יכולת התרחבות',
      'noun',
      'The architecture was redesigned for greater scalability.',
    ],
    [
      'fault tolerance',
      'עמידות לתקלות',
      'noun',
      'Replication improves the system’s fault tolerance.',
    ],
    [
      'bottleneck',
      'צוואר בקבוק',
      'noun',
      'Database writes became the main performance bottleneck.',
    ],
    ['latency', 'זמן השהיה', 'noun', 'Caching reduced the latency of repeated requests.'],
    ['throughput', 'קצב עיבוד', 'noun', 'The benchmark measures throughput under heavy load.'],
    ['idempotent', 'אידמפוטנטי', 'adjective', 'An idempotent operation can be repeated safely.'],
    [
      'eventual consistency',
      'עקביות מתכנסת',
      'noun',
      'The distributed store relies on eventual consistency.',
    ],
    [
      'dependency injection',
      'הזרקת תלויות',
      'noun',
      'Dependency injection makes the component easier to test.',
    ],
    ['race condition', 'תנאי מרוץ', 'noun', 'A lock prevented the race condition.'],
    ['technical debt', 'חוב טכני', 'noun', 'The team allocated time to reduce technical debt.'],
    [
      'refactor',
      'לשכתב מבנה קוד',
      'verb',
      'They will refactor the module without changing its behavior.',
    ],
    [
      'observability',
      'יכולת תצפית',
      'noun',
      'Structured logs improve observability in production.',
    ],
  ],
  [
    [
      'continuous integration',
      'אינטגרציה רציפה',
      'noun',
      'Continuous integration detects regressions early.',
    ],
    [
      'deployment pipeline',
      'צינור פריסה',
      'noun',
      'The deployment pipeline requires every test to pass.',
    ],
    ['rollback', 'חזרה לגרסה קודמת', 'noun', 'The release plan includes an automatic rollback.'],
    ['feature flag', 'דגל תכונה', 'noun', 'A feature flag limits the change to selected users.'],
    ['vulnerability', 'פגיעות אבטחה', 'noun', 'The patch closes a serious vulnerability.'],
    ['authentication', 'אימות זהות', 'noun', 'Authentication confirms who the user is.'],
    ['authorization', 'הרשאה', 'noun', 'Authorization determines which records may be viewed.'],
    ['encryption', 'הצפנה', 'noun', 'Encryption protects sensitive data in transit.'],
    [
      'secret rotation',
      'החלפת סודות',
      'noun',
      'Regular secret rotation reduces long-term exposure.',
    ],
    [
      'incident response',
      'תגובה לתקרית',
      'noun',
      'The incident response process defines clear responsibilities.',
    ],
    ['zero downtime', 'ללא זמן השבתה', 'noun', 'The migration was completed with zero downtime.'],
    ['postmortem', 'תחקיר תקלה', 'noun', 'The postmortem focused on learning and prevention.'],
  ],
  [
    ['news', 'חדשות', 'noun', 'I read the news every morning.'],
    ['report', 'דיווח', 'noun', 'The report describes what happened.'],
    ['headline', 'כותרת', 'noun', 'The headline appears at the top of the page.'],
    ['article', 'כתבה', 'noun', 'She shared an interesting article.'],
    ['journalist', 'עיתונאי', 'noun', 'The journalist asked several questions.'],
    ['interview', 'ראיון', 'noun', 'The interview was broadcast on television.'],
    ['event', 'אירוע', 'noun', 'The event attracted many visitors.'],
    ['public', 'ציבור', 'noun', 'The museum is open to the public.'],
    ['statement', 'הצהרה', 'noun', 'The organization published a short statement.'],
    ['source', 'מקור', 'noun', 'A reliable source confirmed the details.'],
    ['live update', 'עדכון חי', 'noun', 'The website posted a live update.'],
    [
      'breaking news',
      'חדשות מתפרצות',
      'noun',
      'The channel interrupted the program for breaking news.',
    ],
  ],
  [
    ['government', 'ממשלה', 'noun', 'The government presented its annual plan.'],
    ['election', 'בחירות', 'noun', 'The election will take place next month.'],
    ['vote', 'להצביע', 'verb', 'Citizens can vote at local polling stations.'],
    ['candidate', 'מועמד', 'noun', 'Each candidate answered questions from the audience.'],
    ['minister', 'שר', 'noun', 'The minister spoke at the committee meeting.'],
    ['law', 'חוק', 'noun', 'The new law takes effect in January.'],
    ['budget', 'תקציב', 'noun', 'The council approved the budget.'],
    ['economy', 'כלכלה', 'noun', 'Tourism supports the local economy.'],
    ['price', 'מחיר', 'noun', 'The price of fuel changed this week.'],
    ['trade', 'מסחר', 'noun', 'The agreement encourages trade between the countries.'],
    ['unemployment', 'אבטלה', 'noun', 'The report tracks changes in unemployment.'],
    ['interest rate', 'שיעור ריבית', 'noun', 'The bank announced a new interest rate.'],
  ],
  [
    ['negotiation', 'משא ומתן', 'noun', 'The parties resumed negotiation through mediators.'],
    ['ceasefire', 'הפסקת אש', 'noun', 'Observers called for a durable ceasefire.'],
    ['sanction', 'עיצום', 'noun', 'The measure introduced a targeted economic sanction.'],
    ['alliance', 'ברית', 'noun', 'The alliance coordinated a joint response.'],
    ['envoy', 'שליח מדיני', 'noun', 'A special envoy traveled to the region.'],
    ['bilateral', 'דו־צדדי', 'adjective', 'The leaders held a bilateral meeting.'],
    ['escalation', 'הסלמה', 'noun', 'Diplomats worked to prevent further escalation.'],
    [
      'humanitarian aid',
      'סיוע הומניטרי',
      'noun',
      'Humanitarian aid reached the affected communities.',
    ],
    ['displacement', 'עקירה', 'noun', 'The crisis caused widespread displacement.'],
    ['sovereignty', 'ריבונות', 'noun', 'The statement emphasized national sovereignty.'],
    ['mediation', 'תיווך', 'noun', 'International mediation helped restart the talks.'],
    [
      'geopolitical',
      'גאופוליטי',
      'adjective',
      'The decision has broader geopolitical implications.',
    ],
  ],
  [
    ['legislation', 'חקיקה', 'noun', 'The proposed legislation returned to the committee.'],
    ['regulation', 'אסדרה', 'noun', 'The regulation sets stricter reporting standards.'],
    [
      'accountability',
      'אחריותיות',
      'noun',
      'Independent oversight strengthens public accountability.',
    ],
    ['transparency', 'שקיפות', 'noun', 'The group demanded greater transparency in the process.'],
    ['bipartisan', 'דו־מפלגתי', 'adjective', 'The proposal received bipartisan support.'],
    ['polarization', 'קיטוב', 'noun', 'The debate reflected growing political polarization.'],
    [
      'misinformation',
      'מידע כוזב',
      'noun',
      'The platform introduced tools to limit misinformation.',
    ],
    ['public opinion', 'דעת קהל', 'noun', 'The survey measured shifts in public opinion.'],
    [
      'fiscal policy',
      'מדיניות פיסקלית',
      'noun',
      'Fiscal policy can influence demand and investment.',
    ],
    [
      'cost of living',
      'יוקר המחיה',
      'noun',
      'Housing is central to the debate about the cost of living.',
    ],
    [
      'climate resilience',
      'חוסן אקלימי',
      'noun',
      'The city invested in long-term climate resilience.',
    ],
    [
      'sustainable development',
      'פיתוח בר־קיימא',
      'noun',
      'The plan links growth with sustainable development.',
    ],
  ],
];

export const up = (pgm) => {
  insertRows(
    pgm,
    'word_topics',
    ['id', 'slug', 'title', 'description', 'sort_order'],
    topics.map(([slug, title, description], index) => [
      id(5, index + 1),
      slug,
      title,
      description,
      (index + 2) * 10,
    ]),
  );

  insertRows(
    pgm,
    'word_tracks',
    [
      'id',
      'topic_id',
      'slug',
      'title',
      'description',
      'level_code',
      'cefr_from',
      'cefr_to',
      'source_language_code',
      'translation_language_code',
      'sort_order',
    ],
    tracks.map(([topicIndex, slug, title, description, levelCode, cefrFrom, cefrTo], index) => [
      id(6, index + 1),
      id(5, topicIndex + 1),
      slug,
      title,
      description,
      levelCode,
      cefrFrom,
      cefrTo,
      'en',
      'he',
      levelCode === 'beginner' ? 10 : 30,
    ]),
  );

  insertRows(
    pgm,
    'word_packs',
    ['id', 'track_id', 'slug', 'module_number', 'title', 'description', 'version', 'sort_order'],
    packs.map(([trackIndex, moduleNumber, slug, title, description], index) => [
      id(7, index + 1),
      id(6, trackIndex + 1),
      slug,
      moduleNumber,
      title,
      description,
      1,
      moduleNumber * 10,
    ]),
  );

  let entrySequence = 1;
  const entryRows = entriesByPack.flatMap((entries, packIndex) =>
    entries.map(([sourceText, translationText, partOfSpeech, exampleText], entryIndex) => {
      const row = [
        id(8, entrySequence),
        id(7, packIndex + 1),
        sourceText,
        sourceText.toLocaleLowerCase('en'),
        translationText,
        translationText,
        sourceText.includes(' ') ? 'phrase' : 'word',
        partOfSpeech,
        exampleText,
        (entryIndex + 1) * 10,
      ];
      entrySequence += 1;
      return row;
    }),
  );
  insertRows(
    pgm,
    'word_pack_entries',
    [
      'id',
      'pack_id',
      'source_text',
      'normalized_source_text',
      'translation_text',
      'normalized_translation_text',
      'item_type',
      'part_of_speech',
      'example_text',
      'sort_order',
    ],
    entryRows,
  );
};

export const down = (pgm) => {
  pgm.sql(`
    DELETE FROM product_gotit.learning_item_pack_entries
    WHERE pack_id IN (
      SELECT p.id FROM product_gotit.word_packs p
      JOIN product_gotit.word_tracks tr ON tr.id=p.track_id
      JOIN product_gotit.word_topics tp ON tp.id=tr.topic_id
      WHERE tp.slug IN ('sports','fruits-and-vegetables','everyday-words','software-development','current-events')
    );
    DELETE FROM product_gotit.user_word_packs
    WHERE pack_id IN (
      SELECT p.id FROM product_gotit.word_packs p
      JOIN product_gotit.word_tracks tr ON tr.id=p.track_id
      JOIN product_gotit.word_topics tp ON tp.id=tr.topic_id
      WHERE tp.slug IN ('sports','fruits-and-vegetables','everyday-words','software-development','current-events')
    );
    DELETE FROM product_gotit.word_packs
    WHERE track_id IN (
      SELECT tr.id FROM product_gotit.word_tracks tr
      JOIN product_gotit.word_topics tp ON tp.id=tr.topic_id
      WHERE tp.slug IN ('sports','fruits-and-vegetables','everyday-words','software-development','current-events')
    );
    DELETE FROM product_gotit.word_tracks
    WHERE topic_id IN (
      SELECT id FROM product_gotit.word_topics
      WHERE slug IN ('sports','fruits-and-vegetables','everyday-words','software-development','current-events')
    );
    DELETE FROM product_gotit.word_topics
    WHERE slug IN ('sports','fruits-and-vegetables','everyday-words','software-development','current-events');
  `);
};
