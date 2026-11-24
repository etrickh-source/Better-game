import * as THREE from 'three';

export interface WristUiState {
  roomCode: string;
  connected: boolean;
  playersOnline: number;
  draftCode: string;
  keyboardOpen: boolean;
  gamePhase: 'lobby' | 'hiding' | 'hunt' | 'ended';
  gameRole: 'none' | 'murderer' | 'innocent' | 'eliminated';
  timeLeftSec: number;
  abilityText: string;
}

interface KeyButtonDef {
  id: string;
  label: string;
  action: 'char' | 'del' | 'clear' | 'join' | 'close';
  value?: string;
  localCenter: THREE.Vector3;
  halfW: number;
  halfH: number;
  mesh: THREE.Mesh;
  baseZ: number;
  pressAnim: number;
  cooldown: number;
  wasInside: boolean;
}

const _wristLocalOffset = new THREE.Vector3(0.024, 0.056, 0.095);
const _wristEulerOffset = new THREE.Euler(-0.46, 0.28, -0.14, 'YXZ');
const _wristQuatOffset = new THREE.Quaternion().setFromEuler(_wristEulerOffset);
const _tapBoxLocal = new THREE.Vector3(0, -0.014, 0.009);
const _tapWorldPos = new THREE.Vector3();
const _tmpVec = new THREE.Vector3();
const _kbLocalFinger = new THREE.Vector3();
const _kbForward = new THREE.Vector3();
const _kbPos = new THREE.Vector3();
const _kbUp = new THREE.Vector3(0, 1, 0);

const _startBoxLocal = new THREE.Vector3(0.036, 0.024, 0.009);
const _startWorldPos = new THREE.Vector3();

