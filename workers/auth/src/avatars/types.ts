import type { Env } from '../auth';

export type AvatarProviderId = 'vroid' | 'atproto' | 'sketchfab';
export type AvatarFormat = 'vrm' | 'glb' | 'gltf';

/**
 * What a world receives: enough to render one avatar, nothing about the
 * account behind it. `modelUrl` points at the provider's own storage.
 * The same shape is `AvatarDescriptor` in @worldmesh/runtime.
 */
export interface AvatarDescriptor {
  provider: AvatarProviderId;
  /** The provider's id for the avatar: a VRoid Hub model id, an at:// URI, or a Sketchfab model uid. */
  avatarId: string;
  name: string | null;
  thumbnail: string | null;
  format: AvatarFormat;
  modelUrl: string;
  /** When `modelUrl` stops working (ISO 8601), or null if it does not expire. */
  expiresAt: string | null;
  /** The avatar's public page, for credit where the license asks for it. */
  sourceUrl: string | null;
}

/** One avatar as a provider lists it. */
export interface ProviderAvatar {
  id: string;
  name: string | null;
  thumbnail: string | null;
  format: AvatarFormat;
  /** Small, non-secret details worth keeping with a selection (e.g. VRM version). */
  metadata?: Record<string, unknown>;
}

export interface ConnectionRow {
  id: string;
  user_id: string;
  provider: AvatarProviderId;
  provider_account_id: string;
  display_name: string | null;
  service_endpoint: string | null;
  token_enc: string | null;
  status: 'active' | 'reconnect';
  created_at: number;
  updated_at: number;
}

export interface AvatarRow {
  id: string;
  user_id: string;
  connection_id: string;
  provider: AvatarProviderId;
  external_avatar_id: string;
  display_name: string | null;
  thumbnail_url: string | null;
  format: AvatarFormat;
  selected: number;
  metadata_json: string | null;
}

/** What a provider hands back once an account is verified. */
export interface NewConnection {
  providerAccountId: string;
  displayName: string | null;
  serviceEndpoint?: string | null;
  /** Provider credentials to keep (sealed before storage), or null to keep none. */
  credentials: unknown | null;
  /**
   * Write access for one upload from the visitor's device, when that is what
   * was authorized. Never stored: it rides in a short-lived sealed cookie and
   * is revoked once the upload is done.
   */
  uploadGrant?: unknown;
}

/** State that must survive the round trip through the provider's authorization page. */
export interface OAuthFlow {
  provider: AvatarProviderId;
  userId: string;
  state: string;
  verifier: string;
  /** Unix ms. */
  expiresAt: number;
  /** Provider-specific extras (AT Protocol: issuer, DPoP key, expected DID…). */
  extra?: Record<string, unknown>;
}

export interface ProviderContext {
  env: Env;
  /** Public origin of the hub, e.g. https://worldmesh.net. */
  origin: string;
  /** Where the provider sends the browser back to. */
  redirectUri: string;
  /** Persists refreshed credentials, or marks the connection for reconnecting (null). */
  saveCredentials(connection: ConnectionRow, credentials: unknown | null): Promise<void>;
  /** Decrypts a connection's stored credentials. */
  credentials<T>(connection: ConnectionRow): Promise<T | null>;
  /** Work that may finish after the response (e.g. revoking a token). */
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * A source of externally hosted avatars. Adding a provider means implementing
 * this and listing it in `PROVIDERS`; routes, storage, the wallet UI and the
 * runtime never change.
 */
export interface AvatarProvider {
  readonly id: AvatarProviderId;
  readonly label: string;
  /** Whether the Worker has what this provider needs (client credentials…). */
  isConfigured(env: Env): boolean;
  /**
   * Starts authorization: where to send the browser, and what the callback must see again.
   * `upload` asks for the extra permission `uploads` needs.
   */
  connect(ctx: ProviderContext, input: { userId: string; handle?: string; upload?: boolean }): Promise<{ url: string; flow: OAuthFlow }>;
  /** Finishes authorization at the callback. Throws AvatarError when it cannot be verified. */
  completeConnect(ctx: ProviderContext, params: URLSearchParams, flow: OAuthFlow): Promise<NewConnection>;
  /** Best-effort revocation at the provider before the connection is deleted. */
  disconnect(ctx: ProviderContext, connection: ConnectionRow): Promise<void>;
  listAvatars(ctx: ProviderContext, connection: ConnectionRow): Promise<ProviderAvatar[]>;
  /** One avatar, verified to belong to this account, or null. Used when selecting. */
  getAvatar(ctx: ProviderContext, connection: ConnectionRow, avatarId: string): Promise<ProviderAvatar | null>;
  /** A fresh descriptor pointing at the provider's copy of the model. */
  resolveAvatar(ctx: ProviderContext, connection: ConnectionRow, avatar: AvatarRow): Promise<AvatarDescriptor>;
  /** Renews stored credentials if they are about to expire, and returns the usable ones. */
  refreshAuth(ctx: ProviderContext, connection: ConnectionRow): Promise<unknown | null>;
  /** Present when visitors can add a model from their device to their own account here. */
  readonly uploads?: AvatarUploads;
}

/** A model file from the visitor's device, already sent to the provider by their browser. */
export interface UploadedModel {
  name: string | null;
  /** What the file is, from its contents (checked in the browser). */
  format: 'vrm' | 'glb';
  vrmVersion: '0.x' | '1.0' | null;
  /** The provider's reference to the uploaded file, as it answered the browser. */
  file: unknown;
}

/** Where and how the visitor's browser sends the file. The bytes never pass through WorldMesh. */
export interface UploadTarget {
  url: string;
  /** Sent as `Authorization: DPoP <token>`. */
  accessToken: string;
  /** The private key the token is bound to; the browser signs DPoP proofs with it. */
  dpopKey: JsonWebKey;
}

/**
 * Uploads from the visitor's device into their own account at the provider,
 * under a grant from `completeConnect` that is used once and then revoked.
 */
export interface AvatarUploads {
  target(grant: unknown): UploadTarget | null;
  /** Turns the uploaded file into an avatar in the account, and returns it as `listAvatars` would. */
  createAvatar(ctx: ProviderContext, connection: ConnectionRow, grant: unknown, model: UploadedModel): Promise<ProviderAvatar>;
  /** Which account the grant is for (to match it with the connection). */
  account(grant: unknown): string | null;
  /** Best-effort revocation of the grant. */
  end(ctx: ProviderContext, grant: unknown): Promise<void>;
}

/** An error whose message is safe to show the user. */
export class AvatarError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    /** The provider refused our credentials: the user has to connect again. */
    readonly reconnect = false,
  ) {
    super(message);
  }
}
