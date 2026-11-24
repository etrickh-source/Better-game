import * as THREE from 'three';
import { createMonkeyHand, MonkeyHandRig } from './monkeyHands';
import { VoiceChatManager, VoiceStatus } from './voiceChat';
import {
  loadRemoteHandModel,
  UploadedHandRef,
} from './customHandLoader';
import { GorillaPlayerRig, HandFingerPose, preloadGorillaPlayerTemplate } from './gorillaPlayerRig';
import { createKnifeModel, KnifeVisualRig } from './knifeModel';

export type GamePhase = 'lobby' | 'hiding' | 'hunt' | 'ended';
export type PlayerGameRole = 'none' | 'murderer' | 'innocent' | 'eliminated';

export interface RoomGameState {
  phase: GamePhase;
  murdererId: string | null;
  innocentIds: string[];
  aliveInnocentIds: string[];
  phaseEndsAt: number;
  serverTime: number;
  winner: 'murderer' | 'innocent' | null;
  endReason: string;
  isPractice: boolean;
  roundId: number;
}

export interface KnifeThrownEvent {
  knifeId: string;
  throwerId: string;
  origin: THREE.Vector3;
  vel: THREE.Vector3;
}

export interface PlayerKilledEvent {
  victimId: string;
  killerId: string;
  killerName: string;
  victimName: string;
  victimPos: THREE.Vector3;
  killerPos: THREE.Vector3;
  impactPos: THREE.Vector3;
  impactVel: THREE.Vector3;
}

export interface RemotePlayerState {
  headPos: { x: number; y: number; z: number };
  headYaw: number;
  headPitch: number;
  leftHand: { x: number; y: number; z: number };
  rightHand: { x: number; y: number; z: number };
  leftQuat?: [number, number, number, number];
  rightQuat?: [number, number, number, number];
  leftContact: boolean;
  rightContact: boolean;
  leftFingers?: HandFingerPose;
  rightFingers?: HandFingerPose;
  speaking?: boolean;
  leftHandModel?: UploadedHandRef | null;
  rightHandModel?: UploadedHandRef | null;
}

interface RemoteAvatar {
  id: string;
  name: string;
  color: string;
  root: THREE.Group;
  primitiveGroup: THREE.Group;
  fullRig: GorillaPlayerRig | null;
  head: THREE.Group;
  torso: THREE.Mesh;
  nametagSprite: THREE.Sprite;
  leftHand: MonkeyHandRig;
  rightHand: MonkeyHandRig;
  targetHeadPos: THREE.Vector3;
  targetHeadYaw: number;
  targetHeadPitch: number;
  targetLeftHand: THREE.Vector3;
  targetRightHand: THREE.Vector3;
  targetLeftQuat: THREE.Quaternion;
  targetRightQuat: THREE.Quaternion;
  hasLeftQuat: boolean;
  hasRightQuat: boolean;
  leftContact: boolean;
  rightContact: boolean;
  leftFingers: HandFingerPose;
  rightFingers: HandFingerPose;
  speaking: boolean;
  leftModelKey: string;
  rightModelKey: string;
  knifeRig: KnifeVisualRig | null;
}

export interface MultiplayerStatus {
  connected: boolean;
  room: string;
  playerId: string | null;
  username: string;
  playerCount: number;
  seed: number | null;
}

const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _targetQuat = new THREE.Quaternion();
const _peerPosMap = new Map<string, THREE.Vector3>();

function drawNametagCanvas(canvas: HTMLCanvasElement, label: string, speaking: boolean): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = speaking ? 'rgba(2, 132, 199, 0.92)' : 'rgba(15, 23, 42, 0.8)';
  ctx.beginPath();
  ctx.roundRect(10, 12, 276, 40, 10);
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 21px "Plus Jakarta Sans", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const display = speaking ? `${label} (Mic)` : label;
  ctx.fillText(display.slice(0, 22), 148, 33);
}

function createNametagSprite(label: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 296;
  canvas.height = 64;
  drawNametagCanvas(canvas, label, false);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(0.95, 0.21, 1);
  sprite.position.set(0, 0.38, 0);
  return sprite;
}

