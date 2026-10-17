import { Vector3 } from 'three';

const UP = new Vector3(0, 1, 0);
import type { Input } from '../controls/input.js';
import type { Abilities, MovementTuning, PeerBody } from '../types.js';
import type { CollisionWorld } from './collision.js';

export const DEFAULT_TUNING: MovementTuning = {
  walkSpeed: 5.2,
  sprintSpeed: 9,
  crouchSpeed: 2.4,
  flySpeed: 12,
  jumpSpeed: 7.6,
  gravity: 24,
  groundAccel: 14,
  airAccel: 4,
  dashSpeed: 18,
  dashCooldown: 1.2,
  maxFallSpeed: 55,
  fallLimit: -60,
};

/**
 * How fast two people who start out inside each other (both arriving at the
 * spawn point, say) drift apart, in m/s. Slow, so it reads as making room
 * rather than a shove.
 */
const SEPARATE_SPEED = 1.5;

/**
 * A normal jump peaks about 1.2 m and another person is about 1.8 m tall, so
 * a jump that reaches their shoulders is close enough to hop the rest of the
 * way onto their head.
 */
const MOUNT_REACH = 0.7;

/** Still counts as jumping into someone when you are just brushing their side. */
const MOUNT_SLACK = 0.12;

/**
 * After landing on someone, ignore steering briefly. Otherwise the same
 * forward hold that made the jump walks you off their head immediately.
 */
const HEAD_STICK = 0.45;

/** Two jump presses this close together toggle flight, as in Minecraft. */
const DOUBLE_TAP = 0.3;

/** Fast flying (Ctrl, or double-tap forward) multiplies the fly speed by this. */
const FLY_FAST = 2;

/** Room left between the head and a ceiling flown up into. */
const HEAD_GAP = 0.05;

/** Coming down onto the floor faster than this ends a flight. */
const LAND_SPEED = 0.5;

export interface ControllerOptions {
  input: Input;
  collision: CollisionWorld;
  abilities: Abilities;
  tuning?: Partial<MovementTuning>;
  height: number;
  radius: number;
  spawn: Vector3;
}

/**
 * The one movement implementation every WorldMesh world shares.
 * Optional capabilities are branches on `abilities` flags, never subclasses:
 * that is what keeps "declare it in config" honest.
 */
export class MovementController {
  /** Player feet position in world space. */
  readonly position = new Vector3();
  readonly velocity = new Vector3();
  onGround = false;
  crouching = false;
  flying = false;
  /** Flying fast: until the player stops moving or the flight ends. */
  flyingFast = false;
  /** Current standing height, shrinks while crouching. */
  currentHeight: number;
  /** Other people's bodies, which this player walks into rather than through, and can stand on. */
  bodies: (() => Iterable<PeerBody>) | null = null;

  readonly tuning: MovementTuning;

  private input: Input;
  private collision: CollisionWorld;
  private abilities: Abilities;
  private baseHeight: number;
  private radius: number;
  private jumpsUsed = 0;
  private dashCooldown = 0;
  private dashTime = 0;
  private dashDirection = new Vector3();
  private scratch = new Vector3();
  private groundProbe = new Vector3();
  /** Set for this step when a jump should finish on someone's head. */
  private mount: { x: number; z: number; head: number; reach: number } | null = null;
  /** Seconds left to stay planted after landing on someone. */
  private headStick = 0;
  /** Seconds since the last jump press that could start a double tap. */
  private sinceJumpTap = Infinity;
  /** Seconds since the last forward press that could start a double tap. */
  private sinceForwardTap = Infinity;

  constructor(options: ControllerOptions) {
    this.input = options.input;
    this.collision = options.collision;
    this.abilities = options.abilities;
    this.tuning = { ...DEFAULT_TUNING, ...options.tuning };
    this.baseHeight = options.height;
    this.currentHeight = options.height;
    this.radius = options.radius;
    this.position.copy(options.spawn);
  }

  get height(): number {
    return this.currentHeight;
  }

  reset(position: Vector3): void {
    this.position.copy(position);
    this.velocity.set(0, 0, 0);
    this.onGround = false;
    this.flying = false;
    this.crouching = false;
    this.jumpsUsed = 0;
    this.dashTime = 0;
    this.headStick = 0;
    this.sinceJumpTap = Infinity;
    this.sinceForwardTap = Infinity;
    this.flyingFast = false;
  }

