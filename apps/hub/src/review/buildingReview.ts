/**
 * Reviewing worlds' buildings (docs/specs/buildings.md §5.2), at
 * /review-building. The admin dashboard lists them; here a reviewer's own
 * browser downloads the model straight from where it is hosted, checks it
 * the way the city does, shows it standing on its block with the portal face
 * marked, and hashes it. Approving pins that hash: visitors' browsers show
 * the building only if their download hashes the same. The file never
 * passes through WorldMesh.
 *
 * Reviewers only: workers/auth answers /api/account/building/review for
 * verified emails in ADMIN_EMAILS, and nobody else.
 */
import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  EdgesGeometry,
  Group,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
  Texture,
  WebGLRenderer,
  type Object3D,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { DOOR_OUT } from '../walk/avenuePlan';
import { planBuilding, type BuildingPlan } from '../walk/buildingFit';
import { BLOCK_LOT, checkWeight, countTriangles, downloadBuilding, parseBuilding, sha256Hex } from '../walk/buildingModel';

type Status = 'pending' | 'approved' | 'rejected' | 'hidden';

interface QueueEntry {
  world: string;
  status: Status;
  reason: string | null;
  buildingId: string;
  buildingName: string | null;
  provider: string;
  updatedAt: number;
  /** Open reports from visitors. */
  reports: number;
}

type ReportReason = 'offensive' | 'sexual' | 'violent' | 'copyright' | 'broken' | 'other';

interface Report {
  id: string;
  reason: ReportReason;
  note: string | null;
  /** About the file standing now, rather than one approved before it. */
  sameFile: boolean;
  createdAt: number;
  reporter: string;
}

interface Details {
  link: { world: string; status: Status; reason: string | null; sha256: string | null; version: string | null; createdAt: number; reviewedAt: number | null; reviewedBy: string | null };
  building: { id: string; name: string | null; provider: string; providerLabel: string; modelId: string; thumbnail: string | null; bytes: number | null; sourceUrl: string | null };
  owner: { name: string | null; email: string | null; username: string | null };
  reports: Report[];
  file: { modelUrl: string; expiresAt: string | null; version: string | null } | null;
  fileError: string | null;
}

/** What this browser made of the file. */
interface Check {
  sha256: string | null;
  bytes: number | null;
  problem: string | null;
  plan: BuildingPlan | null;
  triangles: number;
}

const API = '/api/account/building';
const REASONS: Record<ReportReason, string> = {
  offensive: 'Offensive or hateful',
  sexual: 'Sexual content',
  violent: 'Violent or graphic',
  copyright: "Someone else's work",
  broken: 'Broken or in the way',
  other: 'Something else',
};
const STATUS: Record<Status, [string, string]> = {
  pending: ['Waiting for review', 'warn'],
  approved: ['In the city', 'good'],
  rejected: ['Rejected', 'bad'],
  hidden: ['Hidden', 'bad'],
};

const app = document.getElementById('app')!;
(document.getElementById('dashboard') as HTMLAnchorElement).href = dashboardUrl();
let viewer: { dispose(): void } | null = null;

const world = new URLSearchParams(location.search).get('world');
void (world ? showLink(world) : showQueue());

// ── The list ─────────────────────────────────────────────────────────────────

async function showQueue(): Promise<void> {
  try {
    const { links } = await api<{ links: QueueEntry[] }>('/review/queue');
    const section = el('section');
    section.append(el('h2', 'Buildings on worlds'));
    if (!links.length) section.append(el('p', 'No world has asked for a building yet.', 'muted'));
    const list = el('ul', undefined, 'queue');
    for (const entry of links) {
      const item = el('li');
      const [label, tone] = STATUS[entry.status];
      const open = el('a', entry.buildingName || 'Unnamed') as HTMLAnchorElement;
      open.href = `?world=${encodeURIComponent(entry.world)}`;
      item.append(el('span', label, `pill ${tone}`));
      if (entry.reports) item.append(el('span', `${entry.reports} report${entry.reports === 1 ? '' : 's'}`, 'pill bad'));
      item.append(open, el('span', `for ${entry.world.replace(/^https:\/\//, '')} · ${entry.provider}`, 'muted'));
      list.append(item);
    }
    section.append(list);
    app.replaceChildren(section);
    app.style.gridTemplateColumns = 'minmax(0, 1fr)';
  } catch (error) {
    showError(error);
  }
}

