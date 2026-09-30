"""Editorial helper for the static English/Hebrew daily-use catalog.

Requires openpyxl, torch, transformers and sentencepiece. The committed JSON is
the runtime source; this helper is only for repeatable draft generation and review.
"""

import json
import math
import re
from pathlib import Path

import openpyxl
import requests
import torch
from transformers import AutoModelForSeq2SeqLM, AutoTokenizer


ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "migrations" / "data" / "daily-english-en-he.json"
COCA_URL = "https://www.wordfrequency.info/samples/wordFrequency.xlsx"
COCA_FILE = Path.home() / ".cache" / "gotit" / "wordFrequency.xlsx"
MODEL = "Helsinki-NLP/opus-mt-en-he"

# The first units privilege immediate conversation over raw corpus rank.
FIRST_WORDS = """
i you be have do go come want need can yes no please thank sorry hello goodbye
what where when why how who this that here there now today tomorrow time name
help water food eat drink bathroom home house family friend mother father child
person man woman good bad big small more less one two three my your me we they
he she it in on with for to from and or but because not if at of a the know
understand speak say tell ask look see hear listen give take make get use work
live love like feel
""".split()

BASIC_PHRASES = """
good morning|good evening|good night|how are you?|i'm fine|thank you|
thank you very much|you're welcome|excuse me|i'm sorry|no problem|
please help me|i don't understand|i don't know|i think so|what is this?|
what's your name?|my name is|nice to meet you|where are you from?|
how old are you?|i live in|do you speak english?|can you repeat that?|
please speak slowly|what does it mean?|how do you say|i need help|
i need water|i'd like|i want to|can i have|how much is it?|
where is the bathroom?|where is the station?|i'm looking for|turn left|
turn right|go straight|i'm lost|what time is it?|see you later|
see you tomorrow|take care|let's go|come here|wait a moment|just a moment|
right now|not yet|of course|maybe later|i agree|i don't agree|
i like it|i don't like it|that's fine|it doesn't matter|are you okay?|
i'm okay
""".replace("\n", "").split("|")

GOOD_PHRASES = """
get up|wake up|go out|come back|find out|look for|look after|take care of|
put on|take off|turn on|turn off|pick up|give up|run out of|
look forward to|get along with|be able to|used to|have to|be supposed to|
in fact|at least|as soon as|by the way|on the other hand|in my opinion|
in the end|for example|as a result|make sense|take a break|pay attention|
keep in touch|make a decision|take a look|be in charge of|no longer|
from time to time|all of a sudden
""".replace("\n", "").split("|")

ADVANCED_PHRASES = """
on behalf of|in terms of|in spite of|regardless of|as far as i know|
to some extent|more or less|in the long run|in the meantime|
at the same time|as opposed to|not necessarily|it depends on|
make the most of|come up with|bring up|carry out|figure out|rule out|
point out|break down|set up|put up with|look into|follow through|
in light of|given that|assuming that|even though|provided that|
in contrast|in addition to|on top of that|all things considered|
for the time being|sooner or later|once in a while|take into account|
make up for|get away with
""".replace("\n", "").split("|")

