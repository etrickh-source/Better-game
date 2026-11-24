import { ChangeEvent, DragEvent, FormEvent, useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  FastForward,
  Film,
  Hand,
  Image as ImageIcon,
  Lock,
  Mic,
  MicOff,
  Music,
  Play,
  RotateCcw,
  RotateCw,
  Shield,
  ShieldCheck,
  Skull,
  Sparkles,
  Square,
  Sun,
  Timer,
  Upload,
  Users,
  Volume2,
  VolumeX,
  X,
  Zap,
} from 'lucide-react';
import type { User } from 'firebase/auth';
import { SandboxEngine, SandboxTelemetry } from './engine/SandboxEngine';
import { CustomHandTransform } from './engine/customHandLoader';
import { ColorWheel } from './components/ColorWheel';
import {
  saveAndLockHandConfigInFirebase,
  signInWithGoogleForFirebase,
  subscribeFirebaseAuth,
  subscribeHandConfig,
  updateBrightnessInFirebase,
} from './firebase';

function generateRandomRoomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 5; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

function getRoomFromUrl(): string {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('room');
  if (!raw) return generateRandomRoomCode();
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 16);
  return cleaned || generateRandomRoomCode();
}

export default function App() {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const vrMountRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<SandboxEngine | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textureInputRef = useRef<HTMLInputElement | null>(null);
  const roomInputRef = useRef<HTMLInputElement | null>(null);
  const brightnessTimerRef = useRef<number | null>(null);
  const initialRoomRef = useRef<string>(getRoomFromUrl());

  const [roomId, setRoomId] = useState<string>(initialRoomRef.current);
  const [roomKeyboardOpen, setRoomKeyboardOpen] = useState<boolean>(false);
  const [roomDraftCode, setRoomDraftCode] = useState<string>('');
  const [joined, setJoined] = useState<boolean>(false);
  const [usernameInput, setUsernameInput] = useState<string>('');
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [enableVoiceOnJoin, setEnableVoiceOnJoin] = useState<boolean>(true);

  const [audioEnabled, setAudioEnabled] = useState<boolean>(true);
  const [dockOpen, setDockOpen] = useState<boolean>(true);
  const [copiedLink, setCopiedLink] = useState<boolean>(false);

  // Firebase Auth & Immutable Lock State
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [authBusy, setAuthBusy] = useState<boolean>(false);

  // Custom 3D Hand Model, Texture, Color Wheel, Brightness & AI Orientation State
  const [handModalOpen, setHandModalOpen] = useState<boolean>(false);
  const [handTarget, setHandTarget] = useState<'both' | 'left' | 'right'>('both');
  const [handTransform, setHandTransform] = useState<CustomHandTransform>({
    scale: 1.0,
    rotX: 0,
    rotY: 0,
    rotZ: 0,
  });
  const [textureDataUrl, setTextureDataUrl] = useState<string | null>(null);
  const [tintColor, setTintColor] = useState<string>('#ffffff');
  const [brightness, setBrightness] = useState<number>(1.0);
  const [flipTextureY, setFlipTextureY] = useState<boolean>(false);
  const [handUploadStatus, setHandUploadStatus] = useState<string | null>(null);
  const [handUploadError, setHandUploadError] = useState<string | null>(null);
  const [handUploading, setHandUploading] = useState<boolean>(false);
  const [aiOrienting, setAiOrienting] = useState<boolean>(false);
  const [finalizing, setFinalizing] = useState<boolean>(false);
  const [isHandLocked, setIsHandLocked] = useState<boolean>(false);
  const [isDraggingFile, setIsDraggingFile] = useState<boolean>(false);

  const [telemetry, setTelemetry] = useState<SandboxTelemetry>({
    altitude: 0,
    speed: 0,
    chunks: 0,
    isVR: false,
    isPointerLocked: false,
    leftContact: false,
    rightContact: false,
    contextLost: false,
    playersOnline: 1,
    mpConnected: false,
    room: roomId,
    username: '',
    micState: 'off',
    isSpeaking: false,
    voiceError: null,
    hasCustomLeftHand: false,
    hasCustomRightHand: false,
    isHandFinalized: false,
    isHandLocked: false,
    gamePhase: 'lobby',
    gameRole: 'none',
    gameTimeLeftSec: 0,
    gameWinner: null,
    gameEndReason: '',
    gameNotice: null,
    isPracticeMode: false,
    knifeCooldownSec: 0,
    superJumpCooldownSec: 0,
    killEditActive: false,
    killEditPhase: null,
    killEditCutIndex: 0,
    killEditTotalCuts: 12,
    killEditFlash: 0,
    killEditTimeLeftSec: 0,
    killEditKillerName: '',
    killEditVictimName: '',
    dummyKills: 0,
  });

  useEffect(() => {
    const container = viewportRef.current;
    const vrMount = vrMountRef.current;
    if (!container || !vrMount) return;

    const startRoom = initialRoomRef.current;
    const engine = new SandboxEngine(
      container,
      vrMount,
      startRoom,
      2026,
      (next) => {
        setTelemetry(next);
        if (next.room) {
          setRoomId((prev) => (prev !== next.room ? next.room : prev));
        }
        if (next.isHandLocked) {
          setIsHandLocked(true);
        }
      },
      (restored) => {
        setHandTarget(restored.target);
        setHandTransform(restored.transform);
        setTextureDataUrl(restored.textureDataUrl);
        setTintColor(restored.tintColor);
        setBrightness(restored.brightness);
        setFlipTextureY(restored.flipTextureY);
        setIsHandLocked(restored.locked);
        setHandUploadStatus(
          restored.locked
            ? 'Hand model & texture are permanently locked in Firebase. Only brightness can be changed.'
            : 'Loaded finalized custom hand model.'
        );
      },
      {
        onOpenWristKeyboard: () => {
          setRoomKeyboardOpen(true);
          setRoomDraftCode('');
          if (document.pointerLockElement) {
            document.exitPointerLock?.();
          }
          window.setTimeout(() => {
            roomInputRef.current?.focus();
          }, 15);
        },
        onCloseWristKeyboard: () => {
          setRoomKeyboardOpen(false);
          setRoomDraftCode('');
          roomInputRef.current?.blur();
        },
        onRoomDraftChange: (code) => {
          setRoomDraftCode(code);
        },
        onRoomSwitched: (nextCode) => {
          setRoomId(nextCode);
          setRoomKeyboardOpen(false);
          setRoomDraftCode('');
          const nextUrl = `${window.location.pathname}?room=${encodeURIComponent(nextCode)}`;
          window.history.replaceState(null, '', nextUrl);
        },
        onAutoJoined: () => {
          setJoined(true);
        },
      }
    );
    engineRef.current = engine;

    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code === 'KeyH' && !e.repeat) {
        setDockOpen((prev) => !prev);
      }
      if (e.code === 'KeyG' && !e.repeat) {
        if (document.pointerLockElement) {
          document.exitPointerLock?.();
        }
        engineRef.current?.openRoomKeyboard();
        setRoomKeyboardOpen(true);
        setRoomDraftCode('');
        window.setTimeout(() => roomInputRef.current?.focus(), 15);
      }
      if (e.code === 'Escape') {
        setHandModalOpen(false);
        setRoomKeyboardOpen(false);
        engineRef.current?.closeRoomKeyboard();
      }
    };
    window.addEventListener('keydown', onKey);

    return () => {
      window.removeEventListener('keydown', onKey);
      if (brightnessTimerRef.current) {
        window.clearTimeout(brightnessTimerRef.current);
      }
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    return subscribeFirebaseAuth((user) => {
      setFirebaseUser(user);
    });
  }, []);

  useEffect(() => {
    if (!firebaseUser) return;
    return subscribeHandConfig(
      firebaseUser.uid,
      (config) => {
        if (!config) return;
        setHandTarget(config.target);
        setHandTransform({
          scale: config.scale,
          rotX: config.rotX,
          rotY: config.rotY,
          rotZ: config.rotZ,
        });
        setTintColor(config.baseTintColor);
        setBrightness(config.brightness);
        setFlipTextureY(config.flipTextureY);
        setIsHandLocked(Boolean(config.locked));
        void engineRef.current?.applyFirebaseHandConfig(config);
      },
      (err) => {
        setHandUploadError(err.message);
      }
    );
  }, [firebaseUser]);

  const handleJoinSubmit = (e: FormEvent) => {
    e.preventDefault();
    const cleaned = usernameInput
      .replace(/[\u0000-\u001f\u007f<>`"'&/\\]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 18);

    if (cleaned.length < 2) {
      setUsernameError('Please enter a username with at least 2 characters.');
      return;
    }

    setUsernameError(null);
    setJoined(true);
    engineRef.current?.joinSession(cleaned, enableVoiceOnJoin);
  };

  const handleRespawn = () => {
    engineRef.current?.respawn();
  };

  const handleToggleAudio = () => {
    const next = !audioEnabled;
    setAudioEnabled(next);
    engineRef.current?.setAudioEnabled(next);
  };

  const handleToggleMic = () => {
    void engineRef.current?.toggleVoiceMic();
  };

  const handleCopyInvite = async () => {
    const activeRoom = telemetry.room || roomId;
    const inviteUrl = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(activeRoom)}`;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopiedLink(true);
      window.setTimeout(() => setCopiedLink(false), 2000);
    } catch {
      // Clipboard blocked in iframe fallback
    }
  };

  const handleOpenRoomCodeModal = () => {
    if (document.pointerLockElement) {
      document.exitPointerLock?.();
    }
    setRoomDraftCode('');
    setRoomKeyboardOpen(true);
    engineRef.current?.openRoomKeyboard();
    window.setTimeout(() => {
      roomInputRef.current?.focus();
    }, 15);
  };

  const handleRoomDraftInput = (raw: string) => {
    const cleaned = raw.toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 12);
    setRoomDraftCode(cleaned);
    engineRef.current?.setRoomKeyboardDraft(cleaned);
  };

  const handleSubmitJoinRoom = (e: FormEvent) => {
    e.preventDefault();
    const cleaned = roomDraftCode.trim();
    if (cleaned.length < 2) return;
    engineRef.current?.switchRoom(cleaned);
    engineRef.current?.closeRoomKeyboard();
    setRoomKeyboardOpen(false);
    setRoomDraftCode('');
  };

  const handleGoogleSignIn = async () => {
    setAuthBusy(true);
    setHandUploadError(null);
    try {
      const user = await signInWithGoogleForFirebase();
      setFirebaseUser(user);
    } catch (err) {
      setHandUploadError(err instanceof Error ? err.message : 'Google Sign-In failed.');
    } finally {
      setAuthBusy(false);
    }
  };

  const handleAiAutoOrient = async (targetOverride?: 'both' | 'left' | 'right') => {
    if (!engineRef.current || isHandLocked) return;
    setAiOrienting(true);
    setHandUploadError(null);
    try {
      const res = await engineRef.current.aiOrientCurrentHand(targetOverride || handTarget);
      setHandTransform(res.transform);
      setHandUploadStatus(`AI Auto-Orient: ${res.reasoning}`);
    } catch (err) {
      setHandUploadError(err instanceof Error ? err.message : 'AI Auto-Orient failed.');
    } finally {
      setAiOrienting(false);
    }
  };

  const handleProcessHandFile = async (file: File) => {
    if (!engineRef.current || isHandLocked) return;
    setHandUploading(true);
    setHandUploadError(null);
    setHandUploadStatus(null);
    try {
      const result = await engineRef.current.applyCustomHandFile(
        handTarget,
        file,
        handTransform,
        textureDataUrl,
        tintColor,
        brightness,
        flipTextureY
      );
      const nextFlip = result.ext === 'glb' || result.ext === 'gltf' ? false : flipTextureY;
      setFlipTextureY(nextFlip);
      setHandUploadStatus(`Loaded "${file.name}". Running AI orientation analysis...`);
      setHandUploading(false);
      await handleAiAutoOrient(handTarget);
    } catch (err) {
      setHandUploadError(err instanceof Error ? err.message : 'Failed to load 3D model file.');
      setHandUploading(false);
    }
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      void handleProcessHandFile(file);
    }
    e.target.value = '';
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDraggingFile(false);
    if (isHandLocked) return;
    const file = e.dataTransfer.files?.[0];
    if (file) {
      void handleProcessHandFile(file);
    }
  };

  const handleTextureUpload = (e: ChangeEvent<HTMLInputElement>) => {
    if (isHandLocked) return;
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setHandUploadError('Please choose a PNG, JPEG, or WebP texture image.');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      if (!dataUrl) return;
      setTextureDataUrl(dataUrl);
      setHandUploadError(null);
      void engineRef.current
        ?.applyTextureAndColorToHands(handTarget, dataUrl, tintColor, flipTextureY, brightness)
        .then(() => setHandUploadStatus(`Applied texture "${file.name}". Spin the color wheel to recolor.`))
        .catch((err) => setHandUploadError(err instanceof Error ? err.message : 'Texture failed.'));
    };
    reader.readAsDataURL(file);
  };

  const handleColorWheelChange = (nextHex: string) => {
    if (isHandLocked) return;
    setTintColor(nextHex);
    void engineRef.current?.applyTextureAndColorToHands(
      handTarget,
      textureDataUrl,
      nextHex,
      flipTextureY,
      brightness
    );
  };

  const handleBrightnessChange = (nextBrightness: number) => {
    const clamped = Math.max(0.1, Math.min(1.5, Number(nextBrightness.toFixed(2))));
    setBrightness(clamped);
    void engineRef.current?.setHandBrightness(clamped);

    if (isHandLocked && firebaseUser) {
      if (brightnessTimerRef.current) {
        window.clearTimeout(brightnessTimerRef.current);
      }
      brightnessTimerRef.current = window.setTimeout(() => {
        void updateBrightnessInFirebase(firebaseUser.uid, clamped).catch((err) => {
          setHandUploadError(err instanceof Error ? err.message : 'Failed to save brightness to Firebase.');
        });
      }, 220);
    }
  };

  const handleFlipTextureToggle = (nextFlip: boolean) => {
    if (isHandLocked) return;
    setFlipTextureY(nextFlip);
    void engineRef.current?.applyTextureAndColorToHands(
      handTarget,
      textureDataUrl,
      tintColor,
      nextFlip,
      brightness
    );
  };

  const handleRemoveTexture = () => {
    if (isHandLocked) return;
    setTextureDataUrl(null);
    void engineRef.current
      ?.applyTextureAndColorToHands(handTarget, null, tintColor, flipTextureY, brightness)
      .then(() => setHandUploadStatus('Removed custom texture image.'));
  };

  const handleTransformChange = (next: CustomHandTransform) => {
    if (isHandLocked) return;
    setHandTransform(next);
    engineRef.current?.updateCustomHandTransform(handTarget, next);
  };

  const handleRotateAxis = (axis: 'rotX' | 'rotY' | 'rotZ') => {
    if (isHandLocked) return;
    const next: CustomHandTransform = {
      ...handTransform,
      [axis]: (handTransform[axis] + Math.PI / 2) % (Math.PI * 2),
    };
    handleTransformChange(next);
  };

  const handleSaveAndLockPermanently = async () => {
    if (!engineRef.current || isHandLocked) return;
    setFinalizing(true);
    setHandUploadError(null);
    try {
      let user = firebaseUser;
      if (!user) {
        user = await signInWithGoogleForFirebase();
        setFirebaseUser(user);
      }

      const res = await engineRef.current.finalizeCurrentHand(
        handTarget,
        handTransform,
        textureDataUrl,
        tintColor,
        brightness,
        flipTextureY,
        true
      );

      if (!res.modelId) {
        throw new Error('Could not upload model asset to server storage (4 MB cap).');
      }

      await saveAndLockHandConfigInFirebase(user.uid, {
        target: handTarget,
        ext: res.ext,
        modelId: res.modelId,
        textureId: res.textureId,
        hasTexture: Boolean(textureDataUrl && res.textureId),
        baseTintColor: tintColor,
        brightness,
        flipTextureY,
        scale: handTransform.scale,
        rotX: handTransform.rotX,
        rotY: handTransform.rotY,
        rotZ: handTransform.rotZ,
      });

      setIsHandLocked(true);
      setHandUploadStatus(
        'Saved & permanently locked in Firebase. All edit settings removed — only brightness remains adjustable.'
      );
    } catch (err) {
      setHandUploadError(err instanceof Error ? err.message : 'Failed to lock hand configuration in Firebase.');
    } finally {
      setFinalizing(false);
    }
  };

  const handleResetHands = () => {
    if (isHandLocked) return;
    engineRef.current?.resetCustomHands(handTarget);
    setTextureDataUrl(null);
    setTintColor('#ffffff');
    setBrightness(1.0);
    setHandTransform({ scale: 1.0, rotX: 0, rotY: 0, rotZ: 0 });
    setHandUploadStatus('Restored default Gorilla hands.');
    setHandUploadError(null);
  };

  const micLabel = (() => {
    if (telemetry.micState === 'active') {
      return telemetry.isSpeaking ? 'Speaking' : 'Mic On';
    }
    if (telemetry.micState === 'muted') return 'Mic Muted';
    if (telemetry.micState === 'denied') return 'Mic Blocked';
    if (telemetry.micState === 'unsupported') return 'No Mic';
    return 'Voice Off';
  })();

  const hasAnyCustomHand = telemetry.hasCustomLeftHand || telemetry.hasCustomRightHand;
  const locked = isHandLocked || telemetry.isHandLocked;

  const formatMatchClock = (sec: number): string => {
    const s = Math.max(0, Math.ceil(sec));
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}:${rem.toString().padStart(2, '0')}`;
  };

  const isMatchActive = telemetry.gamePhase === 'hiding' || telemetry.gamePhase === 'hunt';

  return (
    <div className="relative w-full h-full overflow-hidden bg-[#0a0c12]">
      {/* Isolated WebGL Viewport Container */}
      <div
        ref={viewportRef}
        className="w-full h-full cursor-crosshair"
        aria-label="3D WebXR Haunted Hotel Viewport"
      />

      {/* WebGL Context Lost Fallback */}
      {telemetry.contextLost && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-slate-900/80 text-white">
          <div className="max-w-sm rounded-xl bg-slate-800 px-6 py-5 text-center shadow-xl border border-slate-700">
            <h2 className="text-base font-semibold">Graphics Context Paused</h2>
            <p className="mt-1.5 text-sm text-slate-300">
              WebGL rendering was suspended by the browser. Reload or restore the tab to resume.
            </p>
          </div>
        </div>
      )}

      {/* Required Username Entry Gate */}
      {!joined && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-slate-950/65 p-4">
          <form
            onSubmit={handleJoinSubmit}
            className="w-full max-w-md rounded-xl bg-white p-6 shadow-2xl border border-slate-200 text-slate-900"
          >
            <h1 className="text-xl font-bold tracking-tight text-slate-900">
              Enter Haunted Hotel
            </h1>
            <p className="mt-1.5 text-sm text-slate-600">
              Your starting room code is <span className="font-mono-tabular font-bold text-slate-900">{roomId}</span>. Check your left wrist in VR to join a friend or start Murder Mystery.
            </p>

            <div className="mt-5">
              <label htmlFor="username-input" className="block text-xs font-semibold text-slate-700">
                Username
              </label>
              <input
                id="username-input"
                type="text"
                autoFocus
                required
                minLength={2}
                maxLength={18}
                value={usernameInput}
                onChange={(e) => {
                  setUsernameInput(e.target.value);
                  if (usernameError) setUsernameError(null);
                }}
                placeholder="Enter your name..."
                className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-600/20"
              />
              {usernameError && (
                <p className="mt-1.5 text-xs font-medium text-red-600">{usernameError}</p>
              )}
            </div>

            <label className="mt-4 flex items-center gap-2.5 text-xs text-slate-700 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={enableVoiceOnJoin}
                onChange={(e) => setEnableVoiceOnJoin(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-600"
              />
              <span>Enable voice chat microphone on join (toggle anytime with M)</span>
            </label>

            <button
              type="submit"
              className="mt-5 w-full rounded-lg bg-red-700 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-red-800 transition-colors cursor-pointer"
            >
              Join Hotel
            </button>
          </form>
        </div>
      )}

      {/* Room Code Join Modal & Meta Quest Virtual Keyboard Input Target */}
      {joined && roomKeyboardOpen && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-slate-900/45 p-4">
          <form
            onSubmit={handleSubmitJoinRoom}
            className="w-full max-w-sm rounded-xl bg-white p-5 shadow-2xl border border-slate-200 text-slate-900"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-bold text-slate-900">Join Friend&apos;s Room</h2>
                <p className="mt-0.5 text-xs text-slate-600">
                  Your current code: <span className="font-mono-tabular font-semibold text-slate-900">{telemetry.room || roomId}</span>
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setRoomKeyboardOpen(false);
                  engineRef.current?.closeRoomKeyboard();
                }}
                aria-label="Close Room Modal"
                className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900 cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-4">
              <label htmlFor="room-code-input" className="block text-xs font-semibold text-slate-700">
                Friend&apos;s Room Code
              </label>
              <input
                ref={roomInputRef}
                id="room-code-input"
                type="text"
                inputMode="text"
                autoCapitalize="characters"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                maxLength={12}
                value={roomDraftCode}
                onChange={(e) => handleRoomDraftInput(e.target.value)}
                placeholder="e.g. K7M9P"
                className="mt-1.5 w-full rounded-lg border border-slate-300 bg-slate-50 px-3.5 py-2.5 font-mono-tabular text-base font-bold tracking-widest uppercase text-slate-900 placeholder:text-slate-400 focus:border-sky-600 focus:bg-white focus:outline-none focus:ring-2 focus:ring-sky-600/20"
              />
            </div>

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setRoomKeyboardOpen(false);
                  engineRef.current?.closeRoomKeyboard();
                }}
                className="rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={roomDraftCode.trim().length < 2}
                className="rounded-lg bg-sky-600 px-4 py-2 text-xs font-semibold text-white hover:bg-sky-700 disabled:opacity-45 transition-colors cursor-pointer"
              >
                Join Room
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Subtle Center Aim Reticle in Pointer-Lock Desktop Mode */}
      {joined && telemetry.isPointerLocked && !telemetry.isVR && !handModalOpen && !roomKeyboardOpen && !telemetry.killEditActive && (
        <div className="pointer-events-none fixed inset-0 z-10 flex items-center justify-center">
          <div
            className={`h-2 w-2 rounded-full border transition-transform duration-150 ${
              telemetry.leftContact || telemetry.rightContact
                ? 'scale-125 border-sky-600 bg-sky-400'
                : 'border-slate-700/70 bg-white/80'
            }`}
          />
        </div>
      )}

      {/* Top Minimal Spatial HUD & Prominent VRButton */}
      <header
        className={`pointer-events-none absolute top-0 left-0 right-0 z-10 flex items-start justify-between px-5 py-4 gap-4 transition-opacity duration-150 ${
          telemetry.killEditActive ? 'opacity-0' : 'opacity-100'
        }`}
      >
        <div className="pointer-events-auto rounded-xl bg-white/95 px-4 py-2.5 border border-slate-200 shadow-sm">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-bold tracking-tight text-slate-900 whitespace-nowrap">
              Haunted Hotel · WebXR
            </h2>
            {telemetry.username && (
              <>
                <span aria-hidden="true" className="text-slate-300">·</span>
                <span className="text-xs font-semibold text-sky-700 whitespace-nowrap">
                  {telemetry.username}
                </span>
              </>
            )}
            {isMatchActive && (
              <span
                className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ${
                  telemetry.gameRole === 'murderer'
                    ? 'bg-red-100 text-red-800 border border-red-200'
                    : telemetry.gameRole === 'innocent'
                    ? 'bg-sky-100 text-sky-800 border border-sky-200'
                    : 'bg-slate-200 text-slate-700 border border-slate-300'
                }`}
              >
                {telemetry.gameRole === 'murderer' ? (
                  <Skull className="h-3 w-3" />
                ) : (
                  <Shield className="h-3 w-3" />
                )}
                <span>
                  {telemetry.isPracticeMode
                    ? 'Solo Practice'
                    : telemetry.gameRole === 'none'
                    ? 'Spectator'
                    : telemetry.gameRole}
                </span>
              </span>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-600 font-mono-tabular">
            <span>ALT {telemetry.altitude.toFixed(1)}m</span>
            <span aria-hidden="true" className="text-slate-300">/</span>
            <span>SPD {telemetry.speed.toFixed(1)} m/s</span>
            <span aria-hidden="true" className="text-slate-300">/</span>
            <span className="inline-flex items-center gap-1 text-slate-800 font-semibold">
              <Users className="h-3 w-3" />
              {telemetry.playersOnline} {telemetry.mpConnected ? 'Online' : 'Offline'}
            </span>
            {!isMatchActive && telemetry.playersOnline <= 1 && (
              <>
                <span aria-hidden="true" className="text-slate-300">/</span>
                <span className="inline-flex items-center gap-1 font-bold text-red-700">
                  <Skull className="h-3 w-3" />
                  Dummy Kills: {telemetry.dummyKills}
                </span>
              </>
            )}
            {isMatchActive && (
              <>
                <span aria-hidden="true" className="text-slate-300">/</span>
                <span
                  className={`inline-flex items-center gap-1 font-bold ${
                    telemetry.gamePhase === 'hiding' ? 'text-amber-700' : 'text-red-700'
                  }`}
                >
                  <Timer className="h-3 w-3" />
                  {telemetry.gamePhase === 'hiding' ? 'HIDE ' : 'HUNT '}
                  {formatMatchClock(telemetry.gameTimeLeftSec)}
                </span>
              </>
            )}
          </div>
        </div>

        <div className="pointer-events-auto flex flex-wrap items-center justify-end gap-2">
          {joined && (
            !isMatchActive ? (
              <button
                type="button"
                onClick={() => engineRef.current?.startHotelMatch(telemetry.playersOnline < 2)}
                title="Start 3-minute Haunted Hotel Murder Mystery (also tappable on your Left Wrist)"
                className="inline-flex items-center gap-1.5 rounded-lg bg-red-700 px-3.5 py-2 text-xs font-semibold text-white border border-red-800 shadow-sm hover:bg-red-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Play className="h-3.5 w-3.5" />
                <span>{telemetry.playersOnline >= 2 ? 'Start Murder Mystery' : 'Solo Practice'}</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => engineRef.current?.stopHotelMatch()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white border border-slate-950 shadow-sm hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Square className="h-3 w-3" />
                <span>End Match</span>
              </button>
            )
          )}

          {joined && (
            <button
              type="button"
              onClick={handleOpenRoomCodeModal}
              title="Click or tap your left wrist in VR to join a friend's room code (G)"
              className="inline-flex items-center gap-1.5 rounded-lg bg-white/95 px-3.5 py-2 text-xs font-semibold text-slate-900 border border-slate-200 shadow-sm hover:bg-white transition-colors whitespace-nowrap shrink-0 cursor-pointer font-mono-tabular"
            >
              <span>Room: {telemetry.room || roomId}</span>
            </button>
          )}

          {joined && (
            <button
              type="button"
              onClick={handleToggleMic}
              title={telemetry.voiceError || 'Toggle Voice Chat Microphone (M)'}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-semibold border shadow-sm transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                telemetry.micState === 'active'
                  ? telemetry.isSpeaking
                    ? 'bg-sky-600 text-white border-sky-700'
                    : 'bg-white/95 text-emerald-700 border-emerald-300 hover:bg-white'
                  : 'bg-white/95 text-slate-700 border-slate-200 hover:bg-white'
              }`}
            >
              {telemetry.micState === 'active' ? (
                <Mic className="h-3.5 w-3.5" />
              ) : (
                <MicOff className="h-3.5 w-3.5" />
              )}
              <span>{micLabel} (M)</span>
            </button>
          )}

          <button
            type="button"
            onClick={handleCopyInvite}
            className="inline-flex items-center gap-1.5 rounded-lg bg-white/95 px-3.5 py-2 text-xs font-semibold text-slate-800 border border-slate-200 shadow-sm hover:bg-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {copiedLink ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
            <span>{copiedLink ? 'Link Copied' : 'Copy Friend Link'}</span>
          </button>

          {joined && !telemetry.isPointerLocked && !telemetry.isVR && (
            <button
              type="button"
              onClick={() => engineRef.current?.requestDesktopPlay()}
              className="rounded-lg bg-white/95 px-4 py-2 text-xs font-semibold text-slate-800 border border-slate-200 shadow-sm hover:bg-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Lock Mouse Look
            </button>
          )}

          <div ref={vrMountRef} className="shrink-0" />
        </div>
      </header>

      {/* Match Winner / Active Ability Banner */}
      {joined && !telemetry.killEditActive && (telemetry.gamePhase === 'ended' || telemetry.gameNotice) && (
        <div className="pointer-events-none fixed top-20 left-1/2 z-10 -translate-x-1/2">
          <div
            className={`rounded-xl px-4 py-2 text-center shadow-lg border text-xs font-semibold ${
              telemetry.gamePhase === 'ended' && telemetry.gameWinner === 'murderer'
                ? 'bg-red-950/95 border-red-700 text-red-100'
                : telemetry.gamePhase === 'ended' && telemetry.gameWinner === 'innocent'
                ? 'bg-sky-950/95 border-sky-700 text-sky-100'
                : 'bg-slate-900/95 border-slate-700 text-slate-100'
            }`}
          >
            {telemetry.gamePhase === 'ended' && telemetry.gameWinner
              ? `${telemetry.gameWinner === 'murderer' ? 'MURDERER WINS' : 'INNOCENT WINS'} — ${telemetry.gameEndReason}`
              : telemetry.gameNotice}
          </div>
        </div>
      )}

      {/* Cinematic Funk Kill-Edit Letterbox & Beat Flash Overlay */}
      {joined && telemetry.killEditActive && (
        <>
          {telemetry.killEditFlash > 0.01 && (
            <div
              className="pointer-events-none fixed inset-0 z-20"
              style={{
                backgroundColor: `rgba(255, 240, 240, ${Math.min(0.42, telemetry.killEditFlash * 0.42)})`,
              }}
            />
          )}

          {/* Top Cinema Letterbox Bar */}
          <div className="pointer-events-none fixed top-0 left-0 right-0 z-20 h-[9vh] min-h-[56px] bg-black border-b border-red-900/50 flex items-center justify-between px-6">
            <div className="flex items-center gap-3 text-white">
              <span className="inline-flex items-center gap-1.5 rounded-md bg-red-700 px-2.5 py-1 text-[11px] font-black uppercase tracking-wider text-white">
                <Film className="h-3.5 w-3.5" />
                <span>
                  {telemetry.killEditPhase === 'slowmo'
                    ? 'SLOW-MO KNIFE IMPACT'
                    : `FRAME ${telemetry.killEditCutIndex}/${telemetry.killEditTotalCuts}`}
                </span>
              </span>
              <span className="text-xs sm:text-sm font-bold tracking-wide text-red-200 uppercase">
                {telemetry.killEditVictimName} ELIMINATED
              </span>
            </div>

            <div className="hidden sm:flex items-center gap-2 text-xs font-semibold text-amber-300 font-mono-tabular">
              <Music className="h-3.5 w-3.5" />
              <span>HEAVENLY JUMPSTYLE</span>
              <span className="text-slate-500">·</span>
              <span className="text-white">{Math.ceil(telemetry.killEditTimeLeftSec)}s</span>
            </div>
          </div>

          {/* Bottom Cinema Letterbox Bar */}
          <div className="fixed bottom-0 left-0 right-0 z-30 h-[9vh] min-h-[58px] bg-black border-t border-red-900/50 flex items-center justify-between px-6 gap-4">
            <div className="flex items-center gap-2.5 text-xs text-slate-200 truncate">
              <Skull className="h-4 w-4 text-red-500 shrink-0" />
              <span className="font-bold text-white uppercase tracking-wide truncate">
                Killer Spotlight: {telemetry.killEditKillerName || telemetry.username || 'Murderer'}
              </span>
            </div>

            <button
              type="button"
              onClick={() => engineRef.current?.skipKillEdit()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-white/15 hover:bg-white/25 border border-white/25 px-3.5 py-1.5 text-xs font-semibold text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <FastForward className="h-3.5 w-3.5" />
              <span>Skip Edit (Space)</span>
            </button>
          </div>
        </>
      )}

      {/* Hand Settings / Locked Brightness Drawer */}
      {joined && handModalOpen && (
        <div className="fixed bottom-24 right-5 z-30 w-[min(440px,94vw)] max-h-[calc(100vh-140px)] overflow-y-auto rounded-xl bg-white p-5 shadow-2xl border border-slate-200 text-slate-900">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="flex items-center gap-1.5 text-base font-bold text-slate-900">
                {locked && <Lock className="h-4 w-4 text-emerald-600" />}
                <span>{locked ? 'Hand Brightness (Locked)' : 'Custom 3D Hand Models'}</span>
              </h3>
              <p className="mt-0.5 text-xs text-slate-600">
                {locked
                  ? 'Model, orientation, and texture are permanently locked in Firebase.'
                  : 'Upload a model, auto-orient with AI, paint textures, and lock in Firebase.'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setHandModalOpen(false)}
              aria-label="Close Hand Panel"
              className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900 cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Firebase Account Bar */}
          <div className="mt-3 flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
            {firebaseUser ? (
              <div className="flex items-center gap-2 text-xs text-slate-700 truncate">
                <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-600" />
                <span className="truncate font-medium">
                  Firebase: {firebaseUser.email || firebaseUser.displayName || 'Connected'}
                </span>
              </div>
            ) : (
              <>
                <span className="text-xs text-slate-600">
                  {locked ? 'Sign in to sync brightness with Firebase' : 'Sign in with Google to lock in Firebase'}
                </span>
                <button
                  type="button"
                  disabled={authBusy}
                  onClick={() => void handleGoogleSignIn()}
                  className="rounded-md bg-slate-900 px-2.5 py-1 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50 cursor-pointer whitespace-nowrap"
                >
                  {authBusy ? 'Signing in...' : 'Sign in with Google'}
                </button>
              </>
            )}
          </div>

          {locked ? (
            /* LOCKED MODE: All change settings removed. Only saved texture preview & Brightness remain. */
            <div className="mt-4 space-y-4">
              {textureDataUrl && (
                <div className="flex items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2.5">
                  <img
                    src={textureDataUrl}
                    alt="Saved Hand Texture"
                    className="h-10 w-10 rounded-md border border-emerald-200 object-cover"
                  />
                  <div>
                    <p className="text-xs font-semibold text-emerald-900">Texture Saved &amp; Locked</p>
                    <p className="text-[11px] text-emerald-700">
                      Your 3D hand mesh, orientation, and texture cannot be altered.
                    </p>
                  </div>
                </div>
              )}

              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <div className="flex items-center justify-between text-xs font-semibold text-slate-800">
                  <span className="inline-flex items-center gap-1.5">
                    <Sun className="h-4 w-4 text-amber-500" />
                    <span>Hand Brightness</span>
                  </span>
                  <span className="font-mono-tabular text-slate-900">{Math.round(brightness * 100)}%</span>
                </div>
                <input
                  type="range"
                  min={0.1}
                  max={1.5}
                  step={0.02}
                  value={brightness}
                  onChange={(e) => handleBrightnessChange(Number(e.target.value))}
                  aria-label="Hand Brightness"
                  className="mt-2.5 w-full accent-sky-600 cursor-pointer"
                />
                <div className="mt-1 flex justify-between text-[11px] text-slate-500">
                  <span>Dim (10%)</span>
                  <span>Normal (100%)</span>
                  <span>Bright (150%)</span>
                </div>
              </div>
            </div>
          ) : (
            /* UNLOCKED SETUP MODE */
            <>
              {/* Target Hand Selector */}
              <div className="mt-3.5 flex items-center gap-1 rounded-lg bg-slate-100 p-1">
                {(
                  [
                    { id: 'both', label: 'Both Hands (Mirror)' },
                    { id: 'left', label: 'Left Hand' },
                    { id: 'right', label: 'Right Hand' },
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setHandTarget(tab.id)}
                    className={`flex-1 rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap ${
                      handTarget === tab.id
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {/* 3D Model Dropzone */}
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDraggingFile(true);
                }}
                onDragLeave={() => setIsDraggingFile(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`mt-3.5 flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-4 py-4 text-center transition-colors cursor-pointer ${
                  isDraggingFile
                    ? 'border-sky-500 bg-sky-50'
                    : 'border-slate-300 bg-slate-50 hover:border-slate-400 hover:bg-slate-100/70'
                }`}
              >
                <Upload className="h-5 w-5 text-slate-500" />
                <p className="mt-1.5 text-xs font-semibold text-slate-800">
                  {handUploading ? 'Loading 3D model...' : 'Upload .glb, .gltf, .obj, .fbx, or .stl'}
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".glb,.gltf,.obj,.fbx,.stl"
                  onChange={handleFileChange}
                  className="hidden"
                />
              </div>

              {/* AI Auto-Orient & Manual Orientation */}
              <div className="mt-3.5 space-y-3 border-t border-slate-200 pt-3.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-slate-800">Fit &amp; Orientation</span>
                  <button
                    type="button"
                    disabled={!hasAnyCustomHand || aiOrienting}
                    onClick={() => void handleAiAutoOrient()}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-45 cursor-pointer whitespace-nowrap"
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    <span>{aiOrienting ? 'Analyzing Model...' : 'AI Auto-Orient'}</span>
                  </button>
                </div>

                <div>
                  <div className="flex items-center justify-between text-xs font-medium text-slate-700">
                    <span>Hand Scale</span>
                    <span className="font-mono-tabular text-slate-900">{handTransform.scale.toFixed(2)}x</span>
                  </div>
                  <input
                    type="range"
                    min={0.4}
                    max={2.5}
                    step={0.05}
                    value={handTransform.scale}
                    onChange={(e) =>
                      handleTransformChange({ ...handTransform, scale: Number(e.target.value) })
                    }
                    className="mt-1 w-full accent-sky-600 cursor-pointer"
                  />
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-medium text-slate-700">Manual Rotate</span>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() =>
                        handleTransformChange({
                          ...handTransform,
                          rotY: (handTransform.rotY + Math.PI) % (Math.PI * 2),
                        })
                      }
                      className="inline-flex items-center gap-1 rounded-lg border border-sky-200 bg-sky-50 px-2.5 py-1 text-xs font-semibold text-sky-800 hover:bg-sky-100 cursor-pointer"
                    >
                      <RotateCw className="h-3 w-3" />
                      <span>Flip 180°</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRotateAxis('rotX')}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
                    >
                      <RotateCw className="h-3 w-3" />
                      <span>X</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRotateAxis('rotY')}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
                    >
                      <RotateCw className="h-3 w-3" />
                      <span>Y</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRotateAxis('rotZ')}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
                    >
                      <RotateCw className="h-3 w-3" />
                      <span>Z</span>
                    </button>
                  </div>
                </div>
              </div>

              {/* Texture Upload + Color Wheel + Brightness */}
              <div className="mt-3.5 space-y-3 border-t border-slate-200 pt-3.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-slate-800">Texture Image &amp; Color Wheel</span>
                  <div className="flex items-center gap-1.5">
                    {textureDataUrl && (
                      <button
                        type="button"
                        onClick={handleRemoveTexture}
                        className="rounded border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50 cursor-pointer"
                      >
                        Clear Texture
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={!hasAnyCustomHand}
                      onClick={() => textureInputRef.current?.click()}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-45 cursor-pointer whitespace-nowrap"
                    >
                      <ImageIcon className="h-3.5 w-3.5" />
                      <span>{textureDataUrl ? 'Change Texture' : 'Upload Texture'}</span>
                    </button>
                  </div>
                  <input
                    ref={textureInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    onChange={handleTextureUpload}
                    className="hidden"
                  />
                </div>

                {textureDataUrl && (
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <img
                        src={textureDataUrl}
                        alt="Uploaded Hand Texture"
                        className="h-8 w-8 rounded border border-slate-200 object-cover"
                      />
                      <span className="text-xs text-slate-600">Texture active</span>
                    </div>
                    <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={flipTextureY}
                        onChange={(e) => handleFlipTextureToggle(e.target.checked)}
                        className="h-3.5 w-3.5 rounded border-slate-300 text-sky-600"
                      />
                      <span>Flip Texture Y</span>
                    </label>
                  </div>
                )}

                <ColorWheel color={tintColor} onChange={handleColorWheelChange} />

                <div>
                  <div className="flex items-center justify-between text-xs font-medium text-slate-700">
                    <span className="inline-flex items-center gap-1.5">
                      <Sun className="h-3.5 w-3.5 text-amber-500" />
                      <span>Hand Brightness</span>
                    </span>
                    <span className="font-mono-tabular text-slate-900">{Math.round(brightness * 100)}%</span>
                  </div>
                  <input
                    type="range"
                    min={0.1}
                    max={1.5}
                    step={0.02}
                    value={brightness}
                    onChange={(e) => handleBrightnessChange(Number(e.target.value))}
                    className="mt-1 w-full accent-sky-600 cursor-pointer"
                  />
                </div>
              </div>

              {/* Save & Permanently Lock Actions */}
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-3.5">
                <button
                  type="button"
                  onClick={handleResetHands}
                  className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer"
                >
                  Reset Default
                </button>

                <button
                  type="button"
                  disabled={!hasAnyCustomHand || finalizing}
                  onClick={() => void handleSaveAndLockPermanently()}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-45 cursor-pointer whitespace-nowrap"
                >
                  <Lock className="h-3.5 w-3.5" />
                  <span>{finalizing ? 'Locking in Firebase...' : 'Save & Lock Permanently'}</span>
                </button>
              </div>
            </>
          )}

          {handUploadError && (
            <p className="mt-3 text-xs font-medium text-red-600">{handUploadError}</p>
          )}
          {handUploadStatus && (
            <p className="mt-3 text-xs font-medium text-emerald-700">{handUploadStatus}</p>
          )}
        </div>
      )}

      {/* Collapsible Bottom Controls Bar */}
      {joined && !telemetry.killEditActive && (
        <>
          <div
            className={`fixed bottom-4 left-1/2 z-20 -translate-x-1/2 w-[min(880px,95vw)] transition-transform duration-200 ease-out ${
              dockOpen ? 'translate-y-0' : 'translate-y-[calc(100%+24px)]'
            }`}
          >
            <div className="flex justify-center mb-1.5">
              <button
                type="button"
                onClick={() => setDockOpen((v) => !v)}
                className="flex items-center gap-1.5 rounded-lg bg-white/92 px-3 py-1 text-xs font-medium text-slate-700 border border-slate-200/90 shadow-sm hover:bg-white transition-colors cursor-pointer whitespace-nowrap"
              >
                {dockOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
                <span>{dockOpen ? 'Hide Controls (H)' : 'Show Controls (H)'}</span>
              </button>
            </div>

            <div className="rounded-xl bg-white/94 border border-slate-200 shadow-lg px-4 py-2.5 text-slate-800">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-xs text-slate-600">
                  {telemetry.gameRole === 'murderer'
                    ? 'Murderer: Flick Right Trigger (or press F) to throw knife toward fingertip direction'
                    : telemetry.gameRole === 'innocent'
                    ? 'Innocent (1.28x Speed Boost): Press A on Quest (or F) to Super Jump far away'
                    : !isMatchActive && telemetry.playersOnline <= 1
                    ? 'Test Dummy Active: Flick Right Trigger (or press F) to throw knife · Dummy respawns automatically'
                    : 'Enter VR · Check Left Wrist for Room Code & Start Game · M voice chat'}
                </span>

                <div className="flex items-center gap-2 shrink-0">
                  {telemetry.gameRole === 'innocent' && isMatchActive && (
                    <button
                      type="button"
                      disabled={telemetry.superJumpCooldownSec > 0}
                      onClick={() => engineRef.current?.triggerAbilityDesktop()}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-sky-300 bg-sky-50 px-3 py-1.5 text-xs font-semibold text-sky-800 hover:bg-sky-100 disabled:opacity-55 transition-colors whitespace-nowrap shrink-0 cursor-pointer font-mono-tabular"
                    >
                      <Zap className="h-3.5 w-3.5" />
                      <span>
                        {telemetry.superJumpCooldownSec > 0
                          ? `Super Jump (${telemetry.superJumpCooldownSec.toFixed(0)}s)`
                          : 'Super Jump (A / F)'}
                      </span>
                    </button>
                  )}

                  {((telemetry.gameRole === 'murderer' &&
                    (telemetry.gamePhase === 'hunt' || (telemetry.isPracticeMode && telemetry.gamePhase === 'hiding'))) ||
                    (!isMatchActive && telemetry.playersOnline <= 1)) && (
                    <button
                      type="button"
                      disabled={telemetry.knifeCooldownSec > 0}
                      onClick={() => engineRef.current?.triggerAbilityDesktop()}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-red-300 bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-800 hover:bg-red-100 disabled:opacity-55 transition-colors whitespace-nowrap shrink-0 cursor-pointer font-mono-tabular"
                    >
                      <Skull className="h-3.5 w-3.5" />
                      <span>
                        {telemetry.knifeCooldownSec > 0
                          ? `Knife (${telemetry.knifeCooldownSec.toFixed(1)}s)`
                          : 'Throw Knife (Trigger / F)'}
                      </span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => {
                      if (document.pointerLockElement) {
                        document.exitPointerLock?.();
                      }
                      setHandModalOpen((prev) => !prev);
                    }}
                    className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      locked
                        ? 'border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
                        : hasAnyCustomHand
                        ? 'border-sky-300 bg-sky-50 text-sky-800 hover:bg-sky-100'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    {locked ? <Lock className="h-3.5 w-3.5" /> : <Hand className="h-3.5 w-3.5" />}
                    <span>
                      {locked
                        ? 'Hand Brightness'
                        : telemetry.isHandFinalized
                        ? 'Finalized Hand'
                        : hasAnyCustomHand
                        ? 'Custom Hands Active'
                        : 'Upload Hand Model'}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={handleRespawn}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    <span>Respawn (R)</span>
                  </button>

                  <button
                    type="button"
                    onClick={handleToggleAudio}
                    aria-label={audioEnabled ? 'Mute Audio' : 'Enable Audio'}
                    className="inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white p-1.5 text-slate-700 hover:bg-slate-50 transition-colors shrink-0 cursor-pointer"
                  >
                    {audioEnabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {!dockOpen && (
            <button
              type="button"
              onClick={() => setDockOpen(true)}
              className="fixed bottom-4 left-1/2 z-20 -translate-x-1/2 flex items-center gap-1.5 rounded-lg bg-white/92 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 shadow-sm hover:bg-white transition-colors cursor-pointer whitespace-nowrap"
            >
              <ChevronUp className="h-3.5 w-3.5" />
              <span>Show Controls (H)</span>
            </button>
          )}
        </>
      )}
    </div>
  );
}
