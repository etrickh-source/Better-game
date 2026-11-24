import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

export interface CustomHandTransform {
  scale: number;
  rotX: number;
  rotY: number;
  rotZ: number;
  mirrorX?: boolean;
}

export interface UploadedHandRef {
  id: string;
  ext: string;
  scale: number;
  rotX: number;
  rotY: number;
  rotZ: number;
  textureId: string | null;
  tintColor: string;
  brightness?: number;
  flipTextureY: boolean;
}

export interface FinalizedHandPayload {
  target: 'both' | 'left' | 'right';
  ext: string;
  modelBuffer: ArrayBuffer;
  textureDataUrl: string | null;
  tintColor: string;
  brightness: number;
  flipTextureY: boolean;
  scale: number;
  rotX: number;
  rotY: number;
  rotZ: number;
  locked?: boolean;
}

export const SUPPORTED_HAND_EXTENSIONS = ['glb', 'gltf', 'obj', 'fbx', 'stl'] as const;

const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');

const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(dracoLoader);

const objLoader = new OBJLoader();
const fbxLoader = new FBXLoader();
const stlLoader = new STLLoader();
const textureLoader = new THREE.TextureLoader();

const _box = new THREE.Box3();
const _center = new THREE.Vector3();
const _size = new THREE.Vector3();

function ensureBoxUVs(geometry: THREE.BufferGeometry): void {
  if (geometry.attributes.uv) return;
  const pos = geometry.attributes.position;
  if (!pos) return;
  if (!geometry.attributes.normal) {
    geometry.computeVertexNormals();
  }
  const norm = geometry.attributes.normal;
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox || new THREE.Box3();
  const size = new THREE.Vector3();
  bbox.getSize(size);
  const sx = Math.max(size.x, 1e-4);
  const sy = Math.max(size.y, 1e-4);
  const sz = Math.max(size.z, 1e-4);

  const uvs = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = (pos.getX(i) - bbox.min.x) / sx;
    const y = (pos.getY(i) - bbox.min.y) / sy;
    const z = (pos.getZ(i) - bbox.min.z) / sz;

    const nx = norm ? Math.abs(norm.getX(i)) : 0;
    const ny = norm ? Math.abs(norm.getY(i)) : 1;
    const nz = norm ? Math.abs(norm.getZ(i)) : 0;

    if (ny >= nx && ny >= nz) {
      uvs[i * 2] = x;
      uvs[i * 2 + 1] = z;
    } else if (nx >= ny && nx >= nz) {
      uvs[i * 2] = z;
      uvs[i * 2 + 1] = y;
    } else {
      uvs[i * 2] = x;
      uvs[i * 2 + 1] = y;
    }
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
}

export function disposeObject3D(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry?.dispose();
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      for (const mat of mats) {
        if (!mat) continue;
        for (const val of Object.values(mat)) {
          if (val && typeof val === 'object' && 'isTexture' in val) {
            (val as THREE.Texture).dispose();
          }
        }
        mat.dispose();
      }
    }
  });
}

function sanitizeMaterialsAndMeshes(root: THREE.Object3D): number {
  let meshCount = 0;

  root.traverse((child) => {
    child.visible = true;

    if (child instanceof THREE.SkinnedMesh) {
      child.skeleton?.update();
      child.computeBoundingBox();
      child.computeBoundingSphere();
    }

    if (child instanceof THREE.Mesh) {
      meshCount++;
      child.castShadow = true;
      child.receiveShadow = true;
      child.frustumCulled = false;

      if (child.geometry) {
        if (!child.geometry.attributes.normal) {
          child.geometry.computeVertexNormals();
        }
        ensureBoxUVs(child.geometry);
        child.geometry.computeBoundingBox();
        child.geometry.computeBoundingSphere();
      }

      if (!child.material) {
        child.material = new THREE.MeshStandardMaterial({
          color: 0xffffff,
          roughness: 0.62,
          metalness: 0.08,
          side: THREE.DoubleSide,
        });
      } else {
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        const clonedMats = mats.map((mat) => {
          if (!mat) return mat;
          const cloned = mat.clone();
          cloned.side = THREE.DoubleSide;
          if (cloned.transparent && cloned.opacity <= 0.01) {
            cloned.opacity = 1;
            cloned.transparent = false;
          }
          // Preserve baseline original map/color/emissive for future tint & brightness resets
          cloned.userData.originalMap = (cloned as THREE.MeshStandardMaterial).map || null;
          cloned.userData.originalColor =
            'color' in cloned && cloned.color instanceof THREE.Color
              ? cloned.color.clone()
              : new THREE.Color(0xffffff);
          cloned.userData.originalEmissive =
            'emissive' in cloned && cloned.emissive instanceof THREE.Color
              ? cloned.emissive.clone()
              : new THREE.Color(0x000000);
          cloned.needsUpdate = true;
          return cloned;
        });
        child.material = Array.isArray(child.material) ? clonedMats : clonedMats[0];
      }
    }
  });

  return meshCount;
}

