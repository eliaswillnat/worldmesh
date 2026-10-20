import type { Env } from '../auth';

export type AvatarProviderId = 'vroid' | 'atproto' | 'sketchfab';
export type AvatarFormat = 'vrm' | 'glb' | 'gltf';
/** What an upload is for: a character, or a building for the hub city (docs/specs/buildings.md). */
export type UploadKind = 'avatar' | 'building';

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
  /** Set by the user in "My characters"; wins over display_name. */
  custom_name: string | null;
  thumbnail_url: string | null;
  format: AvatarFormat;
  selected: number;
  metadata_json: string | null;
}

/** One model a provider lists that could stand in the hub city as a building. Always a GLB. */
export interface ProviderBuilding {
  id: string;
  name: string | null;
  thumbnail: string | null;
  /** Size of the GLB in bytes, where the platform says. */
  bytes: number | null;
  /** The model's public page, for credit. */
  sourceUrl: string | null;
}

/**
 * Where a saved building's file is right now (docs/specs/buildings.md §7.2):
 * the platform's own storage, which the visitor's browser downloads from.
 */
export interface BuildingFile {
  modelUrl: string;
  /** Unix ms when `modelUrl` stops working, or null if it does not expire. */
  expiresAt: number | null;
  /**
   * What the platform says the file is, to notice a replaced one before
   * anything is downloaded (§5.3): the blob CID on AT Protocol, the GLB's size
   * on Sketchfab. Null where the platform doesn't say.
   */
  version: string | null;
}

export interface BuildingRow {
  id: string;
  user_id: string;
  connection_id: string;
  provider: AvatarProviderId;
  external_id: string;
  display_name: string | null;
  custom_name: string | null;
  thumbnail_url: string | null;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
}

/** A building standing, or waiting to stand, on a world's block (docs/specs/buildings.md §5). */
export interface BuildingLinkRow {
  world_url: string;
  building_id: string;
  status: 'pending' | 'approved' | 'rejected' | 'hidden';
  sha256: string | null;
  version: string | null;
  portal_json: string | null;
  reason: string | null;
  checked_at: number;
  reviewed_at: number | null;
  reviewed_by: string | null;
  created_at: number;
  updated_at: number;
}

/** What a provider hands back once an account is verified. */
export interface NewConnection {
  providerAccountId: string;
  displayName: string | null;
  serviceEndpoint?: string | null;
  /** Provider credentials to keep (sealed before storage), or null to keep none. */
  credentials: unknown | null;
  /** Set when the user authorized an upload: handed to their browser, never stored. */
  uploadGrant?: UploadGrant;
}

/**
 * Short-lived permission for the user's browser to upload one avatar straight
 * to their own account. The model never passes through WorldMesh.
 */
export interface UploadGrant {
  provider: AvatarProviderId;
  /** What the browser may upload with it. */
  kind: UploadKind;
  /** Where the browser sends the model (the user's PDS). */
  service: string;
  /** The account the upload goes to (the DID). */
  account: string;
  accessToken: string;
  /** Kept server-side only (in the sealed grant cookie), so it can be revoked too. */
  refreshToken?: string | null;
  /** DPoP-bound tokens: the browser signs each request with this key. */
  dpopKey?: JsonWebKey;
  expiresAt: number;
  /** Where the grant is given back once the upload is done. */
  revocationEndpoint?: string | null;
  issuer?: string;
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
  /** Starts authorization: where to send the browser, and what the callback must see again. */
  connect(ctx: ProviderContext, input: { userId: string; handle?: string; upload?: UploadKind }): Promise<{ url: string; flow: OAuthFlow }>;
  /** Gives an upload grant back once the browser is done with it. Best effort. */
  revokeUpload?(ctx: ProviderContext, grant: UploadGrant): Promise<void>;
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
  /** How "My buildings" names this platform, where it can hold buildings at all. */
  readonly buildingLabel?: string;
  /** Models of this account that could stand as buildings (./buildings.ts). */
  listBuildings?(ctx: ProviderContext, connection: ConnectionRow): Promise<ProviderBuilding[]>;
  /** One of them, verified to belong to this account, or null. Used when saving. */
  getBuilding?(ctx: ProviderContext, connection: ConnectionRow, id: string): Promise<ProviderBuilding | null>;
  /** Where a saved building's file is now, or null once it is gone from the platform. */
  resolveBuilding?(ctx: ProviderContext, connection: ConnectionRow, building: BuildingRow): Promise<BuildingFile | null>;
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