// ── One building ─────────────────────────────────────────────────────────────

async function showLink(worldUrl: string): Promise<void> {
  viewer?.dispose();
  viewer = null;
  let details: Details;
  try {
    details = await api<Details>(`/review?world=${encodeURIComponent(worldUrl)}`);
  } catch (error) {
    showError(error);
    return;
  }
  document.title = `${details.building.name || 'Building'} — Building review`;

  const stage = el('div', undefined, 'viewer');
  const overlay = el('div', 'Downloading the model from its platform…', 'overlay');
  stage.append(overlay);
  const fileSection = el('section');
  fileSection.append(el('h2', 'The file'), el('p', details.file ? 'Checking…' : (details.fileError ?? 'No file.'), details.file ? 'muted' : 'bad'));
  const decide = el('section');
  app.replaceChildren(stage, aside(details, fileSection, decide));
  app.style.gridTemplateColumns = '';

  let check: Check | null = null;
  renderDecision(decide, details, check);
  if (!details.file) {
    overlay.textContent = 'Nothing to show.';
    return;
  }
  check = await inspect(details.file.modelUrl, stage, overlay);
  renderFile(fileSection, details, check);
  renderDecision(decide, details, check);
}

function aside(details: Details, fileSection: HTMLElement, decide: HTMLElement): HTMLElement {
  const box = el('aside');
  const [label, tone] = STATUS[details.link.status];

  const worldSection = el('section');
  worldSection.append(el('h2', 'World'), facts([
    ['Address', linkTo(details.link.world)],
    ['Status', el('span', label, tone)],
    ...(details.link.reason ? ([['Reason', details.link.reason]] as Fact[]) : []),
    ['Linked', when(details.link.createdAt)],
    ...(details.link.reviewedAt ? ([['Reviewed', `${when(details.link.reviewedAt)} by ${details.link.reviewedBy ?? '—'}`]] as Fact[]) : []),
  ]));

  const buildingSection = el('section');
  buildingSection.append(el('h2', 'Building'), facts([
    ['Name', details.building.name || 'Unnamed'],
    ['Platform', details.building.sourceUrl ? linkTo(details.building.sourceUrl, details.building.providerLabel) : details.building.providerLabel],
    ['Model', el('code', details.building.modelId)],
    ['Id', el('code', details.building.id)],
    ['Owner', [details.owner.name, details.owner.username && `@${details.owner.username}`, details.owner.email].filter(Boolean).join(' · ') || '—'],
  ]));

  box.append(worldSection);
  if (details.reports.length) box.append(reportsSection(details));
  box.append(buildingSection, fileSection, decide);
  return box;
}

/** What visitors reported, and a way to set the reports aside if the building is fine. */
function reportsSection(details: Details): HTMLElement {
  const section = el('section');
  section.append(el('h2', `Reports (${details.reports.length})`));
  for (const report of details.reports) {
    const item = el('p');
    item.append(el('strong', REASONS[report.reason]), ` · ${when(report.createdAt)} · ${report.reporter}`);
    if (!report.sameFile) item.append(el('span', ' · about a file approved before this one', 'warn'));
    section.append(item);
    if (report.note) section.append(el('p', `“${report.note}”`, 'muted'));
  }
  const dismiss = el('button', 'Dismiss reports') as HTMLButtonElement;
  dismiss.type = 'button';
  dismiss.addEventListener('click', () => void send(details, { action: 'dismiss' }));
  section.append(el('p', 'Hiding the building closes them too.', 'muted'), dismiss);
  return section;
}

/** Downloads, hashes and checks the model the way the city does, and stands it on a block. */
async function inspect(url: string, stage: HTMLElement, overlay: HTMLElement): Promise<Check> {
  const check: Check = { sha256: null, bytes: null, problem: null, plan: null, triangles: 0 };
  let data: ArrayBuffer;
  try {
    data = await downloadBuilding(url);
  } catch (error) {
    overlay.textContent = 'The model could not be downloaded.';
    check.problem = `It could not be downloaded: ${message(error)}.`;
    return check;
  }
  check.bytes = data.byteLength;
  check.sha256 = await sha256Hex(data);
  let model: Group;
  try {
    model = await parseBuilding(data);
  } catch (error) {
    overlay.textContent = 'The model could not be read.';
    check.problem = `${message(error)}.`;
    return check;
  }
  check.triangles = countTriangles(model);
  try {
    checkWeight(model);
  } catch (error) {
    check.problem = `${message(error)}.`;
  }
  const plan = planBuilding(model, BLOCK_LOT, DOOR_OUT);
  check.plan = plan;
  check.problem ??= plan.problem;
  viewer = showOnBlock(stage, model, plan);
  overlay.textContent = 'Drag to turn, scroll or pinch to zoom. Magenta: the portal face. The box: its block.';
  return check;
}