function normalizeLoadedObject(rawModel: THREE.Object3D, transform: CustomHandTransform): THREE.Group {
  const meshCount = sanitizeMaterialsAndMeshes(rawModel);
  if (meshCount === 0) {
    throw new Error('The uploaded 3D file contains no visible mesh geometry.');
  }

  const wrapper = new THREE.Group();
  wrapper.name = 'CustomHandModelWrapper';

  const pivot = new THREE.Group();
  pivot.name = 'CustomHandPivot';

  const scaler = new THREE.Group();
  scaler.name = 'CustomHandScaler';

  const centerer = new THREE.Group();
  centerer.name = 'CustomHandCenterer';

  centerer.add(rawModel);
  scaler.add(centerer);
  pivot.add(scaler);
  wrapper.add(pivot);

  wrapper.updateMatrixWorld(true);
  _box.setFromObject(rawModel);

  if (!_box.isEmpty()) {
    _box.getCenter(_center);
    _box.getSize(_size);
    centerer.position.copy(_center).negate();
    const maxDim = Math.max(_size.x, _size.y, _size.z, 1e-4);
    const baseScale = 0.28 / maxDim;
    scaler.scale.setScalar(baseScale);
    wrapper.userData.rawDimensions = { x: _size.x, y: _size.y, z: _size.z };
  } else {
    wrapper.userData.rawDimensions = { x: 1, y: 1, z: 1 };
  }

  applyCustomHandTransform(wrapper, transform);
  return wrapper;
}

export function applyCustomHandTransform(group: THREE.Object3D, transform: CustomHandTransform): void {
  const pivot = group.getObjectByName('CustomHandPivot') || group;
  const s = Math.max(0.25, Math.min(3.0, transform.scale || 1));
  pivot.scale.set(transform.mirrorX ? -s : s, s, s);
  pivot.rotation.set(transform.rotX || 0, transform.rotY || 0, transform.rotZ || 0);
}