  /** Advance one simulation step. `yaw` is the camera heading in radians. */
  step(dt: number, yaw: number, controlsEnabled: boolean): void {
    this.headStick = Math.max(0, this.headStick - dt);
    this.sinceJumpTap += dt;
    this.sinceForwardTap += dt;
    const axis = controlsEnabled && this.headStick === 0 ? this.input.getMoveAxis() : { x: 0, z: 0 };
    let jumpTap = controlsEnabled && this.input.consume('jump');

    if (this.updateModes(controlsEnabled, jumpTap)) jumpTap = false;
    this.updateFlyingFast(controlsEnabled, axis.x !== 0 || axis.z !== 0);

    // Rotate local input into world space using the camera heading.
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    const wishX = axis.x * cos + axis.z * sin;
    const wishZ = -axis.x * sin + axis.z * cos;

    const speed = this.currentSpeed();
    const targetX = wishX * speed;
    const targetZ = wishZ * speed;

    if (this.flying) {
      this.stepFlying(dt, targetX, targetZ, controlsEnabled);
    } else {
      this.stepGrounded(dt, targetX, targetZ, jumpTap);
    }

    this.stepDash(dt, controlsEnabled, wishX, wishZ, yaw);
    this.applyMotion(dt);
  }

  /** Says whether `jumpTap` was used up toggling flight. */
  private updateModes(controlsEnabled: boolean, jumpTap: boolean): boolean {
    let toggle = this.abilities.flying && controlsEnabled && this.input.consume('fly');
    let tapUsed = false;
    if (this.abilities.flying && jumpTap) {
      if (this.sinceJumpTap < DOUBLE_TAP) {
        toggle = !toggle;
        tapUsed = true;
        this.sinceJumpTap = Infinity;
      } else {
        this.sinceJumpTap = 0;
      }
    }
    if (toggle) {
      this.flying = !this.flying;
      if (this.flying) {
        this.velocity.y = 0;
        this.onGround = false;
      }
    }

    const wantsCrouch = this.abilities.crouching && controlsEnabled && this.input.isDown('crouch');
    this.crouching = wantsCrouch && !this.flying;
    const targetHeight = this.crouching ? this.baseHeight * 0.55 : this.baseHeight;
    // Smooth so the camera does not snap between eye heights.
    this.currentHeight += (targetHeight - this.currentHeight) * 0.35;
    return tapUsed;
  }

  /**
   * As in Minecraft: hold Ctrl while flying any way, or double-tap forward,
   * to go faster, until the player stops moving or the flight ends.
   */
  private updateFlyingFast(controlsEnabled: boolean, moving: boolean): void {
    const tapped = controlsEnabled && this.input.consume('forward');
    if (!this.flying || !moving) {
      this.flyingFast = false;
      if (tapped) this.sinceForwardTap = 0;
      return;
    }
    if (tapped) {
      if (this.sinceForwardTap < DOUBLE_TAP) this.flyingFast = true;
      this.sinceForwardTap = tapped && !this.flyingFast ? 0 : Infinity;
    }
    if (controlsEnabled && this.input.isDown('flyFast')) this.flyingFast = true;
  }

  private currentSpeed(): number {
    const tuning = this.tuning;
    if (this.flying) return tuning.flySpeed * (this.flyingFast ? FLY_FAST : 1);
    if (this.crouching) return tuning.crouchSpeed;
    return this.input.isDown('sprint') ? tuning.sprintSpeed : tuning.walkSpeed;
  }

  private stepGrounded(dt: number, targetX: number, targetZ: number, jumpTap: boolean): void {
    const tuning = this.tuning;
    const accel = this.onGround ? tuning.groundAccel : tuning.airAccel;
    const blend = 1 - Math.exp(-accel * dt);
    this.velocity.x += (targetX - this.velocity.x) * blend;
    this.velocity.z += (targetZ - this.velocity.z) * blend;

    this.velocity.y -= tuning.gravity * dt;
    if (this.velocity.y < -tuning.maxFallSpeed) this.velocity.y = -tuning.maxFallSpeed;

    if (jumpTap) {
      const maxJumps = this.abilities.doubleJump ? 2 : 1;
      if (this.onGround) {
        this.velocity.y = tuning.jumpSpeed;
        this.jumpsUsed = 1;
        this.onGround = false;
        this.headStick = 0;
      } else if (this.jumpsUsed < maxJumps) {
        this.velocity.y = tuning.jumpSpeed * 0.9;
        this.jumpsUsed++;
        this.headStick = 0;
      }
    }
  }

