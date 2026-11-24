import * as THREE from 'three';
import type { WorldCollider } from './hotelWorld';
import { ProceduralAudio } from './audio';

export type PhysicsPreset = 'standard' | 'highBounce' | 'lowGravity';

export interface HandTracker {
  side: 'left' | 'right';
  localPos: THREE.Vector3;
  prevLocalPos: THREE.Vector3;
  visualWorldPos: THREE.Vector3;
  isLocked: boolean;
  lockAnchorWorld: THREE.Vector3;
  lockNormal: THREE.Vector3;
  recentPushVel: THREE.Vector3;
  inContact: boolean;
  xrInputSource: XRInputSource | null;
}

export interface DesktopInputState {
  yaw: number;
  pitch: number;
  leftMouseDown: boolean;
  rightMouseDown: boolean;
  leftPullOffset: number;
  rightPullOffset: number;
  slamTimer: number;
}

export interface CollisionResult {
  collided: boolean;
  resolvedCenter: THREE.Vector3;
  normal: THREE.Vector3;
  penetration: number;
}

const HAND_RADIUS = 0.085;
const HEAD_RADIUS = 0.22;
const BODY_RADIUS = 0.24;

// Pre-allocated scratch math helpers (zero GC inside frame loop)
const _vA = new THREE.Vector3();
const _vB = new THREE.Vector3();
const _vC = new THREE.Vector3();
const _rawHandWorld = new THREE.Vector3();
const _rigDelta = new THREE.Vector3();
const _normalPushVec = new THREE.Vector3();
const _tangentVec = new THREE.Vector3();
const _headWorld = new THREE.Vector3();
const _bodyWorld = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');

function createHandTracker(side: 'left' | 'right'): HandTracker {
  const sign = side === 'left' ? -1 : 1;
  return {
    side,
    localPos: new THREE.Vector3(sign * 0.28, 0.42, -0.45),
    prevLocalPos: new THREE.Vector3(sign * 0.28, 0.42, -0.45),
    visualWorldPos: new THREE.Vector3(),
    isLocked: false,
    lockAnchorWorld: new THREE.Vector3(),
    lockNormal: new THREE.Vector3(0, 1, 0),
    recentPushVel: new THREE.Vector3(),
    inContact: false,
    xrInputSource: null,
  };
}

export class GorillaPhysicsEngine {
  public readonly playerRig: THREE.Group;
  public readonly velocity = new THREE.Vector3();
  public readonly leftHand = createHandTracker('left');
  public readonly rightHand = createHandTracker('right');
  public isGrounded = false;
  public preset: PhysicsPreset = 'standard';
  public speedMultiplier = 1.0;

  private readonly world: WorldCollider;
  private readonly audio: ProceduralAudio;

  private readonly _colCenter = new THREE.Vector3();
  private readonly _colNormal = new THREE.Vector3();

  constructor(playerRig: THREE.Group, world: WorldCollider, audio: ProceduralAudio) {
    this.playerRig = playerRig;
    this.world = world;
    this.audio = audio;
  }

  public getPresetParams() {
    const mult = this.speedMultiplier;
    switch (this.preset) {
      case 'highBounce':
        return { gravity: 10.5, pushMultiplier: 1.38 * mult, maxSpeed: 22.0 * mult, gripFirm: 0.94 };
      case 'lowGravity':
        return { gravity: 4.2, pushMultiplier: 1.05 * mult, maxSpeed: 18.0 * mult, gripFirm: 0.90 };
      case 'standard':
      default:
        return { gravity: 10.8, pushMultiplier: 1.15 * mult, maxSpeed: 18.0 * mult, gripFirm: 0.91 };
    }
  }

  public resetToSpawn(x = 0, y = 0.25, z = 6): void {
    this.playerRig.position.set(x, y, z);
    this.velocity.set(0, 0, 0);
    this.leftHand.isLocked = false;
    this.rightHand.isLocked = false;
    this.leftHand.recentPushVel.set(0, 0, 0);
    this.rightHand.recentPushVel.set(0, 0, 0);
    this.isGrounded = false;
  }

  private resolveSphereWorld(
    center: THREE.Vector3,
    radius: number,
    outCenter: THREE.Vector3,
    outNormal: THREE.Vector3
  ): boolean {
    return this.world.resolveSphere(center, radius, outCenter, outNormal);
  }

  private triggerHaptics(hand: HandTracker, intensity: number): void {
    const src = hand.xrInputSource;
    if (!src || !src.gamepad) return;
    const gp = src.gamepad as Gamepad & {
      hapticActuators?: Array<{ pulse: (val: number, dur: number) => Promise<boolean> }>;
    };
    const actuator = gp.hapticActuators?.[0];
    if (actuator && typeof actuator.pulse === 'function') {
      actuator.pulse(Math.min(1, Math.max(0.12, intensity)), 28).catch(() => {});
    }
  }

