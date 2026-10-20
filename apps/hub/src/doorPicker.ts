/**
 * Drawing a building's door in "My buildings" (docs/specs/buildings.md §3.2):
 * the chosen GLB, shown on its own; the maker turns it, then drags a
 * rectangle across the wall people should walk through. The rectangle is
 * written into the file as a face with a material named `portal`
 * (./walk/drawnDoor.ts), so what is uploaded is an ordinary building file
 * and everything after (review, hashing, fitting) is unchanged.
 */
import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  DirectionalLight,
  DoubleSide,
  HemisphereLight,
  Matrix3,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  PMREMGenerator,
  Raycaster,
  Scene,
  Texture,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Group,
  type Material,
  type Object3D,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { DOOR_OUT } from './walk/avenuePlan';
import { isPortalName, MAX_LEAN, planBuilding } from './walk/buildingFit';
import { BLOCK_LOT, parseBuilding } from './walk/buildingModel';
import { addDoorToGlb, doorCorners, type DoorCorners } from './walk/drawnDoor';

const MAGENTA = 0xff3df0;
/** A drag shorter than this share of the model's size is a tap, not a door. */
const SMALLEST = 0.01;

/**
 * Open the door picker on `glb`. Resolves with the file with the drawn door
 * in it, or null when the maker closes it without one.
 */
export function openDoorPicker(glb: ArrayBuffer): Promise<ArrayBuffer | null> {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'world-claim door-picker';
    dialog.setAttribute('aria-labelledby', 'door-picker-title');
    // Keys and pointers stay here, not with the hub behind it.
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'keydown', 'keyup', 'wheel', 'touchstart']) {
      dialog.addEventListener(type, (event) => event.stopPropagation());
    }
    const title = document.createElement('h2');
    title.id = 'door-picker-title';
    title.textContent = 'Draw the door';
    const hint = document.createElement('p');
    const stage = document.createElement('div');
    stage.className = 'door-picker-stage';
    const status = document.createElement('p');
    status.className = 'door-picker-status';
    status.setAttribute('aria-live', 'polite');
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'world-claim-close';
    closeButton.setAttribute('aria-label', 'Close');
    closeButton.textContent = '×';
    const turnButton = modeButton('Turn');
    const drawButton = modeButton('Draw');
    const modes = document.createElement('div');
    modes.className = 'door-picker-mode';
    modes.setAttribute('role', 'group');
    modes.setAttribute('aria-label', 'What dragging does');
    modes.append(turnButton, drawButton);
    const use = document.createElement('button');
    use.type = 'button';
    use.className = 'world-claim-primary';
    use.textContent = 'Use this door';
    use.disabled = true;
    const bar = document.createElement('div');
    bar.className = 'door-picker-bar';
    bar.append(modes, use);
    dialog.append(closeButton, title, hint, stage, status, bar);
    document.body.append(dialog);
    dialog.showModal();

    let viewer: Viewer | null = null;
    let closed = false;
    const close = (result: ArrayBuffer | null) => {
      if (closed) return;
      closed = true;
      viewer?.dispose();
      dialog.close();
      dialog.remove();
      resolve(result);
    };
    closeButton.addEventListener('click', () => close(null));
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      close(null);
    });

    const say = (text: string, error = false) => {
      status.textContent = text;
      status.dataset.error = String(error);
    };
    const setMode = (mode: 'turn' | 'draw') => {
      turnButton.setAttribute('aria-pressed', String(mode === 'turn'));
      drawButton.setAttribute('aria-pressed', String(mode === 'draw'));
      stage.dataset.mode = mode;
      viewer?.setMode(mode);
      hint.textContent =
        mode === 'turn'
          ? 'Drag to turn the model, pinch or scroll to zoom. Then choose Draw.'
          : 'Drag across a wall, from one corner of the door to the other.';
    };
    turnButton.addEventListener('click', () => setMode('turn'));
    drawButton.addEventListener('click', () => setMode('draw'));
    setMode('turn');

    let corners: DoorCorners | null = null;
    use.addEventListener('click', () => {
      if (!corners) return;
      try {
        close(addDoorToGlb(glb, corners));
      } catch (error) {
        say(`The door could not be written into the file: ${error instanceof Error ? error.message : 'unknown error'}.`, true);
      }
    });

    say('Loading the model…');
    parseBuilding(glb).then(
      (model) => {
        if (closed) return dispose(model);
        viewer = showModel(stage, model, {
          onStart: () => {
            corners = null;
            use.disabled = true;
          },
          onDoor: (drawn, text, problem) => {
            corners = problem ? null : drawn;
            use.disabled = !corners;
            say(text, problem);
          },
          onMiss: (text) => say(text, true),
        });
        viewer.setMode(stage.dataset.mode as 'turn' | 'draw');
        say(viewer.current);
      },
      (error) => say(`The model could not be read: ${error instanceof Error ? error.message : 'unknown error'}.`, true),
    );
  });
}

