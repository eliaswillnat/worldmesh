/**
 * WorldMesh usernames double as fediverse handles (@name@worldmesh.net), so
 * they follow the strictest common denominator: lowercase ASCII letters,
 * digits and underscores, starting with a letter. That is a subset of what
 * Mastodon accepts for remote accounts, and it can never collide with a path
 * segment, a dot-file or an IDN lookalike.
 */
export const USERNAME_PATTERN = /^[a-z][a-z0-9_]{2,29}$/;

/** Names that would impersonate the service or collide with routes and system mailboxes. */
const RESERVED = new Set([
  'about', 'abuse', 'account', 'accounts', 'activitypub', 'actor', 'actors', 'admin',
  'administrator', 'anonymous', 'api', 'app', 'apps', 'assets', 'auth', 'billing',
  'blog', 'bot', 'cdn', 'contact', 'dashboard', 'dev', 'docs', 'email', 'everyone',
  'explore', 'feed', 'followers', 'following', 'help', 'home', 'hostmaster', 'hub',
  'inbox', 'info', 'instance', 'legal', 'login', 'logout', 'mail', 'mailer_daemon',
  'me', 'mod', 'moderator', 'moderators', 'news', 'nobody', 'noreply', 'no_reply',
  'nodeinfo', 'null', 'official', 'outbox', 'owner', 'postmaster', 'press', 'privacy',
  'profile', 'register', 'relay', 'root', 'security', 'settings', 'shared_inbox',
  'signin', 'signout', 'signup', 'staff', 'static', 'status', 'support', 'system',
  'team', 'terms', 'test', 'undefined', 'user', 'users', 'webfinger', 'webmaster',
  'well_known', 'world', 'worldmesh', 'worlds', 'www',
]);

export type UsernameCheck = { ok: true; username: string } | { ok: false; error: string };

export function checkUsername(input: unknown): UsernameCheck {
  if (typeof input !== 'string') return { ok: false, error: 'Choose a username.' };
  const username = input.trim().replace(/^@/, '').toLowerCase();
  if (!USERNAME_PATTERN.test(username)) {
    return {
      ok: false,
      error: 'Use 3–30 characters: letters, numbers and underscores, starting with a letter.',
    };
  }
  if (RESERVED.has(username) || username.startsWith('worldmesh')) {
    return { ok: false, error: 'That username is reserved.' };
  }
  return { ok: true, username };
}
