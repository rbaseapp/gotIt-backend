import { createHash } from 'node:crypto';
import { z } from 'zod';

export const unitStepSchema = z.enum([
  'supported:words',
  'supported:meeting',
  'supported:homework',
  'midpoint:words',
  'midpoint:meeting',
  'midpoint:homework',
  'review:words',
  'review:meeting',
  'review:homework',
]);
export type UnitStep = z.infer<typeof unitStepSchema>;
export type UnitPathChoices = {
  kind: 'unit_path';
  id: string;
  packId: string;
  revision: number;
  createdAt: string;
  skippedSteps: UnitStep[];
  unitSkipped?: boolean;
};
export const unitPathChoiceSchema = z
  .object({
    revision: z.number().int().min(-1),
    eventId: z.uuid(),
    skipped: z.boolean(),
    step: unitStepSchema.optional(),
  })
  .strict();

// A separate identity keeps catalog IDs out of the course/homework namespace.
export function unitPathDocumentId(packId: string) {
  const hash = createHash('sha256').update(`gotit:unit-path:${packId}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
export function emptyUnitPathChoices(packId: string): UnitPathChoices {
  return {
    kind: 'unit_path',
    id: unitPathDocumentId(packId),
    packId,
    revision: -1,
    createdAt: new Date().toISOString(),
    skippedSteps: [],
    unitSkipped: false,
  };
}
