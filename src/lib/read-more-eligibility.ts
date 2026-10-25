/** Shared Read More eligibility; no model, database connection or Prompt dependency. */
export const READ_MORE_CONTENT_TEXT_MIN_LENGTH = 3_000;

export type ReadMoreContent = { fullContentText: string | null; contentText: string | null };

/** Unicode code points, matching PostgreSQL char_length(), rather than UTF-16 code units. */
/** Matches PostgreSQL char_length() for trimmed Unicode text. */
export function readMoreTextLength(text: string): number {
  return Array.from(text).length;
}

/** Returns the server-side source text permitted for Read More, if any. */
export function selectReadMoreSourceText(row: ReadMoreContent): string | null {
  const fullContentText = row.fullContentText?.trim();
  if (fullContentText) return fullContentText;
  const contentText = row.contentText?.trim();
  return contentText && readMoreTextLength(contentText) >= READ_MORE_CONTENT_TEXT_MIN_LENGTH
    ? contentText
    : null;
}

// ECMAScript trim() WhiteSpace + LineTerminator code points. PostgreSQL's default btrim
// removes only U+0020; use an explicit set so whitespace-only full text/cache cannot enable a button.
const TRIM_CHARACTERS =
  '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
const SQL_TRIM_CHARACTERS = `U&'${Array.from(TRIM_CHARACTERS, (char) => `\\${char.codePointAt(0)!.toString(16).padStart(4, '0')}`).join('')}'`;

/** Trusted, fixed Brief query aliases only; never accepts client-supplied SQL. */
export function readMoreAvailabilitySql(): string {
  const clean = (column: string) => `btrim(coalesce(${column}, ''), ${SQL_TRIM_CHARACTERS})`;
  return `(
    ${clean('crm.summary_zh')} <> ''
    or ${clean('ra.full_content_text')} <> ''
    or char_length(${clean('ra.content_text')}) >= ${READ_MORE_CONTENT_TEXT_MIN_LENGTH}
  )`;
}
