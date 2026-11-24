import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { HotelWorld } from './hotelWorld';
import { createKnifeModel, KnifeVisualRig } from './knifeModel';
import { createMonkeyHand, MonkeyHandRig } from './monkeyHands';
import { DesktopInputState, GorillaPhysicsEngine, PhysicsPreset } from './physics';
import { ProceduralAudio } from './audio';
import {
  GamePhase,
  KnifeThrownEvent,
  MultiplayerClient,
  MultiplayerStatus,
  PlayerGameRole,
  PlayerKilledEvent,
  RoomGameState,
} from './multiplayer';
import { KillEditManager, KillEditPhase } from './killEditManager';
import { MicState, VoiceStatus } from './voiceChat';
import {
  analyzeHandOrientationWithAI,
  applyCustomHandTransform,
  clearSavedFinalizedHand,
  CustomHandTransform,
  finalizeHandConfiguration,
  loadRemoteAssetsByIds,
  loadSavedFinalizedHand,
  parseHandModelFromArrayBuffer,
  parseHandModelFromFile,
  updateSavedBrightnessLocally,
  UploadedHandRef,
  uploadHandModelForMultiplayer,
  uploadHandTextureForMultiplayer,
} from './customHandLoader';
import { GorillaPlayerRig, HandFingerPose, preloadGorillaPlayerTemplate } from './gorillaPlayerRig';
import { VRRoomWristUI } from './vrRoomWristUI';
import type { FirebaseHandConfig } from '../firebase';

export interface SandboxRoomUiCallbacks {
  onOpenWristKeyboard?: () => void;
  onCloseWristKeyboard?: () => void;
  onRoomDraftChange?: (code: string) => void;
  onRoomSwitched?: (roomCode: string) => void;
  onAutoJoined?: (username: string) => void;
}

export interface SandboxTelemetry {
  altitude: number;
  speed: number;
  chunks: number;
  isVR: boolean;
  isPointerLocked: boolean;
  leftContact: boolean;
  rightContact: boolean;
  contextLost: boolean;
  playersOnline: number;
  mpConnected: boolean;
  room: string;
  username: string;
  micState: MicState;
  isSpeaking: boolean;
  voiceError: string | null;
  hasCustomLeftHand: boolean;
  hasCustomRightHand: boolean;
  isHandFinalized: boolean;
  isHandLocked: boolean;
  gamePhase: GamePhase;
  gameRole: PlayerGameRole;
  gameTimeLeftSec: number;
  gameWinner: 'murderer' | 'innocent' | null;
  gameEndReason: string;
  gameNotice: string | null;
  isPracticeMode: boolean;
  knifeCooldownSec: number;
  superJumpCooldownSec: number;
  killEditActive: boolean;
  killEditPhase: KillEditPhase | null;
  killEditCutIndex: number;
  killEditTotalCuts: number;
  killEditFlash: number;
  killEditTimeLeftSec: number;
  killEditKillerName: string;
  killEditVictimName: string;
  dummyKills: number;
}

const _camLocalPos = new THREE.Vector3();
const _camRigLocal = new THREE.Vector3();
const _tmpHeadBefore = new THREE.Vector3();
const _tmpHeadAfter = new THREE.Vector3();
const _turnUp = new THREE.Vector3(0, 1, 0);
const _turnQuat = new THREE.Quaternion();
const _headWorldPos = new THREE.Vector3();
const _headEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const _ctrlWorldQuat = new THREE.Quaternion();
const _desktopEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const _rightTipOffset = new THREE.Vector3(0.012, -0.004, -0.088);
const _rightTipWorldPos = new THREE.Vector3();
const _tipInstVel = new THREE.Vector3();
const _tipAimDir = new THREE.Vector3();
const _knifeThrowVel = new THREE.Vector3();
const _knifeTargetBody = new THREE.Vector3();
const _knifeForward = new THREE.Vector3(0, 0, -1);
const _knifeDirNorm = new THREE.Vector3();

interface ActiveThrownKnife {
  id: string;
  throwerId: string;
  rig: KnifeVisualRig;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  stuck: boolean;
  spinAngle: number;
  life: number;
}

function detectSoftwareWebGL(): boolean {
  try {
    const probeCanvas = document.createElement('canvas');
    const gl = probeCanvas.getContext('webgl2') || probeCanvas.getContext('webgl');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param) || '');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return false;
  }
}

export class SandboxEngine {
  public readonly renderer: THREE.WebGLRenderer;
  public readonly scene: THREE.Scene;
  public readonly camera: THREE.PerspectiveCamera;
  public readonly playerRig: THREE.Group;
  public readonly xrTrackingGroup: THREE.Group;
  public readonly vrButton: HTMLElement;
  public readonly audio = new ProceduralAudio();
  public readonly hotel: HotelWorld;
  public readonly physics: GorillaPhysicsEngine;
  public readonly multiplayer: MultiplayerClient;

  private readonly container: HTMLElement;
  private readonly isSoftwareGl: boolean;
  private readonly moonLight: THREE.DirectionalLight;
  private readonly playerFlashLight: THREE.PointLight;
  private readonly leftHandMesh: MonkeyHandRig;
  private readonly rightHandMesh: MonkeyHandRig;
  private readonly localKnifeRig: KnifeVisualRig;
  private readonly roomWristUi: VRRoomWristUI;
  private playerModelRig: GorillaPlayerRig | null = null;
  private pendingBrightness = 1.0;

  private readonly activeKnives: ActiveThrownKnife[] = [];
  private readonly killEdit: KillEditManager;
  private practiceDummyGroup: THREE.Group | null = null;
  private practiceDummyPos = new THREE.Vector3(0, 0.25, -2.6);
  private dummyAlive = true;
  private dummyRespawnTimer = 0;
  private dummyKills = 0;
  private meleeCooldown = 0;
  private readonly prevRightTipWorldPos = new THREE.Vector3();
  private readonly smoothedTipVelocity = new THREE.Vector3();
  private hasPrevRightTip = false;
  private rightTriggerWasHeld = false;
  private rightAButtonWasDown = false;
  private knifeCooldown = 0;
  private superJumpCooldown = 0;
  private clockOffsetMs = 0;
  private lastGameRoundId = -1;
  private lastGamePhase: GamePhase = 'lobby';
  private gameNotice: string | null = null;
  private gameNoticeTimer = 0;

  private readonly controller0: THREE.XRTargetRaySpace;
  private readonly controller1: THREE.XRTargetRaySpace;
  private leftController: THREE.XRTargetRaySpace | null = null;
  private rightController: THREE.XRTargetRaySpace | null = null;

  private vrTurnYaw = 0;
  private readonly leftFingerPose: HandFingerPose = { grip: 0.14, trigger: 0.1, thumb: 0.08 };
  private readonly rightFingerPose: HandFingerPose = { grip: 0.14, trigger: 0.1, thumb: 0.08 };

  private readonly desktopState: DesktopInputState = {
    yaw: 0,
    pitch: -0.18,
    leftMouseDown: false,
    rightMouseDown: false,
    leftPullOffset: 0,
    rightPullOffset: 0,
    slamTimer: 0,
  };

  private readonly clock = new THREE.Clock();
  private readonly onTelemetry: (t: SandboxTelemetry) => void;
  private readonly roomUiCallbacks?: SandboxRoomUiCallbacks;
  private telemetryAccum = 0;
  private frameTimerId = 0;
  private disposed = false;
  private isContextLost = false;
  private isDraggingFallback = false;
  private maxStandingHeadY = 0;
  private mpStatus: MultiplayerStatus = {
    connected: false,
    room: 'SANDBOX',
    playerId: null,
    username: '',
    playerCount: 1,
    seed: null,
  };
  private voiceStatus: VoiceStatus = {
    micState: 'off',
    isSpeaking: false,
    connectedPeers: 0,
    errorMessage: null,
  };
  private sessionJoined = false;
  private activeCustomModel: {
    buffer: ArrayBuffer;
    ext: string;
    fileName: string;
    target: 'both' | 'left' | 'right';
    modelId: string | null;
    textureDataUrl: string | null;
    textureId: string | null;
    tintColor: string;
    brightness: number;
    flipTextureY: boolean;
    transform: CustomHandTransform;
  } | null = null;
  private isHandFinalized = false;
  private isHandLocked = false;
  private onFinalizedRestoredCb?: (restored: {
    target: 'both' | 'left' | 'right';
    transform: CustomHandTransform;
    textureDataUrl: string | null;
    tintColor: string;
    brightness: number;
    flipTextureY: boolean;
    locked: boolean;
  }) => void;

