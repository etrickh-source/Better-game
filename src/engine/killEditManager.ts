import * as THREE from 'three';
import { createKnifeModel, KnifeVisualRig } from './knifeModel';
import type { WorldCollider } from './hotelWorld';

export type KillEditPhase = 'slowmo' | 'tuff_cuts';

export interface KillEditSnapshot {
  active: boolean;
  phase: KillEditPhase | null;
  cutIndex: number;
  totalCuts: number;
  timeLeftSec: number;
  flashStrength: number;
  killerName: string;
  victimName: string;
  isLocalKiller: boolean;
}

export interface KillEditTriggerParams {
  victimPos: THREE.Vector3;
  impactPos: THREE.Vector3;
  impactVel: THREE.Vector3;
  killerId: string;
  killerName: string;
  victimName: string;
  isLocalKiller: boolean;
}

export interface KillEditKillerPose {
  headPos: THREE.Vector3;
  yaw: number;
  rightHandPos: THREE.Vector3;
}

interface ToughShotDef {
  localOffset: THREE.Vector3;
  lookHeightOffset: number;
  fov: number;
  rollRad: number;
  dollyVel: THREE.Vector3;
  orbitSpeed: number;
}

const SLOWMO_DURATION = 4.5;
const CUT_INTERVAL = 2.0;
const TOTAL_CUTS = 12; // 12 * 2.0s = 24.0s -> total 28.5s edit
const TOTAL_EDIT_DURATION = SLOWMO_DURATION + TOTAL_CUTS * CUT_INTERVAL;

const TOUGH_SHOTS: ToughShotDef[] = [
  // 0: Low-angle front-left hero up-shot
  { localOffset: new THREE.Vector3(-0.85, -0.58, -1.35), lookHeightOffset: -0.05, fov: 50, rollRad: -0.17, dollyVel: new THREE.Vector3(0.12, 0.04, 0.25), orbitSpeed: 0.14 },
  // 1: Right-hand knife closeup framing killer torso behind
  { localOffset: new THREE.Vector3(0.62, -0.15, -0.82), lookHeightOffset: -0.18, fov: 44, rollRad: 0.19, dollyVel: new THREE.Vector3(-0.08, 0.02, 0.15), orbitSpeed: -0.1 },
  // 2: Dutch-angle front confrontation
  { localOffset: new THREE.Vector3(0.28, -0.12, -1.48), lookHeightOffset: -0.04, fov: 46, rollRad: -0.24, dollyVel: new THREE.Vector3(-0.1, 0, -0.25), orbitSpeed: 0.06 },
  // 3: Over-left-shoulder looking forward
  { localOffset: new THREE.Vector3(-0.72, 0.18, 0.92), lookHeightOffset: -0.1, fov: 58, rollRad: -0.1, dollyVel: new THREE.Vector3(0.15, -0.03, -0.18), orbitSpeed: 0.12 },
  // 4: Steep ceiling drop shot looking down on killer
  { localOffset: new THREE.Vector3(0.9, 1.55, -1.25), lookHeightOffset: -0.15, fov: 62, rollRad: 0.14, dollyVel: new THREE.Vector3(-0.18, -0.35, 0.22), orbitSpeed: 0.25 },
  // 5: Fast orbital swing right-to-front
  { localOffset: new THREE.Vector3(1.45, -0.05, -0.3), lookHeightOffset: -0.06, fov: 48, rollRad: 0.15, dollyVel: new THREE.Vector3(0, 0, 0), orbitSpeed: 0.85 },
  // 6: Dramatic 90-deg side silhouette
  { localOffset: new THREE.Vector3(-1.55, -0.25, 0.05), lookHeightOffset: -0.08, fov: 46, rollRad: -0.19, dollyVel: new THREE.Vector3(0.22, 0.04, -0.1), orbitSpeed: -0.08 },
  // 7: Wide haunted corridor power stance
  { localOffset: new THREE.Vector3(0.18, -0.35, -2.85), lookHeightOffset: -0.12, fov: 68, rollRad: 0.08, dollyVel: new THREE.Vector3(-0.05, 0.04, 0.65), orbitSpeed: 0.0 },
  // 8: Floor worm's-eye steep upward angle
  { localOffset: new THREE.Vector3(0.88, -0.78, -1.1), lookHeightOffset: 0.05, fov: 70, rollRad: 0.22, dollyVel: new THREE.Vector3(-0.15, 0.08, 0.12), orbitSpeed: -0.2 },
  // 9: Tight face lock portrait
  { localOffset: new THREE.Vector3(-0.22, 0.02, -0.98), lookHeightOffset: 0.0, fov: 40, rollRad: -0.12, dollyVel: new THREE.Vector3(0.08, 0, 0.12), orbitSpeed: 0.18 },
  // 10: Right-shoulder knife reveal
  { localOffset: new THREE.Vector3(0.95, 0.15, 0.72), lookHeightOffset: -0.14, fov: 50, rollRad: -0.16, dollyVel: new THREE.Vector3(-0.12, -0.04, -0.25), orbitSpeed: -0.15 },
  // 11: Pull-back hallway finale
  { localOffset: new THREE.Vector3(-0.35, 0.1, -1.65), lookHeightOffset: -0.1, fov: 64, rollRad: 0.12, dollyVel: new THREE.Vector3(0.12, 0.18, -0.95), orbitSpeed: 0.1 },
];

function createSkullEmojiTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, 512, 512);

    // Eerie crimson/dark aura glow behind skull
    const aura = ctx.createRadialGradient(256, 256, 36, 256, 256, 240);
    aura.addColorStop(0, 'rgba(239, 68, 68, 0.78)');
    aura.addColorStop(0.5, 'rgba(127, 29, 29, 0.35)');
    aura.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = aura;
    ctx.beginPath();
    ctx.arc(256, 256, 240, 0, Math.PI * 2);
    ctx.fill();

    // Draw bold crisp skull emoji vector illustration (works identically across all OS/headsets)
    ctx.save();
    ctx.translate(256, 256);

    // Cranium + Jaw silhouette
    ctx.fillStyle = '#f8fafc';
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 14;
    ctx.beginPath();
    ctx.arc(0, -24, 134, Math.PI * 0.85, Math.PI * 2.15, false);
    ctx.lineTo(96, 82);
    ctx.quadraticCurveTo(86, 152, 52, 160);
    ctx.lineTo(-52, 160);
    ctx.quadraticCurveTo(-86, 152, -96, 82);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Subtle bone shading
    const boneGrad = ctx.createLinearGradient(0, -155, 0, 160);
    boneGrad.addColorStop(0, 'rgba(255,255,255,0.45)');
    boneGrad.addColorStop(0.65, 'rgba(203,213,225,0.12)');
    boneGrad.addColorStop(1, 'rgba(148,163,184,0.45)');
    ctx.fillStyle = boneGrad;
    ctx.fill();

    // Deep dark eye sockets + glowing red pinpoints
    for (const side of [-1, 1]) {
      ctx.fillStyle = '#0f172a';
      ctx.beginPath();
      ctx.ellipse(side * 48, -14, 34, 38, side * 0.14, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#ef4444';
      ctx.beginPath();
      ctx.arc(side * 46, -12, 9, 0, Math.PI * 2);
      ctx.fill();
    }

    // Nasal cavity
    ctx.fillStyle = '#0f172a';
    ctx.beginPath();
    ctx.moveTo(0, 26);
    ctx.lineTo(22, 66);
    ctx.quadraticCurveTo(0, 58, -22, 66);
    ctx.closePath();
    ctx.fill();

    // Clenched jaw teeth vertical bars
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 11;
    ctx.lineCap = 'round';
    for (const tx of [-42, -14, 14, 42]) {
      ctx.beginPath();
      ctx.moveTo(tx, 102);
      ctx.lineTo(tx, 154);
      ctx.stroke();
    }
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.moveTo(-66, 128);
    ctx.lineTo(66, 128);
    ctx.stroke();

    ctx.restore();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

const _camPos = new THREE.Vector3();
const _lookPos = new THREE.Vector3();
const _offset = new THREE.Vector3();
const _rayDir = new THREE.Vector3();
const _probe = new THREE.Vector3();
const _forward = new THREE.Vector3(0, 0, -1);
const _tmpQuat = new THREE.Quaternion();
const _upAxis = new THREE.Vector3(0, 1, 0);
const _rollQuat = new THREE.Quaternion();
const _rollAxis = new THREE.Vector3(0, 0, 1);

export class KillEditManager {
  public readonly root = new THREE.Group();
  private readonly skullTexture: THREE.CanvasTexture;
  private readonly mainSkullSprite: THREE.Sprite;
  private readonly orbitSkulls: THREE.Sprite[] = [];
  private readonly shockwaveRing: THREE.Mesh;
  private readonly impactKnife: KnifeVisualRig;

  // VR Floating Cinema Screen so WebXR headset users also see the multi-angle tough edit
  private readonly vrScreenGroup = new THREE.Group();
  private readonly vrScreenMesh: THREE.Mesh;
  private readonly vrRenderTarget: THREE.WebGLRenderTarget;
  private readonly vrEditCamera = new THREE.PerspectiveCamera(56, 16 / 9, 0.08, 120);

  private active = false;
  private elapsed = 0;
  private currentCutIndex = -1;
  private flashTimer = 0;
  private savedFov = 75;

  private killerId = '';
  private killerName = 'Murderer';
  private victimName = 'Enemy';
  private isLocalKiller = false;
  private readonly victimPos = new THREE.Vector3();
  private readonly impactPos = new THREE.Vector3();
  private readonly impactDir = new THREE.Vector3(0, 0, -1);

  private onFinishCb?: () => void;

  constructor(onFinish?: () => void) {
    this.onFinishCb = onFinish;
    this.root.name = 'KillEditEffects';
    this.root.visible = false;

    this.skullTexture = createSkullEmojiTexture();

    const mainMat = new THREE.SpriteMaterial({
      map: this.skullTexture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.mainSkullSprite = new THREE.Sprite(mainMat);
    this.mainSkullSprite.renderOrder = 120;
    this.root.add(this.mainSkullSprite);

    for (let i = 0; i < 4; i++) {
      const m = new THREE.SpriteMaterial({
        map: this.skullTexture,
        transparent: true,
        opacity: 0.85,
        depthTest: false,
        depthWrite: false,
      });
      const s = new THREE.Sprite(m);
      s.scale.setScalar(0.32);
      s.renderOrder = 119;
      this.orbitSkulls.push(s);
      this.root.add(s);
    }

    const ringGeo = new THREE.RingGeometry(0.32, 0.44, 32);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xef4444,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
    });
    this.shockwaveRing = new THREE.Mesh(ringGeo, ringMat);
    this.shockwaveRing.rotation.x = -Math.PI / 2;
    this.root.add(this.shockwaveRing);

    this.impactKnife = createKnifeModel(1.32);
    this.root.add(this.impactKnife.group);

    // VR Cinema Screen RenderTarget
    this.vrRenderTarget = new THREE.WebGLRenderTarget(512, 288, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    const screenMat = new THREE.MeshBasicMaterial({
      map: this.vrRenderTarget.texture,
      toneMapped: false,
    });
    this.vrScreenMesh = new THREE.Mesh(new THREE.PlaneGeometry(1.12, 0.63), screenMat);
    const borderMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1.17, 0.68),
      new THREE.MeshBasicMaterial({ color: 0xef4444 })
    );
    borderMesh.position.z = -0.004;
    this.vrScreenGroup.add(borderMesh);
    this.vrScreenGroup.add(this.vrScreenMesh);
    this.vrScreenGroup.visible = false;
    this.root.add(this.vrScreenGroup);
  }

  public isActive(): boolean {
    return this.active;
  }

  public getTimeScale(): number {
    if (!this.active) return 1.0;
    if (this.elapsed < SLOWMO_DURATION) return 0.08;
    return 0.45;
  }

  public start(params: KillEditTriggerParams, baseFov = 75): void {
    this.active = true;
    this.elapsed = 0;
    this.currentCutIndex = -1;
    this.flashTimer = 0.22;
    this.savedFov = baseFov;

    this.killerId = params.killerId;
    this.killerName = params.killerName;
    this.victimName = params.victimName;
    this.isLocalKiller = params.isLocalKiller;

    this.victimPos.copy(params.victimPos);
    this.impactPos.copy(params.impactPos);
    if (params.impactVel.lengthSq() > 0.01) {
      this.impactDir.copy(params.impactVel).normalize();
    } else {
      this.impactDir.copy(params.victimPos).sub(params.impactPos);
      if (this.impactDir.lengthSq() > 0.001) {
        this.impactDir.normalize();
      } else {
        this.impactDir.set(0, 0, -1);
      }
    }

    this.impactKnife.group.position.copy(this.impactPos).addScaledVector(this.impactDir, -0.25);
    this.impactKnife.group.quaternion.setFromUnitVectors(_forward, this.impactDir);
    this.impactKnife.group.visible = true;

    this.mainSkullSprite.position.copy(this.victimPos).add(new THREE.Vector3(0, 0.25, 0));
    this.shockwaveRing.position.copy(this.victimPos).add(new THREE.Vector3(0, -0.2, 0));

    this.root.visible = true;
  }

  public stop(): void {
    if (!this.active) return;
    this.active = false;
    this.elapsed = 0;
    this.currentCutIndex = -1;
    this.flashTimer = 0;
    this.root.visible = false;
    this.vrScreenGroup.visible = false;
    this.onFinishCb?.();
  }

  public getSnapshot(): KillEditSnapshot {
    if (!this.active) {
      return {
        active: false,
        phase: null,
        cutIndex: 0,
        totalCuts: TOTAL_CUTS,
        timeLeftSec: 0,
        flashStrength: 0,
        killerName: '',
        victimName: '',
        isLocalKiller: false,
      };
    }
    const phase: KillEditPhase = this.elapsed < SLOWMO_DURATION ? 'slowmo' : 'tuff_cuts';
    const cutIdx =
      phase === 'slowmo'
        ? 0
        : Math.min(TOTAL_CUTS, Math.floor((this.elapsed - SLOWMO_DURATION) / CUT_INTERVAL) + 1);
    return {
      active: true,
      phase,
      cutIndex: cutIdx,
      totalCuts: TOTAL_CUTS,
      timeLeftSec: Math.max(0, TOTAL_EDIT_DURATION - this.elapsed),
      flashStrength: Math.min(1, this.flashTimer / 0.16),
      killerName: this.killerName,
      victimName: this.victimName,
      isLocalKiller: this.isLocalKiller,
    };
  }

  public getKillerId(): string {
    return this.killerId;
  }

  public isLocalPlayerKiller(): boolean {
    return this.active && this.isLocalKiller;
  }

  private clampCameraOutsideWalls(origin: THREE.Vector3, desired: THREE.Vector3, hotel: WorldCollider): THREE.Vector3 {
    _rayDir.copy(desired).sub(origin);
    const totalDist = _rayDir.length();
    if (totalDist < 0.05) return desired;
    _rayDir.divideScalar(totalDist);

    const steps = 12;
    let safeDist = totalDist;
    for (let i = 1; i <= steps; i++) {
      const d = (totalDist * i) / steps;
      _probe.copy(origin).addScaledVector(_rayDir, d);
      if (hotel.isPointSolid(_probe.x, _probe.y, _probe.z)) {
        safeDist = Math.max(0.45, ((i - 1) / steps) * totalDist - 0.18);
        break;
      }
    }
    desired.copy(origin).addScaledVector(_rayDir, safeDist);
    desired.y = Math.max(0.22, desired.y);
    return desired;
  }

  private computeEditCameraPose(
    targetCamera: THREE.PerspectiveCamera,
    killerPose: KillEditKillerPose,
    hotel: WorldCollider
  ): void {
    if (this.elapsed < SLOWMO_DURATION) {
      // Phase A: Slow-motion closeup on knife striking victim + 💀 Skull
      const localT = this.elapsed / SLOWMO_DURATION;
      const angle = (localT < 0.5 ? 0.35 : 2.35) + localT * 1.1;
      const radius = localT < 0.5 ? 1.45 - localT * 0.4 : 1.25;
      _lookPos.copy(this.victimPos).lerp(this.impactPos, 0.35);
      _camPos.set(
        _lookPos.x + Math.sin(angle) * radius,
        Math.max(0.35, _lookPos.y + (localT < 0.5 ? -0.1 : 0.25)),
        _lookPos.z + Math.cos(angle) * radius
      );
      this.clampCameraOutsideWalls(_lookPos, _camPos, hotel);

      targetCamera.fov = localT < 0.5 ? 46 : 42;
      targetCamera.updateProjectionMatrix();
      targetCamera.position.copy(_camPos);
      targetCamera.lookAt(_lookPos);
      targetCamera.rotateZ(localT < 0.5 ? -0.12 : 0.14);
    } else {
      // Phase B: Switch every 2.0s through 12 tough camera angles of the Killer
      const cutElapsed = this.elapsed - SLOWMO_DURATION;
      const idx = Math.min(TOUGH_SHOTS.length - 1, Math.floor(cutElapsed / CUT_INTERVAL));
      const inCutTime = cutElapsed - idx * CUT_INTERVAL;
      const shot = TOUGH_SHOTS[idx];

      _lookPos.copy(killerPose.headPos);
      _lookPos.y += shot.lookHeightOffset;
      if (idx === 1 || idx === 10) {
        _lookPos.lerp(killerPose.rightHandPos, 0.45);
      }

      _offset.copy(shot.localOffset).addScaledVector(shot.dollyVel, inCutTime);
      const totalYaw = killerPose.yaw + shot.orbitSpeed * inCutTime;
      _tmpQuat.setFromAxisAngle(_upAxis, totalYaw);
      _offset.applyQuaternion(_tmpQuat);

      _camPos.copy(killerPose.headPos).add(_offset);
      this.clampCameraOutsideWalls(killerPose.headPos, _camPos, hotel);

      // Subtle beat zoom punch right at start of each 2s cut
      const beatZoom = Math.max(0, 1 - inCutTime * 3.5) * 4.5;
      targetCamera.fov = shot.fov - beatZoom;
      targetCamera.updateProjectionMatrix();
      targetCamera.position.copy(_camPos);
      targetCamera.lookAt(_lookPos);

      _rollQuat.setFromAxisAngle(_rollAxis, shot.rollRad);
      targetCamera.quaternion.multiply(_rollQuat);
    }
  }

  public update(
    dt: number,
    desktopCamera: THREE.PerspectiveCamera,
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    isVR: boolean,
    isSoftwareGl: boolean,
    vrHeadWorldPos: THREE.Vector3,
    vrHeadYaw: number,
    killerPose: KillEditKillerPose,
    hotel: WorldCollider
  ): void {
    if (!this.active) return;

    this.elapsed += dt;
    if (this.flashTimer > 0) {
      this.flashTimer = Math.max(0, this.flashTimer - dt);
    }

    if (this.elapsed >= TOTAL_EDIT_DURATION) {
      desktopCamera.fov = this.savedFov;
      desktopCamera.updateProjectionMatrix();
      this.stop();
      return;
    }

    // Track cut transitions (impact -> slowmo angle 2 -> every 2s tough cut)
    const logicalCut =
      this.elapsed < SLOWMO_DURATION
        ? this.elapsed < SLOWMO_DURATION * 0.5
          ? -2
          : -1
        : Math.floor((this.elapsed - SLOWMO_DURATION) / CUT_INTERVAL);
    if (logicalCut !== this.currentCutIndex) {
      this.currentCutIndex = logicalCut;
      this.flashTimer = 0.16;
    }

    // Animate Slow-Motion Knife advancing cleanly into victim during slowmo phase
    if (this.elapsed < SLOWMO_DURATION) {
      const p = Math.min(1, this.elapsed / SLOWMO_DURATION);
      this.impactKnife.group.visible = true;
      this.impactKnife.group.position
        .copy(this.impactPos)
        .addScaledVector(this.impactDir, THREE.MathUtils.lerp(-0.42, 0.04, p));
      this.impactKnife.group.quaternion.setFromUnitVectors(_forward, this.impactDir);
      this.impactKnife.group.rotateZ(p * 1.4);
    } else {
      this.impactKnife.group.visible = false;
    }

    // Animate 3D Emoji Skull Face (💀) hovering & pulsing over victim
    const skullElastic =
      this.elapsed < 0.35
        ? THREE.MathUtils.lerp(0.1, 1.18, this.elapsed / 0.35)
        : 0.96 + Math.sin(this.elapsed * 9.0) * 0.1;
    this.mainSkullSprite.position.set(
      this.victimPos.x,
      this.victimPos.y + 0.36 + Math.sin(this.elapsed * 3.0) * 0.06,
      this.victimPos.z
    );
    this.mainSkullSprite.scale.setScalar(skullElastic);

    for (let i = 0; i < this.orbitSkulls.length; i++) {
      const a = this.elapsed * 2.2 + (i * Math.PI * 2) / this.orbitSkulls.length;
      const r = 0.65 + Math.sin(this.elapsed * 4 + i) * 0.08;
      this.orbitSkulls[i].position.set(
        this.victimPos.x + Math.cos(a) * r,
        this.victimPos.y + 0.18 + Math.sin(this.elapsed * 3 + i * 1.3) * 0.15,
        this.victimPos.z + Math.sin(a) * r
      );
    }

    // Shockwave ring expansion
    const ringScale = 0.6 + (this.elapsed % 2.0) * 1.35;
    this.shockwaveRing.scale.setScalar(ringScale);
    (this.shockwaveRing.material as THREE.MeshBasicMaterial).opacity = Math.max(
      0,
      0.85 * (1 - (this.elapsed % 2.0) / 2.0)
    );

    if (!isVR) {
      this.vrScreenGroup.visible = false;
      this.computeEditCameraPose(desktopCamera, killerPose, hotel);
    } else {
      // VR headset mode: keep HMD stereo camera untouched, render edit cuts onto floating cinema screen
      this.vrScreenGroup.visible = !isSoftwareGl;
      if (!isSoftwareGl) {
        this.computeEditCameraPose(this.vrEditCamera, killerPose, hotel);

        // Position cinema screen 1.55m in front of VR head
        _offset.set(-Math.sin(vrHeadYaw), 0, -Math.cos(vrHeadYaw)).normalize();
        _camPos.copy(vrHeadWorldPos).addScaledVector(_offset, 1.55);
        _camPos.y += 0.12;
        this.vrScreenGroup.position.lerp(_camPos, 1 - Math.exp(-8 * dt));
        this.vrScreenGroup.quaternion.setFromAxisAngle(_upAxis, vrHeadYaw);

        const prevTarget = renderer.getRenderTarget();
        const prevXrEnabled = renderer.xr.enabled;
        renderer.xr.enabled = false;
        this.vrScreenGroup.visible = false;
        renderer.setRenderTarget(this.vrRenderTarget);
        renderer.clear();
        renderer.render(scene, this.vrEditCamera);
        renderer.setRenderTarget(prevTarget);
        renderer.xr.enabled = prevXrEnabled;
        this.vrScreenGroup.visible = true;
      }
    }
  }

  public restoreCamera(desktopCamera: THREE.PerspectiveCamera): void {
    desktopCamera.fov = this.savedFov;
    desktopCamera.updateProjectionMatrix();
  }

  public dispose(): void {
    this.skullTexture.dispose();
    this.impactKnife.dispose();
    this.vrRenderTarget.dispose();
    this.root.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Sprite) {
        if (obj instanceof THREE.Mesh) obj.geometry.dispose();
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) {
          if (m instanceof THREE.Material) m.dispose();
        }
      }
    });
  }
}
