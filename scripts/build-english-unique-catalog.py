"""Build the reviewed-in-source unique English path catalog from the supplied list.

Existing contextual Hebrew senses take precedence. Missing translations are drafted
with the locally cached OPUS en-he model and require editorial review before release.
The generated JSON is committed so migrations never call a model at runtime.
"""

import json
import re
from pathlib import Path

import torch
from transformers import AutoModelForSeq2SeqLM, AutoTokenizer


ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "migrations" / "data"
SOURCE = DATA / "english-unique-3000-source.txt"
OUTPUT = DATA / "english-unique-3000-en-he.json"
MODEL = "Helsinki-NLP/opus-mt-en-he"
DRAFT_CACHE = ROOT / ".local-backups" / "english-unique-draft-translations.json"
OVERRIDES = {
    "checkout": "יציאה מהמלון",
    "wi-fi": "רשת אלחוטית",
    "bluetooth": "בלוטות׳",
    "usb": "חיבור USB",
    "forecasted": "נחזה",
    "rainfall": "כמות הגשם",
    "snowfall": "ירידת שלג",
}


def read_units():
    lines = SOURCE.read_text(encoding="utf-8-sig").splitlines()
    units = []
    for index, line in enumerate(lines):
        match = re.fullmatch(r"Unit (\d+) \u2014 (.+)", line)
        if match:
            units.append(
                {
                    "number": int(match.group(1)),
                    "levelCode": ("beginner", "intermediate", "advanced")[len(units) // 20],
                    "moduleNumber": len(units) % 20 + 1,
                    "name": match.group(2),
                    "words": [word.strip() for word in lines[index + 1].split(",")],
                }
            )
    all_words = [word.casefold() for unit in units for word in unit["words"]]
    if (
        len(units) != 60
        or [unit["number"] for unit in units] != list(range(1, 61))
        or any(len(unit["words"]) != 50 for unit in units)
        or len(set(all_words)) != 3000
    ):
        raise ValueError("The supplied catalog must contain 60 units of 50 unique entries")
    return units


def existing_translations():
    catalog = json.loads((DATA / "english-communication-en-he.json").read_text(encoding="utf-8"))
    corrections = json.loads(
        (DATA / "english-communication-sense-corrections.json").read_text(encoding="utf-8")
    )
    correction_map = {(item["unit"], item["en"]): item["he"] for item in corrections}
    prior = json.loads((DATA / "daily-english-en-he.json").read_text(encoding="utf-8"))
    by_word = {}
    by_unit = {}
    for tier in prior:
        for entry in tier:
            by_word.setdefault(entry["en"].casefold(), entry)
    for unit in catalog:
        for entry in unit["entries"]:
            resolved = {
                **entry,
                "he": correction_map.get((unit["number"], entry["en"]), entry["he"]),
            }
            by_word[entry["en"].casefold()] = resolved
            by_unit[(unit["number"], entry["en"].casefold())] = resolved
    return by_word, by_unit


def translate_missing(words):
    if not words:
        return {}
    translations = json.loads(DRAFT_CACHE.read_text(encoding="utf-8")) if DRAFT_CACHE.exists() else {}
    words = [word for word in words if word.casefold() not in translations]
    if not words:
        return translations
    torch.set_num_threads(4)
    tokenizer = AutoTokenizer.from_pretrained(MODEL, local_files_only=True)
    model = AutoModelForSeq2SeqLM.from_pretrained(MODEL, local_files_only=True)
    for start in range(0, len(words), 48):
        batch = words[start : start + 48]
        encoded = tokenizer(batch, return_tensors="pt", padding=True, truncation=True)
        outputs = model.generate(**encoded, max_new_tokens=40)
        for word, raw in zip(batch, tokenizer.batch_decode(outputs, skip_special_tokens=True)):
            translations[word.casefold()] = raw.strip().strip('"“”.,!?… ')
        print(f"Translated {min(start + 48, len(words))}/{len(words)}", flush=True)
    DRAFT_CACHE.parent.mkdir(exist_ok=True)
    DRAFT_CACHE.write_text(json.dumps(translations, ensure_ascii=False, indent=2), encoding="utf-8")
    return translations


def build():
    units = read_units()
    by_word, by_unit = existing_translations()
    missing = [
        word
        for unit in units
        for word in unit["words"]
        if (unit["number"], word.casefold()) not in by_unit
        and not re.search(r"[\u05d0-\u05ea]", by_word.get(word.casefold(), {}).get("he", ""))
    ]
    drafts = translate_missing(missing)
    output = []
    for unit in units:
        entries = []
        for word in unit["words"]:
            previous = by_unit.get((unit["number"], word.casefold())) or by_word.get(word.casefold())
            he = (
                previous["he"]
                if previous and re.search(r"[\u05d0-\u05ea]", previous["he"])
                else OVERRIDES.get(word.casefold(), drafts[word.casefold()])
            )
            if not re.search(r"[\u05d0-\u05ea]", he):
                raise ValueError(f"Missing Hebrew translation: {unit['number']}/{word}")
            entries.append(
                {
                    "en": word,
                    "he": he,
                    "type": previous["type"] if previous else ("phrase" if " " in word else "word"),
                    "pos": previous["pos"] if previous else None,
                    "translationSource": (
                        "existing"
                        if previous and re.search(r"[\u05d0-\u05ea]", previous["he"])
                        else "manual-override" if word.casefold() in OVERRIDES
                        else "draft-opus-mt-en-he"
                    ),
                }
            )
        output.append({key: value for key, value in unit.items() if key != "words"} | {"entries": entries})
    OUTPUT.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {OUTPUT}; {len(missing)} draft translations", flush=True)


if __name__ == "__main__":
    build()
