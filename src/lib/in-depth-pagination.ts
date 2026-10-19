import { z } from 'zod';

export const IN_DEPTH_PAGE_SIZE = 10;
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
    if (!value || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const raw = Buffer.from(value, 'base64url');
    if (raw.toString('base64url') !== value) throw new Error();
    return CursorSchema.parse(JSON.parse(raw.toString('utf8')));
  } catch {
    throw new Error('Invalid In-depth cursor.');
  }
}

export function encodeInDepthCursor(value: InDepthCursor): string {
  return Buffer.from(JSON.stringify(CursorSchema.parse(value))).toString('base64url');
}