export async function applyHandTextureAndTint(
  group: THREE.Object3D,
  textureDataUrl: string | null,
  tintColor: string,
  flipY: boolean,
  brightness = 1.0
): Promise<void> {
  let loadedTex: THREE.Texture | null = null;
  if (textureDataUrl) {
    loadedTex = await new Promise<THREE.Texture>((resolve, reject) => {
      textureLoader.load(
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

  const b = Math.max(0.1, Math.min(1.5, Number.isFinite(brightness) ? brightness : 1.0));
  const parsedTint = new THREE.Color(tintColor || '#ffffff');

  group.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    for (const mat of mats) {
      if (!mat) continue;
      const stdMat = mat as THREE.MeshStandardMaterial;

      if (loadedTex) {
        if (stdMat.map && stdMat.map !== stdMat.userData.originalMap) {
          stdMat.map.dispose();
        }
        stdMat.map = loadedTex.clone();
        stdMat.map.needsUpdate = true;
      } else {
        if (stdMat.map && stdMat.map !== stdMat.userData.originalMap) {
          stdMat.map.dispose();
        }
        stdMat.map = (stdMat.userData.originalMap as THREE.Texture | null) || null;
      }

      if ('color' in stdMat && stdMat.color instanceof THREE.Color) {
        const base =
          tintColor.toLowerCase() === '#ffffff' && !loadedTex && stdMat.userData.originalColor instanceof THREE.Color
            ? (stdMat.userData.originalColor as THREE.Color)
            : parsedTint;
        stdMat.color.setRGB(base.r * b, base.g * b, base.b * b);

        if ('emissive' in stdMat && stdMat.emissive instanceof THREE.Color) {
          if (b > 1.0) {
            const boost = (b - 1.0) * 0.25;
            stdMat.emissive.setRGB(base.r * boost, base.g * boost, base.b * boost);
            stdMat.emissiveIntensity = 1.0;
          } else if (stdMat.userData.originalEmissive instanceof THREE.Color) {
            stdMat.emissive.copy(stdMat.userData.originalEmissive);
            stdMat.emissiveIntensity = 1.0;
          }
        }
      }
      stdMat.needsUpdate = true;
    }
  });

  if (loadedTex) {
    loadedTex.dispose();
  }
}

export async function renderHandPreviewSheet(
  buffer: ArrayBuffer,
  ext: string
): Promise<{ dataUrl: string; dimensions: { x: number; y: number; z: number } }> {
  // Parse an unrotated, unscaled neutral copy for consistent AI orientation analysis
  const neutralGroup = await parseHandModelFromArrayBuffer(buffer, ext, {
    scale: 1.0,
    rotX: 0,
    rotY: 0,
    rotZ: 0,
    mirrorX: false,
  });

  const dimensions = (neutralGroup.userData.rawDimensions as { x: number; y: number; z: number }) || {
    x: 1,
    y: 1,
    z: 1,
  };

  const panelW = 220;
  const panelH = 220;

  const offscreen = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
  offscreen.setSize(panelW, panelH);
  offscreen.outputColorSpace = THREE.SRGBColorSpace;
  offscreen.setClearColor(0xf1f5f9, 1);

  const previewScene = new THREE.Scene();
  previewScene.add(new THREE.HemisphereLight(0xffffff, 0x64748b, 1.3));
  const key = new THREE.DirectionalLight(0xffffff, 1.4);
  key.position.set(1.5, 2.5, 1.8);
  previewScene.add(key);
  const rim = new THREE.DirectionalLight(0xdbeafe, 0.8);
  rim.position.set(-1.5, -1.0, -1.8);
  previewScene.add(rim);

  const axes = new THREE.AxesHelper(0.22);
  previewScene.add(axes);
  previewScene.add(neutralGroup);

  const cam = new THREE.PerspectiveCamera(42, 1, 0.02, 10);

  const sheet = document.createElement('canvas');
  sheet.width = panelW * 3;
  sheet.height = panelH;
  const ctx = sheet.getContext('2d');

  const views = [
    {
      label: '1. Side (+X)',
      footerLeft: '← WRIST (+Z)',
      footerRight: 'FINGERS (-Z) →',
      pos: new THREE.Vector3(0.58, 0.04, 0),
      up: new THREE.Vector3(0, 1, 0),
    },
    {
      label: '2. Player View',
      footerLeft: 'Camera behind (+Z)',
      footerRight: 'Away (-Z)',
      pos: new THREE.Vector3(0.32, 0.28, 0.5),
      up: new THREE.Vector3(0, 1, 0),
    },
    {
      label: '3. Top (+Y)',
      footerLeft: 'TOP=Fingers(-Z)',
      footerRight: 'BOT=Wrist(+Z)',
      pos: new THREE.Vector3(0, 0.58, 0.01),
      up: new THREE.Vector3(0, 0, -1),
    },
  ];

  if (ctx) {
    views.forEach((v, idx) => {
      cam.up.copy(v.up);
      cam.position.copy(v.pos);
      cam.lookAt(0, 0, 0);
      offscreen.render(previewScene, cam);

      const x0 = idx * panelW;
      ctx.drawImage(offscreen.domElement, x0, 0);

      ctx.fillStyle = 'rgba(15, 23, 42, 0.82)';
      ctx.fillRect(x0 + 6, 6, 118, 20);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 11px sans-serif';
      ctx.fillText(v.label, x0 + 12, 20);

      ctx.fillStyle = 'rgba(15, 23, 42, 0.78)';
      ctx.fillRect(x0 + 4, panelH - 22, panelW - 8, 18);
      ctx.fillStyle = '#e2e8f0';
      ctx.font = 'bold 10px sans-serif';
      ctx.fillText(v.footerLeft, x0 + 8, panelH - 9);
      ctx.textAlign = 'right';
      ctx.fillText(v.footerRight, x0 + panelW - 8, panelH - 9);
      ctx.textAlign = 'left';
    });
  }

  disposeObject3D(neutralGroup);
  offscreen.dispose();

  return {
    dataUrl: sheet.toDataURL('image/png'),
    dimensions,
  };
}

export async function parseHandModelFromArrayBuffer(
  buffer: ArrayBuffer,
  extRaw: string,
  transform: CustomHandTransform
): Promise<THREE.Group> {
  const ext = extRaw.toLowerCase().replace(/^\./, '');

  if (ext === 'glb' || ext === 'gltf') {
    const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
      gltfLoader.parse(
        buffer,
        '',
        (res) => resolve(res),
        (err) => {
          const msg = err instanceof Error ? err.message : String(err || '');
          if (ext === 'gltf' && /bin|buffer|fetch|uri/i.test(msg)) {
            reject(
              new Error(
                'External .bin/.png files cannot be read from a standalone .gltf file. Please export as a single .glb file.'
              )
            );
          } else {
            reject(new Error(msg || 'Failed to parse GLTF/GLB model.'));
          }
        }
      );
    });
    return normalizeLoadedObject(gltf.scene, transform);
  }

  if (ext === 'obj') {
    const text = new TextDecoder().decode(buffer);
    const obj = objLoader.parse(text);
    obj.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.material = new THREE.MeshStandardMaterial({
          color: 0xffffff,
          roughness: 0.62,
          metalness: 0.08,
          side: THREE.DoubleSide,
        });
      }
    });
    return normalizeLoadedObject(obj, transform);
  }

  if (ext === 'fbx') {
    const fbx = fbxLoader.parse(buffer, '');
    return normalizeLoadedObject(fbx, transform);
  }

  if (ext === 'stl') {
    const geometry = stlLoader.parse(buffer);
    geometry.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.62,
      metalness: 0.08,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, mat);
    return normalizeLoadedObject(mesh, transform);
  }

  throw new Error(`Unsupported file extension ".${ext}". Please upload .glb, .gltf, .obj, .fbx, or .stl.`);
}