  constructor(
    container: HTMLElement,
    vrMount: HTMLElement,
    roomId: string,
    initialSeed: number,
    onTelemetry: (t: SandboxTelemetry) => void,
    onFinalizedRestored?: (restored: {
      target: 'both' | 'left' | 'right';
      transform: CustomHandTransform;
      textureDataUrl: string | null;
      tintColor: string;
      brightness: number;
      flipTextureY: boolean;
      locked: boolean;
    }) => void,
    roomUiCallbacks?: SandboxRoomUiCallbacks
  ) {
    this.container = container;
    this.onTelemetry = onTelemetry;
    this.onFinalizedRestoredCb = onFinalizedRestored;
    this.roomUiCallbacks = roomUiCallbacks;
    this.isSoftwareGl = detectSoftwareWebGL();

    // 1. Renderer setup (WebXR + ACES Filmic + Software-WebGL guard)
    this.renderer = new THREE.WebGLRenderer({
      antialias: !this.isSoftwareGl,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.02;
    this.renderer.setPixelRatio(this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight);
    this.renderer.shadowMap.enabled = !this.isSoftwareGl;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType('local-floor');

    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    container.appendChild(this.renderer.domElement);

    // 2. Scary Haunted Hotel Atmosphere, Fog & Moonlit Reflections
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0c12);
    this.scene.fog = new THREE.FogExp2(0x0a0c12, 0.032);

    // Procedural Studio Environment Map (RoomEnvironment) for realistic metallic knife & brass
    const pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
    pmremGenerator.dispose();

    // 3. Camera, XR Tracking Offset Group & Player Rig
    const aspect = (container.clientWidth || window.innerWidth) / (container.clientHeight || window.innerHeight);
    this.camera = new THREE.PerspectiveCamera(75, aspect, 0.08, 160);
    this.camera.position.set(0, 1.05, 0);

    this.playerRig = new THREE.Group();
    this.playerRig.name = 'PlayerRig';
    this.playerRig.position.set(0, 0.25, 6.5);

    this.xrTrackingGroup = new THREE.Group();
    this.xrTrackingGroup.name = 'XRTrackingGroup';
    this.xrTrackingGroup.add(this.camera);
    this.playerRig.add(this.xrTrackingGroup);
    this.scene.add(this.playerRig);

    // 4. Eerie Moonlit Fill + Player Exploration Lantern
    const hemiLight = new THREE.HemisphereLight(0x566987, 0x1b110f, 0.62);
    hemiLight.position.set(0, 30, 0);
    this.scene.add(hemiLight);

    this.moonLight = new THREE.DirectionalLight(0x9fb8e8, 0.55);
    this.moonLight.position.set(22, 36, 18);
    this.moonLight.castShadow = !this.isSoftwareGl;
    this.moonLight.shadow.mapSize.width = 1024;
    this.moonLight.shadow.mapSize.height = 1024;
    this.moonLight.shadow.camera.near = 2;
    this.moonLight.shadow.camera.far = 90;
    const d = 28;
    this.moonLight.shadow.camera.left = -d;
    this.moonLight.shadow.camera.right = d;
    this.moonLight.shadow.camera.top = d;
    this.moonLight.shadow.camera.bottom = -d;
    this.moonLight.shadow.bias = -0.0005;
    this.moonLight.shadow.normalBias = 0.025;
    this.scene.add(this.moonLight);
    this.scene.add(this.moonLight.target);

    this.playerFlashLight = new THREE.PointLight(0xffe0b2, 1.85, 13, 1.5);
    this.scene.add(this.playerFlashLight);

    // 5. Massive Creepy Maze Hotel World
    const maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    this.hotel = new HotelWorld(maxAniso, !this.isSoftwareGl);
    this.scene.add(this.hotel.group);

    // 6. Physics Engine & Full Gorilla Tag Player Model
    this.physics = new GorillaPhysicsEngine(this.playerRig, this.hotel, this.audio);
    this.leftHandMesh = createMonkeyHand('left');
    this.rightHandMesh = createMonkeyHand('right');
    this.scene.add(this.leftHandMesh.group);
    this.scene.add(this.rightHandMesh.group);

    // Murderer Placeholder 3D Knife held in right hand
    this.localKnifeRig = createKnifeModel(1.08);
    this.localKnifeRig.group.visible = false;
    this.scene.add(this.localKnifeRig.group);

    // Kill Edit Sequencer (3D Skull Emoji, Slow-Mo Knife Impact, Tough Killer Cuts)
    this.killEdit = new KillEditManager(() => {
      this.audio.stopKillEditMusic();
      this.playerModelRig?.setThirdPersonReveal(false);
      this.killEdit.restoreCamera(this.camera);
      if (!this.dummyAlive) {
        this.respawnPracticeDummy();
      }
      this.emitTelemetry();
    });
    this.scene.add(this.killEdit.root);

    // Solo practice / singleplayer mannequin target (constantly respawns)
    this.buildPracticeDummy();

    void preloadGorillaPlayerTemplate()
      .then((template) => {
        if (this.disposed) return;
        const rig = new GorillaPlayerRig(template, { isLocalFirstPerson: true });
        rig.setBrightness(this.pendingBrightness);
        if (this.activeCustomModel && (this.activeCustomModel.textureDataUrl || this.activeCustomModel.tintColor.toLowerCase() !== '#ffffff')) {
          void rig.applyCustomTextureAndTint(
            this.activeCustomModel.textureDataUrl,
            this.activeCustomModel.tintColor,
            this.activeCustomModel.flipTextureY,
            this.pendingBrightness
          );
        }
        this.playerModelRig = rig;
        this.scene.add(rig.group);
        this.leftHandMesh.group.visible = false;
        this.rightHandMesh.group.visible = false;
      })
      .catch((err) => {
        console.warn('Gorilla player GLB fallback to procedural hands:', err);
      });

    // 8. Real-Time WebSocket Multiplayer & Hotel Murder Mystery Sync
    const normalizedRoom = roomId.toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 16) || 'SANDBOX';
    this.mpStatus.room = normalizedRoom;
    this.multiplayer = new MultiplayerClient(
      normalizedRoom,
      '',
      (status) => {
        this.mpStatus = status;
        this.emitTelemetry();
      },
      (voice) => {
        this.voiceStatus = voice;
        this.emitTelemetry();
      },
      () => {
        // Fixed Haunted Hotel layout per room; no voxel seed swap needed
      },
      {
        onGameState: (game) => this.handleServerGameState(game),
        onKnifeThrown: (ev) => this.spawnThrownKnife(ev),
        onPlayerKilled: (ev) => this.handleRemotePlayerKilled(ev),
        onSuperJumped: () => {
          this.audio.playSuperJump();
        },
        onGameNotice: (message) => {
          this.gameNotice = message;
          this.gameNoticeTimer = 5.0;
          this.roomWristUi.showBanner('HOTEL LOBBY', message, '#fbbf24', 3.5);
          this.emitTelemetry();
        },
      }
    );
    this.scene.add(this.multiplayer.group);

    // 8b. Left Wrist Room Watch & Spatial 3D VR Keyboard
    this.roomWristUi = new VRRoomWristUI({
      onRequestKeyboardOpen: () => {
        this.roomUiCallbacks?.onOpenWristKeyboard?.();
      },
      onSubmitRoomCode: (code) => {
        this.switchRoom(code);
      },
      onDraftCodeChange: (code) => {
        this.roomUiCallbacks?.onRoomDraftChange?.(code);
      },
      onKeyboardClosed: () => {
        this.roomUiCallbacks?.onCloseWristKeyboard?.();
      },
      onPlayTap: (pitch) => {
        this.audio.playUiTap(pitch);
      },
      onPulseHaptic: (strength, durationMs) => {
        this.pulseRightHaptic(strength, durationMs);
      },
      onRequestStartMatch: () => {
        this.startHotelMatch(this.mpStatus.playerCount < 2);
      },
    });
    this.scene.add(this.roomWristUi.root);

    // 8. WebXR Controllers (mounted inside xrTrackingGroup so VR head & controllers share tracking offset)
    this.controller0 = this.renderer.xr.getController(0);
    this.controller1 = this.renderer.xr.getController(1);
    this.xrTrackingGroup.add(this.controller0);
    this.xrTrackingGroup.add(this.controller1);
    this.leftController = this.controller0;
    this.rightController = this.controller1;

    this.controller0.addEventListener('connected', (ev) => this.handleControllerConnected(this.controller0, ev));
    this.controller1.addEventListener('connected', (ev) => this.handleControllerConnected(this.controller1, ev));
    this.controller0.addEventListener('disconnected', () => this.handleControllerDisconnected(this.controller0));
    this.controller1.addEventListener('disconnected', () => this.handleControllerDisconnected(this.controller1));

    // 9. Prominent Three.js VRButton
    this.vrButton = VRButton.createButton(this.renderer);
    this.styleVRButton(this.vrButton);
    vrMount.appendChild(this.vrButton);

    // Pre-compile shaders on hardware GPUs
    if (!this.isSoftwareGl) {
      this.renderer.compile(this.scene, this.camera);
    }

    // 10. Event Listeners & Render Loop
    this.bindEvents();
    this.startLoop();

    // 11. Auto-restore finalized hand model if previously saved
    void this.restoreFinalizedHand(onFinalizedRestored);
  }

  private styleVRButton(btn: HTMLElement): void {
    btn.style.position = 'static';
    btn.style.bottom = 'auto';
    btn.style.left = 'auto';
    btn.style.transform = 'none';
    btn.style.width = 'auto';
    btn.style.minWidth = '144px';
    btn.style.padding = '10px 18px';
    btn.style.borderRadius = '10px';
    btn.style.border = '1px solid rgba(14, 165, 233, 0.45)';
    btn.style.background = '#0284c7';
    btn.style.color = '#ffffff';
    btn.style.fontFamily = "'Plus Jakarta Sans', sans-serif";
    btn.style.fontSize = '13px';
    btn.style.fontWeight = '600';
    btn.style.letterSpacing = '0.01em';
    btn.style.opacity = '1';
    btn.style.cursor = 'pointer';
    btn.style.boxShadow = '0 4px 12px rgba(2, 132, 199, 0.25)';
  }

  private handleControllerConnected(ctrl: THREE.XRTargetRaySpace, ev: THREE.Event & { data?: XRInputSource }): void {
    const src = ev.data;
    if (!src) return;
    if (src.handedness === 'left') {
      this.leftController = ctrl;
      this.physics.leftHand.xrInputSource = src;
    } else if (src.handedness === 'right') {
      this.rightController = ctrl;
      this.physics.rightHand.xrInputSource = src;
    } else if (ctrl === this.controller0) {
      this.leftController = ctrl;
      this.physics.leftHand.xrInputSource = src;
    } else {
      this.rightController = ctrl;
      this.physics.rightHand.xrInputSource = src;
    }
  }

  private handleControllerDisconnected(ctrl: THREE.XRTargetRaySpace): void {
    if (ctrl === this.leftController) {
      this.physics.leftHand.xrInputSource = null;
      this.physics.leftHand.isLocked = false;
    }
    if (ctrl === this.rightController) {
      this.physics.rightHand.xrInputSource = null;
      this.physics.rightHand.isLocked = false;
    }
  }

  private bindEvents(): void {
    window.addEventListener('resize', this.onResize);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);