  private stepFlying(dt: number, targetX: number, targetZ: number, controlsEnabled: boolean): void {
    const blend = 1 - Math.exp(-this.tuning.groundAccel * dt);
    this.velocity.x += (targetX - this.velocity.x) * blend;
    this.velocity.z += (targetZ - this.velocity.z) * blend;

    const up = controlsEnabled && this.input.isDown('jump') ? 1 : 0;
    // Shift goes down, as in Minecraft; so does crouch where the world has it.
    const crouch = this.abilities.crouching && this.input.isDown('crouch');
    const down = controlsEnabled && (crouch || this.input.isDown('sprint')) ? 1 : 0;
    const targetY = (up - down) * this.tuning.flySpeed;
    this.velocity.y += (targetY - this.velocity.y) * blend;
    this.onGround = false;
  }

  private stepDash(
    dt: number,
    controlsEnabled: boolean,
    wishX: number,
    wishZ: number,
    yaw: number,
  ): void {
    if (!this.abilities.dash) return;
    this.dashCooldown = Math.max(0, this.dashCooldown - dt);

    if (controlsEnabled && this.input.consume('dash') && this.dashCooldown === 0) {
      // Dash along the input direction, or straight ahead when standing still.
      if (wishX === 0 && wishZ === 0) {
        this.dashDirection.set(-Math.sin(yaw), 0, -Math.cos(yaw));
      } else {
        this.dashDirection.set(wishX, 0, wishZ).normalize();
      }
      this.dashTime = 0.18;
      this.dashCooldown = this.tuning.dashCooldown;
    }

    if (this.dashTime > 0) {
      this.dashTime = Math.max(0, this.dashTime - dt);
      this.velocity.x = this.dashDirection.x * this.tuning.dashSpeed;
      this.velocity.z = this.dashDirection.z * this.tuning.dashSpeed;
      if (!this.flying && this.velocity.y < 0) this.velocity.y = 0;
    }
  }

  private applyMotion(dt: number): void {
    const horizontal = this.scratch.set(this.velocity.x * dt, 0, this.velocity.z * dt);
    let resolved = this.collision.resolveHorizontal(
      this.position,
      horizontal,
      this.radius,
      this.currentHeight,
    );
    const walked = resolved.clone();
    const apart = this.keepApart(resolved, dt);
    // Stepping round someone can lead into a wall, so check the walls again.
    if (apart !== 'clear') {
      resolved = this.collision.resolveHorizontal(this.position, resolved, this.radius, this.currentHeight);
    }

    // Feed the resolved slide back into velocity so we do not keep pushing
    // into a wall and accelerating along it. Drifting out of someone is not
    // walking, so it does not carry on once clear of them.
    if (dt > 0) {
      const moved = apart === 'separating' ? walked : resolved;
      this.velocity.x = moved.x / dt;
      this.velocity.z = moved.z / dt;
    }
    this.position.x += resolved.x;
    this.position.z += resolved.z;
    this.hopOntoHead();

    const previousY = this.position.y;
    this.position.y += this.velocity.y * dt;
    if (this.flying && this.velocity.y > 0) this.stopAtCeiling(previousY);

    // Sample from where the feet *were*, and look down far enough to cover the
    // distance just fallen. Sampling from the new position would miss the floor
    // on the frame the player crosses it and drop them through the world.
    const fallDistance = Math.max(0, previousY - this.position.y);
    const stepHeight = this.onGround ? 0.6 : 0.05;
    this.groundProbe.set(this.position.x, previousY, this.position.z);
    const ground = this.collision.sampleGround(
      this.groundProbe,
      stepHeight,
      fallDistance + 4,
    );
    const floor = ground.y;
    const head = this.highestHead(previousY, stepHeight);
    if (head > ground.y) ground.y = head;

    if (this.flying) {
      if (this.position.y >= ground.y) return;
      if (this.velocity.y > -LAND_SPEED) {
        this.position.y = ground.y;
        this.velocity.y = Math.max(0, this.velocity.y);
        return;
      }
      // Flying down onto the floor lands, as in Minecraft.
      this.flying = false;
    }

    if (this.position.y <= ground.y + 1e-3 && this.velocity.y <= 0) {
      // Dropping onto someone from above (a hop already planted itself).
      if (!this.onGround && head > floor) {
        this.headStick = HEAD_STICK;
        this.velocity.x *= 0.2;
        this.velocity.z *= 0.2;
      }
      this.position.y = ground.y;
      this.velocity.y = 0;
      this.onGround = true;
      this.jumpsUsed = 0;
    } else {
      this.onGround = false;
    }
  }

  /**
   * Flying up bumps the head on whatever is overhead (a glass roof, say)
   * instead of passing through. Only while flying, so jumps in existing
   * worlds behave as they always have.
   */
  private stopAtCeiling(previousY: number): void {
    const half = this.currentHeight / 2;
    const origin = this.scratch.set(this.position.x, previousY + half, this.position.z);
    const far = half + (this.position.y - previousY) + HEAD_GAP;
    const distance = this.collision.castDistance(origin, UP, far);
    if (distance >= far) return;
    const highest = origin.y + distance - HEAD_GAP - this.currentHeight;
    this.position.y = Math.max(previousY, Math.min(this.position.y, highest));
    this.velocity.y = 0;
  }

