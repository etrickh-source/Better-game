import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

export const GORILLA_PLAYER_MODEL_URL = '/models/gorilla_tag_player_model.glb';

const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');

const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(dracoLoader);

let cachedTemplatePromise: Promise<THREE.Group> | null = null;

export function preloadGorillaPlayerTemplate(): Promise<THREE.Group> {
  if (!cachedTemplatePromise) {
    cachedTemplatePromise = new Promise<THREE.Group>((resolve, reject) => {
      gltfLoader.load(
        GORILLA_PLAYER_MODEL_URL,
        (gltf) => {
          resolve(gltf.scene);
        },
        undefined,
        (err) => {
          cachedTemplatePromise = null;
          reject(err instanceof Error ? err : new Error('Failed to load gorilla player model.'));
        }
      );
    });
  }
  return cachedTemplatePromise;
}

export interface HandFingerPose {
  grip: number;
  trigger: number;
  thumb: number;
}

type FingerKind = 'pinky' | 'pointer' | 'thumb';

interface ArmChain {
  side: 'left' | 'right';
  upper: THREE.Object3D;
  lower: THREE.Object3D;
  wrist: THREE.Object3D;
  fingers: { bone: THREE.Object3D; restQuat: THREE.Quaternion; kind: FingerKind }[];
  upperLen: number;
  lowerLen: number;
  fingerState: HandFingerPose;
}

const _shoulderPos = new THREE.Vector3();
const _elbowPos = new THREE.Vector3();
const _wristTarget = new THREE.Vector3();
const _toWrist = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _poleRaw = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _rigRight = new THREE.Vector3();
const _rigBack = new THREE.Vector3();
const _rigUp = new THREE.Vector3(0, 1, 0);
const _uY = new THREE.Vector3();
const _lY = new THREE.Vector3();
const _xAxis = new THREE.Vector3();
const _zAxis = new THREE.Vector3();
const _bendHint = new THREE.Vector3();
const _handForward = new THREE.Vector3();
const _handInward = new THREE.Vector3();
const _rotMat = new THREE.Matrix4();
const _targetWorldQuat = new THREE.Quaternion();
const _parentWorldQuat = new THREE.Quaternion();
const _wristLocalEuler = new THREE.Euler();
const _headEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const _bodyQuat = new THREE.Quaternion();
const _torsoOffset = new THREE.Vector3();

function setBoneWorldBasis(
  bone: THREE.Object3D,
  xAxis: THREE.Vector3,
  yAxis: THREE.Vector3,
  zAxis: THREE.Vector3
): void {
  _rotMat.makeBasis(xAxis, yAxis, zAxis);
  _targetWorldQuat.setFromRotationMatrix(_rotMat);
  if (bone.parent) {
    bone.parent.getWorldQuaternion(_parentWorldQuat);
    bone.quaternion.copy(_parentWorldQuat).invert().multiply(_targetWorldQuat);
  } else {
    bone.quaternion.copy(_targetWorldQuat);
  }
  bone.updateMatrixWorld(true);
}

export class GorillaPlayerRig {
  public readonly group = new THREE.Group();
  private readonly modelWrapper = new THREE.Group();
  private readonly modelRoot: THREE.Group;
  private readonly rigScale: number;
  private readonly isLocalFirstPerson: boolean;

  private readonly mainBone: THREE.Object3D | null;
  private readonly headBone: THREE.Object3D | null;
  private faceOverlayMesh: THREE.Object3D | null = null;
  private readonly leftArm: ArmChain | null;
  private readonly rightArm: ArmChain | null;

  private readonly furMaterials: THREE.MeshStandardMaterial[] = [];
  private readonly allMaterials: THREE.MeshStandardMaterial[] = [];
  private readonly originalColors = new Map<THREE.MeshStandardMaterial, THREE.Color>();
  private readonly originalMaps = new Map<THREE.MeshStandardMaterial, THREE.Texture | null>();
  private readonly originalEmissives = new Map<THREE.MeshStandardMaterial, THREE.Color>();

  private currentBrightness = 1.0;
  private currentTintHex = '#ffffff';
  private bodyYaw = 0;

