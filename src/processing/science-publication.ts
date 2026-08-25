/**
 * Science Digest 的出版物名称推断工具。
 * 仅使用已确认的 Nature URL 编码映射，避免把 subject feed 名称误当作实际期刊。
 */
export type SciencePublicationInferenceInput = {
  url: string | null;
  sourceName: string;
};

export type SciencePublicationInference = {
  publication: string | null;
  articleCode: string | null;
  reason: "known_nature_article_code" | "non_nature_source" | "unknown_nature_article_code" | "invalid_url";
};

const CONFIRMED_NATURE_PUBLICATION_BY_CODE: Record<string, string> = {
  s41598: "Scientific Reports",
  s41467: "Nature Communications",
};

export function inferSciencePublication(
  input: SciencePublicationInferenceInput,
): SciencePublicationInference {
  if (!isNatureSubjectFeed(input.sourceName)) {
    return {
      publication: null,
      articleCode: null,
      reason: "non_nature_source",
    };
  }

  const articleCode = extractNatureArticleCode(input.url);
  if (!articleCode) {
    return {
      publication: null,
      articleCode: null,
      reason: "invalid_url",
    };
  }

  const publication = CONFIRMED_NATURE_PUBLICATION_BY_CODE[articleCode] ?? null;
  return {
    publication,
    articleCode,
    reason: publication ? "known_nature_article_code" : "unknown_nature_article_code",
  };
}

export function extractNatureArticleCode(value: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const url = new URL(trimmed);
    if (!url.hostname.toLowerCase().endsWith("nature.com")) {
      return null;
    }

    const match = url.pathname.match(/^\/articles\/(s\d{5})-/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export function getConfirmedNaturePublicationMappings(): Record<string, string> {
  return { ...CONFIRMED_NATURE_PUBLICATION_BY_CODE };
}

function isNatureSubjectFeed(sourceName: string): boolean {
  return sourceName.trim().toLowerCase().startsWith("nature:");
}