    const canvas = this.renderer.domElement;
    canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    canvas.addEventListener('contextmenu', this.onContextMenu);
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);

    this.renderer.xr.addEventListener('sessionstart', this.onXRSessionChange);
    this.renderer.xr.addEventListener('sessionend', this.onXRSessionChange);
  }

  private pulseRightHaptic(strength: number, durationMs: number): void {
    const gp = this.getXRInputSource('right')?.gamepad as (Gamepad & {
      hapticActuators?: Array<{ pulse?: (value: number, duration: number) => Promise<boolean> }>;
    }) | undefined;
    try {
      gp?.hapticActuators?.[0]?.pulse?.(strength, durationMs)?.catch?.(() => {});
    } catch {
      // Haptics optional
    }
  }

  private onXRSessionChange = (): void => {
    this.physics.leftHand.isLocked = false;
    this.physics.rightHand.isLocked = false;
    this.maxStandingHeadY = 0;
    this.vrTurnYaw = 0;
    this.playerRig.rotation.y = 0;
    if (this.renderer.xr.isPresenting && !this.sessionJoined) {
      const autoName = `Gorilla-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      this.joinSession(autoName, false);
      this.roomUiCallbacks?.onAutoJoined?.(autoName);
    }
    if (!this.renderer.xr.isPresenting) {
      this.xrTrackingGroup.position.set(0, 0, 0);
      this.roomWristUi.closeKeyboard();
    }
    if (this.isSoftwareGl) {
      this.stopLoop();
      this.startLoop();
    }
    this.emitTelemetry();
  };

  private onContextLost = (e: Event): void => {
    e.preventDefault();
    this.isContextLost = true;
    this.stopLoop();
    this.emitTelemetry();
  };

  private onContextRestored = (): void => {
    this.isContextLost = false;
    this.startLoop();
    this.emitTelemetry();
  };

  private onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
  };

  private onResize = (): void => {
    if (this.disposed || this.renderer.xr.isPresenting) return;
    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  };

  private onPointerLockChange = (): void => {
    if (document.pointerLockElement !== this.renderer.domElement) {
      this.desktopState.leftMouseDown = false;
      this.desktopState.rightMouseDown = false;
    }
    this.emitTelemetry();
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (!this.sessionJoined) return;
    this.audio.unlock();

    if (e.code === 'Space' && !e.repeat) {
      e.preventDefault();
      if (this.killEdit.isActive()) {
        this.skipKillEdit();
      } else {
        this.desktopState.slamTimer = 0.16;
      }
    }
    if (e.code === 'KeyQ') {
      this.desktopState.leftMouseDown = true;
    }
    if (e.code === 'KeyE') {
      this.desktopState.rightMouseDown = true;
    }
    if (e.code === 'KeyR' && !e.repeat) {
      this.respawn();
    }
    if (e.code === 'KeyF' && !e.repeat) {
      this.triggerAbilityDesktop();
    }
    if (e.code === 'KeyM' && !e.repeat) {
      void this.toggleVoiceMic();
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === 'KeyQ') {
      this.desktopState.leftMouseDown = false;
    }
    if (e.code === 'KeyE') {
      this.desktopState.rightMouseDown = false;
    }
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (!this.sessionJoined) return;
    this.audio.unlock();
    const canvas = this.renderer.domElement;
    if (document.pointerLockElement !== canvas) {
      try {
        canvas.requestPointerLock?.();
      } catch {
        // Fallback drag look still works if pointer lock is blocked
      }
      if (e.button === 0) {
        this.isDraggingFallback = true;
      }
      return;
    }

    if (e.button === 0) this.desktopState.leftMouseDown = true;
    if (e.button === 2) this.desktopState.rightMouseDown = true;
  };

  private onMouseUp = (e: MouseEvent): void => {
    this.isDraggingFallback = false;
    if (e.button === 0) this.desktopState.leftMouseDown = false;
    if (e.button === 2) this.desktopState.rightMouseDown = false;
  };

  private onMouseMove = (e: MouseEvent): void => {
    const isLocked = document.pointerLockElement === this.renderer.domElement;
    if (!isLocked && !this.isDraggingFallback) return;

    const dx = e.movementX || 0;
    const dy = e.movementY || 0;
    const sens = 0.0024;

    if (isLocked && (this.desktopState.leftMouseDown || this.desktopState.rightMouseDown)) {
      // Allow pulling locked virtual hands downward/upward while holding mouse button to climb walls
      if (this.desktopState.leftMouseDown) {
        this.desktopState.leftPullOffset = THREE.MathUtils.clamp(
          this.desktopState.leftPullOffset - dy * 0.0032,
          -0.68,
          0.35
        );
      }
      if (this.desktopState.rightMouseDown) {
        this.desktopState.rightPullOffset = THREE.MathUtils.clamp(
          this.desktopState.rightPullOffset - dy * 0.0032,
          -0.68,
          0.35
        );
      }
      this.desktopState.yaw -= dx * sens * 0.7;
    } else {
      this.desktopState.yaw -= dx * sens;
      this.desktopState.pitch = THREE.MathUtils.clamp(
        this.desktopState.pitch - dy * sens,
        -Math.PI * 0.46,
        Math.PI * 0.46
      );
    }
  };

  public requestDesktopPlay(): void {
    this.audio.unlock();
    try {
      this.renderer.domElement.requestPointerLock?.();
    } catch {
      // Safe fallback
    }
  }

  public respawn(): void {
    const role = this.getLocalGameRole();
    const phase = this.multiplayer.currentGame.phase;
    const spawn =
      role === 'innocent' && (phase === 'hiding' || phase === 'hunt')
        ? this.hotel.getInnocentStartSpawn()
        : this.hotel.getLobbySpawn();
    this.physics.resetToSpawn(spawn.x, spawn.y, spawn.z);
    this.vrTurnYaw = 0;
    this.playerRig.rotation.y = 0;
    this.desktopState.yaw = 0;
    this.desktopState.pitch = -0.14;
    this.emitTelemetry();
  }

  public setSeed(seed: number): void {
    void seed;
    this.respawn();
  }

  public setRenderDistance(rd: number): void {
    const clamped = Math.max(2, Math.min(6, rd));
    if (this.scene.fog instanceof THREE.FogExp2) {
      this.scene.fog.density = THREE.MathUtils.lerp(0.048, 0.022, (clamped - 2) / 4);
    }
  }

  public setPhysicsPreset(preset: PhysicsPreset): void {
    this.physics.preset = preset;
  }

  public setAudioEnabled(enabled: boolean): void {
    this.audio.setEnabled(enabled);
  }

  public joinSession(username: string, enableVoice: boolean): void {
    this.sessionJoined = true;
    this.audio.unlock();
    this.audio.startBackgroundMusic();
    this.multiplayer.joinWithUsername(username);
    if (enableVoice) {
      void this.multiplayer.voice.enableMic();
    }
    this.emitTelemetry();
  }

  public switchRoom(nextRoomCode: string): string {
    const joined = this.multiplayer.switchRoom(nextRoomCode);
    this.mpStatus = {
      ...this.mpStatus,
      room: joined,
      connected: false,
      playerCount: 1,
    };
    this.roomUiCallbacks?.onRoomSwitched?.(joined);
    this.emitTelemetry();
    return joined;
  }

  public setRoomKeyboardDraft(code: string): void {
    this.roomWristUi.setDraftCode(code);
  }

  public openRoomKeyboard(): void {
    _headWorldPos.copy(this.playerRig.position).add(_camLocalPos);
    if (this.renderer.xr.isPresenting) {
      this.camera.getWorldQuaternion(_ctrlWorldQuat);
      _headEuler.setFromQuaternion(_ctrlWorldQuat, 'YXZ');
    } else {
      _headEuler.set(this.desktopState.pitch, this.desktopState.yaw, 0, 'YXZ');
    }
    this.roomWristUi.openKeyboard(_headWorldPos, _headEuler.y);
  }

  public closeRoomKeyboard(): void {
    this.roomWristUi.closeKeyboard();
  }

  public async toggleVoiceMic(): Promise<void> {
    await this.multiplayer.voice.toggleMic();
  }

  private buildPracticeDummy(): void {
    const g = new THREE.Group();
    g.name = 'PracticeTargetDummy';

    const suitMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.72,
      metalness: 0.12,
    });
    const shirtMat = new THREE.MeshStandardMaterial({
      color: 0xe2e8f0,
      roughness: 0.65,
    });
    const skinMat = new THREE.MeshStandardMaterial({
      color: 0xd6cfc7,
      roughness: 0.55,
    });
    const targetMat = new THREE.MeshStandardMaterial({
      color: 0xef4444,
      emissive: 0x991b1b,
      emissiveIntensity: 0.65,
      roughness: 0.35,
    });
    const eyeMat = new THREE.MeshStandardMaterial({
      color: 0x0f172a,
      roughness: 0.2,
    });

    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.42, 0.12, 16), suitMat);
    base.position.y = 0.06;
    g.add(base);

    // Legs
    for (const side of [-0.12, 0.12]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.075, 0.56, 10), suitMat);
      leg.position.set(side, 0.38, 0);
      g.add(leg);
    }

    // Suit torso + shirt + glowing chest bullseye
    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.21, 0.62, 14), suitMat);
    torso.position.y = 0.94;
    torso.castShadow = !this.isSoftwareGl;
    g.add(torso);

    const chest = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.36, 0.06), shirtMat);
    chest.position.set(0, 0.98, 0.20);
    g.add(chest);

    const bullseye = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.03, 18), targetMat);
    bullseye.rotation.x = Math.PI / 2;
    bullseye.position.set(0, 0.96, 0.23);
    g.add(bullseye);

    // Arms
    for (const side of [-1, 1]) {
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.055, 0.54, 10), suitMat);
      arm.position.set(side * 0.31, 0.92, 0.04);
      arm.rotation.z = side * 0.18;
      arm.rotation.x = -0.22;
      g.add(arm);
    }

    // Head + eerie painted eyes
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.21, 16, 14), skinMat);
    head.position.y = 1.44;
    head.castShadow = !this.isSoftwareGl;
    g.add(head);

    for (const side of [-0.07, 0.07]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.028, 8, 8), eyeMat);
      eye.position.set(side, 1.46, 0.18);
      g.add(eye);
    }

    g.position.copy(this.practiceDummyPos);
    g.visible = false;
    this.practiceDummyGroup = g;
    this.scene.add(g);
  }

  private isSingleplayerDummyMode(): boolean {
    const game = this.multiplayer.currentGame;
    return Boolean(game.isPractice) || (game.phase === 'lobby' && this.mpStatus.playerCount <= 1 && this.sessionJoined);
  }

  private respawnPracticeDummy(): void {
    this.dummyAlive = true;
    this.dummyRespawnTimer = 0;
    // Alternate between accessible Lobby/Hallway spots & hotel maze spots so singleplayer dummy stays fun to hunt
    const game = this.multiplayer.currentGame;
    if (game.isPractice) {
      const nextSpot = this.hotel.getFarTeleportSpot(this.playerRig.position, 6.0, this.practiceDummyPos);
      this.practiceDummyPos.copy(nextSpot);
    } else {
      const quickSpots = [
        new THREE.Vector3(0, 0.25, -2.6),
        new THREE.Vector3(-4.5, 0.25, -5.5),
        new THREE.Vector3(4.5, 0.25, -5.5),
        new THREE.Vector3(0, 0.25, 0.5),
        this.hotel.getInnocentStartSpawn(),
      ];
      let picked = quickSpots[Math.floor(Math.random() * quickSpots.length)];
      if (picked.distanceTo(this.playerRig.position) < 3.2) {
        picked = this.hotel.getInnocentStartSpawn();
      }
      this.practiceDummyPos.copy(picked);
    }
    if (this.practiceDummyGroup) {
      this.practiceDummyGroup.position.copy(this.practiceDummyPos);
    }
  }

  private triggerDummyKill(impactPos: THREE.Vector3, impactVel: THREE.Vector3): void {
    if (!this.dummyAlive) return;
    this.dummyAlive = false;
    this.dummyRespawnTimer = 0.25;
    this.dummyKills += 1;

    const victimHead = this.practiceDummyPos.clone().add(new THREE.Vector3(0, 1.42, 0));
    this.audio.playKnifeHitWall();
    this.audio.startKillEditMusic(49.5);
    this.killEdit.start(
      {
        victimPos: victimHead,
        impactPos: impactPos.clone(),
        impactVel: impactVel.clone(),
        killerId: this.multiplayer.playerId || 'local',
        killerName: this.mpStatus.username || 'Player',
        victimName: 'Test Dummy',
        isLocalKiller: true,
      },
      75
    );
    this.roomWristUi.showBanner('ELIMINATED 💀', 'Heavenly Jumpstyle Kill Edit!', '#ef4444', 4.5);
    this.emitTelemetry();
  }

  private handleRemotePlayerKilled(ev: PlayerKilledEvent): void {
    if (ev.victimId === this.multiplayer.playerId) {
      this.roomWristUi.showBanner('YOU WERE CAUGHT! 💀', 'The Murderer struck you down.', '#ef4444', 4.5);
    } else if (ev.killerId === this.multiplayer.playerId) {
      this.roomWristUi.showBanner('ELIMINATED 💀', `Caught ${ev.victimName}!`, '#ef4444', 4.5);
    }
    this.audio.playKnifeHitWall();
    this.audio.startKillEditMusic(49.5);
    this.killEdit.start(
      {
        victimPos: ev.victimPos,
        impactPos: ev.impactPos,
        impactVel: ev.impactVel,
        killerId: ev.killerId,
        killerName: ev.killerName,
        victimName: ev.victimName,
        isLocalKiller: ev.killerId === this.multiplayer.playerId,
      },
      75
    );
    this.emitTelemetry();
  }

  public skipKillEdit(): void {
    if (!this.killEdit.isActive()) return;
    this.killEdit.restoreCamera(this.camera);
    this.killEdit.stop();
  }

  public startHotelMatch(practice = false): void {
    if (!this.sessionJoined) return;
    this.audio.unlock();
    this.audio.startBackgroundMusic();
    this.multiplayer.startGame(practice);
  }

  public stopHotelMatch(): void {
    if (!this.sessionJoined) return;
    this.skipKillEdit();
    this.multiplayer.stopGame();
  }

  public triggerAbilityDesktop(): void {
    const role = this.getLocalGameRole();
    const phase = this.multiplayer.currentGame.phase;
    const canSingleplayerThrow = this.isSingleplayerDummyMode() && this.dummyAlive;
    if (
      canSingleplayerThrow ||
      (role === 'murderer' && (phase === 'hunt' || (this.multiplayer.currentGame.isPractice && phase === 'hiding')))
    ) {
      this.triggerKnifeThrow(true);
    } else if (role === 'innocent' && (phase === 'hiding' || phase === 'hunt')) {
      this.triggerSuperJump();
    }
  }

  public getLocalGameRole(): PlayerGameRole {
    const game = this.multiplayer.currentGame;
    const myId = this.multiplayer.playerId;
    if (game.phase === 'lobby' || !myId) return 'none';
    if (game.murdererId === myId) return 'murderer';
    if (game.aliveInnocentIds.includes(myId)) return 'innocent';
    if (game.innocentIds.includes(myId)) return 'eliminated';
    return 'none';
  }

  public getGameTimeLeftSec(): number {
    const game = this.multiplayer.currentGame;
    if (game.phase === 'lobby' || game.phaseEndsAt <= 0) return 0;
    const estServerNow = Date.now() + this.clockOffsetMs;
    return Math.max(0, (game.phaseEndsAt - estServerNow) / 1000);
  }

  private handleServerGameState(game: RoomGameState): void {
    if (typeof game.serverTime === 'number' && game.serverTime > 0) {
      this.clockOffsetMs = game.serverTime - Date.now();
    }

    const isNewRound = game.roundId !== this.lastGameRoundId;
    const phaseChanged = game.phase !== this.lastGamePhase;
    this.lastGameRoundId = game.roundId;
    this.lastGamePhase = game.phase;

    this.hotel.setGatesLocked(game.phase === 'hiding');
    const role = this.getLocalGameRole();

    if (isNewRound && (game.phase === 'hiding' || (game.isPractice && game.phase === 'hunt'))) {
      this.knifeCooldown = 0;
      this.superJumpCooldown = 0;
      this.clearActiveKnives();
      this.audio.playRoundAlert('start');

      if (game.isPractice) {
        const spot = this.hotel.getInnocentStartSpawn();
        this.practiceDummyPos.copy(spot);
        if (this.practiceDummyGroup) {
          this.practiceDummyGroup.position.copy(spot);
        }
        const lobby = this.hotel.getLobbySpawn();
        this.physics.resetToSpawn(lobby.x, lobby.y, lobby.z);
        this.roomWristUi.showBanner(
          'SOLO PRACTICE · MURDERER',
          'Track the dummy in the hotel & throw your knife with Trigger / F!',
          '#ef4444',
          5.0
        );
      } else if (role === 'murderer') {
        const lobby = this.hotel.getLobbySpawn();
        this.physics.resetToSpawn(lobby.x, lobby.y, lobby.z);
        this.roomWristUi.showBanner(
          'YOU ARE THE MURDERER',
          'Gates open in 15s. Flick Trigger / F to throw your knife!',
          '#ef4444',
          5.5
        );
      } else if (role === 'innocent') {
        const hideSpot = this.hotel.getInnocentStartSpawn();
        this.physics.resetToSpawn(hideSpot.x, hideSpot.y, hideSpot.z);
        this.roomWristUi.showBanner(
          'YOU ARE INNOCENT · HIDE!',
          'Speed boost active! Press A (or F) to Super Jump far from the Murderer.',
          '#38bdf8',
          5.5
        );
      }
    } else if (phaseChanged && game.phase === 'hunt') {
      this.audio.playRoundAlert('hunt');
      if (role === 'murderer') {
        this.roomWristUi.showBanner(
          'HUNT STARTED · 3:00',
          'Gates are open! Eliminate the Innocent before time expires.',
          '#ef4444',
          4.0
        );
      } else if (role === 'innocent') {
        this.roomWristUi.showBanner(
          'THE MURDERER IS LOOSE!',
          'Survive 3:00! Press A (or F) for randomized Super Jump.',
          '#fbbf24',
          4.0
        );
      }
    } else if (phaseChanged && game.phase === 'ended') {
      this.clearActiveKnives();
      if (game.winner === 'innocent') {
        this.audio.playRoundAlert('innocentWin');
        this.roomWristUi.showBanner('INNOCENT WINS!', game.endReason || 'Survived the Haunted Hotel!', '#38bdf8', 5.5);
      } else if (game.winner === 'murderer') {
        this.audio.playRoundAlert('murdererWin');
        this.roomWristUi.showBanner('MURDERER WINS!', game.endReason || 'Everyone was caught!', '#ef4444', 5.5);
      }
    } else if (phaseChanged && game.phase === 'lobby') {
      this.clearActiveKnives();
    }

    this.emitTelemetry();
  }

  private triggerSuperJump(): void {
    const role = this.getLocalGameRole();
    const phase = this.multiplayer.currentGame.phase;
    if (role !== 'innocent' || (phase !== 'hiding' && phase !== 'hunt')) return;
    if (this.superJumpCooldown > 0) return;

    const murdererPos = this.multiplayer.getPlayerPositionById(this.multiplayer.currentGame.murdererId);
    const dest = this.hotel.getFarTeleportSpot(murdererPos, 8.5, this.playerRig.position);

    this.physics.resetToSpawn(dest.x, dest.y + 0.35, dest.z);
    this.physics.velocity.set(0, 4.2, 0);
    this.superJumpCooldown = 14.0;
    this.audio.playSuperJump();
    this.pulseRightHaptic(0.85, 70);
    this.multiplayer.sendSuperJump();
    this.roomWristUi.showBanner('SUPER JUMP!', 'Teleported far from the Murderer', '#38bdf8', 2.4);
    this.emitTelemetry();
  }

  private triggerKnifeThrow(useGazeFallback = false): void {
    const role = this.getLocalGameRole();
    const game = this.multiplayer.currentGame;
    const isSingleDummy = this.isSingleplayerDummyMode();
    const canThrow =
      isSingleDummy ||
      (role === 'murderer' && (game.phase === 'hunt' || (game.isPractice && game.phase === 'hiding')));
    if (!canThrow || this.knifeCooldown > 0) return;

    _rightTipWorldPos
      .copy(_rightTipOffset)
      .applyQuaternion(this.rightHandMesh.group.quaternion)
      .add(this.rightHandMesh.group.position);

    if (useGazeFallback && !this.renderer.xr.isPresenting) {
      // Desktop mode: throw directly along player gaze from right hand/eye level
      _tipAimDir.set(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize();
      _knifeThrowVel.copy(_tipAimDir).multiplyScalar(17.5);
      _knifeThrowVel.y += 1.4;
      _rightTipWorldPos.copy(this.playerRig.position).add(_camLocalPos).addScaledVector(_tipAimDir, 0.45);
    } else {
      // VR fingertip yeet tracking: combine tracked fingertip velocity with hand forward orientation
      const tipSpeed = this.smoothedTipVelocity.length();
      _tipAimDir.set(0, 0, -1).applyQuaternion(this.rightHandMesh.group.quaternion).normalize();

      if (tipSpeed >= 1.15) {
        const launchSpeed = THREE.MathUtils.clamp(tipSpeed * 3.1, 13.5, 23.0);
        _knifeThrowVel
          .copy(this.smoothedTipVelocity)
          .normalize()
          .lerp(_tipAimDir, 0.25)
          .normalize()
          .multiplyScalar(launchSpeed);
      } else {
        _knifeThrowVel.copy(_tipAimDir).multiplyScalar(16.5);
      }
      _knifeThrowVel.y += 1.05;
    }

    this.knifeCooldown = isSingleDummy && game.phase === 'lobby' ? 1.8 : 4.2;
    this.audio.playKnifeThrow();
    this.pulseRightHaptic(0.9, 55);

    if (game.phase === 'hunt') {
      this.multiplayer.sendKnifeThrow(_rightTipWorldPos, _knifeThrowVel);
    } else {
      // Local singleplayer dummy lobby practice throw
      this.spawnThrownKnife({
        knifeId: `local-${Date.now()}`,
        throwerId: this.multiplayer.playerId || 'local',
        origin: _rightTipWorldPos.clone(),
        vel: _knifeThrowVel.clone(),
      });
    }
    this.emitTelemetry();
  }

  private spawnThrownKnife(ev: KnifeThrownEvent): void {
    const rig = createKnifeModel(1.18);
    rig.group.position.copy(ev.origin);
    _knifeDirNorm.copy(ev.vel).normalize();
    rig.group.quaternion.setFromUnitVectors(_knifeForward, _knifeDirNorm);
    this.scene.add(rig.group);

    this.activeKnives.push({
      id: ev.knifeId,
      throwerId: ev.throwerId,
      rig,
      pos: ev.origin.clone(),
      vel: ev.vel.clone(),
      stuck: false,
      spinAngle: 0,
      life: 6.5,
    });
  }

  private clearActiveKnives(): void {
    for (const k of this.activeKnives) {
      this.scene.remove(k.rig.group);
      k.rig.dispose();
    }
    this.activeKnives.length = 0;
  }

  private updateActiveKnives(dt: number): void {
    const game = this.multiplayer.currentGame;
    const isLocalMurderer = this.getLocalGameRole() === 'murderer';
    const localPlayerId = this.multiplayer.playerId || 'local';
    const canHitDummy = this.isSingleplayerDummyMode() && this.dummyAlive && this.practiceDummyGroup?.visible;
    const remoteTargets =
      isLocalMurderer && !game.isPractice && game.phase === 'hunt'
        ? this.multiplayer.getRemoteTargetPositions(game.aliveInnocentIds)
        : [];

    for (let i = this.activeKnives.length - 1; i >= 0; i--) {
      const k = this.activeKnives[i];
      k.life -= dt;
      if (k.life <= 0) {
        this.scene.remove(k.rig.group);
        k.rig.dispose();
        this.activeKnives.splice(i, 1);
        continue;
      }

      if (k.stuck) continue;

      const subSteps = 3;
      const subDt = dt / subSteps;
      let hitTarget = false;

      for (let s = 0; s < subSteps; s++) {
        k.vel.y -= 6.8 * subDt;
        k.pos.addScaledVector(k.vel, subDt);

        if ((isLocalMurderer || canHitDummy) && k.throwerId === localPlayerId) {
          // Check remote Innocent player body/head hit
          for (const tgt of remoteTargets) {
            const headDist = k.pos.distanceTo(tgt.headPos);
            _knifeTargetBody.copy(tgt.headPos);
            _knifeTargetBody.y -= 0.34;
            const bodyDist = k.pos.distanceTo(_knifeTargetBody);
            if (headDist <= 0.46 || bodyDist <= 0.5) {
              this.multiplayer.sendKnifeHit(tgt.id, k.pos, k.vel);
              hitTarget = true;
              break;
            }
          }

          // Check Singleplayer / Practice Test Dummy hit
          if (!hitTarget && canHitDummy && this.dummyAlive) {
            _knifeTargetBody.copy(this.practiceDummyPos);
            _knifeTargetBody.y += 1.05;
            if (k.pos.distanceTo(_knifeTargetBody) <= 0.68) {
              this.triggerDummyKill(k.pos, k.vel);
              hitTarget = true;
            }
          }
        }

        if (hitTarget || this.hotel.isPointSolid(k.pos.x, k.pos.y, k.pos.z)) {
          k.stuck = true;
          k.life = Math.min(k.life, 2.5);
          if (!hitTarget) {
            this.audio.playKnifeHitWall();
          }
          break;
        }
      }

      k.rig.group.position.copy(k.pos);
      if (!k.stuck && k.vel.lengthSq() > 0.01) {
        _knifeDirNorm.copy(k.vel).normalize();
        k.rig.group.quaternion.setFromUnitVectors(_knifeForward, _knifeDirNorm);
        k.spinAngle += dt * 16.0;
        k.rig.group.rotateX(k.spinAngle);
      }
    }

    // Close-quarters melee knife touch against remote Innocent OR Test Dummy
    if (this.meleeCooldown <= 0 && !this.killEdit.isActive()) {
      _tipAimDir.set(0, 0, -0.22).applyQuaternion(this.rightHandMesh.group.quaternion);
      _rightTipWorldPos.copy(this.rightHandMesh.group.position).add(_tipAimDir);

      if (isLocalMurderer && game.phase === 'hunt' && !game.isPractice && remoteTargets.length > 0) {
        for (const tgt of remoteTargets) {
          const dHead = _rightTipWorldPos.distanceTo(tgt.headPos);
          _knifeTargetBody.copy(tgt.headPos);
          _knifeTargetBody.y -= 0.34;
          const dBody = _rightTipWorldPos.distanceTo(_knifeTargetBody);
          if (dHead <= 0.5 || dBody <= 0.52) {
            this.meleeCooldown = 0.6;
            this.multiplayer.sendKnifeHit(tgt.id, _rightTipWorldPos, _tipAimDir);
            break;
          }
        }
      } else if (canHitDummy && this.dummyAlive) {
        _knifeTargetBody.copy(this.practiceDummyPos);
        _knifeTargetBody.y += 1.05;
        if (_rightTipWorldPos.distanceTo(_knifeTargetBody) <= 0.62) {
          this.meleeCooldown = 0.6;
          this.triggerDummyKill(_rightTipWorldPos, _tipAimDir);
        }
      }
    }
  }

  private async restoreFinalizedHand(
    onRestored?: (restored: {
      target: 'both' | 'left' | 'right';
      transform: CustomHandTransform;
      textureDataUrl: string | null;
      tintColor: string;
      brightness: number;
      flipTextureY: boolean;
      locked: boolean;
    }) => void
  ): Promise<void> {
    const saved = await loadSavedFinalizedHand();
    if (!saved || this.disposed) return;

    const p = saved.payload;
    const transform: CustomHandTransform = {
      scale: p.scale,
      rotX: p.rotX,
      rotY: p.rotY,
      rotZ: p.rotZ,
    };
    const brightness = typeof p.brightness === 'number' ? p.brightness : 1.0;

    try {
      await this.applyBufferToHands(
        p.target,
        p.modelBuffer,
        p.ext,
        'Saved Hand Model',
        transform,
        p.textureDataUrl,
        p.tintColor,
        brightness,
        p.flipTextureY,
        saved.modelId,
        saved.textureId
      );
      this.isHandFinalized = true;
      this.isHandLocked = Boolean(p.locked);
      this.emitTelemetry();
      onRestored?.({
        target: p.target,
        transform,
        textureDataUrl: p.textureDataUrl,
        tintColor: p.tintColor,
        brightness,
        flipTextureY: p.flipTextureY,
        locked: Boolean(p.locked),
      });
    } catch {
      // Ignore corrupt saved model
    }
  }

  public async applyFirebaseHandConfig(config: FirebaseHandConfig): Promise<void> {
    if (this.disposed) return;
    const transform: CustomHandTransform = {
      scale: config.scale,
      rotX: config.rotX,
      rotY: config.rotY,
      rotZ: config.rotZ,
    };

    // If same model is already active locally, just sync lock & brightness
    if (
      this.activeCustomModel &&
      (this.activeCustomModel.modelId === config.modelId || this.isHandFinalized)
    ) {
      this.isHandFinalized = true;
      this.isHandLocked = Boolean(config.locked);
      await this.setHandBrightness(config.brightness);
      this.onFinalizedRestoredCb?.({
        target: config.target,
        transform: this.activeCustomModel.transform,
        textureDataUrl: this.activeCustomModel.textureDataUrl,
        tintColor: config.baseTintColor,
        brightness: config.brightness,
        flipTextureY: config.flipTextureY,
        locked: Boolean(config.locked),
      });
      this.emitTelemetry();
      return;
    }

    const remote = await loadRemoteAssetsByIds(
      config.modelId,
      config.ext,
      config.hasTexture && config.textureId ? config.textureId : null
    );
    if (!remote || this.disposed) return;

    await this.applyBufferToHands(
      config.target,
      remote.modelBuffer,
      config.ext,
      'Saved Hand Model',
      transform,
      remote.textureDataUrl,
      config.baseTintColor,
      config.brightness,
      config.flipTextureY,
      config.modelId,
      config.textureId || null
    );

    await finalizeHandConfiguration({
      target: config.target,
      ext: config.ext,
      modelBuffer: remote.modelBuffer,
      textureDataUrl: remote.textureDataUrl,
      tintColor: config.baseTintColor,
      brightness: config.brightness,
      flipTextureY: config.flipTextureY,
      scale: config.scale,
      rotX: config.rotX,
      rotY: config.rotY,
      rotZ: config.rotZ,
      locked: Boolean(config.locked),
    });

    this.isHandFinalized = true;
    this.isHandLocked = Boolean(config.locked);
    this.emitTelemetry();
    this.onFinalizedRestoredCb?.({
      target: config.target,
      transform,
      textureDataUrl: remote.textureDataUrl,
      tintColor: config.baseTintColor,
      brightness: config.brightness,
      flipTextureY: config.flipTextureY,
      locked: Boolean(config.locked),
    });
  }

  private async applyBufferToHands(
    target: 'both' | 'left' | 'right',
    buffer: ArrayBuffer,
    ext: string,
    fileName: string,
    transform: CustomHandTransform,
    textureDataUrl: string | null,
    tintColor: string,
    brightness: number,
    flipTextureY: boolean,
    knownModelId: string | null = null,
    knownTextureId: string | null = null
  ): Promise<{ shared: boolean }> {
    const rightOrSingleGroup = await parseHandModelFromArrayBuffer(buffer, ext, {
      ...transform,
      mirrorX: false,
    });

    if (target === 'both') {
      const leftGroup = await parseHandModelFromArrayBuffer(buffer, ext, {
        ...transform,
        mirrorX: true,
      });
      applyCustomHandTransform(rightOrSingleGroup, { ...transform, mirrorX: false });
      this.leftHandMesh.setCustomModel(leftGroup);
      this.rightHandMesh.setCustomModel(rightOrSingleGroup);
    } else if (target === 'left') {
      applyCustomHandTransform(rightOrSingleGroup, { ...transform, mirrorX: false });
      this.leftHandMesh.setCustomModel(rightOrSingleGroup);
    } else {
      applyCustomHandTransform(rightOrSingleGroup, { ...transform, mirrorX: false });
      this.rightHandMesh.setCustomModel(rightOrSingleGroup);
    }

    if (textureDataUrl || tintColor.toLowerCase() !== '#ffffff' || Math.abs(brightness - 1.0) > 0.001) {
      this.pendingBrightness = brightness;
      await this.playerModelRig?.applyCustomTextureAndTint(textureDataUrl, tintColor, flipTextureY, brightness);
      if (target === 'both' || target === 'left') {
        await this.leftHandMesh.applyTextureAndTint(textureDataUrl, tintColor, flipTextureY, brightness);
      }
      if (target === 'both' || target === 'right') {
        await this.rightHandMesh.applyTextureAndTint(textureDataUrl, tintColor, flipTextureY, brightness);
      }
    }

    let modelId = knownModelId;
    if (!modelId) {
      const uploaded = await uploadHandModelForMultiplayer(buffer, ext);
      modelId = uploaded?.id || null;
    }

    let textureId = knownTextureId;
    if (!textureId && textureDataUrl) {
      textureId = await uploadHandTextureForMultiplayer(textureDataUrl);
    }

    this.activeCustomModel = {
      buffer,
      ext,
      fileName,
      target,
      modelId,
      textureDataUrl,
      textureId,
      tintColor,
      brightness,
      flipTextureY,
      transform: { ...transform },
    };

    if (modelId) {
      const ref: UploadedHandRef = {
        id: modelId,
        ext,
        scale: transform.scale,
        rotX: transform.rotX,
        rotY: transform.rotY,
        rotZ: transform.rotZ,
        textureId,
        tintColor,
        brightness,
        flipTextureY,
      };
      if (target === 'both' || target === 'left') {
        this.multiplayer.localLeftHandModel = { ...ref };
      }
      if (target === 'both' || target === 'right') {
        this.multiplayer.localRightHandModel = { ...ref };
      }
    }

    this.emitTelemetry();
    return { shared: Boolean(modelId) };
  }

  public async applyCustomHandFile(
    target: 'both' | 'left' | 'right',
    file: File,
    transform: CustomHandTransform,
    textureDataUrl: string | null,
    tintColor: string,
    brightness: number,
    flipTextureY: boolean
  ): Promise<{ shared: boolean; ext: string }> {
    if (this.isHandLocked) {
      throw new Error('Your hand model is permanently locked. Only brightness can be adjusted.');
    }
    this.isHandFinalized = false;
    const parsed = await parseHandModelFromFile(file, transform);
    const { disposeObject3D } = await import('./customHandLoader');
    disposeObject3D(parsed.group);

    // GLTF/GLB UVs default flipY=false, OBJ/FBX/STL default flipY=true
    const autoFlipY = parsed.ext === 'glb' || parsed.ext === 'gltf' ? false : flipTextureY;

    const res = await this.applyBufferToHands(
      target,
      parsed.buffer,
      parsed.ext,
      file.name,
      transform,
      textureDataUrl,
      tintColor,
      brightness,
      autoFlipY
    );
    return { ...res, ext: parsed.ext };
  }

  public async aiOrientCurrentHand(target: 'both' | 'left' | 'right'): Promise<{
    transform: CustomHandTransform;
    reasoning: string;
  }> {
    if (this.isHandLocked) {
      throw new Error('Your hand orientation is permanently locked.');
    }
    if (!this.activeCustomModel) {
      throw new Error('Upload a 3D hand model first before running AI Auto-Orient.');
    }

    const advice = await analyzeHandOrientationWithAI(
      this.activeCustomModel.buffer,
      this.activeCustomModel.ext,
      this.activeCustomModel.fileName,
      target
    );

    const degToRad = Math.PI / 180;
    const nextTransform: CustomHandTransform = {
      scale: advice.recommendedScale,
      rotX: advice.rotXDeg * degToRad,
      rotY: advice.rotYDeg * degToRad,
      rotZ: advice.rotZDeg * degToRad,
    };

    this.isHandFinalized = false;
    this.updateCustomHandTransform(target, nextTransform);
    this.emitTelemetry();

    return {
      transform: nextTransform,
      reasoning: advice.reasoning,
    };
  }

  public async applyTextureAndColorToHands(
    target: 'both' | 'left' | 'right',
    textureDataUrl: string | null,
    tintColor: string,
    flipTextureY: boolean,
    brightness = 1.0
  ): Promise<void> {
    if (this.isHandLocked) {
      throw new Error('Your texture and color are permanently locked. Only brightness can be adjusted.');
    }
    this.isHandFinalized = false;

    this.pendingBrightness = brightness;
    await this.playerModelRig?.applyCustomTextureAndTint(textureDataUrl, tintColor, flipTextureY, brightness);

    if (target === 'both' || target === 'left') {
      await this.leftHandMesh.applyTextureAndTint(textureDataUrl, tintColor, flipTextureY, brightness);
    }
    if (target === 'both' || target === 'right') {
      await this.rightHandMesh.applyTextureAndTint(textureDataUrl, tintColor, flipTextureY, brightness);
    }

    if (this.activeCustomModel) {
      let textureId = this.activeCustomModel.textureId;
      if (textureDataUrl !== this.activeCustomModel.textureDataUrl) {
        textureId = textureDataUrl ? await uploadHandTextureForMultiplayer(textureDataUrl) : null;
      }
      this.activeCustomModel.textureDataUrl = textureDataUrl;
      this.activeCustomModel.textureId = textureId;
      this.activeCustomModel.tintColor = tintColor;
      this.activeCustomModel.brightness = brightness;
      this.activeCustomModel.flipTextureY = flipTextureY;

      if ((target === 'both' || target === 'left') && this.multiplayer.localLeftHandModel) {
        this.multiplayer.localLeftHandModel = {
          ...this.multiplayer.localLeftHandModel,
          textureId,
          tintColor,
          brightness,
          flipTextureY,
        };
      }
      if ((target === 'both' || target === 'right') && this.multiplayer.localRightHandModel) {
        this.multiplayer.localRightHandModel = {
          ...this.multiplayer.localRightHandModel,
          textureId,
          tintColor,
          brightness,
          flipTextureY,
        };
      }
    }

    this.emitTelemetry();
  }

  public async setHandBrightness(brightness: number): Promise<void> {
    const b = Math.max(0.1, Math.min(1.5, Number.isFinite(brightness) ? brightness : 1.0));
    this.pendingBrightness = b;
    this.playerModelRig?.setBrightness(b);
    if (!this.activeCustomModel) return;

    const target = this.activeCustomModel.target;
    const { textureDataUrl, tintColor, flipTextureY } = this.activeCustomModel;
    this.activeCustomModel.brightness = b;

    if (target === 'both' || target === 'left') {
      await this.leftHandMesh.applyTextureAndTint(textureDataUrl, tintColor, flipTextureY, b);
    }
    if (target === 'both' || target === 'right') {
      await this.rightHandMesh.applyTextureAndTint(textureDataUrl, tintColor, flipTextureY, b);
    }

    if (this.multiplayer.localLeftHandModel) {
      this.multiplayer.localLeftHandModel = {
        ...this.multiplayer.localLeftHandModel,
        brightness: b,
      };
    }
    if (this.multiplayer.localRightHandModel) {
      this.multiplayer.localRightHandModel = {
        ...this.multiplayer.localRightHandModel,
        brightness: b,
      };
    }

    if (this.isHandFinalized || this.isHandLocked) {
      await updateSavedBrightnessLocally(b);
    }
  }

  public async finalizeCurrentHand(
    target: 'both' | 'left' | 'right',
    transform: CustomHandTransform,
    textureDataUrl: string | null,
    tintColor: string,
    brightness: number,
    flipTextureY: boolean,
    lockPermanently = true
  ): Promise<{
    serverSaved: boolean;
    modelId: string | null;
    textureId: string | null;
    ext: string;
  }> {
    if (this.isHandLocked) {
      throw new Error('Hand configuration is already permanently locked.');
    }
    if (!this.activeCustomModel) {
      throw new Error('Upload a 3D model before saving and locking.');
    }

    const res = await finalizeHandConfiguration({
      target,
      ext: this.activeCustomModel.ext,
      modelBuffer: this.activeCustomModel.buffer,
      textureDataUrl,
      tintColor,
      brightness,
      flipTextureY,
      scale: transform.scale,
      rotX: transform.rotX,
      rotY: transform.rotY,
      rotZ: transform.rotZ,
      locked: lockPermanently,
    });

    let modelId = res.modelId || this.activeCustomModel.modelId;
    if (!modelId) {
      const uploaded = await uploadHandModelForMultiplayer(
        this.activeCustomModel.buffer,
        this.activeCustomModel.ext
      );
      modelId = uploaded?.id || null;
    }

    let textureId = res.textureId ?? this.activeCustomModel.textureId;
    if (!textureId && textureDataUrl) {
      textureId = await uploadHandTextureForMultiplayer(textureDataUrl);
    }

    this.activeCustomModel.target = target;
    this.activeCustomModel.transform = { ...transform };
    this.activeCustomModel.brightness = brightness;
    if (modelId) this.activeCustomModel.modelId = modelId;
    if (textureId !== undefined) this.activeCustomModel.textureId = textureId;

    if (modelId) {
      const ref: UploadedHandRef = {
        id: modelId,
        ext: this.activeCustomModel.ext,
        scale: transform.scale,
        rotX: transform.rotX,
        rotY: transform.rotY,
        rotZ: transform.rotZ,
        textureId: textureId ?? null,
        tintColor,
        brightness,
        flipTextureY,
      };
      if (target === 'both' || target === 'left') {
        this.multiplayer.localLeftHandModel = { ...ref };
      }
      if (target === 'both' || target === 'right') {
        this.multiplayer.localRightHandModel = { ...ref };
      }
    }

    this.isHandFinalized = true;
    this.isHandLocked = lockPermanently;
    this.emitTelemetry();
    return {
      serverSaved: res.serverSaved,
      modelId: modelId ?? null,
      textureId: textureId ?? null,
      ext: this.activeCustomModel.ext,
    };
  }

  public getActiveHandSummary(): {
    ext: string;
    modelId: string | null;
    textureId: string | null;
    hasTexture: boolean;
  } | null {
    if (!this.activeCustomModel) return null;
    return {
      ext: this.activeCustomModel.ext,
      modelId: this.activeCustomModel.modelId,
      textureId: this.activeCustomModel.textureId,
      hasTexture: Boolean(this.activeCustomModel.textureDataUrl),
    };
  }

  public updateCustomHandTransform(
    target: 'both' | 'left' | 'right',
    transform: CustomHandTransform
  ): void {
    if (this.isHandLocked) return;
    this.isHandFinalized = false;
    if (this.activeCustomModel) {
      this.activeCustomModel.transform = { ...transform };
    }
    if ((target === 'both' || target === 'left') && this.leftHandMesh.hasCustomModel()) {
      this.leftHandMesh.updateCustomTransform({ ...transform, mirrorX: target === 'both' });
      if (this.multiplayer.localLeftHandModel) {
        this.multiplayer.localLeftHandModel = {
          ...this.multiplayer.localLeftHandModel,
          scale: transform.scale,
          rotX: transform.rotX,
          rotY: transform.rotY,
          rotZ: transform.rotZ,
        };
      }
    }
    if ((target === 'both' || target === 'right') && this.rightHandMesh.hasCustomModel()) {
      this.rightHandMesh.updateCustomTransform({ ...transform, mirrorX: false });
      if (this.multiplayer.localRightHandModel) {
        this.multiplayer.localRightHandModel = {
          ...this.multiplayer.localRightHandModel,
          scale: transform.scale,
          rotX: transform.rotX,
          rotY: transform.rotY,
          rotZ: transform.rotZ,
        };
      }
    }
  }

  public resetCustomHands(target: 'both' | 'left' | 'right'): void {
    if (this.isHandLocked) return;
    this.isHandFinalized = false;
    if (target === 'both' || target === 'left') {
      this.leftHandMesh.setCustomModel(null);
      this.multiplayer.localLeftHandModel = null;
    }
    if (target === 'both' || target === 'right') {
      this.rightHandMesh.setCustomModel(null);
      this.multiplayer.localRightHandModel = null;
    }
    if (!this.leftHandMesh.hasCustomModel() && !this.rightHandMesh.hasCustomModel()) {
      this.activeCustomModel = null;
      void clearSavedFinalizedHand();
    }
    this.emitTelemetry();
  }

  private getXRInputSource(side: 'left' | 'right'): XRInputSource | null {
    const cached =
      side === 'left' ? this.physics.leftHand.xrInputSource : this.physics.rightHand.xrInputSource;
    if (cached && cached.gamepad) return cached;

    const session = this.renderer.xr.getSession();
    if (!session) return cached;
    for (const src of session.inputSources) {
      if (src.handedness === side) {
        if (side === 'left') this.physics.leftHand.xrInputSource = src;
        else this.physics.rightHand.xrInputSource = src;
        return src;
      }
    }
    return cached;
  }

  private sampleRightStickTurnX(): number {
    const gp = this.getXRInputSource('right')?.gamepad;
    if (!gp || !gp.axes || gp.axes.length === 0) return 0;

    // WebXR xr-standard: axes[2] is thumbstick X; fallback to axes[0] for 2-axis gamepads
    const raw = gp.axes.length >= 4 ? (gp.axes[2] ?? 0) : gp.axes.length >= 2 ? (gp.axes[0] ?? 0) : 0;
    const deadzone = 0.16;
    const abs = Math.abs(raw);
    if (abs <= deadzone) return 0;
    return Math.sign(raw) * ((abs - deadzone) / (1 - deadzone));
  }

  private sampleHandFingers(side: 'left' | 'right', out: HandFingerPose): void {
    if (this.renderer.xr.isPresenting) {
      const gp = this.getXRInputSource(side)?.gamepad;
      const buttons = gp?.buttons;
      if (buttons && buttons.length > 0) {
        const triggerBtn = buttons[0];
        const gripBtn = buttons[1];
        const thumbButtons = [buttons[3], buttons[4], buttons[5]];

        const triggerVal = triggerBtn
          ? triggerBtn.value > 0.02
            ? triggerBtn.value
            : triggerBtn.pressed
            ? 1
            : triggerBtn.touched
            ? 0.14
            : 0
          : 0;
        const gripVal = gripBtn
          ? gripBtn.value > 0.02
            ? gripBtn.value
            : gripBtn.pressed
            ? 1
            : gripBtn.touched
            ? 0.14
            : 0
          : 0;

        let thumbVal = 0.06;
        for (const tb of thumbButtons) {
          if (!tb) continue;
          if (tb.pressed || tb.value > 0.5) {
            thumbVal = 1.0;
            break;
          }
          if (tb.touched) {
            thumbVal = Math.max(thumbVal, 0.45);
          }
        }

        out.grip = Math.max(0, Math.min(1, gripVal));
        out.trigger = Math.max(0, Math.min(1, triggerVal));
        out.thumb = thumbVal;
        return;
      }
    }

    const activeBtn =
      side === 'left' ? this.desktopState.leftMouseDown : this.desktopState.rightMouseDown;
    const inContact =
      side === 'left' ? this.physics.leftHand.inContact : this.physics.rightHand.inContact;

    out.grip = activeBtn ? 1.0 : inContact ? 0.65 : 0.14;
    out.trigger = activeBtn ? 1.0 : inContact ? 0.5 : 0.1;
    out.thumb = activeBtn ? 0.8 : inContact ? 0.35 : 0.08;
  }

  private syncHandsAndCamera(dt: number): void {
    const isXR = this.renderer.xr.isPresenting;

    if (isXR) {
      // Auto-calibrate Gorilla eye height (~0.98m above floor) + 1.38x Gorilla arm reach
      // so standing VR players reach the ground naturally without crouching.
      const GORILLA_EYE_HEIGHT = 0.98;
      const ARM_REACH_SCALE = 1.38;

      if (this.camera.position.y >= 0.45) {
        if (this.camera.position.y > this.maxStandingHeadY) {
          this.maxStandingHeadY = this.camera.position.y;
        }
        const headSink = Math.max(0, this.maxStandingHeadY - GORILLA_EYE_HEIGHT);
        this.xrTrackingGroup.position.set(0, -headSink, 0);
      } else {
        // 'local' fallback when HMD sits near y = 0
        this.xrTrackingGroup.position.set(0, GORILLA_EYE_HEIGHT, 0);
      }

      this.playerRig.updateMatrixWorld(true);

      // Right-stick smooth turning pivoted around the player's current head XZ
      const rightStickX = this.sampleRightStickTurnX();
      const turnDelta = -rightStickX * 2.45 * dt;
      if (Math.abs(turnDelta) > 1e-6) {
        this.camera.getWorldPosition(_tmpHeadBefore);
        this.vrTurnYaw += turnDelta;
        this.playerRig.rotation.y = this.vrTurnYaw;
        this.playerRig.updateMatrixWorld(true);
        this.camera.getWorldPosition(_tmpHeadAfter);

        this.playerRig.position.x += _tmpHeadBefore.x - _tmpHeadAfter.x;
        this.playerRig.position.z += _tmpHeadBefore.z - _tmpHeadAfter.z;
        this.playerRig.updateMatrixWorld(true);
      }

      _camRigLocal.copy(this.camera.position).add(this.xrTrackingGroup.position);
      _camLocalPos.copy(_camRigLocal).applyQuaternion(this.playerRig.quaternion);

      if (Math.abs(turnDelta) > 1e-6) {
        // Rotate previous hand samples with the turn so smooth turning never injects phantom push velocity
        _turnQuat.setFromAxisAngle(_turnUp, turnDelta);
        this.physics.leftHand.prevLocalPos
          .sub(_camLocalPos)
          .applyQuaternion(_turnQuat)
          .add(_camLocalPos);
        this.physics.rightHand.prevLocalPos
          .sub(_camLocalPos)
          .applyQuaternion(_turnQuat)
          .add(_camLocalPos);
      }

      if (this.leftController) {
        this.physics.leftHand.localPos
          .copy(this.leftController.position)
          .add(this.xrTrackingGroup.position)
          .sub(_camRigLocal)
          .multiplyScalar(ARM_REACH_SCALE)
          .add(_camRigLocal)
          .applyQuaternion(this.playerRig.quaternion);
      }
      if (this.rightController) {
        this.physics.rightHand.localPos
          .copy(this.rightController.position)
          .add(this.xrTrackingGroup.position)
          .sub(_camRigLocal)
          .multiplyScalar(ARM_REACH_SCALE)
          .add(_camRigLocal)
          .applyQuaternion(this.playerRig.quaternion);
      }
    } else {
      // Desktop camera preview rotation & virtual gorilla arms (WASD removed for VR)
      this.vrTurnYaw = 0;
      this.playerRig.rotation.y = 0;
      this.xrTrackingGroup.position.set(0, 0, 0);
      this.camera.position.set(0, 1.05, 0);
      this.camera.rotation.order = 'YXZ';
      this.camera.rotation.y = this.desktopState.yaw;
      this.camera.rotation.x = this.desktopState.pitch;
      this.camera.rotation.z = 0;

      this.physics.updateDesktopVirtualHands(this.desktopState, dt);
      _camLocalPos.set(0, 1.05, 0);
    }

    // Step Gorilla Tag physics
    this.physics.step(dt, _camLocalPos);

    // Sample individual finger poses (Grip -> pinky/grip fingers, Trigger -> pointer finger, Face/Stick -> thumb)
    this.sampleHandFingers('left', this.leftFingerPose);
    this.sampleHandFingers('right', this.rightFingerPose);

    // Update visual hand meshes to clamped surface positions
    this.leftHandMesh.group.position.copy(this.physics.leftHand.visualWorldPos);
    this.rightHandMesh.group.position.copy(this.physics.rightHand.visualWorldPos);

    if (isXR) {
      if (this.leftController) {
        this.leftController.getWorldQuaternion(_ctrlWorldQuat);
        this.leftHandMesh.group.quaternion.copy(_ctrlWorldQuat);
      }
      if (this.rightController) {
        this.rightController.getWorldQuaternion(_ctrlWorldQuat);
        this.rightHandMesh.group.quaternion.copy(_ctrlWorldQuat);
      }
    } else {
      _desktopEuler.set(this.desktopState.pitch * 0.45 - 0.35, this.desktopState.yaw, 0, 'YXZ');
      this.leftHandMesh.group.quaternion.setFromEuler(_desktopEuler);
      this.rightHandMesh.group.quaternion.setFromEuler(_desktopEuler);
    }

    this.leftHandMesh.setContactState(this.physics.leftHand.inContact);
    this.rightHandMesh.setContactState(this.physics.rightHand.inContact);

    // Update full articulated Gorilla Tag player model & 2-bone arm IK + per-finger pose
    if (this.playerModelRig) {
      _headWorldPos.copy(this.playerRig.position).add(_camLocalPos);
      if (isXR) {
        this.camera.getWorldQuaternion(_ctrlWorldQuat);
        _headEuler.setFromQuaternion(_ctrlWorldQuat, 'YXZ');
      } else {
        _headEuler.set(this.desktopState.pitch, this.desktopState.yaw, 0, 'YXZ');
      }
      this.playerModelRig.updatePose({
        dt,
        headWorldPos: _headWorldPos,
        headYaw: _headEuler.y,
        headPitch: _headEuler.x,
        leftHandWorldPos: this.physics.leftHand.visualWorldPos,
        rightHandWorldPos: this.physics.rightHand.visualWorldPos,
        leftHandWorldQuat: isXR ? this.leftHandMesh.group.quaternion : undefined,
        rightHandWorldQuat: isXR ? this.rightHandMesh.group.quaternion : undefined,
        leftContact: this.physics.leftHand.inContact,
        rightContact: this.physics.rightHand.inContact,
        leftFingers: this.leftFingerPose,
        rightFingers: this.rightFingerPose,
      });
    }
  }

  private updateMoonShadowTarget(): void {
    const snap = 1.0;
    const sx = Math.round(this.playerRig.position.x / snap) * snap;
    const sy = Math.round(this.playerRig.position.y / snap) * snap;
    const sz = Math.round(this.playerRig.position.z / snap) * snap;
    this.moonLight.target.position.set(sx, sy, sz);
    this.moonLight.position.set(sx + 22, sy + 36, sz + 18);
    this.moonLight.target.updateMatrixWorld();

    _headWorldPos.copy(this.playerRig.position).add(_camLocalPos);
    this.playerFlashLight.position.copy(_headWorldPos);
  }

  private emitTelemetry(): void {
    const game = this.multiplayer.currentGame;
    const role = this.getLocalGameRole();
    const editSnap = this.killEdit.getSnapshot();
    this.onTelemetry({
      altitude: Math.max(0, this.playerRig.position.y),
      speed: this.physics.velocity.length(),
      chunks: 4,
      isVR: this.renderer.xr.isPresenting,
      isPointerLocked: document.pointerLockElement === this.renderer.domElement,
      leftContact: this.physics.leftHand.inContact,
      rightContact: this.physics.rightHand.inContact,
      contextLost: this.isContextLost,
      playersOnline: this.mpStatus.playerCount,
      mpConnected: this.mpStatus.connected,
      room: this.mpStatus.room,
      username: this.mpStatus.username,
      micState: this.voiceStatus.micState,
      isSpeaking: this.voiceStatus.isSpeaking,
      voiceError: this.voiceStatus.errorMessage,
      hasCustomLeftHand: this.leftHandMesh.hasCustomModel(),
      hasCustomRightHand: this.rightHandMesh.hasCustomModel(),
      isHandFinalized: this.isHandFinalized,
      isHandLocked: this.isHandLocked,
      gamePhase: game.phase,
      gameRole: role,
      gameTimeLeftSec: this.getGameTimeLeftSec(),
      gameWinner: game.winner,
      gameEndReason: game.endReason,
      gameNotice: this.gameNotice,
      isPracticeMode: Boolean(game.isPractice),
      knifeCooldownSec: this.knifeCooldown,
      superJumpCooldownSec: this.superJumpCooldown,
      killEditActive: editSnap.active,
      killEditPhase: editSnap.phase,
      killEditCutIndex: editSnap.cutIndex,
      killEditTotalCuts: editSnap.totalCuts,
      killEditFlash: editSnap.flashStrength,
      killEditTimeLeftSec: editSnap.timeLeftSec,
      killEditKillerName: editSnap.killerName,
      killEditVictimName: editSnap.victimName,
      dummyKills: this.dummyKills,
    });
  }

  private tick = (): void => {
    if (this.disposed || this.isContextLost) return;

    const rawDt = Math.min(0.05, this.clock.getDelta() || 0.016);
    const timeScale = this.killEdit.getTimeScale();
    const dt = rawDt * timeScale;

    if (this.knifeCooldown > 0) this.knifeCooldown = Math.max(0, this.knifeCooldown - rawDt);
    if (this.superJumpCooldown > 0) this.superJumpCooldown = Math.max(0, this.superJumpCooldown - rawDt);
    if (this.meleeCooldown > 0) this.meleeCooldown = Math.max(0, this.meleeCooldown - rawDt);
    if (this.gameNoticeTimer > 0) {
      this.gameNoticeTimer -= rawDt;
      if (this.gameNoticeTimer <= 0) {
        this.gameNotice = null;
      }
    }

    const role = this.getLocalGameRole();
    const game = this.multiplayer.currentGame;
    const isSingleDummy = this.isSingleplayerDummyMode();

    // Auto-respawn Test Dummy when in Singleplayer / Practice and not currently mid-kill-edit
    if (isSingleDummy && !this.dummyAlive && !this.killEdit.isActive()) {
      this.dummyRespawnTimer -= rawDt;
      if (this.dummyRespawnTimer <= 0) {
        this.respawnPracticeDummy();
      }
    }

    // Innocent gets a noticeable Speed Booster over Murderer
    this.physics.speedMultiplier = role === 'innocent' ? 1.28 : 1.0;

    // Animate Haunted Hotel chandelier & antique lights
    this.hotel.update(this.clock.elapsedTime);

    // Practice / Singleplayer Test Dummy visibility & idle watch behavior
    if (this.practiceDummyGroup) {
      const showDummy = isSingleDummy && this.dummyAlive;
      this.practiceDummyGroup.visible = showDummy;
      if (showDummy) {
        const dx = this.playerRig.position.x - this.practiceDummyPos.x;
        const dz = this.playerRig.position.z - this.practiceDummyPos.z;
        this.practiceDummyGroup.rotation.y = Math.atan2(dx, dz);
        this.practiceDummyGroup.position.y =
          this.practiceDummyPos.y + Math.sin(this.clock.elapsedTime * 2.6) * 0.04;
      }
    }

    // Update physics & hands (freeze desktop camera override while desktop kill edit films third-person angles)
    const editActive = this.killEdit.isActive();
    const isXR = this.renderer.xr.isPresenting;
    this.playerModelRig?.setThirdPersonReveal(editActive && !isXR && this.killEdit.isLocalPlayerKiller());

    if (!editActive || isXR) {
      this.syncHandsAndCamera(dt);
    } else if (this.playerModelRig) {
      // Keep local Gorilla rig animated cleanly in world space during slow-mo desktop edit
      _headWorldPos.copy(this.playerRig.position).add(_camLocalPos);
      _headEuler.set(this.desktopState.pitch, this.desktopState.yaw, 0, 'YXZ');
      this.playerModelRig.updatePose({
        dt,
        headWorldPos: _headWorldPos,
        headYaw: _headEuler.y,
        headPitch: _headEuler.x,
        leftHandWorldPos: this.physics.leftHand.visualWorldPos,
        rightHandWorldPos: this.physics.rightHand.visualWorldPos,
        leftContact: this.physics.leftHand.inContact,
        rightContact: this.physics.rightHand.inContact,
        leftFingers: this.leftFingerPose,
        rightFingers: this.rightFingerPose,
      });
    }

    // Sync multiplayer pose & update Left Wrist Room Watch / Spatial VR Keyboard
    _headWorldPos.copy(this.playerRig.position).add(_camLocalPos);
    if (isXR) {
      this.camera.getWorldQuaternion(_ctrlWorldQuat);
      _headEuler.setFromQuaternion(_ctrlWorldQuat, 'YXZ');
    } else {
      _headEuler.set(this.desktopState.pitch, this.desktopState.yaw, 0, 'YXZ');
    }

    _rightTipWorldPos
      .copy(_rightTipOffset)
      .applyQuaternion(this.rightHandMesh.group.quaternion)
      .add(this.rightHandMesh.group.position);

    // Track continuous right fingertip velocity for accurate "yeet" knife throws
    if (this.hasPrevRightTip && rawDt > 1e-4) {
      _tipInstVel.copy(_rightTipWorldPos).sub(this.prevRightTipWorldPos).divideScalar(rawDt);
      const alpha = 1 - Math.exp(-18 * rawDt);
      this.smoothedTipVelocity.lerp(_tipInstVel, alpha);
    } else {
      this.smoothedTipVelocity.set(0, 0, 0);
      this.hasPrevRightTip = true;
    }
    this.prevRightTipWorldPos.copy(_rightTipWorldPos);

    // Poll Quest Right Controller buttons: A (buttons[4]) for Innocent Super Jump, Trigger (buttons[0]) for Knife Throw
    if (isXR && this.sessionJoined) {
      const rightGp = this.getXRInputSource('right')?.gamepad;
      const buttons = rightGp?.buttons;
      if (buttons && buttons.length > 0) {
        const aBtn = buttons[4];
        const aDown = Boolean(aBtn && (aBtn.pressed || aBtn.value > 0.6));
        if (aDown && !this.rightAButtonWasDown && role === 'innocent') {
          this.triggerSuperJump();
        }
        this.rightAButtonWasDown = aDown;

        const trigBtn = buttons[0];
        const trigHeld = Boolean(trigBtn && (trigBtn.pressed || trigBtn.value > 0.55));
        if (!trigHeld && this.rightTriggerWasHeld && (role === 'murderer' || isSingleDummy)) {
          this.triggerKnifeThrow(false);
        }
        this.rightTriggerWasHeld = trigHeld;
      }
    }

    // Hold local placeholder 3D knife in right hand (Murderer during Hunt, Singleplayer Dummy mode, or Killer during Kill Edit)
    const showHeldKnife =
      (isSingleDummy ||
        (role === 'murderer' && (game.phase === 'hunt' || (game.isPractice && game.phase === 'hiding'))) ||
        this.killEdit.isLocalPlayerKiller()) &&
      (this.killEdit.isLocalPlayerKiller() || this.knifeCooldown <= 0.05);
    this.localKnifeRig.group.visible = showHeldKnife;
    if (showHeldKnife) {
      this.localKnifeRig.group.position.copy(this.rightHandMesh.group.position);
      this.localKnifeRig.group.quaternion.copy(this.rightHandMesh.group.quaternion);
    }

    // Update flying/embedded knives + hit detection
    this.updateActiveKnives(dt);

    // Update Kill Edit Sequencer (uses real wall-clock rawDt for 2.0s beats while world runs slow-mo)
    if (this.killEdit.isActive()) {
      const killerId = this.killEdit.getKillerId();
      const remoteKiller =
        killerId && killerId !== (this.multiplayer.playerId || 'local')
          ? this.multiplayer.getPlayerPoseById(killerId)
          : null;
      const killerPose = remoteKiller || {
        headPos: _headWorldPos.clone(),
        yaw: _headEuler.y,
        rightHandPos: this.rightHandMesh.group.position.clone(),
      };
      this.killEdit.update(
        rawDt,
        this.camera,
        this.renderer,
        this.scene,
        isXR,
        this.isSoftwareGl,
        _headWorldPos,
        _headEuler.y,
        killerPose,
        this.hotel
      );
    }

    const abilityText =
      role === 'innocent'
        ? this.superJumpCooldown > 0
          ? `SUPER JUMP ${this.superJumpCooldown.toFixed(0)}s`
          : 'A: SUPER JUMP READY'
        : role === 'murderer' || isSingleDummy
          ? this.knifeCooldown > 0
            ? `KNIFE ${this.knifeCooldown.toFixed(1)}s`
            : 'TRIGGER: THROW KNIFE'
          : game.phase === 'ended' && game.winner
            ? game.winner === 'innocent'
              ? 'INNOCENT SURVIVED!'
              : 'MURDERER WON!'
            : 'TAP TO JOIN ROOM';

    this.roomWristUi.update({
      dt: rawDt,
      leftWristWorldPos: this.leftHandMesh.group.position,
      leftWristWorldQuat: this.leftHandMesh.group.quaternion,
      rightFingerTipWorldPos: _rightTipWorldPos,
      headWorldPos: _headWorldPos,
      headYaw: _headEuler.y,
      roomCode: this.mpStatus.room,
      connected: this.mpStatus.connected,
      playersOnline: this.mpStatus.playerCount,
      sessionJoined: this.sessionJoined,
      gamePhase: game.phase,
      gameRole: role,
      timeLeftSec: this.getGameTimeLeftSec(),
      abilityText,
    });

    this.multiplayer.update(
      rawDt,
      _headWorldPos,
      _headEuler.y,
      _headEuler.x,
      this.leftHandMesh.group.position,
      this.rightHandMesh.group.position,
      this.physics.leftHand.inContact,
      this.physics.rightHand.inContact,
      this.leftFingerPose,
      this.rightFingerPose,
      this.leftHandMesh.group.quaternion,
      this.rightHandMesh.group.quaternion
    );

    // Keep shadow frustum & lantern centered on player
    this.updateMoonShadowTarget();

    // Render frame
    this.renderer.render(this.scene, this.camera);

    // Throttled HUD telemetry update (~10Hz)
    this.telemetryAccum += rawDt;
    if (this.telemetryAccum >= 0.08) {
      this.telemetryAccum = 0;
      this.emitTelemetry();
    }

    // Pace software WebGL loops cleanly via afterDraw
    if (this.isSoftwareGl && !isXR) {
      this.scheduleAfterDraw();
    }
  };

  private scheduleAfterDraw(): void {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    if (!gl || typeof gl.fenceSync !== 'function') {
      this.frameTimerId = window.setTimeout(this.tick, 80);
      return;
    }
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    const poll = () => {
      if (this.disposed || this.isContextLost) {
        if (sync) gl.deleteSync(sync);
        return;
      }
      const state = sync ? gl.getSyncParameter(sync, gl.SYNC_STATUS) : gl.SIGNALED;
      if (state === gl.UNSIGNALED) {
        this.frameTimerId = window.setTimeout(poll, 5);
      } else {
        if (sync) gl.deleteSync(sync);
        this.frameTimerId = window.setTimeout(this.tick, 80);
      }
    };
    this.frameTimerId = window.setTimeout(poll, 5);
  }

  private startLoop(): void {
    this.clock.start();
    if (this.isSoftwareGl && !this.renderer.xr.isPresenting) {
      this.tick();
    } else {
      this.renderer.setAnimationLoop(this.tick);
    }
  }

  private stopLoop(): void {
    this.renderer.setAnimationLoop(null);
    if (this.frameTimerId) {
      clearTimeout(this.frameTimerId);
      this.frameTimerId = 0;
    }
  }

  public dispose(): void {
    this.disposed = true;
    this.stopLoop();

    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('mousemove', this.onMouseMove);

    const canvas = this.renderer.domElement;
    canvas.removeEventListener('mousedown', this.onMouseDown);
    canvas.removeEventListener('contextmenu', this.onContextMenu);
    canvas.removeEventListener('webglcontextlost', this.onContextLost);
    canvas.removeEventListener('webglcontextrestored', this.onContextRestored);

    this.renderer.xr.removeEventListener('sessionstart', this.onXRSessionChange);
    this.renderer.xr.removeEventListener('sessionend', this.onXRSessionChange);

    this.multiplayer.dispose();
    this.roomWristUi.dispose();
    this.killEdit.dispose();
    this.playerModelRig?.dispose();
    this.localKnifeRig.dispose();
    this.clearActiveKnives();
    if (this.practiceDummyGroup) {
      this.practiceDummyGroup.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          if (obj.material instanceof THREE.Material) obj.material.dispose();
        }
      });
    }
    this.hotel.dispose();
    this.audio.dispose();

    if (this.vrButton.parentElement) {
      this.vrButton.parentElement.removeChild(this.vrButton);
    }
    if (canvas.parentElement) {
      canvas.parentElement.removeChild(canvas);
    }
    this.renderer.dispose();
  }
}