WORD_OVERRIDES = {
    "i": "אני",
    "a": "מילת יידוע לא מסוימת",
    "the": "ה־",
    "be": "להיות",
    "have": "יש; להחזיק",
    "do": "לעשות",
    "can": "יכול",
    "will": "עתיד; ירצה",
    "would": "היה; היה רוצה",
    "could": "יכול היה",
    "should": "צריך; כדאי",
    "may": "עשוי; רשאי",
    "might": "אולי; עשוי",
    "must": "חייב",
    "need": "להזדקק; צריך",
    "mean": "להתכוון; משמעותו",
    "get": "לקבל; להגיע",
    "make": "לעשות; להכין",
    "like": "לאהוב; כמו",
    "right": "נכון; ימין",
    "lot": "הרבה; כמות גדולה",
    "work": "לעבוד; עבודה",
    "call": "להתקשר; לקרוא",
    "help": "לעזור; עזרה",
    "use": "להשתמש",
    "feel": "להרגיש",
    "put": "לשים",
    "talk": "לדבר",
    "ask": "לשאול; לבקש",
    "tell": "לספר; להגיד",
    "say": "לומר",
    "thank": "להודות",
    "goodbye": "להתראות",
    "please": "בבקשה",
    "sorry": "סליחה; מצטער",
    "no": "לא",
    "yes": "כן",
    "of": "של",
    "to": "ל־; אל",
    "for": "בשביל; עבור",
    "with": "עם",
    "in": "ב־; בתוך",
    "on": "על",
    "at": "ב־; אצל",
    "as": "כמו; בתור",
    "by": "על ידי; ליד",
    "just": "רק; בדיוק",
    "still": "עדיין",
    "too": "גם; יותר מדי",
    "over": "מעל; נגמר",
    "out": "החוצה",
    "up": "למעלה",
    "down": "למטה",
    "here": "כאן",
    "there": "שם; יש",
    "all": "כל; הכול",
    "every": "כל",
    "one": "אחד",
    "two": "שניים",
    "three": "שלושה",
    "they": "הם; הן",
    "them": "אותם; אותן",
    "we": "אנחנו",
    "us": "אותנו; לנו",
    "you": "אתה; את",
    "your": "שלך",
    "he": "הוא",
    "she": "היא",
    "it": "זה; זאת",
    "me": "אותי; לי",
    "my": "שלי",
    "her": "שלה; אותה",
    "his": "שלו",
    "our": "שלנו",
    "their": "שלהם; שלהן",
    "him": "אותו; לו",
    "child": "ילד; ילדה",
    "man": "גבר; אדם",
    "woman": "אישה",
    "person": "אדם",
    "people": "אנשים",
    "about": "על; לגבי; בערך",
    "home": "בית; הביתה",
    "happen": "לקרות",
    "first": "ראשון; קודם",
    "old": "ישן; מבוגר",
    "most": "רוב; הכי",
    "case": "מקרה; תיק",
    "hold": "להחזיק",
    "morning": "בוקר",
    "baby": "תינוק; תינוקת",
    "wrong": "לא נכון; שגוי",
    "hard": "קשה; קשיח",
    "its": "שלו; שלה",
    "brother": "אח",
    "mind": "מחשבה; דעת",
    "sense": "חוש; משמעות",
    "security": "ביטחון; אבטחה",
    "seat": "מושב",
    "serious": "רציני",
    "willing": "מוכן; נכון ל־",
    "easy": "קל",
    "poor": "עני; דל",
    "gather": "לאסוף; להתכנס",
    "shake": "לנער; לרעוד",
    "feed": "להאכיל",
    "collect": "לאסוף; לגבות",
    "screw": "להבריג; לפשל",
    "rain": "גשם",
    "snow": "שלג",
    "sake": "למען; תועלת",
    "upon": "על; בעת",
    "onto": "אל; על גבי",
    "pm": "אחר הצהריים; בערב",
    "et": "ו־ (בלטינית)",
    "fifteen": "חמש עשרה",
    "twelve": "שתים עשרה",
    "vs": "נגד; לעומת",
    "stock": "מלאי; מניה",
    "correct": "נכון; לתקן",
    "minister": "שר",
    "email": "דואר אלקטרוני",
    "aircraft": "מטוס; כלי טיס",
    "clear": "ברור; צלול",
    "major": "גדול; מרכזי",
    "immediate": "מיידי",
    "multiple": "רב; מרובה",
    "ongoing": "מתמשך",
}