function formatClock(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${rem.toString().padStart(2, '0')}`;
}

function drawWristScreen(
  canvas: HTMLCanvasElement,
  state: WristUiState,
  fingerHoveredTap: boolean,
  fingerHoveredStart: boolean
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;

  ctx.clearRect(0, 0, w, h);

  // Dark slate/obsidian bezel background
  ctx.fillStyle = '#0f172a';
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, 26);
  ctx.fill();

  const borderColor =
    state.gameRole === 'murderer'
      ? '#ef4444'
      : state.gameRole === 'innocent'
        ? '#38bdf8'
        : state.keyboardOpen
          ? '#38bdf8'
          : '#334155';
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.roundRect(3, 3, w - 6, h - 6, 24);
  ctx.stroke();

  // Header row: ROOM CODE + online / Start button or Match Timer
  ctx.fillStyle = '#94a3b8';
  ctx.font = 'bold 20px "Plus Jakarta Sans", sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(`ROOM ${state.roomCode || '-----'}`, 24, 34);

  if (state.gamePhase === 'lobby' || state.gamePhase === 'ended') {
    // Tappable START MATCH badge on top right of wrist watch
    const bx = w - 188;
    const by = 14;
    const bw = 166;
    const bh = 42;
    ctx.fillStyle = fingerHoveredStart ? '#dc2626' : '#991b1b';
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, 12);
    ctx.fill();
    ctx.strokeStyle = fingerHoveredStart ? '#fca5a5' : '#ef4444';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.font = 'bold 18px "Plus Jakarta Sans", sans-serif';
    ctx.fillText(state.playersOnline >= 2 ? 'START GAME' : 'PRACTICE', bx + bw / 2, by + bh / 2 + 1);
  } else {
    ctx.textAlign = 'right';
    ctx.fillStyle = state.gamePhase === 'hiding' ? '#fbbf24' : '#f87171';
    ctx.font = 'bold 26px "JetBrains Mono", monospace';
    const prefix = state.gamePhase === 'hiding' ? 'HIDE ' : '';
    ctx.fillText(`${prefix}${formatClock(state.timeLeftSec)}`, w - 24, 34);
  }

  // Center Readout: Room Code in lobby, Role + Ability status during match
  ctx.textAlign = 'center';
  if (state.gamePhase === 'lobby' || state.gamePhase === 'ended') {
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 54px "JetBrains Mono", monospace';
    ctx.fillText(state.roomCode || '-----', w / 2, 102);

    ctx.fillStyle = state.connected ? '#34d399' : '#fbbf24';
    ctx.font = 'bold 17px "Plus Jakarta Sans", sans-serif';
    ctx.fillText(
      state.connected ? `${state.playersOnline} IN HOTEL` : 'CONNECTING...',
      w / 2,
      142
    );
  } else {
    ctx.fillStyle =
      state.gameRole === 'murderer'
        ? '#f87171'
        : state.gameRole === 'innocent'
          ? '#38bdf8'
          : '#94a3b8';
    ctx.font = 'bold 34px "Plus Jakarta Sans", sans-serif';
    const roleLabel =
      state.gameRole === 'murderer'
        ? 'MURDERER'
        : state.gameRole === 'innocent'
          ? 'INNOCENT'
          : 'SPECTATING';
    ctx.fillText(roleLabel, w / 2, 92);

    ctx.fillStyle = '#e2e8f0';
    ctx.font = '600 20px "JetBrains Mono", monospace';
    ctx.fillText(state.abilityText || '', w / 2, 134);
  }

  // Little empty input space below for tapping with right finger (Room Code Keyboard)
  const boxX = 24;
  const boxY = 164;
  const boxW = w - 48;
  const boxH = 96;

  ctx.fillStyle = state.keyboardOpen
    ? '#1e3a8a'
    : fingerHoveredTap
      ? '#1e293b'
      : '#020617';
  ctx.beginPath();
  ctx.roundRect(boxX, boxY, boxW, boxH, 16);
  ctx.fill();

  ctx.strokeStyle = state.keyboardOpen
    ? '#38bdf8'
    : fingerHoveredTap
      ? '#7dd3fc'
      : '#475569';
  ctx.lineWidth = fingerHoveredTap || state.keyboardOpen ? 5 : 3;
  ctx.beginPath();
  ctx.roundRect(boxX, boxY, boxW, boxH, 16);
  ctx.stroke();

  if (state.keyboardOpen && state.draftCode.length > 0) {
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 42px "JetBrains Mono", monospace';
    ctx.fillText(`${state.draftCode}_`, w / 2, boxY + boxH / 2 + 2);
  } else {
    ctx.fillStyle = fingerHoveredTap ? '#e0f2fe' : '#94a3b8';
    ctx.font = '600 23px "Plus Jakarta Sans", sans-serif';
    ctx.fillText(
      state.keyboardOpen ? 'Typing code...' : 'Tap to enter friend code',
      w / 2,
      boxY + boxH / 2 + 1
    );
  }
}

function createKeyTexture(label: string, variant: 'normal' | 'action' | 'primary' | 'danger'): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 96;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const bg =
      variant === 'primary'
        ? '#0284c7'
        : variant === 'danger'
          ? '#b91c1c'
          : variant === 'action'
            ? '#334155'
            : '#1e293b';
    const border =
      variant === 'primary'
        ? '#38bdf8'
        : variant === 'danger'
          ? '#f87171'
          : '#475569';

    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.roundRect(4, 4, 120, 88, 16);
    ctx.fill();

    ctx.strokeStyle = border;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.roundRect(4, 4, 120, 88, 16);
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = label.length > 2 ? 'bold 28px "Plus Jakarta Sans", sans-serif' : 'bold 42px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 64, 50);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function drawKeyboardHeader(
  canvas: HTMLCanvasElement,
  currentRoom: string,
  draftCode: string
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;

  ctx.clearRect(0, 0, w, h);

  ctx.fillStyle = '#0f172a';
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, 20);
  ctx.fill();

  ctx.fillStyle = '#94a3b8';
  ctx.font = 'bold 22px "Plus Jakarta Sans", sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('JOIN FRIEND ROOM', 28, 34);

  ctx.textAlign = 'right';
  ctx.fillStyle = '#7dd3fc';
  ctx.font = '600 22px "JetBrains Mono", monospace';
  ctx.fillText(`YOUR CODE: ${currentRoom}`, w - 28, 34);

  // Input box
  ctx.fillStyle = '#020617';
  ctx.beginPath();
  ctx.roundRect(24, 60, w - 48, 76, 14);
  ctx.fill();

  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.roundRect(24, 60, w - 48, 76, 14);
  ctx.stroke();

  ctx.textAlign = 'center';
  if (draftCode.length > 0) {
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 46px "JetBrains Mono", monospace';
    ctx.fillText(`${draftCode}_`, w / 2, 100);
  } else {
    ctx.fillStyle = '#64748b';
    ctx.font = '500 26px "Plus Jakarta Sans", sans-serif';
    ctx.fillText('Poke keys or type on Quest keyboard...', w / 2, 100);
  }
}

export class VRRoomWristUI {
  public readonly root = new THREE.Group();
  public readonly wristGroup = new THREE.Group();
  public readonly keyboardGroup = new THREE.Group();
  public readonly fingerTipDot: THREE.Mesh;

  private readonly wristCanvas: HTMLCanvasElement;
  private readonly wristTexture: THREE.CanvasTexture;
  private readonly kbHeaderCanvas: HTMLCanvasElement;
  private readonly kbHeaderTexture: THREE.CanvasTexture;
  private readonly bannerGroup = new THREE.Group();
  private readonly bannerCanvas: HTMLCanvasElement;
  private readonly bannerTexture: THREE.CanvasTexture;
  private bannerTimer = 0;
  private readonly keys: KeyButtonDef[] = [];

  private fingerHoveredWrist = false;
  private fingerHoveredStart = false;
  private wristTapCooldown = 0;
  private wristWasInside = false;
  private startTapCooldown = 0;
  private startWasInside = false;
  private lastWristHash = '';
  private lastKbHeaderHash = '';

  private keyboardOpen = false;
  private draftCode = '';
  private currentRoom = '';
  private connected = false;
  private playersOnline = 1;

  private readonly onRequestKeyboardOpen: () => void;
  private readonly onSubmitRoomCode: (code: string) => void;
  private readonly onDraftCodeChange: (code: string) => void;
  private readonly onKeyboardClosed: () => void;
  private readonly onPlayTap: (pitch?: number) => void;
  private readonly onPulseHaptic: (strength: number, durationMs: number) => void;
  private readonly onRequestStartMatch?: () => void;

  constructor(callbacks: {
    onRequestKeyboardOpen: () => void;
    onSubmitRoomCode: (code: string) => void;
    onDraftCodeChange: (code: string) => void;
    onKeyboardClosed: () => void;
    onPlayTap: (pitch?: number) => void;
    onPulseHaptic: (strength: number, durationMs: number) => void;
    onRequestStartMatch?: () => void;
  }) {
    this.onRequestKeyboardOpen = callbacks.onRequestKeyboardOpen;
    this.onSubmitRoomCode = callbacks.onSubmitRoomCode;
    this.onDraftCodeChange = callbacks.onDraftCodeChange;
    this.onKeyboardClosed = callbacks.onKeyboardClosed;
    this.onPlayTap = callbacks.onPlayTap;
    this.onPulseHaptic = callbacks.onPulseHaptic;
    this.onRequestStartMatch = callbacks.onRequestStartMatch;

    this.root.name = 'VRRoomWristUI';

    // 1. Left Wrist Watch Display
    this.wristCanvas = document.createElement('canvas');
    this.wristCanvas.width = 512;
    this.wristCanvas.height = 288;
    this.wristTexture = new THREE.CanvasTexture(this.wristCanvas);
    this.wristTexture.colorSpace = THREE.SRGBColorSpace;

    const housingGeo = new THREE.BoxGeometry(0.136, 0.080, 0.012);
    const housingMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.55,
      metalness: 0.25,
    });
    const housing = new THREE.Mesh(housingGeo, housingMat);
    this.wristGroup.add(housing);

    const screenGeo = new THREE.PlaneGeometry(0.128, 0.072);
    const screenMat = new THREE.MeshBasicMaterial({
      map: this.wristTexture,
      transparent: true,
    });
    const screen = new THREE.Mesh(screenGeo, screenMat);
    screen.position.set(0, 0, 0.0068);
    this.wristGroup.add(screen);
    this.root.add(this.wristGroup);

    // 2. Right Index Finger Tip Indicator (visible when near wrist or keyboard)
    const dotGeo = new THREE.SphereGeometry(0.0085, 12, 10);
    const dotMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.9,
    });
    this.fingerTipDot = new THREE.Mesh(dotGeo, dotMat);
    this.fingerTipDot.visible = false;
    this.root.add(this.fingerTipDot);

    // 3. Spatial 3D Poke Keyboard
    this.keyboardGroup.visible = false;
    const panelGeo = new THREE.BoxGeometry(0.58, 0.38, 0.016);
    const panelMat = new THREE.MeshStandardMaterial({
      color: 0x0f172a,
      roughness: 0.7,
      metalness: 0.15,
    });
    const panel = new THREE.Mesh(panelGeo, panelMat);
    this.keyboardGroup.add(panel);

    this.kbHeaderCanvas = document.createElement('canvas');
    this.kbHeaderCanvas.width = 1024;
    this.kbHeaderCanvas.height = 160;
    this.kbHeaderTexture = new THREE.CanvasTexture(this.kbHeaderCanvas);
    this.kbHeaderTexture.colorSpace = THREE.SRGBColorSpace;

    const headerGeo = new THREE.PlaneGeometry(0.54, 0.086);
    const headerMat = new THREE.MeshBasicMaterial({
      map: this.kbHeaderTexture,
      transparent: true,
    });
    const headerMesh = new THREE.Mesh(headerGeo, headerMat);
    headerMesh.position.set(0, 0.135, 0.009);
    this.keyboardGroup.add(headerMesh);

    this.buildKeyboardLayout();
    this.root.add(this.keyboardGroup);

    // 4. Floating 3D VR Match Role / Winner Banner
    this.bannerCanvas = document.createElement('canvas');
    this.bannerCanvas.width = 768;
    this.bannerCanvas.height = 192;
    this.bannerTexture = new THREE.CanvasTexture(this.bannerCanvas);
    this.bannerTexture.colorSpace = THREE.SRGBColorSpace;
    const bannerGeo = new THREE.PlaneGeometry(0.95, 0.24);
    const bannerMat = new THREE.MeshBasicMaterial({
      map: this.bannerTexture,
      transparent: true,
      depthTest: false,
    });
    const bannerMesh = new THREE.Mesh(bannerGeo, bannerMat);
    this.bannerGroup.add(bannerMesh);
    this.bannerGroup.renderOrder = 20;
    this.bannerGroup.visible = false;
    this.root.add(this.bannerGroup);
  }

  public showBanner(title: string, subtitle: string, accentHex = '#ef4444', durationSec = 4.2): void {
    const ctx = this.bannerCanvas.getContext('2d');
    if (ctx) {
      const w = this.bannerCanvas.width;
      const h = this.bannerCanvas.height;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(10, 14, 22, 0.92)';
      ctx.beginPath();
      ctx.roundRect(8, 8, w - 16, h - 16, 24);
      ctx.fill();
      ctx.strokeStyle = accentHex;
      ctx.lineWidth = 6;
      ctx.stroke();

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = accentHex;
      ctx.font = 'bold 46px "Plus Jakarta Sans", sans-serif';
      ctx.fillText(title, w / 2, 68);

      ctx.fillStyle = '#e2e8f0';
      ctx.font = '600 26px "Plus Jakarta Sans", sans-serif';
      ctx.fillText(subtitle, w / 2, 130);
    }
    this.bannerTexture.needsUpdate = true;
    this.bannerTimer = durationSec;
    this.bannerGroup.visible = true;
  }

  private buildKeyboardLayout(): void {
    const rows: Array<Array<{ label: string; action: KeyButtonDef['action']; value?: string; widthUnits?: number; variant?: 'normal' | 'action' | 'primary' | 'danger' }>> = [
      ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'].map((c) => ({
        label: c,
        action: 'char',
        value: c,
      })),
      ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'].map((c) => ({
        label: c,
        action: 'char',
        value: c,
      })),
      ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'].map((c) => ({
        label: c,
        action: 'char',
        value: c,
      })),
      [
        ...['Z', 'X', 'C', 'V', 'B', 'N', 'M'].map((c) => ({
          label: c,
          action: 'char' as const,
          value: c,
        })),
        { label: 'DEL', action: 'del', widthUnits: 1.8, variant: 'action' },
      ],
      [
        { label: 'CANCEL', action: 'close', widthUnits: 2.5, variant: 'danger' },
        { label: 'CLEAR', action: 'clear', widthUnits: 2.4, variant: 'action' },
        { label: 'JOIN ROOM', action: 'join', widthUnits: 4.1, variant: 'primary' },
      ],
    ];

    const keyUnitW = 0.048;
    const keyGap = 0.0055;
    const keyH = 0.039;
    const rowStep = 0.0455;
    const startY = 0.058;

    rows.forEach((row, rIdx) => {
      const totalWidth = row.reduce(
        (sum, k, i) => sum + (k.widthUnits || 1) * keyUnitW + (i > 0 ? keyGap : 0),
        0
      );
      let cursorX = -totalWidth / 2;
      const y = startY - rIdx * rowStep;

      for (const k of row) {
        const w = (k.widthUnits || 1) * keyUnitW;
        const cx = cursorX + w / 2;
        cursorX += w + keyGap;

        const geo = new THREE.BoxGeometry(w, keyH, 0.012);
        const tex = createKeyTexture(k.label, k.variant || 'normal');
        const sideMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.6 });
        const faceMat = new THREE.MeshBasicMaterial({ map: tex });
        const mats = [sideMat, sideMat, sideMat, sideMat, faceMat, sideMat];

        const mesh = new THREE.Mesh(geo, mats);
        const baseZ = 0.014;
        mesh.position.set(cx, y, baseZ);
        this.keyboardGroup.add(mesh);

        this.keys.push({
          id: `${rIdx}-${k.label}`,
          label: k.label,
          action: k.action,
          value: k.value,
          localCenter: new THREE.Vector3(cx, y, baseZ),
          halfW: w * 0.5,
          halfH: keyH * 0.5,
          mesh,
          baseZ,
          pressAnim: 0,
          cooldown: 0,
          wasInside: false,
        });
      }
    });
  }

  public isKeyboardOpen(): boolean {
    return this.keyboardOpen;
  }

  public openKeyboard(headWorldPos: THREE.Vector3, headYaw: number): void {
    if (!this.keyboardOpen) {
      this.keyboardOpen = true;
      this.draftCode = '';
      this.keyboardGroup.visible = true;
      for (const key of this.keys) {
        key.cooldown = 0.28;
        key.wasInside = false;
      }
      this.positionKeyboardInFrontOfPlayer(headWorldPos, headYaw);
    }
  }

  public closeKeyboard(): void {
    if (!this.keyboardOpen) return;
    this.keyboardOpen = false;
    this.keyboardGroup.visible = false;
    this.onKeyboardClosed();
  }

  public setDraftCode(next: string): void {
    const cleaned = next.toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 12);
    this.draftCode = cleaned;
  }

  public getDraftCode(): string {
    return this.draftCode;
  }

  public positionKeyboardInFrontOfPlayer(headWorldPos: THREE.Vector3, headYaw: number): void {
    _kbForward.set(-Math.sin(headYaw), 0, -Math.cos(headYaw)).normalize();
    _kbPos.copy(headWorldPos).addScaledVector(_kbForward, 0.46);
    _kbPos.y -= 0.16;
    this.keyboardGroup.position.copy(_kbPos);

    // Face player horizontally with comfortable slight upward tilt
    this.keyboardGroup.quaternion.setFromAxisAngle(_kbUp, headYaw);
    this.keyboardGroup.rotateX(-0.24);
    this.keyboardGroup.updateMatrixWorld(true);
  }

  public update(params: {
    dt: number;
    leftWristWorldPos: THREE.Vector3;
    leftWristWorldQuat: THREE.Quaternion;
    rightFingerTipWorldPos: THREE.Vector3;
    headWorldPos: THREE.Vector3;
    headYaw: number;
    roomCode: string;
    connected: boolean;
    playersOnline: number;
    sessionJoined: boolean;
    gamePhase: 'lobby' | 'hiding' | 'hunt' | 'ended';
    gameRole: 'none' | 'murderer' | 'innocent' | 'eliminated';
    timeLeftSec: number;
    abilityText: string;
  }): void {
    const {
      dt,
      leftWristWorldPos,
      leftWristWorldQuat,
      rightFingerTipWorldPos,
      headWorldPos,
      headYaw,
      roomCode,
      connected,
      playersOnline,
      sessionJoined,
      gamePhase,
      gameRole,
      timeLeftSec,
      abilityText,
    } = params;

    this.currentRoom = roomCode;
    this.connected = connected;
    this.playersOnline = playersOnline;

    if (this.wristTapCooldown > 0) {
      this.wristTapCooldown = Math.max(0, this.wristTapCooldown - dt);
    }
    if (this.startTapCooldown > 0) {
      this.startTapCooldown = Math.max(0, this.startTapCooldown - dt);
    }

    // 1. Anchor Wrist Room Display onto left forearm/wrist
    _tmpVec.copy(_wristLocalOffset).applyQuaternion(leftWristWorldQuat);
    this.wristGroup.position.copy(leftWristWorldPos).add(_tmpVec);
    this.wristGroup.quaternion.copy(leftWristWorldQuat).multiply(_wristQuatOffset);
    this.wristGroup.updateMatrixWorld(true);

    // 2. Check Right-Hand Finger Tap on Wrist Empty Space (Room Code) & Start Button
    _tapWorldPos.copy(_tapBoxLocal).applyMatrix4(this.wristGroup.matrixWorld);
    const distToTap = rightFingerTipWorldPos.distanceTo(_tapWorldPos);
    const isNearWrist = distToTap < 0.14;
    const isTouchingWrist = distToTap < 0.052;
    this.fingerHoveredWrist = isNearWrist;

    _startWorldPos.copy(_startBoxLocal).applyMatrix4(this.wristGroup.matrixWorld);
    const distToStart = rightFingerTipWorldPos.distanceTo(_startWorldPos);
    const canTapStart = gamePhase === 'lobby' || gamePhase === 'ended';
    this.fingerHoveredStart = canTapStart && distToStart < 0.11;

    if (sessionJoined) {
      if (canTapStart && distToStart < 0.042 && !this.startWasInside && this.startTapCooldown <= 0) {
        this.startWasInside = true;
        this.startTapCooldown = 0.8;
        this.onPlayTap(860);
        this.onPulseHaptic(0.6, 45);
        this.onRequestStartMatch?.();
      } else if (distToStart > 0.065) {
        this.startWasInside = false;
      }

      if (isTouchingWrist && !this.wristWasInside && this.wristTapCooldown <= 0) {
        this.wristWasInside = true;
        this.wristTapCooldown = 0.45;
        this.onPlayTap(740);
        this.onPulseHaptic(0.55, 40);
        if (!this.keyboardOpen) {
          this.openKeyboard(headWorldPos, headYaw);
          this.onRequestKeyboardOpen();
        } else {
          this.onRequestKeyboardOpen();
        }
      } else if (distToTap > 0.078) {
        this.wristWasInside = false;
      }
    }

    // 3. Update 3D Spatial Keyboard & Fingertip Poke Physics
    let minKeyDist = Infinity;
    if (this.keyboardOpen) {
      this.keyboardGroup.updateMatrixWorld(true);
      _kbLocalFinger.copy(rightFingerTipWorldPos);
      this.keyboardGroup.worldToLocal(_kbLocalFinger);

      for (const key of this.keys) {
        if (key.cooldown > 0) key.cooldown = Math.max(0, key.cooldown - dt);
        if (key.pressAnim > 0) key.pressAnim = Math.max(0, key.pressAnim - dt * 6);

        const dx = Math.abs(_kbLocalFinger.x - key.localCenter.x);
        const dy = Math.abs(_kbLocalFinger.y - key.localCenter.y);
        const dz = _kbLocalFinger.z - key.baseZ;
        const planeDist = Math.hypot(
          Math.max(0, dx - key.halfW),
          Math.max(0, dy - key.halfH),
          Math.max(0, Math.abs(dz) - 0.015)
        );
        if (planeDist < minKeyDist) minKeyDist = planeDist;

        const inside = dx <= key.halfW + 0.004 && dy <= key.halfH + 0.004 && dz >= -0.022 && dz <= 0.024;
        if (inside && !key.wasInside && key.cooldown <= 0) {
          key.wasInside = true;
          key.cooldown = 0.24;
          key.pressAnim = 1.0;
          this.triggerKeyAction(key);
        } else if (!inside && (dx > key.halfW + 0.012 || dy > key.halfH + 0.012 || dz > 0.032)) {
          key.wasInside = false;
        }

        key.mesh.position.z = key.baseZ - key.pressAnim * 0.007;
      }

      if (headWorldPos.distanceTo(this.keyboardGroup.position) > 1.45) {
        this.closeKeyboard();
      }
    }

    // 3b. Floating VR Match Banner
    if (this.bannerTimer > 0) {
      this.bannerTimer = Math.max(0, this.bannerTimer - dt);
      _kbForward.set(-Math.sin(headYaw), 0, -Math.cos(headYaw)).normalize();
      _kbPos.copy(headWorldPos).addScaledVector(_kbForward, 1.35);
      _kbPos.y += 0.24;
      this.bannerGroup.position.lerp(_kbPos, 1 - Math.exp(-8 * dt));
      this.bannerGroup.quaternion.setFromAxisAngle(_kbUp, headYaw);
      this.bannerGroup.visible = this.bannerTimer > 0;
    }

    // 4. Show subtle fingertip pointer dot when finger is close to wrist watch or keyboard
    const showTip =
      sessionJoined && (distToTap < 0.28 || distToStart < 0.22 || (this.keyboardOpen && minKeyDist < 0.28));
    this.fingerTipDot.visible = showTip;
    if (showTip) {
      this.fingerTipDot.position.copy(rightFingerTipWorldPos);
    }

    // 5. Redraw canvases only when state changes
    const roundedSec = Math.ceil(timeLeftSec);
    const wristHash = `${roomCode}|${connected ? 1 : 0}|${playersOnline}|${this.draftCode}|${this.keyboardOpen ? 1 : 0}|${this.fingerHoveredWrist ? 1 : 0}|${this.fingerHoveredStart ? 1 : 0}|${gamePhase}|${gameRole}|${roundedSec}|${abilityText}`;
    if (wristHash !== this.lastWristHash) {
      this.lastWristHash = wristHash;
      drawWristScreen(
        this.wristCanvas,
        {
          roomCode,
          connected,
          playersOnline,
          draftCode: this.draftCode,
          keyboardOpen: this.keyboardOpen,
          gamePhase,
          gameRole,
          timeLeftSec,
          abilityText,
        },
        this.fingerHoveredWrist,
        this.fingerHoveredStart
      );
      this.wristTexture.needsUpdate = true;
    }

    if (this.keyboardOpen) {
      const kbHash = `${roomCode}|${this.draftCode}`;
      if (kbHash !== this.lastKbHeaderHash) {
        this.lastKbHeaderHash = kbHash;
        drawKeyboardHeader(this.kbHeaderCanvas, roomCode, this.draftCode);
        this.kbHeaderTexture.needsUpdate = true;
      }
    }
  }

  private triggerKeyAction(key: KeyButtonDef): void {
    this.onPlayTap(key.action === 'join' ? 880 : key.action === 'close' ? 420 : 640);
    this.onPulseHaptic(0.45, 28);

    if (key.action === 'char' && key.value) {
      if (this.draftCode.length < 12) {
        this.draftCode += key.value;
        this.onDraftCodeChange(this.draftCode);
      }
    } else if (key.action === 'del') {
      this.draftCode = this.draftCode.slice(0, -1);
      this.onDraftCodeChange(this.draftCode);
    } else if (key.action === 'clear') {
      this.draftCode = '';
      this.onDraftCodeChange(this.draftCode);
    } else if (key.action === 'join') {
      const target = this.draftCode.trim();
      if (target.length >= 2) {
        this.onSubmitRoomCode(target);
        this.closeKeyboard();
      }
    } else if (key.action === 'close') {
      this.closeKeyboard();
    }
  }

  public dispose(): void {
    this.wristTexture.dispose();
    this.kbHeaderTexture.dispose();
    this.bannerTexture.dispose();
    this.root.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) {
          if (m instanceof THREE.Material) {
            const basic = m as THREE.MeshBasicMaterial;
            basic.map?.dispose();
            m.dispose();
          }
        }
      }
    });
  }
}
