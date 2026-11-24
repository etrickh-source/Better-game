import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  User,
} from 'firebase/auth';
import {
  doc,
  getDoc,
  getDocFromServer,
  getFirestore,
  onSnapshot,
  serverTimestamp,
  setDoc,
  Unsubscribe,
  updateDoc,
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

async function testConnection(): Promise<void> {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}

void testConnection();

export interface FirebaseHandConfig {
  ownerId: string;
  locked: boolean;
  target: 'both' | 'left' | 'right';
  ext: 'glb' | 'gltf' | 'obj' | 'fbx' | 'stl';
  modelId: string;
  textureId: string;
  hasTexture: boolean;
  baseTintColor: string;
  brightness: number;
  flipTextureY: boolean;
  scale: number;
  rotX: number;
  rotY: number;
  rotZ: number;
}

const ALLOWED_EXTS = new Set(['glb', 'gltf', 'obj', 'fbx', 'stl']);

function clampNum(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Number(n.toFixed(4))));
}

function sanitizeHexColor(hex: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex.toLowerCase() : '#ffffff';
}

function sanitizeUuid(id: string | null | undefined): string {
  if (!id) return '';
  return /^[a-f0-9-]{8,36}$/i.test(id) ? id : '';
}

export async function signInWithGoogleForFirebase(): Promise<User> {
  const cred = await signInWithPopup(auth, googleProvider);
  const user = cred.user;
  if (user && user.email) {
    const profilePath = `users/${user.uid}/private/profile`;
    const profileRef = doc(db, 'users', user.uid, 'private', 'profile');
    try {
      const existing = await getDoc(profileRef);
      if (!existing.exists()) {
        await setDoc(profileRef, {
          uid: user.uid,
          email: user.email.slice(0, 254),
          displayName: (user.displayName || '').slice(0, 100),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } else {
        await updateDoc(profileRef, {
          email: user.email.slice(0, 254),
          displayName: (user.displayName || '').slice(0, 100),
          updatedAt: serverTimestamp(),
        });
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, profilePath);
    }
  }
  return user;
}

export function subscribeFirebaseAuth(callback: (user: User | null) => void): Unsubscribe {
  return onAuthStateChanged(auth, callback);
}

export function subscribeHandConfig(
  uid: string,
  onConfig: (config: FirebaseHandConfig | null) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  const path = `handConfigs/${uid}`;
  const ref = doc(db, 'handConfigs', uid);
  return onSnapshot(
    ref,
    (snap) => {
      if (!snap.exists()) {
        onConfig(null);
        return;
      }
      onConfig(snap.data() as FirebaseHandConfig);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.GET, path);
      } catch (wrapped) {
        if (onError && wrapped instanceof Error) {
          onError(wrapped);
        }
      }
    }
  );
}

export async function saveAndLockHandConfigInFirebase(
  uid: string,
  input: {
    target: 'both' | 'left' | 'right';
    ext: string;
    modelId: string;
    textureId: string | null;
    hasTexture: boolean;
    baseTintColor: string;
    brightness: number;
    flipTextureY: boolean;
    scale: number;
    rotX: number;
    rotY: number;
    rotZ: number;
  }
): Promise<FirebaseHandConfig> {
  const extClean = input.ext.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!ALLOWED_EXTS.has(extClean)) {
    throw new Error('Unsupported 3D model format for Firebase persistence.');
  }

  const modelIdClean = sanitizeUuid(input.modelId);
  if (!modelIdClean) {
    throw new Error('Model upload ID missing. Please upload your 3D hand model first.');
  }

  const textureIdClean = sanitizeUuid(input.textureId);
  const path = `handConfigs/${uid}`;
  const ref = doc(db, 'handConfigs', uid);

  let existingLocked = false;
  let exists = false;
  try {
    const snap = await getDoc(ref);
    exists = snap.exists();
    existingLocked = exists && Boolean(snap.data()?.locked);
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }

  if (existingLocked) {
    throw new Error('Your hand configuration is permanently locked in Firebase. Only brightness can be changed.');
  }

  const payload: Omit<FirebaseHandConfig, 'createdAt' | 'updatedAt'> = {
    ownerId: uid,
    locked: true,
    target: input.target === 'left' || input.target === 'right' ? input.target : 'both',
    ext: extClean as FirebaseHandConfig['ext'],
    modelId: modelIdClean,
    textureId: textureIdClean,
    hasTexture: Boolean(input.hasTexture && textureIdClean),
    baseTintColor: sanitizeHexColor(input.baseTintColor),
    brightness: clampNum(input.brightness, 0.1, 1.5, 1.0),
    flipTextureY: Boolean(input.flipTextureY),
    scale: clampNum(input.scale, 0.25, 3.0, 1.0),
    rotX: clampNum(input.rotX, -Math.PI * 2, Math.PI * 2, 0),
    rotY: clampNum(input.rotY, -Math.PI * 2, Math.PI * 2, 0),
    rotZ: clampNum(input.rotZ, -Math.PI * 2, Math.PI * 2, 0),
  };

  try {
    if (!exists) {
      await setDoc(ref, {
        ...payload,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(ref, {
        ...payload,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }

  return payload;
}

export async function updateBrightnessInFirebase(uid: string, brightness: number): Promise<void> {
  const path = `handConfigs/${uid}`;
  const ref = doc(db, 'handConfigs', uid);
  const clamped = clampNum(brightness, 0.1, 1.5, 1.0);
  try {
    await updateDoc(ref, {
      brightness: clamped,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}
