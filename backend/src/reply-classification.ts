export type ReplyClassification = 'human' | 'unsubscribe' | 'complaint' | 'bounce' | 'auto_reply';

export function classifyReply(
  from: string,
  subject: string,
  headers: Map<string, string>,
  body: string,
): ReplyClassification {
  const submitted = headers.get('auto-submitted')?.toLowerCase();
  const precedence = headers.get('precedence')?.toLowerCase();
  if ((submitted && submitted !== 'no') || ['bulk', 'list', 'junk'].includes(precedence ?? '') ||
      /\b(out of office|automatic reply|auto.?reply|vacation response)\b/i.test(subject)) return 'auto_reply';
  if (/mailer-daemon|postmaster/i.test(from) || /final-recipient:|action: failed|status: 5\.\d\.\d/i.test(body)) return 'bounce';
  if (/\b(unsubscribe|remove me|stop emailing|stop contacting|do not email|don't email)\b/i.test(body)) return 'unsubscribe';
  if (/\b(spam|report you|complaint|how did you get my email|abuse)\b/i.test(`${subject} ${body}`)) return 'complaint';
  return 'human';
}