PHRASE_OVERRIDES = {
    "good morning": "בוקר טוב",
    "good evening": "ערב טוב",
    "good night": "לילה טוב",
    "how are you?": "מה שלומך?",
    "i'm fine": "אני בסדר",
    "thank you": "תודה",
    "thank you very much": "תודה רבה",
    "you're welcome": "בבקשה; על לא דבר",
    "excuse me": "סליחה",
    "i'm sorry": "אני מצטער; אני מצטערת",
    "no problem": "אין בעיה",
    "please help me": "בבקשה עזור לי; בבקשה עזרי לי",
    "i don't understand": "אני לא מבין; אני לא מבינה",
    "i don't know": "אני לא יודע; אני לא יודעת",
    "i think so": "אני חושב שכן; אני חושבת שכן",
    "what is this?": "מה זה?",
    "what's your name?": "איך קוראים לך?",
    "my name is": "קוראים לי",
    "nice to meet you": "נעים להכיר",
    "where are you from?": "מאיפה אתה; מאיפה את?",
    "how old are you?": "בן כמה אתה; בת כמה את?",
    "i live in": "אני גר; אני גרה ב־",
    "do you speak english?": "אתה מדבר אנגלית; את מדברת אנגלית?",
    "can you repeat that?": "אפשר לחזור על זה?",
    "please speak slowly": "בבקשה דבר לאט; דברי לאט",
    "what does it mean?": "מה זה אומר?",
    "how do you say": "איך אומרים",
    "i need help": "אני צריך עזרה; אני צריכה עזרה",
    "i need water": "אני צריך מים; אני צריכה מים",
    "i'd like": "הייתי רוצה",
    "i want to": "אני רוצה ל־",
    "can i have": "אפשר לקבל",
    "how much is it?": "כמה זה עולה?",
    "where is the bathroom?": "איפה השירותים?",
    "where is the station?": "איפה התחנה?",
    "i'm looking for": "אני מחפש; אני מחפשת",
    "turn left": "פנה שמאלה; פני שמאלה",
    "turn right": "פנה ימינה; פני ימינה",
    "go straight": "המשך ישר; המשיכי ישר",
    "i'm lost": "הלכתי לאיבוד",
    "what time is it?": "מה השעה?",
    "see you later": "נתראה אחר כך",
    "see you tomorrow": "נתראה מחר",
    "take care": "שמור על עצמך; שמרי על עצמך",
    "let's go": "בוא נלך; בואי נלך",
    "come here": "בוא הנה; בואי הנה",
    "wait a moment": "חכה רגע; חכי רגע",
    "just a moment": "רק רגע",
    "right now": "עכשיו; ברגע זה",
    "not yet": "עדיין לא",
    "of course": "כמובן",
    "maybe later": "אולי אחר כך",
    "i agree": "אני מסכים; אני מסכימה",
    "i don't agree": "אני לא מסכים; אני לא מסכימה",
    "i like it": "אני אוהב את זה; אני אוהבת את זה",
    "i don't like it": "אני לא אוהב את זה; אני לא אוהבת את זה",
    "that's fine": "זה בסדר",
    "it doesn't matter": "זה לא משנה",
    "are you okay?": "אתה בסדר; את בסדר?",
    "i'm okay": "אני בסדר",
}

EXCLUDE_WORDS = {
    "fuck", "fucking", "shit", "damn", "bitch", "ass", "crap", "hell",
    "murder", "kill", "killer", "gun", "shoot", "dead", "die", "death",
    "god", "jesus", "christ", "bible", "lord", "sir", "ma'am",
}

POS = {
    "n": "noun", "v": "verb", "j": "adjective", "r": "adverb",
    "p": "pronoun", "i": "preposition", "c": "conjunction",
    "a": "determiner", "t": "particle", "m": "number",
    "e": "adverb", "u": "interjection",
}


def ranked_words():
    COCA_FILE.parent.mkdir(parents=True, exist_ok=True)
    if not COCA_FILE.exists():
        response = requests.get(COCA_URL, timeout=60)
        response.raise_for_status()
        COCA_FILE.write_bytes(response.content)
    sheet = openpyxl.load_workbook(COCA_FILE, read_only=True, data_only=True)["1 lemmas"]
    words = {}
    for row in list(sheet.values)[1:]:
        rank, lemma, pos, _, per_million, caps, *_ = row
        if not isinstance(lemma, str) or not re.fullmatch(r"[a-z]+", lemma.lower()):
            continue
        lemma = lemma.lower()
        if lemma in EXCLUDE_WORDS or not isinstance(caps, (float, int)) or caps > 0.45:
            continue
        if pos not in POS:
            continue
        tvm, spoken = row[19], row[20]
        score = (
            0.65 * math.log1p(max(0, tvm or 0) + max(0, spoken or 0))
            + 0.35 * math.log1p(per_million or 0)
        )
        if lemma not in words or score > words[lemma][0]:
            words[lemma] = (score, rank, POS[pos])
    ordered = sorted(words, key=lambda word: -words[word][0])
    missing_pos = {
        "i": "pronoun", "yes": "interjection", "thank": "verb",
        "hello": "interjection", "goodbye": "interjection", "what": "pronoun",
    }
    for word in FIRST_WORDS:
        if word not in words:
            words[word] = (0, 0, missing_pos[word])
    prioritized = FIRST_WORDS
    return [(word, words[word][2], words[word][1]) for word in dict.fromkeys(prioritized + ordered)]