  constructor(template: THREE.Group, options: { isLocalFirstPerson: boolean; furColorHex?: string }) {
    this.isLocalFirstPerson = options.isLocalFirstPerson;
    this.rigScale = 1.12;

    this.group.name = options.isLocalFirstPerson ? 'LocalGorillaPlayerRig' : 'RemoteGorillaPlayerRig';
    this.modelRoot = SkeletonUtils.clone(template) as THREE.Group;

    // Rotate 180 deg around Y so the Gorilla faces -Z (Three.js forward)
    this.modelWrapper.rotation.y = Math.PI;
    this.modelWrapper.scale.setScalar(this.rigScale);
    this.modelWrapper.add(this.modelRoot);
    this.group.add(this.modelWrapper);

    // Collect & prepare materials and handle first-person head culling
    this.modelRoot.traverse((child) => {
      if (child instanceof THREE.SkinnedMesh || child instanceof THREE.Mesh) {
        child.castShadow = true;
        child.receiveShadow = true;
        child.frustumCulled = false;

        // Hide face overlay mesh for local player so it never blocks camera
        if (options.isLocalFirstPerson && child.name === 'Object_7') {
          child.visible = false;
          this.faceOverlayMesh = child;
        }

        const mats = Array.isArray(child.material) ? child.material : [child.material];
        const cloned = mats.map((m) => {
          if (!m) return m;
          const std = m.clone() as THREE.MeshStandardMaterial;
          std.side = THREE.DoubleSide;
          if (!this.originalColors.has(std)) {
            this.originalColors.set(std, std.color ? std.color.clone() : new THREE.Color(0xffffff));
            this.originalMaps.set(std, std.map || null);
            this.originalEmissives.set(std, std.emissive ? std.emissive.clone() : new THREE.Color(0x000000));
            this.allMaterials.push(std);
            if (std.name === 'Material.004' || child.name === 'Object_9') {
              this.furMaterials.push(std);
            }
          }
          std.needsUpdate = true;
          return std;
        });
        child.material = Array.isArray(child.material) ? cloned : cloned[0];
      }
    });

    if (options.furColorHex) {
      this.setFurColor(options.furColorHex);
    }

    this.mainBone = this.modelRoot.getObjectByName('Main_13') || null;
    this.headBone = this.modelRoot.getObjectByName('Head_0') || null;

    if (this.isLocalFirstPerson && this.headBone) {
      // Collapse head geometry cleanly out of the first-person camera view while keeping chest & arms full-sized
      this.headBone.scale.setScalar(0.0001);
    }

    this.leftArm = this.buildArmChain('left');
    this.rightArm = this.buildArmChain('right');
    this.group.updateMatrixWorld(true);
  }

  private findBone(...names: string[]): THREE.Object3D | undefined {
    for (const name of names) {
      const found = this.modelRoot.getObjectByName(name);
      if (found) return found;
    }
    return undefined;
  }

  private buildArmChain(side: 'left' | 'right'): ArmChain | null {
    const upper =
      side === 'left'
        ? this.findBone('Upper_Arm_L_12', 'Upper Arm L_12')
        : this.findBone('Upper_Arm_R_6', 'Upper Arm R_6');
    const lower =
      side === 'left'
        ? this.findBone('Lower_Arm_L_11', 'Lower Arm L_11')
        : this.findBone('Lower_Arm_R_5', 'Lower Arm R_5');
    const wrist =
      side === 'left'
        ? this.findBone('Wrist_L_10', 'Wrist L_10')
        : this.findBone('Wrist_R_4', 'Wrist R_4');
    if (!upper || !lower || !wrist) return null;

    const fingerSpecs: { names: string[]; kind: FingerKind }[] =
      side === 'left'
        ? [
            { names: ['PinkyF_L_7', 'PinkyF L_7'], kind: 'pinky' },
            { names: ['Pointer_L_8', 'Pointer L_8'], kind: 'pointer' },
            { names: ['Thumb_L_9', 'Thumb L_9'], kind: 'thumb' },
          ]
        : [
            { names: ['PinkyF_R_1', 'PinkyF R_1'], kind: 'pinky' },
            { names: ['PointerF_R_2', 'PointerF R_2'], kind: 'pointer' },
            { names: ['Thumb_R_3', 'Thumb R_3'], kind: 'thumb' },
          ];

    const fingers: ArmChain['fingers'] = [];
    for (const spec of fingerSpecs) {
      const bone = this.findBone(...spec.names);
      if (bone) {
        fingers.push({
          bone,
          restQuat: bone.quaternion.clone(),
          kind: spec.kind,
        });
      }
    }

    return {
      side,
      upper,
      lower,
      wrist,
      fingers,
      upperLen: Math.max(0.1, lower.position.length() * this.rigScale),
      lowerLen: Math.max(0.1, wrist.position.length() * this.rigScale),
      fingerState: { grip: 0.14, trigger: 0.1, thumb: 0.08 },
    };
  }