export async function parseHandModelFromFile(
  file: File,
  transform: CustomHandTransform
): Promise<{ group: THREE.Group; buffer: ArrayBuffer; ext: string }> {
  const nameParts = file.name.split('.');
  const ext = (nameParts.length > 1 ? nameParts.pop() : '')?.toLowerCase() || '';
  if (!SUPPORTED_HAND_EXTENSIONS.includes(ext as (typeof SUPPORTED_HAND_EXTENSIONS)[number])) {
    throw new Error('Please choose a .glb, .gltf, .obj, .fbx, or .stl 3D model file.');
  }

  const buffer = await file.arrayBuffer();
  const group = await parseHandModelFromArrayBuffer(buffer, ext, transform);
  return { group, buffer, ext };
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes.buffer;
}

export async function uploadHandModelForMultiplayer(
  buffer: ArrayBuffer,
  ext: string
): Promise<{ id: string; ext: string } | null> {
  if (buffer.byteLength > 4 * 1024 * 1024) {
    return null;
  }

  try {
    const res = await fetch('/api/hand-models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ext,
        dataBase64: arrayBufferToBase64(buffer),
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { id?: string; ext?: string };
    if (typeof data.id === 'string' && typeof data.ext === 'string') {
      return { id: data.id, ext: data.ext };
    }
    return null;
  } catch {
    return null;
  }
}

export async function uploadHandTextureForMultiplayer(dataUrl: string): Promise<string | null> {
  try {
    const res = await fetch('/api/hand-textures', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataUrl }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { id?: string };
    return typeof data.id === 'string' ? data.id : null;
  } catch {
    return null;
  }
}

const remoteBufferCache = new Map<string, ArrayBuffer>();
const remoteTextureDataUrlCache = new Map<string, string>();

async function blobToDataUrl(blob: Blob): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Failed to read blob'));
    reader.readAsDataURL(blob);
  });
}

