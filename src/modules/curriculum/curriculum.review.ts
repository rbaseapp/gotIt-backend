// Applies a native-speaker review sheet (scripts/native-review-sheet.ts) back to the assets.
// A row marked "fix" with a suggested_english replaces that line in its unit and the unit's
// lessons, which repeat dialogue and passages. Tutor names in the sheet read "Rachel" and
// go back to the {{teacherName}} slot.

export type ReviewRow = Record<string, string>;

/** RFC 4180 CSV (quoted fields, doubled quotes, CRLF), as Sheets and Excel export it. */
export function parseCsv(text: string): ReviewRow[] {
  const records: string[][] = [];
  let field = '',
    record: string[] = [],
    quoted = false;
  const source = text.replace(/^﻿/u, '');
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') ((field += '"'), i++);
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') (record.push(field), (field = ''));
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i++;
      (record.push(field), records.push(record), (record = []), (field = ''));
    } else field += ch;
  }
  if (field || record.length) (record.push(field), records.push(record));
  const [header, ...rows] = records.filter((r) => r.some((value) => value.trim()));
  return rows.map((row) =>
    Object.fromEntries(
      (header ?? []).map((name, index) => [name.split(' ')[0]!, row[index] ?? '']),
    ),
  );
}

type Json = Record<string, unknown>;
type Change = { id: string; from: string; to: string };

/** The authored line a sheet row points at, and the unit whose content repeats it. */
function locate(data: Json, id: string): { unit: string; text: string } | null {
  const units = data.units as Json[];
  const lessons = data.lessons as Json[];
  const [scope, kind, key] = id.split(':');
  if (kind === 'example') {
    const lesson = lessons.find((item) => item.id === scope);
    const phase = (lesson?.teacher_script as Json[] | undefined)?.find(
      (item) => item.phase === 'teach_target' && item.target_en === key,
    );
    return typeof phase?.example_en === 'string'
      ? { unit: String(lesson!.unit), text: phase.example_en }
      : null;
  }
  const unit = units.find((item) => item.id === scope);
  if (!unit) return null;
  if (kind === 'passage') return { unit: scope!, text: String(unit.passage_en) };
  if (kind === 'dialogue') {
    const line = (unit.dialogue as Json[])[Number(key) - 1];
    return line ? { unit: scope!, text: String(line.text_en) } : null;
  }
  return null;
}

/** Replace a whole string, or a long line where it is quoted inside a longer string. */
function replaceIn(node: unknown, from: string, to: string): [unknown, number] {
  if (typeof node === 'string') {
    if (node === from) return [to, 1];
    if (from.length >= 20 && node.includes(from)) return [node.split(from).join(to), 1];
    return [node, 0];
  }
  if (Array.isArray(node)) {
    let total = 0;
    const out = node.map((item) => {
      const [value, n] = replaceIn(item, from, to);
      total += n;
      return value;
    });
    return [out, total];
  }
  if (node && typeof node === 'object') {
    let total = 0;
    const out = Object.fromEntries(
      Object.entries(node).map(([key, item]) => {
        const [value, n] = replaceIn(item, from, to);
        total += n;
        return [key, value];
      }),
    );
    return [out, total];
  }
  return [node, 0];
}

/**
 * texts: curriculum.json first, then introduction-update.json (which overrides P01 and
 * A101). Returns the new file texts; formatting is kept except for the changed strings.
 */
export function applyReview(rows: ReviewRow[], texts: string[]) {
  const data = texts.map((text) => JSON.parse(text) as Json);
  const changes: Change[] = [];
  const problems: string[] = [];
  for (const row of rows) {
    if (!/^fix/iu.test(row.verdict?.trim() ?? '')) continue;
    const id = row.id ?? '';
    let suggestion = (row.suggested_english ?? '').trim();
    if (!suggestion) {
      problems.push(`${id}: marked fix without suggested_english`);
      continue;
    }
    const found = data.map((d) => locate(d, id));
    // introduction-update.json overrides its units, so the last file that has the line wins.
    const original = [...found].reverse().find(Boolean);
    if (!original) {
      problems.push(`${id}: not found in the current content`);
      continue;
    }
    // Dialogue rows show "Speaker: line"; reviewers may keep that prefix.
    if (id.includes(':dialogue:')) suggestion = suggestion.replace(/^[^:]{1,30}:\s+/u, '');
    if (original.text.includes('{{teacherName}}'))
      suggestion = suggestion.replace(/\bRachel\b/gu, '{{teacherName}}');
    if (suggestion === original.text) continue;
    let total = 0;
    data.forEach((d, index) => {
      if (!found[index] && !(d.units as Json[]).some((u) => u.id === original.unit)) return;
      for (const key of ['units', 'lessons'] as const)
        d[key] = (d[key] as Json[]).map((item) => {
          const unitId = key === 'units' ? item.id : item.unit;
          if (unitId !== original.unit) return item;
          const [value, n] = replaceIn(item, original.text, suggestion);
          total += n;
          return value as Json;
        });
    });
    if (!total) problems.push(`${id}: the line was not found where it is used`);
    else changes.push({ id, from: original.text, to: suggestion });
  }
  return {
    changes,
    problems,
    texts: texts.map((text, index) => (changes.length ? reformat(text, data[index]!) : text)),
  };
}

// curriculum.json is plain 2-space JSON; introduction-update.json keeps short arrays on one
// line, so there the changed strings are swapped in the original text instead.
function reformat(text: string, value: Json) {
  const ending = text.endsWith('\n') ? '\n' : '';
  const plain = JSON.stringify(JSON.parse(text), null, 2) + ending;
  if (plain === text) return JSON.stringify(value, null, 2) + ending;
  let out = text;
  const before = collect(JSON.parse(text)),
    after = collect(value);
  before.forEach((old, index) => {
    const next = after[index]!;
    if (old !== next) out = out.replace(JSON.stringify(old), JSON.stringify(next));
  });
  return out;
}
const collect = (node: unknown, out: string[] = []): string[] => {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) node.forEach((item) => collect(item, out));
  else if (node && typeof node === 'object')
    Object.values(node).forEach((item) => collect(item, out));
  return out;
};