  public setFurColor(hex: string): void {
    this.currentTintHex = hex || '#ffffff';
    this.reapplyColorsAndBrightness();
  }

  public setBrightness(brightness: number): void {
    this.currentBrightness = Math.max(0.1, Math.min(1.5, Number.isFinite(brightness) ? brightness : 1.0));
    this.reapplyColorsAndBrightness();
  }

  public setThirdPersonReveal(reveal: boolean): void {
    if (!this.isLocalFirstPerson) return;
    if (this.headBone) {
      this.headBone.scale.setScalar(reveal ? 1.0 : 0.0001);
    }
    if (this.faceOverlayMesh) {
      this.faceOverlayMesh.visible = reveal;
    }
  }

  public async applyCustomTextureAndTint(
    textureDataUrl: string | null,
    tintColor: string,
    flipY: boolean,
    brightness: number
  ): Promise<void> {
    this.currentTintHex = tintColor || '#ffffff';
    this.currentBrightness = Math.max(0.1, Math.min(1.5, Number.isFinite(brightness) ? brightness : 1.0));

    let loadedTex: THREE.Texture | null = null;
    if (textureDataUrl) {
      const loader = new THREE.TextureLoader();
      loadedTex = await new Promise<THREE.Texture>((resolve, reject) => {
        loader.load(
          textureDataUrl,
          (tex) => {
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.wrapS = THREE.RepeatWrapping;
            tex.wrapT = THREE.RepeatWrapping;
            tex.flipY = flipY;
            tex.needsUpdate = true;
            resolve(tex);
          },
          undefined,
          () => reject(new Error('Failed to load texture image.'))
        );
      });
    }

    for (const mat of this.furMaterials) {
      const origMap = this.originalMaps.get(mat) || null;
      if (loadedTex) {
        if (mat.map && mat.map !== origMap) mat.map.dispose();
        mat.map = loadedTex.clone();
        mat.map.needsUpdate = true;
      } else {
        if (mat.map && mat.map !== origMap) mat.map.dispose();
        mat.map = origMap;
      }
      mat.needsUpdate = true;
    }

    if (loadedTex) loadedTex.dispose();
    this.reapplyColorsAndBrightness();
  }

  private reapplyColorsAndBrightness(): void {
    const b = this.currentBrightness;
    const tint = new THREE.Color(this.currentTintHex || '#ffffff');

    for (const mat of this.allMaterials) {
      const isFur = this.furMaterials.includes(mat);
      const orig = this.originalColors.get(mat) || new THREE.Color(0xffffff);
      const base = isFur && this.currentTintHex.toLowerCase() !== '#ffffff' ? tint : orig;

      mat.color.setRGB(base.r * b, base.g * b, base.b * b);

      if (b > 1.0) {
        const boost = (b - 1.0) * 0.25;
        mat.emissive.setRGB(base.r * boost, base.g * boost, base.b * boost);
      } else {
        const origEmissive = this.originalEmissives.get(mat);
        if (origEmissive) mat.emissive.copy(origEmissive);
      }
      mat.needsUpdate = true;
    }
  }

