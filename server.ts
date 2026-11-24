import express from 'express';
import { createServer } from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { GoogleGenAI, Type } from '@google/genai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

const SAVED_HANDS_DIR = path.resolve(__dirname, 'saved-hands');
const FINALIZED_MANIFEST_PATH = path.resolve(SAVED_HANDS_DIR, 'finalized-hand.json');

const ai = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    })
  : null;

const GORILLA_COLORS = [
  '#3b82f6', // Sky Blue
  '#10b981', // Emerald
  '#f59e0b', // Amber
  '#ef4444', // Coral Red
  '#8b5cf6', // Violet
  '#ec4899', // Magenta
  '#14b8a6', // Teal
  '#f97316', // Orange
];

const ALLOWED_MODEL_EXTS = new Set(['glb', 'gltf', 'obj', 'fbx', 'stl']);
const ALLOWED_TEX_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_MODEL_BYTES = 4 * 1024 * 1024; // 4 MB cap for shared assets
const MAX_TEX_BYTES = 2 * 1024 * 1024; // 2 MB cap for shared textures
const MAX_STORED_MODELS = 24;
const MAX_STORED_TEXTURES = 24;

interface StoredAsset {
  id: string;
  ext: string;
  mime?: string;
  buffer: Buffer;
  createdAt: number;
}

const handModelStore = new Map<string, StoredAsset>();
const handTextureStore = new Map<string, StoredAsset>();

interface Vec3Tuple {
  x: number;
  y: number;
  z: number;
}

export interface HandModelRef {
  id: string;
  ext: string;
  scale: number;
  rotX: number;
  rotY: number;
  rotZ: number;
  textureId: string | null;
  tintColor: string;
  brightness: number;
  flipTextureY: boolean;
}

interface FinalizedHandManifest {
  modelId: string;
  textureId: string | null;
  target: 'both' | 'left' | 'right';
  ext: string;
  modelFile: string;
  textureFile: string | null;
  textureMime: string | null;
  tintColor: string;
  brightness: number;
  flipTextureY: boolean;
  scale: number;
  rotX: number;
  rotY: number;
  rotZ: number;
  locked: boolean;
  updatedAt: number;
}

interface FingerPose {
  grip: number;
  trigger: number;
  thumb: number;
}

type QuatTuple = [number, number, number, number];

interface PlayerState {
  headPos: Vec3Tuple;
  headYaw: number;
  headPitch: number;
  leftHand: Vec3Tuple;
  rightHand: Vec3Tuple;
  leftQuat?: QuatTuple;
  rightQuat?: QuatTuple;
  leftContact: boolean;
  rightContact: boolean;
  leftFingers: FingerPose;
  rightFingers: FingerPose;
  speaking: boolean;
  leftHandModel: HandModelRef | null;
  rightHandModel: HandModelRef | null;
}

type GamePhase = 'lobby' | 'hiding' | 'hunt' | 'ended';

interface RoomGameState {
  phase: GamePhase;
  murdererId: string | null;
  innocentIds: string[];
  aliveInnocentIds: string[];
  phaseEndsAt: number;
  winner: 'murderer' | 'innocent' | null;
  endReason: string;
  isPractice: boolean;
  roundId: number;
}

interface RoomPlayer {
  id: string;
  name: string;
  color: string;
  ws: WebSocket;
  state: PlayerState;
  lastMsgTime: number;
  lastRtcTime: number;
  lastKnifeThrowAt: number;
  lastSuperJumpAt: number;
}

interface Room {
  id: string;
  seed: number;
  players: Map<string, RoomPlayer>;
  game: RoomGameState;
}

const rooms = new Map<string, Room>();
const HIDING_DURATION_MS = 15_000;
const HUNT_DURATION_MS = 180_000;
const ROUND_END_MS = 6_000;
const KILL_EDIT_ROUND_END_MS = 29_500;
const KNIFE_COOLDOWN_MS = 4_200;
const SUPER_JUMP_COOLDOWN_MS = 14_000;

function ensureSavedHandsDir(): void {
  if (!fs.existsSync(SAVED_HANDS_DIR)) {
    fs.mkdirSync(SAVED_HANDS_DIR, { recursive: true });
  }
}

function safeResolveSavedFile(filename: string): string | null {
  const safeName = path.basename(filename);
  const resolved = path.resolve(SAVED_HANDS_DIR, safeName);
  if (!resolved.startsWith(SAVED_HANDS_DIR + path.sep)) return null;
  return resolved;
}

function sanitizeRoomId(raw: string | null): string {
  if (!raw) return 'SANDBOX';
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 16);
  return cleaned.length > 0 ? cleaned : 'SANDBOX';
}

