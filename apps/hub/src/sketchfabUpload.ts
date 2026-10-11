/**
 * Uploads a GLB (or VRM, which is a GLB) straight from the browser to the
 * user's Sketchfab account, as a draft. WorldMesh only hands over a
 * short-lived grant for this one upload (revoked afterwards); the file never
 * passes through WorldMesh. Sketchfab answers CORS for api.sketchfab.com.
 */
import type { UploadGrant } from './at3dUpload';

/** Uploads the model and returns its Sketchfab uid. It appears in listings once processed. */
export async function uploadToSketchfab(grant: UploadGrant, file: File, name: string): Promise<string> {
  const form = new FormData();
  // Sketchfab picks the importer by extension; a VRM is a GLB.
  form.append('modelFile', file, `${file.name.replace(/\.(vrm|glb)$/i, '') || 'character'}.glb`);
  form.append('name', name);
  // A draft: only the owner sees it until they publish it on Sketchfab.
  form.append('isPublished', 'false');
  form.append('source', 'worldmesh');
  const response = await fetch(new URL('/v3/models', grant.service).toString(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${grant.accessToken}` },
    body: form,
    credentials: 'omit',
  });
  const data = (await response.json().catch(() => ({}))) as { uid?: unknown; detail?: unknown };
  if (response.status === 401 || response.status === 403) throw new Error('Sketchfab refused the upload permission. Start the upload again.');
  if (response.status === 413) throw new Error('The model is too large for your Sketchfab plan.');
  if (!response.ok || typeof data.uid !== 'string') {
    throw new Error(typeof data.detail === 'string' ? `Sketchfab did not accept the model (${data.detail}).` : 'Sketchfab did not accept the model.');
  }
  return data.uid;
}