  public updatePose(params: {
    dt: number;
    headWorldPos: THREE.Vector3;
    headYaw: number;
    headPitch: number;
    leftHandWorldPos: THREE.Vector3;
    rightHandWorldPos: THREE.Vector3;
    leftHandWorldQuat?: THREE.Quaternion;
    rightHandWorldQuat?: THREE.Quaternion;
    leftContact: boolean;
    rightContact: boolean;
    leftFingers?: HandFingerPose;
    rightFingers?: HandFingerPose;
  }): void {
    const {
      dt,
      headWorldPos,
      headYaw,
      headPitch,
      leftHandWorldPos,
      rightHandWorldPos,
      leftHandWorldQuat,
      rightHandWorldQuat,
      leftContact,
      rightContact,
      leftFingers,
      rightFingers,
    } = params;

    // Smooth torso yaw toward head yaw so chest & shoulders follow naturally
    let yawDiff = headYaw - this.bodyYaw;
    while (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
    while (yawDiff < -Math.PI) yawDiff += Math.PI * 2;
    this.bodyYaw += yawDiff * Math.min(1, dt * 10);

    // Position the Gorilla root so Head_0 aligns at headWorldPos
    // In local first-person, nudge chest slightly back/down so chest never clips camera
    const headHeightFromRoot = 0.40 * this.rigScale;
    const backShift = this.isLocalFirstPerson ? 0.06 : 0.0;
    _torsoOffset.set(Math.sin(this.bodyYaw) * backShift, -headHeightFromRoot, Math.cos(this.bodyYaw) * backShift);

    this.group.position.copy(headWorldPos).add(_torsoOffset);
    _bodyQuat.setFromAxisAngle(_rigUp, this.bodyYaw);
    this.group.quaternion.copy(_bodyQuat);
    this.group.updateMatrixWorld(true);

    // Rotate Head_0 for remote players
    if (this.headBone && !this.isLocalFirstPerson) {
      const localYaw = headYaw - this.bodyYaw;
      // Note modelWrapper is rotated 180 deg Y, so head pitch sign stays consistent with camera pitch
      _headEuler.set(-headPitch * 0.85, localYaw, 0, 'YXZ');
      this.headBone.quaternion.setFromEuler(_headEuler);
      this.headBone.updateMatrixWorld(true);
    }

    // Torso horizontal basis vectors in world space (player forward is -Z rotated by bodyYaw)
    _rigRight.set(Math.cos(this.bodyYaw), 0, -Math.sin(this.bodyYaw)).normalize();
    _rigBack.set(Math.sin(this.bodyYaw), 0, Math.cos(this.bodyYaw)).normalize();

    if (this.leftArm) {
      this.solveArmIK(this.leftArm, leftHandWorldPos, leftHandWorldQuat, leftContact, leftFingers, dt);
    }
    if (this.rightArm) {
      this.solveArmIK(this.rightArm, rightHandWorldPos, rightHandWorldQuat, rightContact, rightFingers, dt);
    }
  }

  private solveArmIK(
    arm: ArmChain,
    handWorldPos: THREE.Vector3,
    handWorldQuat: THREE.Quaternion | undefined,
    inContact: boolean,
    fingerTarget: HandFingerPose | undefined,
    dt: number
  ): void {
    const isLeft = arm.side === 'left';
    const sideSign = isLeft ? -1 : 1;

    arm.upper.getWorldPosition(_shoulderPos);

    // Place wrist slightly back from palm/finger contact sphere so knuckles land cleanly on handWorldPos
    if (handWorldQuat) {
      _handForward.set(0, 0, -1).applyQuaternion(handWorldQuat).normalize();
    } else {
      _handForward.copy(handWorldPos).sub(_shoulderPos);
      if (_handForward.lengthSq() < 1e-5) {
        _handForward.copy(_rigBack).negate();
      } else {
        _handForward.normalize();
      }
    }

    _wristTarget.copy(handWorldPos).addScaledVector(_handForward, -0.068 * this.rigScale);
    _toWrist.copy(_wristTarget).sub(_shoulderPos);

    const rawDist = _toWrist.length();
    const minDist = 0.08;
    const maxDist = (arm.upperLen + arm.lowerLen) * 0.996;
    const dist = Math.max(minDist, Math.min(maxDist, rawDist));

    if (rawDist > 1e-5) {
      _dir.copy(_toWrist).divideScalar(rawDist);
    } else {
      _dir.set(0, -1, 0);
    }

    // Pole vector: Gorilla elbows flare outward, backward, and slightly downward
    _poleRaw
      .set(0, -0.32, 0)
      .addScaledVector(_rigRight, sideSign * 0.85)
      .addScaledVector(_rigBack, 0.72);

    // Orthogonalize pole against shoulder-to-wrist direction
    _pole.copy(_poleRaw).addScaledVector(_dir, -_poleRaw.dot(_dir));
    if (_pole.lengthSq() < 1e-4) {
      _pole.set(sideSign, 0, 1).addScaledVector(_dir, -_dir.z);
    }
    _pole.normalize();

    // Analytic 2-bone IK Law of Cosines
    const l1 = arm.upperLen;
    const l2 = arm.lowerLen;
    const cosA = Math.max(-1, Math.min(1, (l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist)));
    const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));

    _elbowPos
      .copy(_shoulderPos)
      .addScaledVector(_dir, l1 * cosA)
      .addScaledVector(_pole, l1 * sinA);