  public updateDesktopVirtualHands(desktop: DesktopInputState, dt: number): void {
    _euler.set(0, desktop.yaw, 0, 'YXZ');
    _forward.set(0, 0, -1).applyEuler(_euler).normalize();
    _right.set(1, 0, 0).applyEuler(_euler).normalize();

    // Gorilla stance: paws clearly framed in lower view and floor-ready (VR-first, no WASD walking)
    const baseHeight = 0.62;
    const baseForward = 0.68;
    const shoulderOffset = 0.28;

    // Coordinated two-hand downward ground/wall push via Spacebar preview
    let slamOffsetY = 0;
    if (desktop.slamTimer > 0) {
      desktop.slamTimer = Math.max(0, desktop.slamTimer - dt);
      const t = 1 - desktop.slamTimer / 0.16;
      slamOffsetY = 0.22 - Math.sin(Math.min(1, t * 1.25) * Math.PI * 0.5) * 1.08;
    }

    this.leftHand.localPos
      .set(0, baseHeight + slamOffsetY, 0)
      .addScaledVector(_forward, baseForward)
      .addScaledVector(_right, -shoulderOffset);

    this.rightHand.localPos
      .set(0, baseHeight + slamOffsetY, 0)
      .addScaledVector(_forward, baseForward)
      .addScaledVector(_right, shoulderOffset);

    // LMB / RMB (or Q / E) manual reach & pull along camera gaze
    _euler.set(desktop.pitch, desktop.yaw, 0, 'YXZ');
    _vA.set(0, 0, -1).applyEuler(_euler).normalize();

    if (desktop.leftMouseDown) {
      this.leftHand.localPos
        .set(0, 1.02 + desktop.leftPullOffset, 0)
        .addScaledVector(_vA, 1.05)
        .addScaledVector(_right, -0.18);
    } else {
      desktop.leftPullOffset = 0;
    }

    if (desktop.rightMouseDown) {
      this.rightHand.localPos
        .set(0, 1.02 + desktop.rightPullOffset, 0)
        .addScaledVector(_vA, 1.05)
        .addScaledVector(_right, 0.18);
    } else {
      desktop.rightPullOffset = 0;
    }
  }

  private solveHandPhysics(hand: HandTracker, dt: number, params: ReturnType<GorillaPhysicsEngine['getPresetParams']>): boolean {
    _rawHandWorld.copy(this.playerRig.position).add(hand.localPos);

    _vB.copy(hand.localPos).sub(hand.prevLocalPos).divideScalar(dt);
    const localSpeed = _vB.length();

    if (hand.isLocked) {
      _vA.copy(hand.lockAnchorWorld).sub(_rawHandWorld);
      const normalPush = _vA.dot(hand.lockNormal);

      _vC.copy(hand.lockAnchorWorld).addScaledVector(hand.lockNormal, -HAND_RADIUS - 0.08);
      const stillOnBlock = this.world.isPointSolid(_vC.x, _vC.y, _vC.z);

      if (normalPush < -0.045 || !stillOnBlock) {
        hand.isLocked = false;
        hand.inContact = false;
        if (hand.recentPushVel.lengthSq() > 0.20) {
          this.velocity.lerp(hand.recentPushVel, 0.78);
          if (this.velocity.length() > params.maxSpeed) {
            this.velocity.setLength(params.maxSpeed);
          }
        }
        hand.visualWorldPos.copy(_rawHandWorld);
        return false;
      }

      _normalPushVec.copy(hand.lockNormal).multiplyScalar(Math.max(0, normalPush));
      _tangentVec.copy(_vA).addScaledVector(hand.lockNormal, -normalPush);

      const grip = normalPush > 0.002 ? params.gripFirm : 0.55;
      _rigDelta.copy(_normalPushVec).addScaledVector(_tangentVec, grip);

      this.playerRig.position.add(_rigDelta);
      hand.lockAnchorWorld.addScaledVector(_tangentVec, -(1 - grip));

      if (this.resolveSphereWorld(hand.lockAnchorWorld, HAND_RADIUS, this._colCenter, this._colNormal)) {
        hand.lockAnchorWorld.copy(this._colCenter);
        if (this._colNormal.lengthSq() > 0.5) {
          hand.lockNormal.lerp(this._colNormal, 0.35).normalize();
        }
      }

      _vC.copy(_rigDelta).divideScalar(dt).multiplyScalar(params.pushMultiplier);
      _vC.addScaledVector(_vB, -0.35 * params.pushMultiplier);

      if (_vC.length() > params.maxSpeed) {
        _vC.setLength(params.maxSpeed);
      }

      hand.recentPushVel.lerp(_vC, 0.52);
      this.velocity.copy(hand.recentPushVel);

      hand.inContact = true;
      hand.visualWorldPos.copy(hand.lockAnchorWorld);
      return true;
    }

    const hit = this.resolveSphereWorld(_rawHandWorld, HAND_RADIUS, this._colCenter, this._colNormal);
    if (hit) {
      hand.isLocked = true;
      hand.inContact = true;
      hand.lockAnchorWorld.copy(this._colCenter);
      hand.lockNormal.copy(this._colNormal);

      _rigDelta.copy(this._colCenter).sub(_rawHandWorld);
      this.playerRig.position.add(_rigDelta);

      const relativeVel = _vA.copy(this.velocity).add(_vB);
      const impactSpeed = Math.max(localSpeed, Math.abs(relativeVel.dot(this._colNormal)));
      this.triggerHaptics(hand, impactSpeed / 7.5);
      this.audio.playSurfaceHit(impactSpeed);

      const vDotN = this.velocity.dot(this._colNormal);
      if (vDotN < 0) {
        this.velocity.addScaledVector(this._colNormal, -vDotN);
      }
      hand.recentPushVel.copy(this.velocity);
      hand.visualWorldPos.copy(hand.lockAnchorWorld);
      return true;
    }

    hand.inContact = false;
    hand.recentPushVel.multiplyScalar(0.8);
    hand.visualWorldPos.copy(_rawHandWorld);
    return false;
  }

