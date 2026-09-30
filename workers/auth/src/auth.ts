import { betterAuth } from 'better-auth';
import { appleClientSecret, appleConfigured, type AppleCredentials } from './apple';
import { mailConfigured, sendMail, type MailEnv } from './mail';
import { hashPassword, verifyPassword } from './password';

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env extends AppleCredentials, MailEnv {
  DB: D1Database;
  /** Public origin of the hub, e.g. https://worldmesh.net. OAuth callbacks live under it. */
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
  /** Domain used in public handles, @username@FEDERATION_DOMAIN. */
  FEDERATION_DOMAIN?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  AUTH_LIMITER?: RateLimiter;
}

export const AUTH_BASE_PATH = '/api/auth';

/** Apple posts its OAuth callback to us from this origin (response_mode=form_post). */
const APPLE_ORIGIN = 'https://appleid.apple.com';

/** What the login dialog can offer besides OAuth. */
export function passwordOptions(env: Env) {
  return { email: true, passwordReset: mailConfigured(env) };
}

export type ProviderId = 'google' | 'apple' | 'github' | 'discord';

/** The sign-in options to show, in display order: only those with credentials set. */
export function configuredProviders(env: Env): ProviderId[] {
  const all: [ProviderId, boolean][] = [
    ['google', !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)],
    ['apple', appleConfigured(env)],
    ['github', !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET)],
    ['discord', !!(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET)],
  ];
  return all.filter(([, on]) => on).map(([id]) => id);
}

const DAY = 60 * 60 * 24;

/** `appleSecret` is the minted client secret JWT, when Apple is configured (see getAuth). */
export function createAuth(env: Env, appleSecret?: string) {
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32) {
    throw new Error('BETTER_AUTH_SECRET must be set to at least 32 characters.');
  }
  const baseURL = new URL(env.BETTER_AUTH_URL);
  const origin = baseURL.origin;

  // With mail set up, a password account must prove its address before it can
  // sign in. That stops someone claiming another person's email ahead of them,
  // and lets Google/GitHub link to it later (linking needs a verified email).
  const mail = mailConfigured(env);

  const socialProviders: Parameters<typeof betterAuth>[0]['socialProviders'] = {};
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    socialProviders.google = {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      prompt: 'select_account',
    };
  }
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
    socialProviders.github = {
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
    };
  }
  if (env.APPLE_CLIENT_ID && appleSecret) {
    socialProviders.apple = {
      clientId: env.APPLE_CLIENT_ID,
      clientSecret: appleSecret,
    };
  }
  if (env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET) {
    socialProviders.discord = {
      clientId: env.DISCORD_CLIENT_ID,
      clientSecret: env.DISCORD_CLIENT_SECRET,
    };
  }

  return betterAuth({
    appName: 'WorldMesh',
    baseURL: origin,
    basePath: AUTH_BASE_PATH,
    secret: env.BETTER_AUTH_SECRET,
    // The D1 binding is detected and driven through D1's own API (batch() for atomicity).
    database: env.DB,
    // Apple's callback is a cross-site form POST, which Better Auth checks
    // against trusted origins before bouncing it to a same-site GET.
    trustedOrigins: appleSecret ? [origin, APPLE_ORIGIN] : [origin],
    socialProviders,
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      autoSignIn: true,
      requireEmailVerification: mail,
      revokeSessionsOnPasswordReset: true,
      password: { hash: hashPassword, verify: verifyPassword },
      ...(mail && {
        sendResetPassword: async ({ user, url }) => {
          await sendMail(env, user.email, 'Reset your WorldMesh password', 'Someone asked to reset the password for your WorldMesh account.', 'Choose a new password', url);
        },
      }),
    },
    ...(mail && {
      emailVerification: {
        sendOnSignUp: true,
        sendOnSignIn: true,
        autoSignInAfterVerification: true,
        sendVerificationEmail: async ({ user, url }) => {
          await sendMail(env, user.email, 'Confirm your WorldMesh email', 'Welcome to WorldMesh! Confirm your email to finish creating your account.', 'Confirm email', url);
        },
      },
    }),
    user: {
      additionalFields: {
        // Set only through POST /api/account/username; `input: false` keeps it
        // out of every Better Auth endpoint that accepts user fields.
        username: { type: 'string', required: false, input: false, unique: true },
      },
    },
    session: {
      expiresIn: 30 * DAY,
      // Slide the expiry at most once a day, so an active visitor never logs
      // out and a session costs at most one D1 write per day.
      updateAge: DAY,
      // A signed copy of the session in a cookie: most page loads verify it
      // with an HMAC and never touch D1.
      cookieCache: { enabled: true, maxAge: 5 * 60 },
    },
    account: {
      // Link Google and GitHub on the same verified email to one user. With no
      // trustedProviders, Better Auth links only when the provider says the
      // email is verified AND the existing user's email is verified.
      accountLinking: { enabled: true, allowDifferentEmails: false },
      // OAuth state and PKCE verifier live in an encrypted, short-lived cookie
      // bound to this browser, instead of a D1 row per sign-in attempt.
      storeStateStrategy: 'cookie',
      encryptOAuthTokens: true,
    },
    databaseHooks: {
      account: {
        // WorldMesh only needs to know who someone is. Provider tokens would be
        // a liability in the database, so they are never stored.
        create: { before: async (account) => ({ data: withoutProviderTokens(account) }) },
        update: { before: async (account) => ({ data: withoutProviderTokens(account) }) },
      },
    },
    rateLimit: {
      // Better Auth only enables this when NODE_ENV=production, which Workers never set.
      enabled: true,
      window: 60,
      max: 60,
      customRules: {
        '/sign-in/*': { window: 60, max: 10 },
        '/sign-up/*': { window: 60, max: 5 },
        '/request-password-reset': { window: 60, max: 3 },
        '/reset-password': { window: 60, max: 5 },
        '/send-verification-email': { window: 60, max: 3 },
        '/callback/*': { window: 60, max: 20 },
      },
    },
    advanced: {
      cookiePrefix: 'worldmesh',
      // __Secure- prefixed, Secure, HttpOnly, SameSite=Lax, host-only.
      useSecureCookies: baseURL.protocol === 'https:',
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
      // Pinned on: Better Auth defaults both off whenever NODE_ENV=test.
      disableOriginCheck: false,
      disableCSRFCheck: false,
    },
    onAPIError: { errorURL: `${origin}/?auth=error` },
    telemetry: { enabled: false },
  });
}

export type Auth = ReturnType<typeof createAuth>;

function withoutProviderTokens<T extends Record<string, unknown>>(account: T): T {
  return {
    ...account,
    accessToken: null,
    refreshToken: null,
    idToken: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
  };
}

/**
 * A fresh instance per request. Caching it per isolate looks cheaper, but
 * Better Auth starts async initialisation (D1 I/O) inside the first request,
 * and Workers never resolve I/O begun in one request for another: every later
 * request would hang.
 */
export async function getAuth(env: Env): Promise<Auth> {
  return createAuth(env, appleConfigured(env) ? await appleClientSecret(env) : undefined);
}