export async function loadRemoteHandModel(
  ref: UploadedHandRef,
  mirrorX: boolean
): Promise<THREE.Group | null> {
  try {
    let buffer = remoteBufferCache.get(ref.id);
    if (!buffer) {
      const res = await fetch(`/api/hand-models/${encodeURIComponent(ref.id)}`);
      if (!res.ok) return null;
      buffer = await res.arrayBuffer();
      if (remoteBufferCache.size > 20) {
        const firstKey = remoteBufferCache.keys().next().value;
        if (firstKey) remoteBufferCache.delete(firstKey);
      }
      remoteBufferCache.set(ref.id, buffer);
    }

    const group = await parseHandModelFromArrayBuffer(buffer, ref.ext, {
      scale: ref.scale,
      rotX: ref.rotX,
      rotY: ref.rotY,
      rotZ: ref.rotZ,
      mirrorX,
    });

    let texDataUrl: string | null = null;
    if (ref.textureId) {
      texDataUrl = remoteTextureDataUrlCache.get(ref.textureId) || null;
      if (!texDataUrl) {
        const texRes = await fetch(`/api/hand-textures/${encodeURIComponent(ref.textureId)}`);
        if (texRes.ok) {
          texDataUrl = await blobToDataUrl(await texRes.blob());
          remoteTextureDataUrlCache.set(ref.textureId, texDataUrl);
        }
      }
    }

    const brightness = typeof ref.brightness === 'number' ? ref.brightness : 1.0;
    if (texDataUrl || (ref.tintColor && ref.tintColor.toLowerCase() !== '#ffffff') || Math.abs(brightness - 1.0) > 0.001) {
      await applyHandTextureAndTint(group, texDataUrl, ref.tintColor || '#ffffff', Boolean(ref.flipTextureY), brightness);
    }

    return group;
  } catch {
    return null;
  }
}

// ---------- Persistent Finalized Hand Storage (IndexedDB + Server) ----------
const IDB_NAME = 'horizon-tag-hand-db';
const IDB_STORE = 'finalized';
const IDB_KEY = 'active-hand';

function openHandIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        req.result.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveToIndexedDB(payload: FinalizedHandPayload): Promise<void> {
  try {
    const db = await openHandIDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(payload, IDB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Ignore IDB unavailable
  }
}

async function loadFromIndexedDB(): Promise<FinalizedHandPayload | null> {
  try {
    const db = await openHandIDB();
    const res = await new Promise<FinalizedHandPayload | null>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
      req.onsuccess = () => resolve((req.result as FinalizedHandPayload) || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return res;
  } catch {
    return null;
  }
}

async function clearIndexedDB(): Promise<void> {
  try {
    const db = await openHandIDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(IDB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Ignore
  }
}

export async function finalizeHandConfiguration(
  payload: FinalizedHandPayload
): Promise<{ serverSaved: boolean; modelId: string | null; textureId: string | null }> {
  await saveToIndexedDB(payload);

  if (payload.modelBuffer.byteLength > 4 * 1024 * 1024) {
    return { serverSaved: false, modelId: null, textureId: null };
  }

  try {
    const res = await fetch('/api/hand-models/finalize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: payload.target,
        ext: payload.ext,
        modelBase64: arrayBufferToBase64(payload.modelBuffer),
        textureDataUrl: payload.textureDataUrl,
        tintColor: payload.tintColor,
        brightness: payload.brightness,
        flipTextureY: payload.flipTextureY,
        scale: payload.scale,
        rotX: payload.rotX,
        rotY: payload.rotY,
        rotZ: payload.rotZ,
        locked: Boolean(payload.locked),
      }),
    });
    if (!res.ok) return { serverSaved: false, modelId: null, textureId: null };
    const data = (await res.json()) as { modelId?: string; textureId?: string | null };
    return {
      serverSaved: true,
      modelId: data.modelId || null,
      textureId: data.textureId ?? null,
    };
  } catch {
    return { serverSaved: false, modelId: null, textureId: null };
  }
}

export async function updateSavedBrightnessLocally(brightness: number): Promise<void> {
  const existing = await loadFromIndexedDB();
  if (existing) {
    await saveToIndexedDB({ ...existing, brightness });
  }
  try {
    await fetch('/api/hand-models/finalized/brightness', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brightness }),
    });
  } catch {
    // Ignore offline error
  }
}