function renderFile(section: HTMLElement, details: Details, check: Check): void {
  const rows: Fact[] = [];
  if (check.bytes !== null) rows.push(['Size', `${(check.bytes / 1024 / 1024).toFixed(2)} MB`]);
  if (check.triangles) rows.push(['Triangles', check.triangles.toLocaleString()]);
  if (check.plan) {
    rows.push(['Scale', `${check.plan.fit.scale.toFixed(3)}× to fit its block`]);
    rows.push(['Door', check.plan.door ? `${check.plan.door.width.toFixed(1)} × ${check.plan.door.height.toFixed(1)} m (portal face)` : 'No portal face: a standard door at its front']);
  }
  if (check.sha256) rows.push(['SHA-256', el('code', check.sha256)]);
  if (details.file?.version) rows.push(['Version', el('code', details.file.version)]);
  section.replaceChildren(el('h2', 'The file'), facts(rows));
  if (check.problem) section.append(el('p', `Can't stand in the city: ${check.problem}`, 'bad'));
  else section.append(el('p', 'Passes every check the city makes.', 'good'));
  if (details.link.sha256 && check.sha256) {
    section.append(
      details.link.sha256 === check.sha256
        ? el('p', 'This is the approved file.', 'good')
        : el('p', 'This is not the file that was approved: the owner replaced it.', 'warn'),
    );
  }
}

function renderDecision(section: HTMLElement, details: Details, check: Check | null): void {
  section.replaceChildren(el('h2', 'Decide'));
  const approve = el('button', details.link.status === 'approved' ? 'Approve this file' : 'Approve', 'primary') as HTMLButtonElement;
  approve.type = 'button';
  approve.disabled = !check?.sha256 || !!check.problem;
  approve.addEventListener('click', () =>
    void send(details, {
      action: 'approve',
      sha256: check!.sha256,
      version: details.file?.version ?? null,
      portal: check?.plan && { door: check.plan.door, scale: check.plan.fit.scale, triangles: check.triangles, bytes: check.bytes },
    }),
  );
  section.append(
    el('p', 'Approving pins this exact file. If its owner replaces it, the building comes down until it is reviewed again.', 'muted'),
    approve,
  );
  const reason = el('textarea') as HTMLTextAreaElement;
  reason.placeholder = 'Reason, shown to the owner (needed to reject or hide)';
  reason.maxLength = 500;
  const row = el('div', undefined, 'actions');
  const reject = el('button', 'Reject', 'danger') as HTMLButtonElement;
  reject.type = 'button';
  reject.addEventListener('click', () => void send(details, { action: 'reject', reason: reason.value }));
  row.append(reject);
  if (details.link.status === 'approved') {
    const hide = el('button', 'Hide from the city', 'danger') as HTMLButtonElement;
    hide.type = 'button';
    hide.addEventListener('click', () => void send(details, { action: 'hide', reason: reason.value }));
    row.append(hide);
  }
  section.append(reason, row);
}

async function send(details: Details, decision: Record<string, unknown>): Promise<void> {
  for (const button of document.querySelectorAll('button')) button.disabled = true;
  try {
    await api('/review', { world: details.link.world, buildingId: details.building.id, ...decision });
    await showLink(details.link.world);
  } catch (error) {
    alert(message(error));
    await showLink(details.link.world);
  }
}

// ── The viewer ───────────────────────────────────────────────────────────────

/**
 * The model on its block as the city would stand it: turned to its portal
 * face, scaled to fit, the door at the origin facing +Z, the street in
 * front. The block's room is outlined, the portal face is magenta, and a
 * 1.8 m figure stands by the door for scale.
 */
