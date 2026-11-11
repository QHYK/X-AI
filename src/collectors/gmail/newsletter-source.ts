/** Source identity only; all content boundaries live in source-guided-selection.ts. */
export type NewsletterMail = {
  gmailMessageId: string;
  html: string | null;
  plainText?: string | null;
  from: { name?: string; address?: string }[];
  subject?: string | null;
  receivedAt?: string | null;
};
const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
export function newsletterSource(mail: NewsletterMail) {
  const name = clean(mail.from[0]?.name),
    address = mail.from[0]?.address?.toLowerCase() ?? '';
  if (address === 'dailybriefing@thomsonreuters.com')
    return /Essential/i.test(name + ' ' + mail.subject)
      ? 'Reuters One Essential Read'
      : 'Reuters Daily Briefing';
  if (address === 'info@theinformation.com') return 'The Information Briefing';
  if (address === 'hello@theinformation.com') return 'The Information AM';
  if (address === 'morningwire@apnews.com') return 'The Associated Press';
  if (address === 'superhuman@mail.joinsuperhuman.ai' || /^Superhuman/.test(name))
    return 'Superhuman';
  if (address === 'squad@thedailyupside.com') return 'The Daily Upside';
  return name || 'Unknown';
}
