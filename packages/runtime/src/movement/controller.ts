import { Vector3 } from 'three';
import type { Input } from '../controls/input';
import type { Abilities, MovementTuning } from '../types';
import type { CollisionWorld } from './collision';

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
  /** Current standing height, shrinks while crouching. */
  currentHeight: number;

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
  }

  /** Advance one simulation step. `yaw` is the camera heading in radians. */
  step(dt: number, yaw: number, controlsEnabled: boolean): void {
    const axis = controlsEnabled ? this.input.getMoveAxis() : { x: 0, z: 0 };

    this.updateModes(controlsEnabled);

    // Rotate local input into world space using the camera heading.
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    const wishX = axis.x * cos - axis.z * sin;
    const wishZ = axis.x * sin + axis.z * cos;

    const speed = this.currentSpeed();
    const targetX = wishX * speed;
    const targetZ = wishZ * speed;

    if (this.flying) {
      this.stepFlying(dt, targetX, targetZ, controlsEnabled);
    } else {
      this.stepGrounded(dt, targetX, targetZ, controlsEnabled);
    }

    this.stepDash(dt, controlsEnabled, wishX, wishZ, yaw);
    this.applyMotion(dt);
  }

  private updateModes(controlsEnabled: boolean): void {
    if (this.abilities.flying && controlsEnabled && this.input.consume('fly')) {
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
  }

  private currentSpeed(): number {
    const tuning = this.tuning;
    if (this.flying) return tuning.flySpeed;
    if (this.crouching) return tuning.crouchSpeed;
    return this.input.isDown('sprint') ? tuning.sprintSpeed : tuning.walkSpeed;
  }

  private stepGrounded(dt: number, targetX: number, targetZ: number, controlsEnabled: boolean): void {
    const tuning = this.tuning;
    const accel = this.onGround ? tuning.groundAccel : tuning.airAccel;
    const blend = 1 - Math.exp(-accel * dt);
    this.velocity.x += (targetX - this.velocity.x) * blend;
    this.velocity.z += (targetZ - this.velocity.z) * blend;

    this.velocity.y -= tuning.gravity * dt;
    if (this.velocity.y < -tuning.maxFallSpeed) this.velocity.y = -tuning.maxFallSpeed;

    if (controlsEnabled && this.input.consume('jump')) {
      const maxJumps = this.abilities.doubleJump ? 2 : 1;
      if (this.onGround) {
        this.velocity.y = tuning.jumpSpeed;
        this.jumpsUsed = 1;
        this.onGround = false;
      } else if (this.jumpsUsed < maxJumps) {
        this.velocity.y = tuning.jumpSpeed * 0.9;
        this.jumpsUsed++;
      }
    }
  }

  private stepFlying(dt: number, targetX: number, targetZ: number, controlsEnabled: boolean): void {
    const blend = 1 - Math.exp(-this.tuning.groundAccel * dt);
    this.velocity.x += (targetX - this.velocity.x) * blend;
    this.velocity.z += (targetZ - this.velocity.z) * blend;

    const up = controlsEnabled && this.input.isDown('jump') ? 1 : 0;
    const down = controlsEnabled && this.abilities.crouching && this.input.isDown('crouch') ? 1 : 0;
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
    const resolved = this.collision.resolveHorizontal(
      this.position,
      horizontal,
      this.radius,
      this.currentHeight,
    );

    // Feed the resolved slide back into velocity so we do not keep pushing
    // into a wall and accelerating along it.
    if (dt > 0) {
      this.velocity.x = resolved.x / dt;
      this.velocity.z = resolved.z / dt;
    }
    this.position.x += resolved.x;
    this.position.z += resolved.z;

    const previousY = this.position.y;
    this.position.y += this.velocity.y * dt;

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

    if (this.flying) {
      if (this.position.y < ground.y) {
        this.position.y = ground.y;
        this.velocity.y = Math.max(0, this.velocity.y);
      }
      return;
    }

    if (this.position.y <= ground.y + 1e-3 && this.velocity.y <= 0) {
      this.position.y = ground.y;
      this.velocity.y = 0;
      this.onGround = true;
      this.jumpsUsed = 0;
    } else {
      this.onGround = false;
    }
  }
}