function showOnBlock(stage: HTMLElement, model: Group, plan: BuildingPlan): { dispose(): void } {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const renderer = new WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  stage.prepend(renderer.domElement);
  const scene = new Scene();
  scene.background = new Color(dark ? 0x121216 : 0xe9e9ee);
  const pmrem = new PMREMGenerator(renderer);
  const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  scene.environment = environment;
  scene.add(new HemisphereLight(0xffffff, 0x555560, 0.8));
  const sun = new DirectionalLight(0xffffff, 1.4);
  sun.position.set(25, 40, 30);
  scene.add(sun);

  const { width, depth, forecourt, height } = BLOCK_LOT;
  const front = forecourt - DOOR_OUT;
  const back = -(depth + DOOR_OUT);
  const street = new Mesh(new PlaneGeometry(width + 60, depth + 60), new MeshStandardMaterial({ color: dark ? 0x2a2a30 : 0xcfcfd6, roughness: 1 }));
  street.rotation.x = -Math.PI / 2;
  street.position.set(0, -0.01, (front + back) / 2);
  const room = new LineSegments(new EdgesGeometry(new BoxGeometry(width, height, front - back)), new LineBasicMaterial({ color: dark ? 0x7a7a88 : 0x6a6a78 }));
  room.position.set(0, height / 2, (front + back) / 2);
  const wallLine = new Mesh(new PlaneGeometry(width, 0.15), new MeshBasicMaterial({ color: 0xff7a59 }));
  wallLine.rotation.x = -Math.PI / 2;
  wallLine.position.set(0, 0.01, -DOOR_OUT);
  const person = new Mesh(new CylinderGeometry(0.25, 0.25, 1.8, 16), new MeshStandardMaterial({ color: 0x3d7bff }));
  person.position.set((plan.door?.width ?? 2) / 2 + 1, 0.9, 1);
  scene.add(street, room, wallLine, person);

  for (const mesh of plan.portalMeshes) mesh.material = new MeshBasicMaterial({ color: 0xff3df0, transparent: true, opacity: 0.6, side: DoubleSide });
  const holder = new Group();
  holder.matrixAutoUpdate = false;
  holder.matrix.copy(plan.fit.matrix).multiply(plan.turn);
  holder.add(model);
  scene.add(holder);

  const camera = new PerspectiveCamera(45, 1, 0.1, 2000);
  camera.position.set(30, 22, 34);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 7, -10);
  controls.enableDamping = true;
  controls.update();

  const resize = () => {
    const { clientWidth, clientHeight } = stage;
    renderer.setSize(clientWidth, clientHeight, false);
    camera.aspect = clientWidth / Math.max(1, clientHeight);
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(stage);
  resize();
  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });

  return {
    dispose() {
      renderer.setAnimationLoop(null);
      observer.disconnect();
      controls.dispose();
      scene.traverse(disposeMesh);
      environment.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

function disposeMesh(object: Object3D): void {
  if (!(object instanceof Mesh || object instanceof LineSegments)) return;
  object.geometry.dispose();
  for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
    for (const value of Object.values(material)) if (value instanceof Texture) value.dispose();
    material.dispose();
  }
}

// ── Bits ─────────────────────────────────────────────────────────────────────

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new ApiError(response.status, data.error || `HTTP ${response.status}`);
  return data;
}

function showError(error: unknown): void {
  const section = el('section');
  if (error instanceof ApiError && error.status === 401) {
    const signIn = el('a', 'Sign in on the hub') as HTMLAnchorElement;
    signIn.href = '/';
    section.append(el('h2', 'Sign in first'), el('p', 'Reviewing needs your WorldMesh account. '), signIn);
  } else if (error instanceof ApiError && error.status === 403) {
    section.append(el('h2', 'Reviewers only'), el('p', 'This account does not review buildings.'));
  } else {
    section.append(el('h2', 'Something went wrong'), el('p', message(error), 'bad'));
  }
  app.replaceChildren(section);
  app.style.gridTemplateColumns = 'minmax(0, 1fr)';
}

type Fact = [string, string | Node];

function facts(rows: Fact[]): HTMLElement {
  const list = el('dl');
  for (const [term, value] of rows) {
    const dd = el('dd');
    dd.append(value);
    list.append(el('dt', term), dd);
  }
  return list;
}

function linkTo(url: string, text = url): HTMLElement {
  const a = el('a', text) as HTMLAnchorElement;
  if (/^https?:\/\//.test(url)) a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

function el(tag: string, text?: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function when(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function dashboardUrl(): string {
  if (location.hostname === 'preview.worldmesh.net') return 'https://preview-admin.worldmesh.net/buildings';
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return 'http://localhost:8791/buildings';
  return 'https://admin.worldmesh.net/buildings';
}
