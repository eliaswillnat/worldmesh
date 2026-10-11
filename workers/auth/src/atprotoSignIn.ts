/**
 * Sign in with ATProto: log in with your own AT Protocol identity (a Bluesky
 * handle, or any handle on any PDS), no WorldMesh password and no big-company
 * account in between.
 *
 *   POST /api/auth/sign-in/atproto  { handle, callbackURL? }  → { url }
 *   GET  /api/auth/atproto/callback ?code&state&iss            → session, redirect
 *
 * The authorization itself (PAR, PKCE, DPoP, issuer and account checks) is the
 * one the Avatar Wallet already uses (avatars/atproto.ts), under the same
 * client id. As there, it only proves who someone is: the tokens are handed
 * back at once. The account is the DID, so it survives handle changes and
 * moving to another PDS.
 *
 * Who it signs in, in order: whoever already signed in with this DID; else
 * the one WorldMesh user who connected this DID in their Avatar Wallet (they
 * proved control of it while signed in); else a new user. A new user has no
 * email, so Better Auth's required, unique email column gets a placeholder
 * under the reserved .invalid domain, which nobody can sign up with.
 */
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint, createAuthMiddleware } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import {
  atprotoProfile,
  beginAtprotoAuth,
  finishAtprotoAuth,
  revokeAtprotoTokens,
  type AtprotoAuthFlow,
} from './avatars/atproto';
import { AvatarError } from './avatars/types';
import { UnsafeUrlError } from './avatars/net';

export const ATPROTO_PROVIDER_ID = 'atproto';
export const ATPROTO_SIGN_IN_PATH = '/sign-in/atproto';
export const ATPROTO_CALLBACK_PATH = '/atproto/callback';
/** Placeholder emails for accounts that only have a DID. RFC 2606: never resolves, never delivers. */
const PLACEHOLDER_DOMAIN = 'atproto.invalid';
const FLOW_COOKIE = 'atproto_flow';
const FLOW_SECONDS = 600;

interface SignInFlow {
  state: string;
  verifier: string;
  callbackURL: string;
  expiresAt: number;
  auth: AtprotoAuthFlow;
}

export function isPlaceholderEmail(email: unknown): boolean {
  return typeof email === 'string' && email.trim().toLowerCase().endsWith(`@${PLACEHOLDER_DOMAIN}`);
}

function placeholderEmail(did: string): string {
  return `${did.toLowerCase().replace(/[^a-z0-9.-]/g, '-')}@${PLACEHOLDER_DOMAIN}`;
}

/** Only paths on the hub itself: never another origin (open redirect). */
function safeCallback(value: unknown): string {
  return typeof value === 'string' && /^\/(?![/\\])/.test(value) && value.length <= 512 ? value : '/';
}