function updateNametagSprite(sprite: THREE.Sprite, label: string, speaking: boolean): void {
  const mat = sprite.material as THREE.SpriteMaterial;
  const tex = mat.map as THREE.CanvasTexture | null;
  if (!tex || !(tex.image instanceof HTMLCanvasElement)) return;
  drawNametagCanvas(tex.image, label, speaking);
  tex.needsUpdate = true;
}

function createRemoteGorillaAvatar(id: string, name: string, color: string, state: RemotePlayerState): RemoteAvatar {
  const root = new THREE.Group();
  root.name = `RemoteGorilla_${id}`;

  const primitiveGroup = new THREE.Group();
  root.add(primitiveGroup);

  const furMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    roughness: 0.9,
    metalness: 0.0,
  });

  const faceMat = new THREE.MeshStandardMaterial({
    color: 0xd4a688,
    roughness: 0.84,
    metalness: 0.0,
  });

  const eyeMat = new THREE.MeshStandardMaterial({
    color: 0x0f172a,
    roughness: 0.3,
  });

  const head = new THREE.Group();
  head.position.set(state.headPos.x, state.headPos.y, state.headPos.z);

  const skullGeo = new THREE.SphereGeometry(0.18, 16, 14);
  skullGeo.scale(0.95, 1.0, 1.04);
  const skull = new THREE.Mesh(skullGeo, furMat);
  skull.castShadow = true;
  head.add(skull);

  const snoutGeo = new THREE.SphereGeometry(0.11, 12, 10);
  snoutGeo.scale(1.05, 0.78, 0.9);
  const snout = new THREE.Mesh(snoutGeo, faceMat);
  snout.position.set(0, -0.04, -0.14);
  head.add(snout);

  const eyeGeo = new THREE.SphereGeometry(0.025, 8, 8);
  const leftEye = new THREE.Mesh(eyeGeo, eyeMat);
  leftEye.position.set(-0.06, 0.03, -0.16);
  head.add(leftEye);

  const rightEye = new THREE.Mesh(eyeGeo, eyeMat);
  rightEye.position.set(0.06, 0.03, -0.16);
  head.add(rightEye);

  primitiveGroup.add(head);

  const nametagSprite = createNametagSprite(name);
  nametagSprite.position.set(state.headPos.x, state.headPos.y + 0.42, state.headPos.z);
  root.add(nametagSprite);

  const torsoGeo = new THREE.CapsuleGeometry(0.17, 0.24, 6, 12);
  const torso = new THREE.Mesh(torsoGeo, furMat);
  torso.position.set(state.headPos.x, state.headPos.y - 0.36, state.headPos.z);
  torso.castShadow = true;
  primitiveGroup.add(torso);

  const leftHand = createMonkeyHand('left', color);
  const rightHand = createMonkeyHand('right', color);
  leftHand.group.position.set(state.leftHand.x, state.leftHand.y, state.leftHand.z);
  rightHand.group.position.set(state.rightHand.x, state.rightHand.y, state.rightHand.z);
  primitiveGroup.add(leftHand.group);
  primitiveGroup.add(rightHand.group);

  return {
    id,
    name,
    color,
    root,
    primitiveGroup,
    fullRig: null,
    head,
    torso,
    nametagSprite,
    leftHand,
    rightHand,
    targetHeadPos: new THREE.Vector3(state.headPos.x, state.headPos.y, state.headPos.z),
    targetHeadYaw: state.headYaw,
    targetHeadPitch: state.headPitch,
    targetLeftHand: new THREE.Vector3(state.leftHand.x, state.leftHand.y, state.leftHand.z),
    targetRightHand: new THREE.Vector3(state.rightHand.x, state.rightHand.y, state.rightHand.z),
    targetLeftQuat: state.leftQuat
      ? new THREE.Quaternion(state.leftQuat[0], state.leftQuat[1], state.leftQuat[2], state.leftQuat[3])
      : new THREE.Quaternion(),
    targetRightQuat: state.rightQuat
      ? new THREE.Quaternion(state.rightQuat[0], state.rightQuat[1], state.rightQuat[2], state.rightQuat[3])
      : new THREE.Quaternion(),
    hasLeftQuat: Boolean(state.leftQuat),
    hasRightQuat: Boolean(state.rightQuat),
    leftContact: state.leftContact,
    rightContact: state.rightContact,
    leftFingers: state.leftFingers ? { ...state.leftFingers } : { grip: 0.14, trigger: 0.1, thumb: 0.08 },
    rightFingers: state.rightFingers ? { ...state.rightFingers } : { grip: 0.14, trigger: 0.1, thumb: 0.08 },
    speaking: Boolean(state.speaking),
    leftModelKey: '',
    rightModelKey: '',
    knifeRig: null,
  };
}