export async function loadSavedFinalizedHand(): Promise<{
  payload: FinalizedHandPayload;
  modelId: string | null;
  textureId: string | null;
} | null> {
  // 1. Check server finalized hand first (persists across updates and devices)
  try {
    const res = await fetch('/api/hand-models/finalized');
    if (res.ok) {
      const data = (await res.json()) as {
        finalized: {
          target: 'both' | 'left' | 'right';
          ext: string;
          modelId: string;
          textureId: string | null;
          textureDataUrl: string | null;
          tintColor: string;
          brightness?: number;
          flipTextureY: boolean;
          scale: number;
          rotX: number;
          rotY: number;
          rotZ: number;
          locked?: boolean;
        } | null;
      };
      if (data.finalized) {
        const f = data.finalized;
        const modelRes = await fetch(`/api/hand-models/${encodeURIComponent(f.modelId)}`);
        if (modelRes.ok) {
          const modelBuffer = await modelRes.arrayBuffer();
          return {
            payload: {
              target: f.target,
              ext: f.ext,
              modelBuffer,
              textureDataUrl: f.textureDataUrl,
              tintColor: f.tintColor,
              brightness: typeof f.brightness === 'number' ? f.brightness : 1.0,
              flipTextureY: f.flipTextureY,
              scale: f.scale,
              rotX: f.rotX,
              rotY: f.rotY,
              rotZ: f.rotZ,
              locked: Boolean(f.locked),
            },
            modelId: f.modelId,
            textureId: f.textureId,
          };
        }
      }
    }
  } catch {
    // Fall back to IndexedDB
  }

  // 2. Fallback to browser IndexedDB
  const localSaved = await loadFromIndexedDB();
  if (localSaved) {
    return {
      payload: {
        ...localSaved,
        brightness: typeof localSaved.brightness === 'number' ? localSaved.brightness : 1.0,
      },
      modelId: null,
      textureId: null,
    };
  }

  return null;
}

export async function loadRemoteAssetsByIds(
  modelId: string,
  ext: string,
  textureId: string | null
): Promise<{ modelBuffer: ArrayBuffer; textureDataUrl: string | null } | null> {
  try {
    const modelRes = await fetch(`/api/hand-models/${encodeURIComponent(modelId)}`);
    if (!modelRes.ok) return null;
    const modelBuffer = await modelRes.arrayBuffer();

    let textureDataUrl: string | null = null;
    if (textureId) {
      const texRes = await fetch(`/api/hand-textures/${encodeURIComponent(textureId)}`);
      if (texRes.ok) {
        textureDataUrl = await blobToDataUrl(await texRes.blob());
      }
    }
    if (!ext) return null;
    return { modelBuffer, textureDataUrl };
  } catch {
    return null;
  }
}

export async function clearSavedFinalizedHand(): Promise<void> {
  await clearIndexedDB();
  try {
    await fetch('/api/hand-models/finalized', { method: 'DELETE' });
  } catch {
    // Ignore
  }
}

export async function analyzeHandOrientationWithAI(
  buffer: ArrayBuffer,
  ext: string,
  fileName: string,
  target: 'both' | 'left' | 'right'
): Promise<{
  rotXDeg: number;
  rotYDeg: number;
  rotZDeg: number;
  recommendedScale: number;
  reasoning: string;
}> {
  const preview = await renderHandPreviewSheet(buffer, ext);
  const res = await fetch('/api/ai/orient-hand', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      previewDataUrl: preview.dataUrl,
      fileName,
      target,
      dimensions: preview.dimensions,
    }),
  });

  const data = (await res.json()) as {
    rotXDeg?: number;
    rotYDeg?: number;
    rotZDeg?: number;
    recommendedScale?: number;
    reasoning?: string;
    error?: string;
  };

  if (!res.ok) {
    throw new Error(data.error || 'AI orientation analysis failed.');
  }

  return {
    rotXDeg: Number(data.rotXDeg ?? 0),
    rotYDeg: Number(data.rotYDeg ?? 0),
    rotZDeg: Number(data.rotZDeg ?? 0),
    recommendedScale: Number(data.recommendedScale ?? 1),
    reasoning: data.reasoning || 'Oriented model for realistic first-person hand posture.',
  };
}
