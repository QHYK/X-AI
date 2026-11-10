/** Parser structure is independent of Stage 1 routing. The SQL callers all alias raw_articles as ra. */
export const NEWSLETTER_PROCESSABLE_SQL =
  "coalesce(ra.metadata->'newsletter'->>'content_type', '') <> 'non_content'";

/** The persisted Source method, not body length or URL, determines whether fetching is allowed. */
export const NON_EMAIL_SOURCE_SQL = "lower(btrim(s.collection_method)) <> 'email'";