function modelRefKey(ref: UploadedHandRef | null | undefined): string {
  if (!ref) return '';
  const b = typeof ref.brightness === 'number' ? ref.brightness.toFixed(2) : '1.00';
  return `${ref.id}:${ref.scale.toFixed(2)}:${ref.rotX.toFixed(2)}:${ref.rotY.toFixed(2)}:${ref.rotZ.toFixed(2)}:${ref.textureId || ''}:${ref.tintColor || '#ffffff'}:${b}:${ref.flipTextureY ? 1 : 0}`;
}

export class MultiplayerClient {
  public readonly group = new THREE.Group();
  public readonly voice: VoiceChatManager;
  private readonly avatars = new Map<string, RemoteAvatar>();
  private ws: WebSocket | null = null;
  private reconnectTimer = 0;
  private sendAccum = 0;
  private disposed = false;

  public room: string;
  public username: string;
  public playerId: string | null = null;
  public connected = false;
  public localLeftHandModel: UploadedHandRef | null = null;
  public localRightHandModel: UploadedHandRef | null = null;

  private onStatusChange: (status: MultiplayerStatus) => void;
  private onRoomSeed: (seed: number) => void;
  private onGameState?: (game: RoomGameState) => void;
  private onKnifeThrown?: (ev: KnifeThrownEvent) => void;
  private onPlayerKilled?: (ev: PlayerKilledEvent) => void;
  private onGameNotice?: (message: string) => void;
  private onSuperJumped?: (playerId: string) => void;
  private gorillaTemplate: THREE.Group | null = null;
  public currentGame: RoomGameState = {
    phase: 'lobby',
    murdererId: null,
    innocentIds: [],
    aliveInnocentIds: [],
    phaseEndsAt: 0,
    serverTime: 0,
    winner: null,
    endReason: '',
    isPractice: false,
    roundId: 0,
  };

  constructor(
    room: string,
    username: string,
    onStatusChange: (status: MultiplayerStatus) => void,
    onVoiceStatusChange: (voice: VoiceStatus) => void,
    onRoomSeed: (seed: number) => void,
    gameCallbacks?: {
      onGameState?: (game: RoomGameState) => void;
      onKnifeThrown?: (ev: KnifeThrownEvent) => void;
      onPlayerKilled?: (ev: PlayerKilledEvent) => void;
      onGameNotice?: (message: string) => void;
      onSuperJumped?: (playerId: string) => void;
    }
  ) {
    this.room = room.toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 16) || 'SANDBOX';
    this.username = username;
    this.onStatusChange = onStatusChange;
    this.onRoomSeed = onRoomSeed;
    this.onGameState = gameCallbacks?.onGameState;
    this.onKnifeThrown = gameCallbacks?.onKnifeThrown;
    this.onPlayerKilled = gameCallbacks?.onPlayerKilled;
    this.onGameNotice = gameCallbacks?.onGameNotice;
    this.onSuperJumped = gameCallbacks?.onSuperJumped;
    this.group.name = 'MultiplayerAvatars';

    void preloadGorillaPlayerTemplate()
      .then((template) => {
        if (this.disposed) return;
        this.gorillaTemplate = template;
        for (const avatar of this.avatars.values()) {
          if (!avatar.fullRig) {
            this.attachFullRig(avatar, template);
          }
        }
      })
      .catch(() => {
        // Keep primitive avatar fallback
      });