  public step(dt: number, cameraLocalPos: THREE.Vector3): void {
    const safeDt = Math.min(0.033, Math.max(0.001, dt));
    const params = this.getPresetParams();

    // 1. Gravity & Air Drag
    this.velocity.y -= params.gravity * safeDt;
    const airDrag = Math.exp(-0.16 * safeDt);
    this.velocity.x *= airDrag;
    this.velocity.z *= airDrag;

    // 2. Advance rig by momentum velocity
    this.playerRig.position.addScaledVector(this.velocity, safeDt);

    // 3. Solve Gorilla Tag hand-to-surface push & lock physics
    const leftHit = this.solveHandPhysics(this.leftHand, safeDt, params);
    const rightHit = this.solveHandPhysics(this.rightHand, safeDt, params);

    // 4. Resolve Player Head, Torso & Tracking-Floor Capsule against voxel blocks
    this.isGrounded = false;
    _headWorld.copy(this.playerRig.position).add(cameraLocalPos);

    for (let iter = 0; iter < 2; iter++) {
      // Floor / tracking-origin sphere
      _bodyWorld.set(_headWorld.x, this.playerRig.position.y + 0.16, _headWorld.z);
      if (this.resolveSphereWorld(_bodyWorld, 0.16, this._colCenter, this._colNormal)) {
        _vA.copy(this._colCenter).sub(_bodyWorld);
        this.playerRig.position.add(_vA);
        _headWorld.add(_vA);

        const vDotN = this.velocity.dot(this._colNormal);
        if (vDotN < 0) {
          this.velocity.addScaledVector(this._colNormal, -vDotN);
        }
        if (this._colNormal.y > 0.65) {
          this.isGrounded = true;
        }
      }

      // Chest/torso sphere
      _bodyWorld.set(_headWorld.x, Math.max(this.playerRig.position.y + 0.35, _headWorld.y - 0.42), _headWorld.z);
      if (this.resolveSphereWorld(_bodyWorld, BODY_RADIUS, this._colCenter, this._colNormal)) {
        _vA.copy(this._colCenter).sub(_bodyWorld);
        this.playerRig.position.add(_vA);
        _headWorld.add(_vA);

        const vDotN = this.velocity.dot(this._colNormal);
        if (vDotN < 0) {
          this.velocity.addScaledVector(this._colNormal, -vDotN);
        }
        if (this._colNormal.y > 0.65) {
          this.isGrounded = true;
        }
      }

      // Head sphere
      if (this.resolveSphereWorld(_headWorld, HEAD_RADIUS, this._colCenter, this._colNormal)) {
        _vA.copy(this._colCenter).sub(_headWorld);
        this.playerRig.position.add(_vA);
        _headWorld.add(_vA);

        const vDotN = this.velocity.dot(this._colNormal);
        if (vDotN < 0) {
          this.velocity.addScaledVector(this._colNormal, -vDotN);
        }
      }
    }

    // Hard hotel floor surface guarantee: never allow rig beneath floor slab
    const floorSurfaceY = this.world.getFloorHeightAt(_headWorld.x, _headWorld.z);
    if (this.playerRig.position.y < floorSurfaceY) {
      this.playerRig.position.y = floorSurfaceY;
      if (this.velocity.y < 0) this.velocity.y = 0;
      this.isGrounded = true;
    }

    // 5. Apply ground friction when standing on top of blocks without active hand push
    if (this.isGrounded && !leftHit && !rightHit) {
      const groundFriction = Math.exp(-7.5 * safeDt);
      this.velocity.x *= groundFriction;
      this.velocity.z *= groundFriction;
    }

    // 6. Safety floor respawn if player falls deep below world
    if (this.playerRig.position.y < -10) {
      this.resetToSpawn(0, 0.25, 6);
    }

    this.leftHand.prevLocalPos.copy(this.leftHand.localPos);
    this.rightHand.prevLocalPos.copy(this.rightHand.localPos);

    this.audio.updateWind(this.velocity.length());
  }
}