  /**
   * Bend this step's horizontal `move` so the player does not end up inside
   * anyone else. Walking into someone stops at their edge and slides round
   * them; already overlapping, the gap may only grow. A jump into their upper
   * body is remembered so the player can hop onto their head. Says whether
   * `move` changed, and whether that includes drifting out of someone.
   */
  private keepApart(move: Vector3, dt: number): 'clear' | 'blocked' | 'separating' {
    this.mount = null;
    if (!this.bodies) return 'clear';
    const { x, y, z } = this.position;
    let result: 'clear' | 'blocked' | 'separating' = 'clear';
    for (const body of this.bodies()) {
      const head = body.y + body.height;
      // Entirely above us, or we are already clear of their head: no wall.
      if (body.y >= y + this.currentHeight || y >= head) continue;
      if (!Number.isFinite(head) || !Number.isFinite(body.x) || !Number.isFinite(body.z)) continue;
      const reach = this.radius + body.radius;
      const nowX = x - body.x;
      const nowZ = z - body.z;
      const now = Math.hypot(nowX, nowZ);
      // Jumping into their shoulders hops you onto their head instead of
      // sliding back down. Falling hard still glances off.
      const mounting =
        !this.flying &&
        this.velocity.y > -2 &&
        y >= head - MOUNT_REACH &&
        now < reach + MOUNT_SLACK &&
        !(now >= reach && move.x * nowX + move.z * nowZ > 0);
      if (mounting && (this.mount === null || head > this.mount.head)) {
        this.mount = { x: body.x, z: body.z, head, reach };
      }
      if (mounting && now < reach) continue;
      if (now >= reach + Math.hypot(move.x, move.z)) continue;
      let awayX = nowX + move.x;
      let awayZ = nowZ + move.z;
      const next = Math.hypot(awayX, awayZ);
      const floor = Math.min(reach, now + SEPARATE_SPEED * dt);
      if (next >= floor) continue;
      if (next < 1e-4) {
        // Heading straight through their middle: step back the way we came, or any way at all.
        awayX = now > 1e-4 ? nowX : 1;
        awayZ = now > 1e-4 ? nowZ : 0;
      }
      // End the step `floor` away from them, in the direction we were headed.
      const away = Math.hypot(awayX, awayZ);
      move.x = (awayX / away) * floor - nowX;
      move.z = (awayZ / away) * floor - nowZ;
      if (result !== 'separating') result = now < reach ? 'separating' : 'blocked';
    }
    return result;
  }

  /**
   * Finish a jump on the head chosen in `keepApart`. Step in from the rim so
   * the landing is not balanced on the exact edge, and shed most of the run-up
   * so you stay put long enough to enjoy it.
   */
  private hopOntoHead(): void {
    const mount = this.mount;
    this.mount = null;
    if (!mount) return;
    const dx = this.position.x - mount.x;
    const dz = this.position.z - mount.z;
    const dist = Math.hypot(dx, dz);
    const inset = mount.reach * 0.72;
    if (dist > inset && dist > 1e-4) {
      const scale = inset / dist;
      this.position.x = mount.x + dx * scale;
      this.position.z = mount.z + dz * scale;
    }
    this.position.y = mount.head;
    this.velocity.x = 0;
    this.velocity.z = 0;
    this.velocity.y = 0;
    this.onGround = true;
    this.jumpsUsed = 0;
    this.headStick = HEAD_STICK;
  }

  /**
   * The highest other person's head under the feet this step, so you land on
   * them when falling from above and stay there while they shift a little.
   * `-Infinity` when nobody is underfoot.
   */
  private highestHead(previousY: number, stepHeight: number): number {
    if (!this.bodies) return -Infinity;
    let best = -Infinity;
    const { x, y, z } = this.position;
    for (const body of this.bodies()) {
      const head = body.y + body.height;
      if (!Number.isFinite(head) || !Number.isFinite(body.x) || !Number.isFinite(body.z)) continue;
      // Above where the feet were: someone beside us, not a floor.
      if (head > previousY + stepHeight) continue;
      // Already dropped past them.
      if (y < head - 0.15 && previousY < head) continue;
      const reach = this.radius + body.radius;
      if (Math.hypot(x - body.x, z - body.z) > reach) continue;
      if (head > best) best = head;
    }
    return best;
  }
}
