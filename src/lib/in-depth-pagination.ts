import { z } from 'zod';

export const IN_DEPTH_PAGE_SIZE = 10;
// Old cursors used discovery_candidates timestamps/IDs and cannot continue this ordering.
const CURSOR_PREFIX = 'idc1.';
const CursorSchema = z
  .object({
    createdAt: z.iso.datetime({ precision: 6 }),
    id: z.uuid(),
  })
  .strict();
export type InDepthCursor = z.infer<typeof CursorSchema>;

export function decodeInDepthCursor(value: string | null): InDepthCursor | null {
  if (value === null) return null;
  try {
    if (!value.startsWith(CURSOR_PREFIX) || value.length > 512) throw new Error();
    const encoded = value.slice(CURSOR_PREFIX.length);
    if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error();
    const raw = Buffer.from(encoded, 'base64url');
    if (raw.toString('base64url') !== encoded) throw new Error();
    return CursorSchema.parse(JSON.parse(raw.toString('utf8')));
  } catch {
    throw new Error('Invalid In-depth cursor.');
  }
}

export function encodeInDepthCursor(value: InDepthCursor): string {
  return (
    CURSOR_PREFIX + Buffer.from(JSON.stringify(CursorSchema.parse(value))).toString('base64url')
  );
}