def translate(texts):
    torch.set_num_threads(4)
    tokenizer = AutoTokenizer.from_pretrained(MODEL)
    model = AutoModelForSeq2SeqLM.from_pretrained(MODEL)
    result = []
    for start in range(0, len(texts), 48):
        batch = texts[start:start + 48]
        encoded = tokenizer(batch, return_tensors="pt", padding=True, truncation=True)
        outputs = model.generate(**encoded, max_new_tokens=36)
        result.extend(tokenizer.batch_decode(outputs, skip_special_tokens=True))
        print(f"translated {min(start + 48, len(texts))}/{len(texts)}", flush=True)
    return result


def clean_translation(text):
    return text.strip().strip('"“”.,!?… ').replace("  ", " ")


def build():
    words = ranked_words()[:2860]
    assert len(words) == 2860
    phrases = BASIC_PHRASES + GOOD_PHRASES + ADVANCED_PHRASES
    assert len(BASIC_PHRASES) == 60
    assert len(GOOD_PHRASES) == 40
    assert len(ADVANCED_PHRASES) == 40
    assert len(phrases) == len(set(phrases))

    # Context forces infinitive verb translations and resolves common noun/verb ambiguity.
    texts = [
        f"I want to {word}." if pos == "verb" else
        f"a {word}." if pos == "noun" else
        f"This is {word}." if pos == "adjective" else
        word
        for word, pos, _ in words
    ]
    word_translations = translate(texts)
    phrase_translations = translate(phrases)
    entries = []
    for (word, pos, rank), raw in zip(words, word_translations):
        translation = clean_translation(raw)
        if pos == "verb" and translation.startswith("אני רוצה "):
            translation = translation[len("אני רוצה "):]
        if pos == "adjective":
            translation = re.sub(r"^(?:זה|זהו|זו|זוהי|אלה)\s+", "", translation)
        translation = WORD_OVERRIDES.get(word, translation)
        entries.append({"en": "I" if word == "i" else word, "he": translation, "type": "word", "pos": pos, "cocaRank": rank})

    phrases_by_tier = []
    offset = 0
    for tier_phrases in (BASIC_PHRASES, GOOD_PHRASES, ADVANCED_PHRASES):
        group = []
        for phrase, raw in zip(tier_phrases, phrase_translations[offset:offset + len(tier_phrases)]):
            group.append({"en": phrase, "he": PHRASE_OVERRIDES.get(phrase, clean_translation(raw)), "type": "phrase", "pos": None, "cocaRank": None})
        phrases_by_tier.append(group)
        offset += len(tier_phrases)

    tiers = []
    word_offset = 0
    for tier_index, phrase_group in enumerate(phrases_by_tier):
        word_count = 1000 - len(phrase_group)
        tier_words = entries[word_offset:word_offset + word_count]
        word_offset += word_count
        # Short, common chunks appear in the first unit; the rest are spread through the track.
        if tier_index == 0:
            first = phrase_group[:15]
            rest = phrase_group[15:]
            combined = []
            for i in range(1000):
                if i < 50 and i % 3 == 0 and first:
                    combined.append(first.pop(0))
                elif rest and (i - 50) % 20 == 0 and i >= 50:
                    combined.append(rest.pop(0))
                elif tier_words:
                    combined.append(tier_words.pop(0))
                elif first:
                    combined.append(first.pop(0))
                else:
                    combined.append(rest.pop(0))
        else:
            combined = []
            for i in range(1000):
                if phrase_group and i % 25 == 0:
                    combined.append(phrase_group.pop(0))
                elif tier_words:
                    combined.append(tier_words.pop(0))
                else:
                    combined.append(phrase_group.pop(0))
        assert len(combined) == 1000
        tiers.append(combined)

    assert len({entry["en"].lower() for tier in tiers for entry in tier}) == 3000
    missing = [entry["en"] for tier in tiers for entry in tier if not re.search(r"[א-ת]", entry["he"])]
    if missing:
        print(f"translations requiring review: {missing}", flush=True)
    OUTPUT.write_text(json.dumps(tiers, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"wrote {OUTPUT}", flush=True)


if __name__ == "__main__":
    build()
