/**
 * The hub's side of workers/ads, over plain same-origin fetch. The browser
 * only ever reads public billboard state and drives its own submission; every
 * status change happens on the server, from Stripe's word or the admin's.
 */

import type { AdMediaType } from './config';

export interface PublicAd {
  id: string;
  type: AdMediaType;
  mediaUrl: string;
  posterUrl: string | null;
  url: string;
  advertiser: string;
}

export interface BillboardState {
  id: string;
  state: 'active' | 'reserved';
  ad?: PublicAd;
}

export const ADS_API = '/api/ads';

export async function fetchBillboards(signal?: AbortSignal): Promise<BillboardState[]> {
  const response = await fetch(`${ADS_API}/billboards`, { signal, credentials: 'omit' });
  if (!response.ok) throw new Error(`billboards ${response.status}`);
  const data = (await response.json()) as { billboards?: BillboardState[] };
  return Array.isArray(data.billboards) ? data.billboards : [];
}

export interface CreatedSubmission {
  id: string;
  /** Proves to the server that later confirm/cancel calls come from this browser. */
  token: string;
  clientSecret: string;
  publishableKey: string;
  holdExpiresAt: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Multipart upload with progress; fetch cannot report upload progress. */
export function createSubmission(form: FormData, onProgress: (fraction: number) => void): Promise<CreatedSubmission> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${ADS_API}/submissions`);
    xhr.responseType = 'json';
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      const body = (xhr.response ?? {}) as Partial<CreatedSubmission> & { error?: string };
      if (xhr.status >= 200 && xhr.status < 300 && body.id && body.clientSecret) resolve(body as CreatedSubmission);
      else reject(new ApiError(xhr.status, body.error || 'The upload did not go through. Please try again.'));
    };
    xhr.onerror = () => reject(new ApiError(0, 'Network error while uploading. Check your connection and try again.'));
    xhr.send(form);
  });
}

export interface SubmissionStatus {
  status: string;
  message?: string;
}

export async function confirmSubmission(id: string, token: string): Promise<SubmissionStatus> {
  const response = await fetch(`${ADS_API}/submissions/${encodeURIComponent(id)}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const body = (await response.json().catch(() => ({}))) as SubmissionStatus & { error?: string };
  if (!response.ok) throw new ApiError(response.status, body.error || 'Could not confirm the payment.');
  return body;
}

/** Release the billboard: the advertiser closed the payment step. Survives page unload. */
export function cancelSubmission(id: string, token: string, unloading = false): void {
  const url = `${ADS_API}/submissions/${encodeURIComponent(id)}/cancel`;
  const body = JSON.stringify({ token });
  if (unloading && navigator.sendBeacon) {
    navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
    return;
  }
  void fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
}