    this.voice = new VoiceChatManager(
      (signal) => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify(signal));
        }
      },
      onVoiceStatusChange
    );

    if (this.username.trim().length >= 2) {
      this.connect();
    }
  }

  private attachFullRig(avatar: RemoteAvatar, template: THREE.Group): void {
    const rig = new GorillaPlayerRig(template, {
      isLocalFirstPerson: false,
      furColorHex: avatar.color,
    });
    avatar.fullRig = rig;
    avatar.root.add(rig.group);
    avatar.primitiveGroup.visible = false;
  }

  public joinWithUsername(username: string): void {
    const clean = username.trim().slice(0, 18);
    if (clean.length < 2) return;
    this.username = clean;

    if (!this.ws || this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING) {
      this.connect();
    } else if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'set_name', name: this.username }));
    }
    this.emitStatus();
  }

  public switchRoom(newRoom: string): string {
    const clean = newRoom.toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 16);
    if (!clean) return this.room;
    if (clean === this.room && this.ws && this.ws.readyState === WebSocket.OPEN) {
      return this.room;
    }

    this.room = clean;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = 0;
    }

    if (this.ws) {
      const prev = this.ws;
      this.ws = null;
      prev.onopen = null;
      prev.onmessage = null;
      prev.onclose = null;
      prev.onerror = null;
      prev.close();
    }

    this.connected = false;
    this.playerId = null;
    this.clearAllAvatars();
    this.voice.setLocalSession('', []);
    this.emitStatus();

    if (this.username.trim().length >= 2) {
      this.connect();
    }
    return this.room;
  }

  public startGame(practice = false): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'game:start', practice }));
    }
  }

  public stopGame(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'game:stop' }));
    }
  }

  public sendKnifeThrow(origin: THREE.Vector3, vel: THREE.Vector3): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: 'game:throw_knife',
          origin: {
            x: Number(origin.x.toFixed(3)),
            y: Number(origin.y.toFixed(3)),
            z: Number(origin.z.toFixed(3)),
          },
          vel: {
            x: Number(vel.x.toFixed(3)),
            y: Number(vel.y.toFixed(3)),
            z: Number(vel.z.toFixed(3)),
          },
        })
      );
    }
  }

  public sendSuperJump(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'game:super_jump' }));
    }
  }

  public sendKnifeHit(targetId: string, impactPos?: THREE.Vector3, impactVel?: THREE.Vector3): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: 'game:knife_hit',
          targetId,
          impactPos: impactPos
            ? {
                x: Number(impactPos.x.toFixed(3)),
                y: Number(impactPos.y.toFixed(3)),
                z: Number(impactPos.z.toFixed(3)),
              }
            : undefined,
          impactVel: impactVel
            ? {
                x: Number(impactVel.x.toFixed(3)),
                y: Number(impactVel.y.toFixed(3)),
                z: Number(impactVel.z.toFixed(3)),
              }
            : undefined,
        })
      );
    }
  }

  public getPlayerPositionById(id: string | null): THREE.Vector3 | null {
    if (!id) return null;
    const avatar = this.avatars.get(id);
    return avatar ? avatar.head.position.clone() : null;
  }

  public getPlayerPoseById(
    id: string | null
  ): { headPos: THREE.Vector3; yaw: number; rightHandPos: THREE.Vector3 } | null {
    if (!id) return null;
    const avatar = this.avatars.get(id);
    if (!avatar) return null;
    return {
      headPos: avatar.head.position.clone(),
      yaw: avatar.targetHeadYaw,
      rightHandPos: avatar.rightHand.group.position.clone(),
    };
  }

  public getRemoteTargetPositions(ids: string[]): Array<{ id: string; headPos: THREE.Vector3 }> {
    const out: Array<{ id: string; headPos: THREE.Vector3 }> = [];
    for (const id of ids) {
      const av = this.avatars.get(id);
      if (av) {
        out.push({ id, headPos: av.head.position });
      }
    }
    return out;
  }

  private emitStatus(seed: number | null = null): void {
    this.onStatusChange({
      connected: this.connected,
      room: this.room,
      playerId: this.playerId,
      username: this.username,
      playerCount: this.avatars.size + (this.connected ? 1 : 0),
      seed,
    });
  }

  private connect(): void {
    if (this.disposed) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = 0;
    }
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${window.location.host}/ws?room=${encodeURIComponent(this.room)}&name=${encodeURIComponent(this.username)}`;

    try {
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.onopen = () => {
        if (this.ws !== ws) return;
        this.connected = true;
        this.sendAccum = 1; // Send pose immediately on welcome
        this.emitStatus();
      };

      ws.onmessage = (ev) => {
        if (this.ws !== ws) return;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
        } catch {
          return;
        }

        if (msg.type === 'welcome') {
          this.playerId = String(msg.id);
          if (typeof msg.name === 'string') {
            this.username = msg.name;
          }
          if (typeof msg.room === 'string' && msg.room.length > 0) {
            this.room = msg.room;
          }
          if (typeof msg.seed === 'number') {
            this.onRoomSeed(msg.seed);
          }
          this.clearAllAvatars();
          const list = Array.isArray(msg.players) ? msg.players : [];
          const peerIds: string[] = [];
          for (const p of list) {
            if (p && typeof p === 'object') {
              const playerObj = p as { id: string; name: string; color: string; state: RemotePlayerState };
              this.upsertPlayer(playerObj.id, playerObj.name, playerObj.color, playerObj.state);
              peerIds.push(playerObj.id);
            }
          }
          this.sendAccum = 1;
          this.voice.setLocalSession(this.playerId, peerIds);
          if (msg.game && typeof msg.game === 'object') {
            this.currentGame = msg.game as RoomGameState;
            this.onGameState?.(this.currentGame);
          }
          this.emitStatus(typeof msg.seed === 'number' ? msg.seed : null);
        } else if (msg.type === 'game:state' && msg.game && typeof msg.game === 'object') {
          this.currentGame = msg.game as RoomGameState;
          this.onGameState?.(this.currentGame);
        } else if (msg.type === 'game:knife_thrown' && msg.origin && msg.vel) {
          const o = msg.origin as { x: number; y: number; z: number };
          const v = msg.vel as { x: number; y: number; z: number };
          this.onKnifeThrown?.({
            knifeId: String(msg.knifeId || ''),
            throwerId: String(msg.throwerId || ''),
            origin: new THREE.Vector3(o.x, o.y, o.z),
            vel: new THREE.Vector3(v.x, v.y, v.z),
          });
        } else if (msg.type === 'game:player_killed') {
          const vp = (msg.victimPos as { x: number; y: number; z: number } | undefined) || { x: 0, y: 1.4, z: 0 };
          const kp = (msg.killerPos as { x: number; y: number; z: number } | undefined) || { x: 0, y: 1.4, z: 0 };
          const ip = (msg.impactPos as { x: number; y: number; z: number } | undefined) || vp;
          const iv = (msg.impactVel as { x: number; y: number; z: number } | undefined) || { x: 0, y: 0, z: -1 };
          this.onPlayerKilled?.({
            victimId: String(msg.victimId || ''),
            killerId: String(msg.killerId || ''),
            killerName: String(msg.killerName || 'Murderer'),
            victimName: String(msg.victimName || 'Innocent'),
            victimPos: new THREE.Vector3(vp.x, vp.y, vp.z),
            killerPos: new THREE.Vector3(kp.x, kp.y, kp.z),
            impactPos: new THREE.Vector3(ip.x, ip.y, ip.z),
            impactVel: new THREE.Vector3(iv.x, iv.y, iv.z),
          });
        } else if (msg.type === 'game:super_jumped') {
          this.onSuperJumped?.(String(msg.id || ''));
        } else if (msg.type === 'game:notice' && typeof msg.message === 'string') {
          this.onGameNotice?.(msg.message);
        } else if (msg.type === 'player:joined') {
          const id = String(msg.id);
          if (id !== this.playerId && msg.state) {
            this.upsertPlayer(
              id,
              String(msg.name || 'Gorilla'),
              String(msg.color || '#3b82f6'),
              msg.state as RemotePlayerState
            );
            this.sendAccum = 1;
            this.voice.onPeerJoined(id);
            this.emitStatus();
          }
        } else if (msg.type === 'player:renamed') {
          const id = String(msg.id);
          const avatar = this.avatars.get(id);
          if (avatar && typeof msg.name === 'string') {
            avatar.name = msg.name;
            updateNametagSprite(avatar.nametagSprite, avatar.name, avatar.speaking);
          }
        } else if (msg.type === 'player:state') {
          const id = String(msg.id);
          const avatar = this.avatars.get(id);
          if (avatar && msg.state) {
            const s = msg.state as RemotePlayerState;
            avatar.targetHeadPos.set(s.headPos.x, s.headPos.y, s.headPos.z);
            avatar.targetHeadYaw = s.headYaw;
            avatar.targetHeadPitch = s.headPitch;
            avatar.targetLeftHand.set(s.leftHand.x, s.leftHand.y, s.leftHand.z);
            avatar.targetRightHand.set(s.rightHand.x, s.rightHand.y, s.rightHand.z);
            if (Array.isArray(s.leftQuat) && s.leftQuat.length === 4) {
              avatar.targetLeftQuat.set(s.leftQuat[0], s.leftQuat[1], s.leftQuat[2], s.leftQuat[3]);
              avatar.hasLeftQuat = true;
            }
            if (Array.isArray(s.rightQuat) && s.rightQuat.length === 4) {
              avatar.targetRightQuat.set(s.rightQuat[0], s.rightQuat[1], s.rightQuat[2], s.rightQuat[3]);
              avatar.hasRightQuat = true;
            }
            avatar.leftContact = Boolean(s.leftContact);
            avatar.rightContact = Boolean(s.rightContact);
            if (s.leftFingers) {
              avatar.leftFingers = s.leftFingers;
            }
            if (s.rightFingers) {
              avatar.rightFingers = s.rightFingers;
            }

            const nextSpeaking = Boolean(s.speaking);
            if (nextSpeaking !== avatar.speaking) {
              avatar.speaking = nextSpeaking;
              updateNametagSprite(avatar.nametagSprite, avatar.name, avatar.speaking);
            }

            this.syncRemoteHandModel(avatar, 'left', s.leftHandModel || null);
            this.syncRemoteHandModel(avatar, 'right', s.rightHandModel || null);
          }
        } else if (msg.type === 'player:left') {
          const id = String(msg.id);
          this.removePlayer(id);
          this.voice.onPeerLeft(id);
          this.emitStatus();
        } else if (
          (msg.type === 'rtc:offer' || msg.type === 'rtc:answer' || msg.type === 'rtc:ice') &&
          typeof msg.from === 'string'
        ) {
          void this.voice.handleSignal(
            msg.from,
            msg.type,
            msg.sdp as RTCSessionDescriptionInit | undefined,
            msg.candidate as RTCIceCandidateInit | undefined
          );
        }
      };

      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.connected = false;
        this.emitStatus();
        if (!this.disposed && this.username.trim().length >= 2) {
          this.reconnectTimer = window.setTimeout(() => this.connect(), 1800);
        }
      };

      ws.onerror = () => {
        if (this.ws !== ws) return;
        ws.close();
      };
    } catch {
      if (!this.disposed && this.username.trim().length >= 2) {
        this.reconnectTimer = window.setTimeout(() => this.connect(), 2200);
      }
    }
  }

  private syncRemoteHandModel(
    avatar: RemoteAvatar,
    side: 'left' | 'right',
    ref: UploadedHandRef | null
  ): void {
    const key = modelRefKey(ref);
    const prevKey = side === 'left' ? avatar.leftModelKey : avatar.rightModelKey;
    if (key === prevKey) return;

    const prevParts = prevKey.split(':');
    const prevId = prevParts[0];
    const prevAppearance = prevParts.slice(5).join(':');

    if (side === 'left') avatar.leftModelKey = key;
    else avatar.rightModelKey = key;

    const handRig = side === 'left' ? avatar.leftHand : avatar.rightHand;
    if (!ref) {
      handRig.setCustomModel(null);
      return;
    }

    const nextAppearance = `${ref.textureId || ''}:${ref.tintColor || '#ffffff'}:${typeof ref.brightness === 'number' ? ref.brightness.toFixed(2) : '1.00'}:${ref.flipTextureY ? 1 : 0}`;

    // If only transform changed on same model ID & appearance, update transform directly
    if (prevId === ref.id && prevAppearance === nextAppearance && handRig.hasCustomModel()) {
      handRig.updateCustomTransform({
        scale: ref.scale,
        rotX: ref.rotX,
        rotY: ref.rotY,
        rotZ: ref.rotZ,
        mirrorX: side === 'left',
      });
      return;
    }

    void loadRemoteHandModel(ref, side === 'left').then((loaded) => {
      if (this.disposed) return;
      const latestKey = side === 'left' ? avatar.leftModelKey : avatar.rightModelKey;
      if (latestKey === key && loaded) {
        handRig.setCustomModel(loaded);
      }
    });
  }

  private upsertPlayer(id: string, name: string, color: string, state: RemotePlayerState): void {
    if (this.avatars.has(id)) return;
    const avatar = createRemoteGorillaAvatar(id, name, color, state);
    if (this.gorillaTemplate) {
      this.attachFullRig(avatar, this.gorillaTemplate);
    }
    this.avatars.set(id, avatar);
    this.group.add(avatar.root);
    this.syncRemoteHandModel(avatar, 'left', state.leftHandModel || null);
    this.syncRemoteHandModel(avatar, 'right', state.rightHandModel || null);
  }

  private removePlayer(id: string): void {
    const avatar = this.avatars.get(id);
    if (!avatar) return;
    avatar.fullRig?.dispose();
    avatar.knifeRig?.dispose();
    avatar.leftHand.setCustomModel(null);
    avatar.rightHand.setCustomModel(null);
    this.group.remove(avatar.root);
    this.avatars.delete(id);
  }

  private clearAllAvatars(): void {
    for (const avatar of this.avatars.values()) {
      avatar.fullRig?.dispose();
      avatar.knifeRig?.dispose();
      avatar.leftHand.setCustomModel(null);
      avatar.rightHand.setCustomModel(null);
      this.group.remove(avatar.root);
    }
    this.avatars.clear();
  }

  public update(
    dt: number,
    localHeadWorld: THREE.Vector3,
    localHeadYaw: number,
    localHeadPitch: number,
    localLeftHandWorld: THREE.Vector3,
    localRightHandWorld: THREE.Vector3,
    leftContact: boolean,
    rightContact: boolean,
    leftFingers?: HandFingerPose,
    rightFingers?: HandFingerPose,
    localLeftQuat?: THREE.Quaternion,
    localRightQuat?: THREE.Quaternion
  ): void {
    const alpha = 1 - Math.exp(-18 * dt);
    _peerPosMap.clear();

    for (const avatar of this.avatars.values()) {
      avatar.head.position.lerp(avatar.targetHeadPos, alpha);
      _euler.set(avatar.targetHeadPitch, avatar.targetHeadYaw, 0, 'YXZ');
      _targetQuat.setFromEuler(_euler);
      avatar.head.quaternion.slerp(_targetQuat, alpha);

      avatar.nametagSprite.position.set(
        avatar.head.position.x,
        avatar.head.position.y + 0.42,
        avatar.head.position.z
      );

      avatar.torso.position.set(
        avatar.head.position.x,
        avatar.head.position.y - 0.36,
        avatar.head.position.z
      );
      avatar.torso.rotation.y = avatar.targetHeadYaw;

      avatar.leftHand.group.position.lerp(avatar.targetLeftHand, alpha);
      avatar.rightHand.group.position.lerp(avatar.targetRightHand, alpha);
      if (avatar.hasLeftQuat) {
        avatar.leftHand.group.quaternion.slerp(avatar.targetLeftQuat, alpha);
      } else {
        avatar.leftHand.group.rotation.y = avatar.targetHeadYaw;
      }
      if (avatar.hasRightQuat) {
        avatar.rightHand.group.quaternion.slerp(avatar.targetRightQuat, alpha);
      } else {
        avatar.rightHand.group.rotation.y = avatar.targetHeadYaw;
      }
      avatar.leftHand.setContactState(avatar.leftContact);
      avatar.rightHand.setContactState(avatar.rightContact);

      if (avatar.fullRig) {
        avatar.fullRig.updatePose({
          dt,
          headWorldPos: avatar.head.position,
          headYaw: avatar.targetHeadYaw,
          headPitch: avatar.targetHeadPitch,
          leftHandWorldPos: avatar.leftHand.group.position,
          rightHandWorldPos: avatar.rightHand.group.position,
          leftHandWorldQuat: avatar.hasLeftQuat ? avatar.leftHand.group.quaternion : undefined,
          rightHandWorldQuat: avatar.hasRightQuat ? avatar.rightHand.group.quaternion : undefined,
          leftContact: avatar.leftContact,
          rightContact: avatar.rightContact,
          leftFingers: avatar.leftFingers,
          rightFingers: avatar.rightFingers,
        });
      }

      // Attach/show Knife in Murderer's right hand during Hunt phase
      const isRemoteMurderer =
        (this.currentGame.phase === 'hunt' || this.currentGame.phase === 'hiding') &&
        this.currentGame.murdererId === avatar.id;
      if (isRemoteMurderer) {
        if (!avatar.knifeRig) {
          avatar.knifeRig = createKnifeModel(1.1);
          avatar.root.add(avatar.knifeRig.group);
        }
        avatar.knifeRig.group.visible = this.currentGame.phase === 'hunt';
        avatar.knifeRig.group.position.copy(avatar.rightHand.group.position);
        avatar.knifeRig.group.quaternion.copy(avatar.rightHand.group.quaternion);
      } else if (avatar.knifeRig) {
        avatar.knifeRig.group.visible = false;
      }

      _peerPosMap.set(avatar.id, avatar.head.position);
    }

    // Update spatial proximity voice chat volumes
    this.voice.updateProximity(localHeadWorld, _peerPosMap);
    const localSpeaking = this.voice.getIsSpeaking();

    // Throttled broadcast (~25Hz)
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.sendAccum += dt;
    if (this.sendAccum < 0.04) return;
    this.sendAccum = 0;

    this.ws.send(
      JSON.stringify({
        type: 'state',
        headPos: {
          x: Number(localHeadWorld.x.toFixed(3)),
          y: Number(localHeadWorld.y.toFixed(3)),
          z: Number(localHeadWorld.z.toFixed(3)),
        },
        headYaw: Number(localHeadYaw.toFixed(3)),
        headPitch: Number(localHeadPitch.toFixed(3)),
        leftHand: {
          x: Number(localLeftHandWorld.x.toFixed(3)),
          y: Number(localLeftHandWorld.y.toFixed(3)),
          z: Number(localLeftHandWorld.z.toFixed(3)),
        },
        rightHand: {
          x: Number(localRightHandWorld.x.toFixed(3)),
          y: Number(localRightHandWorld.y.toFixed(3)),
          z: Number(localRightHandWorld.z.toFixed(3)),
        },
        leftQuat: localLeftQuat
          ? [
              Number(localLeftQuat.x.toFixed(3)),
              Number(localLeftQuat.y.toFixed(3)),
              Number(localLeftQuat.z.toFixed(3)),
              Number(localLeftQuat.w.toFixed(3)),
            ]
          : undefined,
        rightQuat: localRightQuat
          ? [
              Number(localRightQuat.x.toFixed(3)),
              Number(localRightQuat.y.toFixed(3)),
              Number(localRightQuat.z.toFixed(3)),
              Number(localRightQuat.w.toFixed(3)),
            ]
          : undefined,
        leftContact,
        rightContact,
        leftFingers: leftFingers
          ? {
              grip: Number(leftFingers.grip.toFixed(2)),
              trigger: Number(leftFingers.trigger.toFixed(2)),
              thumb: Number(leftFingers.thumb.toFixed(2)),
            }
          : undefined,
        rightFingers: rightFingers
          ? {
              grip: Number(rightFingers.grip.toFixed(2)),
              trigger: Number(rightFingers.trigger.toFixed(2)),
              thumb: Number(rightFingers.thumb.toFixed(2)),
            }
          : undefined,
        speaking: localSpeaking,
        leftHandModel: this.localLeftHandModel,
        rightHandModel: this.localRightHandModel,
      })
    );
  }

  public dispose(): void {
    this.disposed = true;
    this.voice.dispose();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.clearAllAvatars();
  }
}