export function atprotoSignIn(options: { db: D1Database }) {
  return {
    id: 'atproto-sign-in',
    hooks: {
      before: [
        {
          // The placeholder domain is ours alone: refuse it everywhere a person types an email.
          matcher: (ctx) => ctx.path === '/sign-up/email' || ctx.path === '/change-email',
          handler: createAuthMiddleware(async (ctx) => {
            const body = ctx.body as { email?: unknown; newEmail?: unknown } | undefined;
            if (isPlaceholderEmail(body?.email) || isPlaceholderEmail(body?.newEmail)) {
              throw new APIError('BAD_REQUEST', { message: 'Use a real email address.' });
            }
          }),
        },
      ],
    },
    endpoints: {
      signInAtproto: createAuthEndpoint(
        ATPROTO_SIGN_IN_PATH,
        { method: 'POST', requireHeaders: true },
        async (ctx) => {
          const body = (ctx.body ?? {}) as { handle?: unknown; callbackURL?: unknown };
          if (typeof body.handle !== 'string' || !body.handle.trim() || body.handle.length > 300) {
            throw new APIError('BAD_REQUEST', { message: 'Enter your handle, like alice.bsky.social.' });
          }
          const origin = new URL(ctx.context.baseURL).origin;
          let begun: Awaited<ReturnType<typeof beginAtprotoAuth>>;
          try {
            begun = await beginAtprotoAuth(origin, callbackUri(origin), body.handle, 'atproto');
          } catch (error) {
            throw asApiError(error);
          }
          const flow: SignInFlow = {
            state: begun.state,
            verifier: begun.verifier,
            callbackURL: safeCallback(body.callbackURL),
            expiresAt: Date.now() + FLOW_SECONDS * 1000,
            auth: begun.flow,
          };
          const cookie = ctx.context.createAuthCookie(FLOW_COOKIE, { maxAge: FLOW_SECONDS });
          // Encrypted: it carries the DPoP private key until the callback.
          ctx.setCookie(cookie.name, await symmetricEncrypt({ key: ctx.context.secret, data: JSON.stringify(flow) }), cookie.attributes);
          return ctx.json({ url: begun.url });
        },
      ),

      atprotoCallback: createAuthEndpoint(ATPROTO_CALLBACK_PATH, { method: 'GET' }, async (ctx) => {
        const origin = new URL(ctx.context.baseURL).origin;
        const fail = (reason: string) => {
          ctx.context.logger.warn(`ATProto sign-in failed: ${reason}`);
          return ctx.redirect(`${origin}/?auth=error`);
        };
        const cookie = ctx.context.createAuthCookie(FLOW_COOKIE, { maxAge: 0 });
        const sealed = ctx.getCookie(cookie.name);
        ctx.setCookie(cookie.name, '', cookie.attributes);
        let flow: SignInFlow | null = null;
        try {
          flow = sealed ? (JSON.parse(await symmetricDecrypt({ key: ctx.context.secret, data: sealed })) as SignInFlow) : null;
        } catch {
          flow = null;
        }
        const params = new URL(ctx.request?.url ?? `${origin}/`).searchParams;
        if (!flow || flow.expiresAt < Date.now() || !params.get('state') || params.get('state') !== flow.state) {
          throw fail('no matching sign-in in this browser');
        }
        if (params.get('error')) throw fail(`denied (${params.get('error')})`);

        const redirectUri = callbackUri(origin);
        let finished: Awaited<ReturnType<typeof finishAtprotoAuth>>;
        try {
          finished = await finishAtprotoAuth(origin, redirectUri, flow.auth, flow.verifier, params);
        } catch (error) {
          throw fail(error instanceof Error ? error.message : 'token exchange failed');
        }
        const done = revokeAtprotoTokens(origin, redirectUri, flow.auth, finished.nonce, finished.body).catch(() => undefined);
        await ctx.context.runInBackgroundOrAwait(done);

        const did = flow.auth.did;
        const adapter = ctx.context.internalAdapter;
        let isNew = false;
        const known = await adapter.findAccountOwnerByKey({ providerId: ATPROTO_PROVIDER_ID, accountId: did });
        // An account row whose user is gone: clear it, so the DID can belong to someone again.
        if (known?.kind === 'orphaned') await adapter.deleteAccount(known.account.id);
        let user = known?.kind === 'owned' ? known.user : null;
        if (!user) {
          const owner = await walletOwner(options.db, did);
          const existing = owner ? await adapter.findUserById(owner) : null;
          if (existing) {
            await adapter.linkAccount({ userId: existing.id, providerId: ATPROTO_PROVIDER_ID, accountId: did });
            user = existing;
          }
        }
        if (!user) {
          const profile = await atprotoProfile(flow.auth.pds, did, new URL(origin).host).catch(() => null);
          const created = await adapter.createOAuthUser(
            {
              name: profile?.displayName || flow.auth.handle,
              email: placeholderEmail(did),
              emailVerified: false,
              image: profile?.avatar ?? null,
            },
            { providerId: ATPROTO_PROVIDER_ID, accountId: did },
          );
          user = created.user;
          isNew = true;
        }

        const session = await adapter.createSession(user.id);
        if (!session) throw fail('could not create a session');
        await setSessionCookie(ctx, { session, user });
        throw ctx.redirect(`${origin}${isNew ? '/?auth=new' : flow.callbackURL}`);
      }),
    },
    rateLimit: [
      { pathMatcher: (path) => path === ATPROTO_SIGN_IN_PATH, window: 60, max: 10 },
      { pathMatcher: (path) => path === ATPROTO_CALLBACK_PATH, window: 60, max: 20 },
    ],
  } satisfies BetterAuthPlugin;
}

export function callbackUri(origin: string): string {
  return `${origin}/api/auth${ATPROTO_CALLBACK_PATH}`;
}

/** The single WorldMesh user who connected this DID in their Avatar Wallet, if exactly one did. */
async function walletOwner(db: D1Database, did: string): Promise<string | null> {
  const { results } = await db
    .prepare("select distinct user_id from avatar_connection where provider = 'atproto' and provider_account_id = ?1 limit 2")
    .bind(did)
    .all<{ user_id: string }>();
  return results.length === 1 ? results[0].user_id : null;
}

function asApiError(error: unknown): APIError {
  if (error instanceof APIError) return error;
  if (error instanceof AvatarError) return new APIError(error.status >= 500 ? 'BAD_GATEWAY' : 'BAD_REQUEST', { message: error.message });
  if (error instanceof UnsafeUrlError) return new APIError('BAD_REQUEST', { message: 'That handle points somewhere WorldMesh will not go.' });
  return new APIError('BAD_GATEWAY', { message: 'Could not reach your AT Protocol server. Try again.' });
}
