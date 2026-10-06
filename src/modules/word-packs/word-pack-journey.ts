/** Entry into supported teaching is separate from independent mastery. */
export type WordPackStation = 'supported' | 'midpoint' | 'review';
export function wordPackJourney(total: number, introduced: number) {
  return (
    [
      { station: 'supported', requiredWords: Math.min(10, total), durationMinutes: 5 },
      { station: 'midpoint', requiredWords: Math.ceil(total / 2), durationMinutes: 5 },
      { station: 'review', requiredWords: total, durationMinutes: 10 },
    ] as const
  ).map((step) => ({ ...step, available: total > 0 && introduced >= step.requiredWords }));
}
