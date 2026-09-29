-- Better Auth core tables (user, session, account, verification).
--
-- Generated from better-auth 1.7.6 `getMigrations()` against D1 with the
-- options in workers/auth/src/auth.ts, then hand-extended with the indexes
-- marked "WorldMesh". Better Auth owns these tables: keep column names as they
-- are, and regenerate if its schema changes on upgrade.

create table "user" (
  "id" text not null primary key,
  "name" text not null,
  "email" text not null unique,
  "emailVerified" integer not null,
  "image" text,
  "createdAt" date not null,
  "updatedAt" date not null,
  -- WorldMesh: the public handle (@username@worldmesh.net). Lowercase, set
  -- once by POST /api/account/username, never by the OAuth profile.
  "username" text unique
);

create table "session" (
  "id" text not null primary key,
  "expiresAt" date not null,
  "token" text not null unique,
  "createdAt" date not null,
  "updatedAt" date not null,
  "ipAddress" text,
  "userAgent" text,
  "userId" text not null references "user" ("id") on delete cascade
);

-- One row per OAuth identity (Google, GitHub) linked to a user.
create table "account" (
  "id" text not null primary key,
  "accountId" text not null,
  "providerId" text not null,
  "userId" text not null references "user" ("id") on delete cascade,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" date,
  "refreshTokenExpiresAt" date,
  "scope" text,
  "password" text,
  "createdAt" date not null,
  "updatedAt" date not null
);

create table "verification" (
  "id" text not null primary key,
  "identifier" text not null,
  "value" text not null,
  "expiresAt" date not null,
  "createdAt" date not null,
  "updatedAt" date not null
);

create index "session_userId_idx" on "session" ("userId");
create index "account_userId_idx" on "account" ("userId");
create index "verification_identifier_idx" on "verification" ("identifier");

-- WorldMesh: every sign-in looks an identity up by (provider, provider's id);
-- this makes that an index lookup and makes a double link impossible.
create unique index "account_provider_account_uq" on "account" ("providerId", "accountId");