function sanitizeUsername(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f<>`"'&/\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 18);
  return cleaned.length >= 2 ? cleaned : fallback;
}

function sanitizeHexColor(raw: unknown): string {
  if (typeof raw !== 'string') return '#ffffff';
  return /^#[0-9a-fA-F]{6}$/.test(raw) ? raw.toLowerCase() : '#ffffff';
}

function clampFinite(val: unknown, min: number, max: number, fallback = 0): number {
  if (typeof val !== 'number' || !Number.isFinite(val)) return fallback;
  return Math.max(min, Math.min(max, val));
}

function parseVec3(raw: unknown, fallback: Vec3Tuple): Vec3Tuple {
  if (!raw || typeof raw !== 'object') return fallback;
  const obj = raw as Record<string, unknown>;
  return {
    x: clampFinite(obj.x, -10000, 10000, fallback.x),
    y: clampFinite(obj.y, -100, 500, fallback.y),
    z: clampFinite(obj.z, -10000, 10000, fallback.z),
  };
}

function parseQuat(raw: unknown): QuatTuple | undefined {
  if (!Array.isArray(raw) || raw.length !== 4) return undefined;
  const x = clampFinite(raw[0], -1.01, 1.01, 0);
  const y = clampFinite(raw[1], -1.01, 1.01, 0);
  const z = clampFinite(raw[2], -1.01, 1.01, 0);
  const w = clampFinite(raw[3], -1.01, 1.01, 1);
  return [x, y, z, w];
}

function parseFingerPose(raw: unknown, fallback: FingerPose): FingerPose {
  if (!raw || typeof raw !== 'object') return fallback;
  const obj = raw as Record<string, unknown>;
  return {
    grip: clampFinite(obj.grip, 0, 1, fallback.grip),
    trigger: clampFinite(obj.trigger, 0, 1, fallback.trigger),
    thumb: clampFinite(obj.thumb, 0, 1, fallback.thumb),
  };
}

function parseHandModelRef(raw: unknown): HandModelRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== 'string' || !/^[a-f0-9-]{8,36}$/i.test(obj.id)) return null;
  const stored = handModelStore.get(obj.id);
  if (!stored) return null;

  let textureId: string | null = null;
  if (typeof obj.textureId === 'string' && /^[a-f0-9-]{8,36}$/i.test(obj.textureId)) {
    if (handTextureStore.has(obj.textureId)) {
      textureId = obj.textureId;
    }
  }

  return {
    id: stored.id,
    ext: stored.ext,
    scale: clampFinite(obj.scale, 0.25, 3.0, 1.0),
    rotX: clampFinite(obj.rotX, -Math.PI * 2, Math.PI * 2, 0),
    rotY: clampFinite(obj.rotY, -Math.PI * 2, Math.PI * 2, 0),
    rotZ: clampFinite(obj.rotZ, -Math.PI * 2, Math.PI * 2, 0),
    textureId,
    tintColor: sanitizeHexColor(obj.tintColor),
    brightness: clampFinite(obj.brightness, 0.1, 1.5, 1.0),
    flipTextureY: Boolean(obj.flipTextureY),
  };
}

function validateModelBuffer(ext: string, buf: Buffer): boolean {
  if (buf.length === 0 || buf.length > MAX_MODEL_BYTES) return false;
  if (ext === 'glb') {
    return buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'glTF';
  }
  if (ext === 'gltf') {
    try {
      const parsed = JSON.parse(buf.toString('utf8'));
      return Boolean(parsed && typeof parsed === 'object');
    } catch {
      return false;
    }
  }
  if (ext === 'obj') {
    const sample = buf.subarray(0, 512).toString('utf8');
    return !sample.includes('\u0000');
  }
  return true;
}

function parseImageDataUrl(dataUrl: string): { mime: string; ext: string; buffer: Buffer } | null {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) return null;
  const mime = match[1];
  if (!ALLOWED_TEX_MIMES.has(mime)) return null;
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length === 0 || buffer.length > MAX_TEX_BYTES) return null;
  const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
  return { mime, ext, buffer };
}

function registerModelInStore(ext: string, buffer: Buffer, preferredId?: string, persistToDisk = false): StoredAsset {
  while (handModelStore.size >= MAX_STORED_MODELS) {
    const oldestKey = handModelStore.keys().next().value;
    if (!oldestKey) break;
    handModelStore.delete(oldestKey);
  }
  const id = preferredId && /^[a-f0-9-]{8,36}$/i.test(preferredId) ? preferredId : crypto.randomUUID();
  const entry: StoredAsset = { id, ext, buffer, createdAt: Date.now() };
  handModelStore.set(id, entry);
  if (persistToDisk) {
    try {
      ensureSavedHandsDir();
      const diskPath = safeResolveSavedFile(`model-${id}.${ext}`);
      if (diskPath) fs.writeFileSync(diskPath, buffer);
    } catch {
      // Ignore disk write failure
    }
  }
  return entry;
}

function registerTextureInStore(mime: string, ext: string, buffer: Buffer, preferredId?: string, persistToDisk = false): StoredAsset {
  while (handTextureStore.size >= MAX_STORED_TEXTURES) {
    const oldestKey = handTextureStore.keys().next().value;
    if (!oldestKey) break;
    handTextureStore.delete(oldestKey);
  }
  const id = preferredId && /^[a-f0-9-]{8,36}$/i.test(preferredId) ? preferredId : crypto.randomUUID();
  const entry: StoredAsset = { id, ext, mime, buffer, createdAt: Date.now() };
  handTextureStore.set(id, entry);
  if (persistToDisk) {
    try {
      ensureSavedHandsDir();
      const diskPath = safeResolveSavedFile(`texture-${id}.${ext}`);
      if (diskPath) fs.writeFileSync(diskPath, buffer);
    } catch {
      // Ignore disk write failure
    }
  }
  return entry;
}

function findPersistedAssetOnDisk(kind: 'model' | 'texture', id: string): StoredAsset | null {
  try {
    if (!fs.existsSync(SAVED_HANDS_DIR)) return null;
    const prefix = `${kind}-${id}.`;
    const match = fs.readdirSync(SAVED_HANDS_DIR).find((f) => f.startsWith(prefix));
    if (!match) return null;
    const resolved = safeResolveSavedFile(match);
    if (!resolved || !fs.existsSync(resolved)) return null;
    const ext = match.slice(prefix.length).toLowerCase();
    const buffer = fs.readFileSync(resolved);
    if (kind === 'model') {
      if (!ALLOWED_MODEL_EXTS.has(ext) || !validateModelBuffer(ext, buffer)) return null;
      return registerModelInStore(ext, buffer, id, false);
    } else {
      const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'jpg' ? 'image/jpeg' : null;
      if (!mime) return null;
      return registerTextureInStore(mime, ext, buffer, id, false);
    }
  } catch {
    return null;
  }
}

// Rehydrate finalized hand assets into memory on server startup so persisted hands survive updates
function loadFinalizedManifest(): FinalizedHandManifest | null {
  try {
    if (!fs.existsSync(FINALIZED_MANIFEST_PATH)) return null;
    const raw = fs.readFileSync(FINALIZED_MANIFEST_PATH, 'utf8');
    const manifest = JSON.parse(raw) as FinalizedHandManifest;
    const modelPath = safeResolveSavedFile(manifest.modelFile);
    if (!modelPath || !fs.existsSync(modelPath)) return null;
    const modelBuf = fs.readFileSync(modelPath);
    if (!validateModelBuffer(manifest.ext, modelBuf)) return null;

    const modelId = manifest.modelId && /^[a-f0-9-]{8,36}$/i.test(manifest.modelId)
      ? manifest.modelId
      : crypto.randomUUID();
    manifest.modelId = modelId;
    registerModelInStore(manifest.ext, modelBuf, modelId);

    if (manifest.textureFile && manifest.textureMime) {
      const texPath = safeResolveSavedFile(manifest.textureFile);
      if (texPath && fs.existsSync(texPath)) {
        const texBuf = fs.readFileSync(texPath);
        const texExt = manifest.textureMime === 'image/png' ? 'png' : manifest.textureMime === 'image/webp' ? 'webp' : 'jpg';
        const textureId = manifest.textureId && /^[a-f0-9-]{8,36}$/i.test(manifest.textureId)
          ? manifest.textureId
          : crypto.randomUUID();
        manifest.textureId = textureId;
        registerTextureInStore(manifest.textureMime, texExt, texBuf, textureId);
      }
    }
    return manifest;
  } catch {
    return null;
  }
}

function createLobbyGameState(roundId = 0): RoomGameState {
  return {
    phase: 'lobby',
    murdererId: null,
    innocentIds: [],
    aliveInnocentIds: [],
    phaseEndsAt: 0,
    winner: null,
    endReason: '',
    isPractice: false,
    roundId,
  };
}

function serializeGameState(room: Room) {
  return {
    ...room.game,
    serverTime: Date.now(),
  };
}

function getOrCreateRoom(roomId: string): Room {
  let room = rooms.get(roomId);
  if (!room) {
    let hash = 2026;
    for (let i = 0; i < roomId.length; i++) {
      hash = ((hash << 5) - hash + roomId.charCodeAt(i)) | 0;
    }
    const seed = Math.abs(hash) % 90000 + 1000;
    room = {
      id: roomId,
      seed: roomId === 'SANDBOX' ? 2026 : seed,
      players: new Map(),
      game: createLobbyGameState(0),
    };
    rooms.set(roomId, room);
  }
  return room;
}

function safeSend(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcastRoom(room: Room, excludeId: string | null, payload: unknown): void {
  const serialized = JSON.stringify(payload);
  for (const [id, player] of room.players.entries()) {
    if (id !== excludeId && player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(serialized);
    }
  }
}

async function startServer() {
  ensureSavedHandsDir();
  loadFinalizedManifest();

  const app = express();
  app.use(express.json({ limit: '8mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, rooms: rooms.size });
  });

  // AI Hand Orientation & Scale Advisor (server-side Gemini Vision inspection)
  app.post('/api/ai/orient-hand', async (req, res) => {
    if (!ai) {
      res.status(503).json({
        error: 'Gemini API key is not configured on the server. Add GEMINI_API_KEY in Settings > Secrets.',
      });
      return;
    }

    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body.previewDataUrl !== 'string') {
      res.status(400).json({ error: 'Missing 3D preview snapshot.' });
      return;
    }

    const match = /^data:(image\/png|image\/jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(body.previewDataUrl);
    if (!match) {
      res.status(400).json({ error: 'Invalid preview image format.' });
      return;
    }

    const fileName = typeof body.fileName === 'string' ? body.fileName.slice(0, 80) : 'custom_hand';
    const target = body.target === 'left' || body.target === 'right' ? body.target : 'both';
    const dims = body.dimensions && typeof body.dimensions === 'object' ? (body.dimensions as Record<string, unknown>) : {};
    const dimX = clampFinite(dims.x, 0.001, 1000, 1);
    const dimY = clampFinite(dims.y, 0.001, 1000, 1);
    const dimZ = clampFinite(dims.z, 0.001, 1000, 1);

    const prompt = `You are a 3D VR character rigger analyzing a 3-panel multi-angle render of a custom uploaded 3D model ("${fileName}") that will replace a player's ${target === 'both' ? 'hands (right hand base, mirrored for left)' : target + ' hand'} in a first-person Gorilla Tag VR game.

The 3 panels show the model currently placed at the hand origin in its RAW export orientation:
- Panel 1 (Left, Side +X View): Looking from +X toward origin. RIGHT side of Panel 1 (-Z) is FORWARD (where FINGERS/TIPS must point, away from player). LEFT side of Panel 1 (+Z) is BACK (where WRIST/ARM must point, toward player). TOP (+Y) is knuckles/top, BOTTOM (-Y) is palm/floor side.
- Panel 2 (Middle, Player 3/4 View): Looking from behind (+Z) toward forward (-Z), matching the player's first-person camera view. If fingers point TOWARD the camera in Panel 2, the hand is backwards and needs 180 deg Y rotation.
- Panel 3 (Right, Top +Y View): Looking straight down from +Y. TOP edge of Panel 3 (-Z) is FORWARD (FINGERS), BOTTOM edge (+Z) is BACK (WRIST).

Raw normalized dimensions: width(X)=${dimX.toFixed(2)}, height(Y)=${dimY.toFixed(2)}, depth(Z)=${dimZ.toFixed(2)}.
Axis arrows shown in the scene: Red = +X, Green = +Y, Blue = +Z.

Determine the Euler rotation (in degrees: rotXDeg, rotYDeg, rotZDeg applied in Three.js XYZ order) and a realistic hand scale multiplier (0.6 to 1.8, where 1.0 = ~28cm) so that:
1. Fingers / front tips point FORWARD along -Z (RIGHT in Panel 1, AWAY from camera in Panel 2, UP toward TOP edge in Panel 3).
2. Wrist / forearm stump points BACK along +Z (LEFT in Panel 1, TOWARD camera in Panel 2, DOWN toward BOTTOM edge in Panel 3).
3. Palm faces downward (-Y) and knuckles/back of hand face upward (+Y).
Note: Many Blender/glTF models export facing +Z (backwards in Three.js), which requires rotYDeg = 180! Prefer clean 90-degree increments (0, 90, -90, 180) unless a slight tilt helps.`;

    try {
      let responseText = '{}';
      let lastErr: unknown = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await ai.models.generateContent({
            model: 'gemini-4-hydrogen',
            contents: {
              parts: [
                {
                  inlineData: {
                    mimeType: match[1],
                    data: match[2],
                  },
                },
                { text: prompt },
              ],
            },
            config: {
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  rotXDeg: {
                    type: Type.NUMBER,
                    description: 'X rotation in degrees between -180 and 180.',
                  },
                  rotYDeg: {
                    type: Type.NUMBER,
                    description: 'Y rotation in degrees between -180 and 180.',
                  },
                  rotZDeg: {
                    type: Type.NUMBER,
                    description: 'Z rotation in degrees between -180 and 180.',
                  },
                  recommendedScale: {
                    type: Type.NUMBER,
                    description: 'Scale multiplier between 0.6 and 1.8 (1.0 is ~28cm).',
                  },
                  reasoning: {
                    type: Type.STRING,
                    description: 'One concise sentence explaining what the 3D model is and how the rotation aligns it realistically.',
                  },
                },
                required: ['rotXDeg', 'rotYDeg', 'rotZDeg', 'recommendedScale', 'reasoning'],
              },
            },
          });
          responseText = (response.text || '{}').trim();
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          const msg = err instanceof Error ? err.message : String(err);
          const transient = /503|UNAVAILABLE|429|RESOURCE_EXHAUSTED|high demand/i.test(msg);
          if (!transient || attempt === 2) break;
          await new Promise((r) => setTimeout(r, 400 * Math.pow(2, attempt)));
        }
      }

      if (lastErr) throw lastErr;

      const parsed = JSON.parse(responseText) as Record<string, unknown>;
      res.json({
        rotXDeg: clampFinite(parsed.rotXDeg, -180, 180, 0),
        rotYDeg: clampFinite(parsed.rotYDeg, -180, 180, 0),
        rotZDeg: clampFinite(parsed.rotZDeg, -180, 180, 0),
        recommendedScale: clampFinite(parsed.recommendedScale, 0.5, 2.0, 1.0),
        reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning.slice(0, 220) : 'Aligned model forward for player view.',
      });
    } catch (err) {
      let msg = err instanceof Error ? err.message : 'AI orientation analysis failed.';
      try {
        const inner = JSON.parse(msg) as { error?: { message?: string } };
        if (inner?.error?.message) msg = inner.error.message;
      } catch {
        // Keep plain message
      }
      res.status(502).json({ error: msg });
    }
  });

  // Upload custom 3D hand model for multiplayer sharing
  app.post('/api/hand-models', (req, res) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body.ext !== 'string' || typeof body.dataBase64 !== 'string') {
      res.status(400).json({ error: 'Invalid upload payload.' });
      return;
    }

    const ext = body.ext.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!ALLOWED_MODEL_EXTS.has(ext)) {
      res.status(400).json({ error: 'Unsupported 3D model format. Use .glb, .gltf, .obj, .fbx, or .stl.' });
      return;
    }

    const buf = Buffer.from(body.dataBase64, 'base64');
    if (!validateModelBuffer(ext, buf)) {
      res.status(400).json({ error: 'Model file is invalid or exceeds 4 MB limit.' });
      return;
    }

    const entry = registerModelInStore(ext, buf, undefined, true);
    res.status(201).json({ id: entry.id, ext: entry.ext });
  });

  // Upload custom texture image for multiplayer sharing & Firebase persistence
  app.post('/api/hand-textures', (req, res) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body.dataUrl !== 'string') {
      res.status(400).json({ error: 'Invalid texture payload.' });
      return;
    }
    const parsed = parseImageDataUrl(body.dataUrl);
    if (!parsed) {
      res.status(400).json({ error: 'Texture must be a PNG, JPEG, or WebP image under 2 MB.' });
      return;
    }
    const entry = registerTextureInStore(parsed.mime, parsed.ext, parsed.buffer, undefined, true);
    res.status(201).json({ id: entry.id, ext: entry.ext });
  });

  app.get('/api/hand-textures/:id', (req, res) => {
    const id = String(req.params.id || '');
    if (!/^[a-f0-9-]{8,36}$/i.test(id)) {
      res.status(400).json({ error: 'Invalid texture ID.' });
      return;
    }
    const stored = handTextureStore.get(id) || findPersistedAssetOnDisk('texture', id);
    if (!stored) {
      res.status(404).json({ error: 'Texture not found.' });
      return;
    }
    res.setHeader('Content-Type', stored.mime || 'image/png');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(stored.buffer);
  });

  // Save finalized custom hand configuration persistently on the server
  app.post('/api/hand-models/finalize', (req, res) => {
    const existingManifest = loadFinalizedManifest();
    if (existingManifest?.locked) {
      res.status(403).json({
        error: 'Hand configuration is permanently locked. Only brightness can be adjusted.',
      });
      return;
    }

    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body.ext !== 'string' || typeof body.modelBase64 !== 'string') {
      res.status(400).json({ error: 'Missing model data to finalize.' });
      return;
    }

    const ext = body.ext.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!ALLOWED_MODEL_EXTS.has(ext)) {
      res.status(400).json({ error: 'Unsupported 3D model format.' });
      return;
    }

    const modelBuf = Buffer.from(body.modelBase64, 'base64');
    if (!validateModelBuffer(ext, modelBuf)) {
      res.status(400).json({ error: 'Model file is invalid or exceeds 4 MB server persistence cap.' });
      return;
    }

    ensureSavedHandsDir();
    const modelEntry = registerModelInStore(ext, modelBuf, undefined, true);
    const modelFilename = `finalized-model.${ext}`;
    const modelPath = safeResolveSavedFile(modelFilename);
    if (!modelPath) {
      res.status(400).json({ error: 'Invalid storage path.' });
      return;
    }
    fs.writeFileSync(modelPath, modelBuf);

    let textureFilename: string | null = null;
    let textureMime: string | null = null;
    let textureId: string | null = null;

    if (typeof body.textureDataUrl === 'string' && body.textureDataUrl.length > 0) {
      const parsedTex = parseImageDataUrl(body.textureDataUrl);
      if (!parsedTex) {
        res.status(400).json({ error: 'Texture image is invalid or exceeds 2 MB limit.' });
        return;
      }
      textureFilename = `finalized-texture.${parsedTex.ext}`;
      textureMime = parsedTex.mime;
      const texPath = safeResolveSavedFile(textureFilename);
      if (texPath) {
        fs.writeFileSync(texPath, parsedTex.buffer);
        const texEntry = registerTextureInStore(parsedTex.mime, parsedTex.ext, parsedTex.buffer, undefined, true);
        textureId = texEntry.id;
      }
    }

    const target = body.target === 'left' || body.target === 'right' ? body.target : 'both';
    const manifest: FinalizedHandManifest = {
      modelId: modelEntry.id,
      textureId,
      target,
      ext,
      modelFile: modelFilename,
      textureFile: textureFilename,
      textureMime,
      tintColor: sanitizeHexColor(body.tintColor),
      brightness: clampFinite(body.brightness, 0.1, 1.5, 1.0),
      flipTextureY: Boolean(body.flipTextureY),
      scale: clampFinite(body.scale, 0.25, 3.0, 1.0),
      rotX: clampFinite(body.rotX, -Math.PI * 2, Math.PI * 2, 0),
      rotY: clampFinite(body.rotY, -Math.PI * 2, Math.PI * 2, 0),
      rotZ: clampFinite(body.rotZ, -Math.PI * 2, Math.PI * 2, 0),
      locked: Boolean(body.locked),
      updatedAt: Date.now(),
    };

    fs.writeFileSync(FINALIZED_MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
    res.status(200).json({
      ok: true,
      modelId: modelEntry.id,
      textureId,
      manifest,
    });
  });

  app.patch('/api/hand-models/finalized/brightness', (req, res) => {
    const manifest = loadFinalizedManifest();
    if (!manifest) {
      res.status(404).json({ error: 'No finalized hand configuration found.' });
      return;
    }
    const body = req.body as Record<string, unknown> | undefined;
    const brightness = clampFinite(body?.brightness, 0.1, 1.5, manifest.brightness ?? 1.0);
    const updated: FinalizedHandManifest = {
      ...manifest,
      brightness,
      updatedAt: Date.now(),
    };
    fs.writeFileSync(FINALIZED_MANIFEST_PATH, JSON.stringify(updated, null, 2), 'utf8');
    res.json({ ok: true, brightness });
  });

  app.get('/api/hand-models/finalized', (_req, res) => {
    const manifest = loadFinalizedManifest();
    if (!manifest) {
      res.json({ finalized: null });
      return;
    }

    const modelPath = safeResolveSavedFile(manifest.modelFile);
    if (!modelPath || !fs.existsSync(modelPath)) {
      res.json({ finalized: null });
      return;
    }

    let textureDataUrl: string | null = null;
    if (manifest.textureFile && manifest.textureMime) {
      const texPath = safeResolveSavedFile(manifest.textureFile);
      if (texPath && fs.existsSync(texPath)) {
        const texBuf = fs.readFileSync(texPath);
        textureDataUrl = `data:${manifest.textureMime};base64,${texBuf.toString('base64')}`;
      }
    }

    res.json({
      finalized: {
        target: manifest.target,
        ext: manifest.ext,
        modelId: manifest.modelId,
        textureId: textureDataUrl ? manifest.textureId : null,
        textureDataUrl,
        tintColor: manifest.tintColor,
        brightness: typeof manifest.brightness === 'number' ? manifest.brightness : 1.0,
        flipTextureY: manifest.flipTextureY,
        scale: manifest.scale,
        rotX: manifest.rotX,
        rotY: manifest.rotY,
        rotZ: manifest.rotZ,
        locked: Boolean(manifest.locked),
        updatedAt: manifest.updatedAt,
      },
    });
  });

  app.delete('/api/hand-models/finalized', (_req, res) => {
    const prev = loadFinalizedManifest();
    if (prev?.locked) {
      res.status(403).json({
        error: 'Hand configuration is permanently locked and cannot be deleted or reset.',
      });
      return;
    }

    try {
      if (prev) {
        handModelStore.delete(prev.modelId);
        if (prev.textureId) handTextureStore.delete(prev.textureId);
      }
      if (fs.existsSync(SAVED_HANDS_DIR)) {
        for (const f of fs.readdirSync(SAVED_HANDS_DIR)) {
          const p = safeResolveSavedFile(f);
          if (p && fs.existsSync(p)) {
            fs.unlinkSync(p);
          }
        }
      }
    } catch {
      // Ignore cleanup errors
    }
    res.json({ ok: true });
  });

  app.get('/api/hand-models/:id', (req, res) => {
    const id = String(req.params.id || '');
    if (!/^[a-f0-9-]{8,36}$/i.test(id)) {
      res.status(400).json({ error: 'Invalid model ID.' });
      return;
    }
    const stored = handModelStore.get(id) || findPersistedAssetOnDisk('model', id);
    if (!stored) {
      res.status(404).json({ error: 'Model not found.' });
      return;
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `attachment; filename="hand.${stored.ext}"`);
    res.send(stored.buffer);
  });

  const httpServer = createServer(app);

  // Attach WebSocket multiplayer & WebRTC voice signaling server on /ws
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    maxPayload: 32768,
  });

  const aliveSockets = new WeakMap<WebSocket, boolean>();
  const heartbeatInterval = setInterval(() => {
    for (const client of wss.clients) {
      if (aliveSockets.get(client) === false) {
        client.terminate();
        continue;
      }
      aliveSockets.set(client, false);
      client.ping();
    }
  }, 15000);

  const gameTickInterval = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      const g = room.game;
      if (g.phase === 'hiding' && now >= g.phaseEndsAt) {
        g.phase = 'hunt';
        g.phaseEndsAt = now + HUNT_DURATION_MS;
        broadcastRoom(room, null, { type: 'game:state', game: serializeGameState(room) });
      } else if (g.phase === 'hunt' && now >= g.phaseEndsAt) {
        g.phase = 'ended';
        g.winner = 'innocent';
        g.endReason = g.isPractice
          ? 'Solo practice timer finished!'
          : 'Time expired! Innocent survived 3:00!';
        g.phaseEndsAt = now + ROUND_END_MS;
        broadcastRoom(room, null, { type: 'game:state', game: serializeGameState(room) });
      } else if (g.phase === 'ended' && now >= g.phaseEndsAt) {
        room.game = createLobbyGameState(g.roundId);
        broadcastRoom(room, null, { type: 'game:state', game: serializeGameState(room) });
      }
    }
  }, 250);

  wss.on('close', () => {
    clearInterval(heartbeatInterval);
    clearInterval(gameTickInterval);
  });

  wss.on('connection', (ws, req) => {
    aliveSockets.set(ws, true);
    ws.on('pong', () => {
      aliveSockets.set(ws, true);
    });

    const reqUrl = new URL(req.url || '/ws', `http://${req.headers.host || 'localhost'}`);
    const roomId = sanitizeRoomId(reqUrl.searchParams.get('room'));
    const room = getOrCreateRoom(roomId);

    if (room.players.size >= 24) {
      safeSend(ws, { type: 'error', message: 'Room is full (max 24 players).' });
      ws.close(1008, 'Room full');
      return;
    }

    const playerId = crypto.randomUUID().slice(0, 8);
    const color = GORILLA_COLORS[room.players.size % GORILLA_COLORS.length];
    const fallbackName = `Gorilla-${playerId.slice(0, 4).toUpperCase()}`;
    const name = sanitizeUsername(reqUrl.searchParams.get('name'), fallbackName);

    const initialState: PlayerState = {
      headPos: { x: 0, y: 8.2, z: 2 },
      headYaw: 0,
      headPitch: 0,
      leftHand: { x: -0.3, y: 7.5, z: 1.5 },
      rightHand: { x: 0.3, y: 7.5, z: 1.5 },
      leftContact: false,
      rightContact: false,
      leftFingers: { grip: 0.14, trigger: 0.1, thumb: 0.08 },
      rightFingers: { grip: 0.14, trigger: 0.1, thumb: 0.08 },
      speaking: false,
      leftHandModel: null,
      rightHandModel: null,
    };

    const player: RoomPlayer = {
      id: playerId,
      name,
      color,
      ws,
      state: initialState,
      lastMsgTime: 0,
      lastRtcTime: 0,
      lastKnifeThrowAt: 0,
      lastSuperJumpAt: 0,
    };

    room.players.set(playerId, player);

    const existingPlayers = Array.from(room.players.values())
      .filter((p) => p.id !== playerId)
      .map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        state: p.state,
      }));

    safeSend(ws, {
      type: 'welcome',
      id: playerId,
      name: player.name,
      color,
      room: room.id,
      seed: room.seed,
      players: existingPlayers,
      game: serializeGameState(room),
    });

    broadcastRoom(room, playerId, {
      type: 'player:joined',
      id: playerId,
      name: player.name,
      color,
      state: initialState,
    });

    ws.on('message', (raw) => {
      aliveSockets.set(ws, true);
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (!msg || typeof msg !== 'object') return;
      const data = msg as Record<string, unknown>;
      const now = Date.now();

      if (data.type === 'state') {
        if (now - player.lastMsgTime < 16) return;
        player.lastMsgTime = now;

        player.state = {
          headPos: parseVec3(data.headPos, player.state.headPos),
          headYaw: clampFinite(data.headYaw, -Math.PI * 4, Math.PI * 4, 0),
          headPitch: clampFinite(data.headPitch, -Math.PI, Math.PI, 0),
          leftHand: parseVec3(data.leftHand, player.state.leftHand),
          rightHand: parseVec3(data.rightHand, player.state.rightHand),
          leftQuat: parseQuat(data.leftQuat) ?? player.state.leftQuat,
          rightQuat: parseQuat(data.rightQuat) ?? player.state.rightQuat,
          leftContact: Boolean(data.leftContact),
          rightContact: Boolean(data.rightContact),
          leftFingers: parseFingerPose(data.leftFingers, player.state.leftFingers),
          rightFingers: parseFingerPose(data.rightFingers, player.state.rightFingers),
          speaking: Boolean(data.speaking),
          leftHandModel:
            data.leftHandModel === undefined ? player.state.leftHandModel : parseHandModelRef(data.leftHandModel),
          rightHandModel:
            data.rightHandModel === undefined ? player.state.rightHandModel : parseHandModelRef(data.rightHandModel),
        };

        broadcastRoom(room, playerId, {
          type: 'player:state',
          id: playerId,
          state: player.state,
        });
      } else if (data.type === 'set_name') {
        const nextName = sanitizeUsername(data.name, player.name);
        if (nextName !== player.name) {
          player.name = nextName;
          broadcastRoom(room, playerId, {
            type: 'player:renamed',
            id: playerId,
            name: player.name,
          });
        }
      } else if (data.type === 'rtc:offer' || data.type === 'rtc:answer' || data.type === 'rtc:ice') {
        if (now - player.lastRtcTime < 5) return;
        player.lastRtcTime = now;

        const targetId = typeof data.to === 'string' ? data.to : '';
        const target = room.players.get(targetId);
        if (!target || target.id === playerId) return;

        safeSend(target.ws, {
          type: data.type,
          from: playerId,
          sdp: data.sdp && typeof data.sdp === 'object' ? data.sdp : undefined,
          candidate: data.candidate && typeof data.candidate === 'object' ? data.candidate : undefined,
        });
      } else if (data.type === 'game:start') {
        if (room.game.phase !== 'lobby' && room.game.phase !== 'ended') return;
        const playersList = Array.from(room.players.values());
        if (playersList.length >= 2) {
          const murdererIndex = Math.floor(Math.random() * playersList.length);
          const murderer = playersList[murdererIndex];
          const innocents = playersList.filter((p) => p.id !== murderer.id).map((p) => p.id);
          for (const p of playersList) {
            p.lastKnifeThrowAt = 0;
            p.lastSuperJumpAt = 0;
          }
          room.game = {
            phase: 'hiding',
            murdererId: murderer.id,
            innocentIds: innocents,
            aliveInnocentIds: [...innocents],
            phaseEndsAt: now + HIDING_DURATION_MS,
            winner: null,
            endReason: '',
            isPractice: false,
            roundId: room.game.roundId + 1,
          };
          broadcastRoom(room, null, { type: 'game:state', game: serializeGameState(room) });
        } else if (data.practice === true) {
          player.lastKnifeThrowAt = 0;
          player.lastSuperJumpAt = 0;
          room.game = {
            phase: 'hunt',
            murdererId: playerId,
            innocentIds: [],
            aliveInnocentIds: [],
            phaseEndsAt: now + HUNT_DURATION_MS,
            winner: null,
            endReason: '',
            isPractice: true,
            roundId: room.game.roundId + 1,
          };
          broadcastRoom(room, null, { type: 'game:state', game: serializeGameState(room) });
        } else {
          safeSend(ws, {
            type: 'game:notice',
            message: 'Need 2+ players in this room to start Murder Mystery (or launch Solo Practice).',
          });
        }
      } else if (data.type === 'game:stop') {
        room.game = createLobbyGameState(room.game.roundId);
        broadcastRoom(room, null, { type: 'game:state', game: serializeGameState(room) });
      } else if (data.type === 'game:throw_knife') {
        const g = room.game;
        if (g.phase !== 'hunt' || g.murdererId !== playerId) return;
        if (now - player.lastKnifeThrowAt < KNIFE_COOLDOWN_MS) return;
        player.lastKnifeThrowAt = now;

        const origin = parseVec3(data.origin, { x: 0, y: 1.5, z: 0 });
        const rawVel = parseVec3(data.vel, { x: 0, y: 0, z: -20 });
        const speed = Math.hypot(rawVel.x, rawVel.y, rawVel.z);
        if (speed > 34) {
          const s = 34 / speed;
          rawVel.x *= s;
          rawVel.y *= s;
          rawVel.z *= s;
        }
        broadcastRoom(room, null, {
          type: 'game:knife_thrown',
          knifeId: crypto.randomUUID().slice(0, 8),
          throwerId: playerId,
          origin,
          vel: rawVel,
        });
      } else if (data.type === 'game:super_jump') {
        const g = room.game;
        if (g.phase !== 'hiding' && g.phase !== 'hunt') return;
        const canSuperJump = g.isPractice || g.aliveInnocentIds.includes(playerId);
        if (!canSuperJump) return;
        if (now - player.lastSuperJumpAt < SUPER_JUMP_COOLDOWN_MS) return;
        player.lastSuperJumpAt = now;
        broadcastRoom(room, null, { type: 'game:super_jumped', id: playerId });
      } else if (data.type === 'game:knife_hit') {
        const g = room.game;
        if (g.phase !== 'hunt' || g.murdererId !== playerId || g.isPractice) return;
        const targetId = typeof data.targetId === 'string' ? data.targetId : '';
        if (!g.aliveInnocentIds.includes(targetId)) return;

        const victimPlayer = room.players.get(targetId);
        const victimPos = victimPlayer ? victimPlayer.state.headPos : { x: 0, y: 1.4, z: 0 };
        const killerPos = player.state.headPos;
        const impactPos = parseVec3(data.impactPos, victimPos);
        const impactVel = parseVec3(data.impactVel, { x: 0, y: 0, z: -1 });

        g.aliveInnocentIds = g.aliveInnocentIds.filter((id) => id !== targetId);
        broadcastRoom(room, null, {
          type: 'game:player_killed',
          victimId: targetId,
          killerId: playerId,
          killerName: player.name,
          victimName: victimPlayer?.name || 'Innocent',
          victimPos,
          killerPos,
          impactPos,
          impactVel,
        });

        if (g.aliveInnocentIds.length === 0) {
          g.phase = 'ended';
          g.winner = 'murderer';
          g.endReason = 'Murderer eliminated the Innocent!';
          g.phaseEndsAt = now + KILL_EDIT_ROUND_END_MS;
        }
        broadcastRoom(room, null, { type: 'game:state', game: serializeGameState(room) });
      }
    });

    ws.on('close', () => {
      const now = Date.now();
      room.players.delete(playerId);
      broadcastRoom(room, null, {
        type: 'player:left',
        id: playerId,
      });

      const g = room.game;
      if (g.phase === 'hiding' || g.phase === 'hunt') {
        if (g.murdererId === playerId && !g.isPractice) {
          g.phase = 'ended';
          g.winner = 'innocent';
          g.endReason = 'Murderer disconnected from the hotel!';
          g.phaseEndsAt = now + ROUND_END_MS;
          broadcastRoom(room, null, { type: 'game:state', game: serializeGameState(room) });
        } else if (g.aliveInnocentIds.includes(playerId)) {
          g.aliveInnocentIds = g.aliveInnocentIds.filter((id) => id !== playerId);
          if (g.aliveInnocentIds.length === 0 && !g.isPractice) {
            g.phase = 'ended';
            g.winner = 'murderer';
            g.endReason = 'Innocent left the hotel!';
            g.phaseEndsAt = now + ROUND_END_MS;
          }
          broadcastRoom(room, null, { type: 'game:state', game: serializeGameState(room) });
        }
      }

      if (room.players.size === 0) {
        rooms.delete(room.id);
      }
    });
  });

  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