    // 1. Orient Upper Arm (+Y along shoulder -> elbow, +Z opposite pole toward bend inside)
    _uY.copy(_elbowPos).sub(_shoulderPos).normalize();
    _bendHint.copy(_pole).negate();
    _xAxis.crossVectors(_uY, _bendHint);
    if (_xAxis.lengthSq() < 1e-5) {
      _xAxis.crossVectors(_uY, _rigUp);
    }
    _xAxis.normalize();
    _zAxis.crossVectors(_xAxis, _uY).normalize();
    setBoneWorldBasis(arm.upper, _xAxis, _uY, _zAxis);

    // 2. Orient Lower Arm (+Y along elbow -> wrist, +Z aligned to bend plane)
    arm.lower.getWorldPosition(_elbowPos);
    _lY.copy(_wristTarget).sub(_elbowPos);
    if (_lY.lengthSq() < 1e-5) {
      _lY.copy(_uY);
    } else {
      _lY.normalize();
    }
    _bendHint.copy(_pole).negate();
    _xAxis.crossVectors(_lY, _bendHint);
    if (_xAxis.lengthSq() < 1e-5) {
      _xAxis.crossVectors(_lY, _rigUp);
    }
    _xAxis.normalize();
    _zAxis.crossVectors(_xAxis, _lY).normalize();
    setBoneWorldBasis(arm.lower, _xAxis, _lY, _zAxis);

    // 3. Orient Wrist / Hand
    // Right wrist: local +Y = fingers forward, local +Z = thumb/inward (-right), local +X = back of hand
    // Left wrist:  local +Y = fingers forward, local +Z = thumb/inward (+right), local -X = back of hand
    if (handWorldQuat) {
      _handForward.set(0, 0, -1).applyQuaternion(handWorldQuat).normalize();
      _handInward.set(-sideSign, 0, 0).applyQuaternion(handWorldQuat).normalize();
    } else {
      // Desktop: fingers angle forward & slightly downward along arm reach, thumbs inward
      _handForward.copy(_lY).lerp(_rigBack.clone().negate(), 0.45).normalize();
      _handInward.copy(_rigRight).multiplyScalar(-sideSign);
    }

    // Ensure _handInward is orthogonal to _handForward
    _zAxis.copy(_handInward).addScaledVector(_handForward, -_handInward.dot(_handForward));
    if (_zAxis.lengthSq() < 1e-4) {
      _zAxis.copy(_rigRight).multiplyScalar(-sideSign);
    }
    _zAxis.normalize();
    _xAxis.crossVectors(_handForward, _zAxis).normalize();
    _zAxis.crossVectors(_xAxis, _handForward).normalize();
    setBoneWorldBasis(arm.wrist, _xAxis, _handForward, _zAxis);

    // 4. Animate individual finger curl from VR Grip / Trigger / Thumb inputs (or contact fallback)
    const fallbackGrip = inContact ? 0.85 : 0.14;
    const targetGrip = fingerTarget ? fingerTarget.grip : fallbackGrip;
    const targetTrigger = fingerTarget ? fingerTarget.trigger : inContact ? 0.72 : 0.1;
    const targetThumb = fingerTarget ? fingerTarget.thumb : inContact ? 0.55 : 0.08;

    const fingerLerp = Math.min(1, dt * 20);
    arm.fingerState.grip += (targetGrip - arm.fingerState.grip) * fingerLerp;
    arm.fingerState.trigger += (targetTrigger - arm.fingerState.trigger) * fingerLerp;
    arm.fingerState.thumb += (targetThumb - arm.fingerState.thumb) * fingerLerp;

    const curlSign = isLeft ? -1 : 1;
    for (const f of arm.fingers) {
      let curlAngle = 0;
      if (f.kind === 'pinky') {
        curlAngle = (0.12 + arm.fingerState.grip * 1.12) * curlSign;
      } else if (f.kind === 'pointer') {
        curlAngle = (0.08 + arm.fingerState.trigger * 1.08) * curlSign;
      } else {
        curlAngle = (0.06 + arm.fingerState.thumb * 0.74) * curlSign;
      }
      _wristLocalEuler.set(0, 0, curlAngle);
      _targetWorldQuat.setFromEuler(_wristLocalEuler);
      f.bone.quaternion.copy(f.restQuat).multiply(_targetWorldQuat);
    }
  }

  public dispose(): void {
    this.modelRoot.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry?.dispose();
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        for (const m of mats) {
          if (!m) continue;
          const std = m as THREE.MeshStandardMaterial;
          const origMap = this.originalMaps.get(std);
          if (std.map && std.map !== origMap) {
            std.map.dispose();
          }
          std.dispose();
        }
      }
    });
  }
}