function modeButton(label: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  return button;
}

interface Viewer {
  /** What the model's door is before anything is drawn. */
  current: string;
  setMode(mode: 'turn' | 'draw'): void;
  dispose(): void;
}

interface Events {
  /** A new door is being drawn: the last one is gone. */
  onStart(): void;
  /** A door was drawn: its corners, and what it makes on a block (or why it can't be a door). */
  onDoor(corners: DoorCorners | null, text: string, problem: boolean): void;
  /** The drag didn't start on a wall. */
  onMiss(text: string): void;
}

/** The model on its own, framed, with a way to draw a door across one of its walls. */
function showModel(stage: HTMLElement, model: Group, events: Events): Viewer {
  const renderer = new WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  stage.prepend(renderer.domElement);
  const scene = new Scene();
  const pmrem = new PMREMGenerator(renderer);
  const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  scene.environment = environment;
  scene.add(new HemisphereLight(0xffffff, 0x555560, 0.8));
  const sun = new DirectionalLight(0xffffff, 1.4);
  sun.position.set(0.5, 1, 0.7);
  scene.add(sun);
  scene.add(model);

  // The door it has now, if any, in magenta until another is drawn.
  const before = planBuilding(model, BLOCK_LOT, DOOR_OUT);
  const originals = new Map<Mesh, Material | Material[]>();
  const highlight = new MeshBasicMaterial({ color: MAGENTA, transparent: true, opacity: 0.6, side: DoubleSide });
  for (const mesh of before.portalMeshes) {
    originals.set(mesh, mesh.material);
    mesh.material = highlight;
  }
  const current = before.door
    ? `Its door now is the magenta face: ${metres(before.door)} on a block. Draw to put the door somewhere else.`
    : before.portalMeshes.length
      ? `Its portal face can't be a door (${before.problem}) Draw one instead.`
      : 'It has no door yet, so a standard one would stand at its front. Draw one on a wall.';

  const bounds = new Box3().setFromObject(model);
  const size = Math.max(bounds.getSize(new Vector3()).length(), 1e-3);
  const middle = bounds.getCenter(new Vector3());
  const camera = new PerspectiveCamera(45, 1, size / 1000, size * 20);
  camera.position.copy(middle).addScaledVector(new Vector3(0.45, 0.35, 1).normalize(), size * 1.2);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(middle);
  controls.enableDamping = true;
  controls.update();

  // The door being drawn, and the street its bottom edge would stand on.
  const doorGeometry = new BufferGeometry();
  doorGeometry.setAttribute('position', new BufferAttribute(new Float32Array(12), 3));
  doorGeometry.setIndex([0, 1, 2, 0, 2, 3]);
  const door = new Mesh(doorGeometry, new MeshBasicMaterial({ name: 'portal', color: MAGENTA, transparent: true, opacity: 0.6, side: DoubleSide }));
  door.visible = false;
  const street = new Mesh(
    new PlaneGeometry(size * 3, size * 3).rotateX(-Math.PI / 2),
    new MeshBasicMaterial({ color: 0x8a8a98, transparent: true, opacity: 0.35, side: DoubleSide, depthWrite: false }),
  );
  street.visible = false;
  scene.add(street);

  const raycaster = new Raycaster();
  const pointer = new Vector2();
  const aim = (event: PointerEvent) => {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
  };
  let mode: 'turn' | 'draw' = 'turn';
  let drag: { id: number; start: Vector3; normal: Vector3; plane: Plane } | null = null;
  let drawn: DoorCorners | null = null;

  const place = (end: Vector3) => {
    if (!drag) return;
    drawn = doorCorners(drag.start, end, drag.normal, size * 0.001);
    const position = doorGeometry.getAttribute('position') as BufferAttribute;
    drawn.forEach((corner, i) => position.setXYZ(i, corner.x, corner.y, corner.z));
    position.needsUpdate = true;
    doorGeometry.computeBoundingBox();
    doorGeometry.computeBoundingSphere();
    door.visible = true;
  };

  const onDown = (event: PointerEvent) => {
    if (mode !== 'draw' || !event.isPrimary || event.button !== 0) return;
    aim(event);
    const hit = raycaster.intersectObject(model, true).find((found) => found.object !== door && found.face);
    if (!hit?.face) {
      events.onMiss('Start the door on a wall of the building.');
      return;
    }
    const normal = hit.face.normal.clone().applyMatrix3(new Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize();
    if (normal.dot(raycaster.ray.direction) > 0) normal.negate();
    if (Math.abs(normal.y) > Math.sin(MAX_LEAN)) {
      events.onMiss("That's a floor or a roof. Draw the door on an upright wall.");
      return;
    }
    // The first door drawn takes over from any the file had, as it will in the file (./walk/drawnDoor.ts).
    if (!door.parent) {
      for (const [mesh, material] of originals) mesh.material = material;
      originals.clear();
      model.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        for (const each of Array.isArray(object.material) ? object.material : [object.material]) {
          if (isPortalName(each.name)) each.name = `former ${each.name.trim()}`;
        }
      });
      model.add(door);
    }
    street.visible = false;
    renderer.domElement.setPointerCapture(event.pointerId);
    drag = { id: event.pointerId, start: hit.point.clone(), normal, plane: new Plane().setFromNormalAndCoplanarPoint(normal, hit.point) };
    events.onStart();
    place(hit.point);
  };
  const onMove = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id) return;
    aim(event);
    const end = raycaster.ray.intersectPlane(drag.plane, new Vector3());
    if (end) place(end);
  };
  const onUp = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id) return;
    drag = null;
    const corners = drawn;
    drawn = null;
    if (!corners || corners[0].distanceTo(corners[1]) < size * SMALLEST || corners[0].distanceTo(corners[3]) < size * SMALLEST) {
      door.visible = false;
      events.onDoor(null, 'Drag further, from one corner of the door to the opposite one.', true);
      return;
    }
    street.position.y = Math.min(...corners.map((corner) => corner.y));
    street.visible = true;
    const plan = planBuilding(model, BLOCK_LOT, DOOR_OUT);
    if (plan.problem || !plan.door) {
      events.onDoor(corners, `This door won't work: ${plan.problem ?? 'it could not be measured.'}`, true);
    } else {
      events.onDoor(corners, `A ${metres(plan.door)} door once the building is fitted to its block. Below the grey plane goes under the street.`, false);
    }
  };
  const canvas = renderer.domElement;
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);

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
    current,
    setMode(next) {
      mode = next;
      controls.enabled = next === 'turn';
    },
    dispose() {
      renderer.setAnimationLoop(null);
      observer.disconnect();
      controls.dispose();
      for (const [mesh, material] of originals) mesh.material = material;
      dispose(scene);
      highlight.dispose();
      environment.dispose();
      renderer.dispose();
      canvas.remove();
    },
  };
}

function metres(door: { width: number; height: number }): string {
  return `${door.width.toFixed(1)} × ${door.height.toFixed(1)} m`;
}

function dispose(root: Object3D): void {
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    object.geometry.dispose();
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      for (const value of Object.values(material)) if (value instanceof Texture) value.dispose();
      material.dispose();
    }
  });
}
