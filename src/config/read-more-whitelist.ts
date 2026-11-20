/** Sources allowed to fetch an article body only after a reader clicks Read More. */
export const READ_MORE_FETCH_SOURCES = [
  { sourceName: 'The Guardian 卫报', hostname: 'theguardian.com' },
  { sourceName: 'TechCrunch', hostname: 'techcrunch.com' },
  { sourceName: 'ScienceDaily: Science News', hostname: 'sciencedaily.com' },
  { sourceName: 'Inc.com', hostname: 'inc.com' }, // 每月3-5篇
  // { sourceName: 'The Associated Press', hostname: 'apnews.com' },
  // CNBC|BBC|Quanta Magazine|The Conversation
  // Axios：以“Smart Brevity（精炼简报）”风格著称的美国顶级政商与科技媒体。仅针对企业高管推出高价 Axios Pro 行业订阅。
] as const;
