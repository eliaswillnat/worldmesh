/**
 * Emails about buildings on worlds (docs/specs/buildings.md §5.2, §8), sent
 * through Resend where the Worker has RESEND_API_KEY and AUTH_FROM_EMAIL,
 * and quietly skipped where it doesn't:
 *
 *   reviewers   a building waits for review (linked, or its file changed), or was first reported
 *   the owner   sent for review, approved, not approved, taken down, or back in review
 *
 * An owner who is also a reviewer gets the reviewer's email only, and nobody
 * is told about a decision they made themselves.
 */
import type { Env } from '../auth';
import { isPlaceholderEmail } from '../atprotoSignIn';
import { mailConfigured, sendMail } from '../mail';
import * as store from './store';

/** The accounts that review buildings: ADMIN_EMAILS, lower-cased. */
export function reviewerEmails(env: Env): string[] {
  return (env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

const reviewUrl = (origin: string, world: string) => `${origin}/review-building?world=${encodeURIComponent(world)}`;

/** The link, its building and owner, when email can be sent at all. */
async function linkFor(env: Env, world: string, buildingId: string): Promise<store.ReviewRow | null> {
  if (!mailConfigured(env)) return null;
  const row = await store.reviewLink(env.DB, world);
  return row?.id === buildingId ? row : null;
}

const nameOf = (row: store.ReviewRow, fallback: string) => row.custom_name ?? row.display_name ?? fallback;

async function toReviewers(env: Env, subject: string, intro: string, url: string): Promise<void> {
  for (const to of reviewerEmails(env)) await sendMail(env, to, subject, intro, 'Review it', url, null);
}

/** A building waits for review: newly linked to a world, or back because its file changed. */
export async function reviewersWaiting(env: Env, origin: string, world: string, buildingId: string, why: 'linked' | 'changed'): Promise<void> {
  const row = await linkFor(env, world, buildingId);
  if (!row) return;
  const owner = row.owner_username ? `@${row.owner_username}` : (row.owner_name ?? 'Someone');
  const intro =
    why === 'linked'
      ? `${owner} wants ${nameOf(row, 'their building')} to stand on ${world} in the hub city.`
      : `The file of ${nameOf(row, 'a building')}, standing on ${world}, changed after it was approved. It is off the city until it is reviewed again.`;
  await toReviewers(env, 'A building is waiting for review', intro, reviewUrl(origin, world));
}

/** A standing building got its first open report. */
export async function reviewersReported(env: Env, origin: string, world: string, buildingId: string, reason: string): Promise<void> {
  const row = await linkFor(env, world, buildingId);
  if (!row) return;
  const intro = `${nameOf(row, 'A building')}, standing on ${world} in the hub city, was reported as ${reason}.`;
  await toReviewers(env, 'A building in the city was reported', intro, reviewUrl(origin, world));
}

export type OwnerNews = 'submitted' | 'approved' | 'rejected' | 'hidden' | 'changed';

/**
 * Tells a building's owner what happened to it on `world`. `actor` is the
 * reviewer who did it, never told about their own decision.
 */
export async function tellOwner(env: Env, origin: string, world: string, buildingId: string, news: OwnerNews, reason: string | null, actor?: string): Promise<void> {
  const row = await linkFor(env, world, buildingId);
  const email = row?.owner_email?.toLowerCase();
  const verified = row?.owner_email_verified === 1 || row?.owner_email_verified === true;
  if (!row || !email || !verified || isPlaceholderEmail(email) || email === actor) return;
  // Reviewers already hear about what waits for review.
  if ((news === 'submitted' || news === 'changed') && reviewerEmails(env).includes(email)) return;
  const name = nameOf(row, 'Your building');
  const [subject, intro, action, url] = (
    {
      submitted: ['Your building was sent for review', `${name} will stand on ${world} in the hub city once a person has looked at it, usually within a day or two.`, 'Open WorldMesh', `${origin}/`],
      approved: ['Your building stands in the city', `${name} was approved, and now stands on ${world} in the hub city.`, 'Walk to it', `${origin}/`],
      rejected: ['Your building was not approved', `${name} was not approved for ${world}: ${reason} You can fix it and link it again from My buildings.`, 'Open WorldMesh', `${origin}/`],
      hidden: ['Your building was taken down', `${name} was taken down from ${world} in the hub city: ${reason}`, 'Open WorldMesh', `${origin}/`],
      changed: ['Your building is being reviewed again', `The file of ${name} changed after it was approved, so it is off ${world} until a person has looked at it again.`, 'Open WorldMesh', `${origin}/`],
    } satisfies Record<OwnerNews, [string, string, string, string]>
  )[news];
  await sendMail(env, row.owner_email!, subject, intro, action, url, null);
}
