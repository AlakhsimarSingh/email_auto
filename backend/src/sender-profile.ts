import { prisma } from './db.js';

// "About you" (Settings): a short, owner-written credibility statement used in every pitch.
// The agent may only use facts written here; numbers in it are allowed in drafts.

export const SENDER_PROFILE_KEY = 'sender_profile';
export type SenderProfile = { bio: string | null };

export function parseSenderProfile(value: unknown): SenderProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Profile must be an object');
  const raw = (value as { bio?: unknown }).bio;
  if (raw === null || raw === undefined || (typeof raw === 'string' && !raw.trim())) return { bio: null };
  if (typeof raw !== 'string') throw new Error('About you must be text');
  const bio = raw.replace(/\s+/g, ' ').trim();
  if (bio.length < 20 || bio.length > 450) throw new Error('Keep "About you" between 20 and 450 characters (two or three sentences).');
  if (/[\u0000-\u001f\u007f<>]/.test(bio)) throw new Error('"About you" cannot contain HTML or control characters.');
  // Links are added automatically from the portfolio settings, so they would only duplicate them.
  if (/https?:\/\/|www\.|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(bio)) throw new Error('Leave links and email addresses out; your portfolio links are added automatically.');
  return { bio };
}

export async function getSenderProfile(): Promise<SenderProfile> {
  const row = await prisma.appSetting.findUnique({ where: { key: SENDER_PROFILE_KEY }, select: { value: true } });
  if (!row) return { bio: null };
  try { return parseSenderProfile(row.value); } catch { return { bio: null }; }
}

export async function saveSenderProfile(profile: SenderProfile) {
  await prisma.appSetting.upsert({ where: { key: SENDER_PROFILE_KEY }, create: { key: SENDER_PROFILE_KEY, value: profile }, update: { value: profile } });
}
