import * as THREE from 'three';

export type MicState = 'off' | 'active' | 'muted' | 'denied' | 'unsupported';

export interface VoiceStatus {
  micState: MicState;
  isSpeaking: boolean;
  connectedPeers: number;
  errorMessage: string | null;
}

interface PeerVoiceLink {
  id: string;
  pc: RTCPeerConnection;
  audioEl: HTMLAudioElement;
  makingOffer: boolean;
  ignoreOffer: boolean;
  pendingCandidates: RTCIceCandidateInit[];
}

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

export class VoiceChatManager {
  private readonly peers = new Map<string, PeerVoiceLink>();
  private readonly sendSignal: (msg: {
    type: 'rtc:offer' | 'rtc:answer' | 'rtc:ice';
    to: string;
    sdp?: RTCSessionDescriptionInit;
    candidate?: RTCIceCandidateInit;
  }) => void;
  private readonly onStatus: (status: VoiceStatus) => void;

  private localId: string | null = null;
  private localStream: MediaStream | null = null;
  private micState: MicState = 'off';
  private errorMessage: string | null = null;
  private disposed = false;

  private analyserCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private analyserData: Uint8Array<ArrayBuffer> | null = null;
  private isSpeaking = false;

  constructor(
    sendSignal: (msg: {
      type: 'rtc:offer' | 'rtc:answer' | 'rtc:ice';
      to: string;
      sdp?: RTCSessionDescriptionInit;
      candidate?: RTCIceCandidateInit;
    }) => void,
    onStatus: (status: VoiceStatus) => void
  ) {
    this.sendSignal = sendSignal;
    this.onStatus = onStatus;
  }

  private emitStatus(): void {
    this.onStatus({
      micState: this.micState,
      isSpeaking: this.isSpeaking,
      connectedPeers: this.peers.size,
      errorMessage: this.errorMessage,
    });
  }

  public getIsSpeaking(): boolean {
    if (this.micState !== 'active' || !this.analyser || !this.analyserData) {
      this.isSpeaking = false;
      return false;
    }
    this.analyser.getByteTimeDomainData(this.analyserData);
    let sumSq = 0;
    for (let i = 0; i < this.analyserData.length; i++) {
      const norm = (this.analyserData[i] - 128) / 128;
      sumSq += norm * norm;
    }
    const rms = Math.sqrt(sumSq / this.analyserData.length);
    const nextSpeaking = rms > 0.025;
    if (nextSpeaking !== this.isSpeaking) {
      this.isSpeaking = nextSpeaking;
      this.emitStatus();
    }
    return this.isSpeaking;
  }

  public async enableMic(): Promise<boolean> {
    if (this.disposed) return false;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this.micState = 'unsupported';
      this.errorMessage = 'Microphone API unavailable in this browser.';
      this.emitStatus();
      return false;
    }

    if (this.localStream) {
      for (const track of this.localStream.getAudioTracks()) {
        track.enabled = true;
      }
      this.micState = 'active';
      this.errorMessage = null;
      this.emitStatus();
      return true;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });

      if (this.disposed) {
        stream.getTracks().forEach((t) => t.stop());
        return false;
      }

      this.localStream = stream;
      this.micState = 'active';
      this.errorMessage = null;

      // Setup lightweight analyser for speaking badge
      try {
        const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (Ctx) {
          this.analyserCtx = new Ctx();
          const source = this.analyserCtx.createMediaStreamSource(stream);
          this.analyser = this.analyserCtx.createAnalyser();
          this.analyser.fftSize = 256;
          this.analyserData = new Uint8Array(new ArrayBuffer(this.analyser.frequencyBinCount));
          source.connect(this.analyser);
        }
      } catch {
        // Speaking meter is optional
      }

      // Attach local audio track to every active peer connection
      for (const peer of this.peers.values()) {
        const senders = peer.pc.getSenders();
        for (const track of stream.getAudioTracks()) {
          const alreadyAdded = senders.some((s) => s.track?.kind === 'audio');
          if (!alreadyAdded) {
            peer.pc.addTrack(track, stream);
          }
        }
      }

      this.emitStatus();
      return true;
    } catch {
      this.micState = 'denied';
      this.errorMessage = 'Microphone permission blocked.';
      this.emitStatus();
      return false;
    }
  }

  public async toggleMic(): Promise<void> {
    if (this.micState === 'off' || this.micState === 'denied') {
      await this.enableMic();
      return;
    }
    if (!this.localStream) return;

    const nextActive = this.micState === 'muted';
    for (const track of this.localStream.getAudioTracks()) {
      track.enabled = nextActive;
    }
    this.micState = nextActive ? 'active' : 'muted';
    if (!nextActive) {
      this.isSpeaking = false;
    }
    this.emitStatus();
  }

  public setLocalSession(localId: string, existingPeerIds: string[]): void {
    this.localId = localId;
    this.clearPeers();
    for (const peerId of existingPeerIds) {
      if (peerId !== localId) {
        this.ensurePeer(peerId);
      }
    }
    this.emitStatus();
  }

  public onPeerJoined(peerId: string): void {
    if (!this.localId || peerId === this.localId) return;
    this.ensurePeer(peerId);
    this.emitStatus();
  }

  public onPeerLeft(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.pc.close();
    peer.audioEl.srcObject = null;
    peer.audioEl.remove();
    this.peers.delete(peerId);
    this.emitStatus();
  }

  private ensurePeer(peerId: string): PeerVoiceLink {
    const existing = this.peers.get(peerId);
    if (existing) return existing;

    const pc = new RTCPeerConnection(RTC_CONFIG);
    const audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    audioEl.setAttribute('playsinline', 'true');
    audioEl.volume = 0.9;
    audioEl.style.display = 'none';
    document.body.appendChild(audioEl);

    const link: PeerVoiceLink = {
      id: peerId,
      pc,
      audioEl,
      makingOffer: false,
      ignoreOffer: false,
      pendingCandidates: [],
    };
    this.peers.set(peerId, link);

    // Ensure receive audio transceiver even before user enables mic so they can always hear friends
    pc.addTransceiver('audio', { direction: 'sendrecv' });

    if (this.localStream) {
      for (const track of this.localStream.getAudioTracks()) {
        pc.addTrack(track, this.localStream);
      }
    }

    pc.ontrack = (ev) => {
      if (ev.streams && ev.streams[0]) {
        audioEl.srcObject = ev.streams[0];
        audioEl.play().catch(() => {
          // Will play on next user interaction if autoplay blocked
        });
      }
    };

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this.sendSignal({
          type: 'rtc:ice',
          to: peerId,
          candidate: ev.candidate.toJSON(),
        });
      }
    };

    pc.onnegotiationneeded = async () => {
      try {
        link.makingOffer = true;
        await pc.setLocalDescription();
        if (pc.localDescription) {
          this.sendSignal({
            type: 'rtc:offer',
            to: peerId,
            sdp: pc.localDescription.toJSON(),
          });
        }
      } catch {
        // Ignore transient negotiation race
      } finally {
        link.makingOffer = false;
      }
    };

    return link;
  }

  public async handleSignal(
    fromId: string,
    type: 'rtc:offer' | 'rtc:answer' | 'rtc:ice',
    sdp?: RTCSessionDescriptionInit,
    candidate?: RTCIceCandidateInit
  ): Promise<void> {
    if (this.disposed || !this.localId || fromId === this.localId) return;
    const link = this.ensurePeer(fromId);
    const pc = link.pc;
    const polite = this.localId < fromId;

    try {
      if (type === 'rtc:offer' && sdp) {
        const offerCollision = link.makingOffer || pc.signalingState !== 'stable';
        link.ignoreOffer = !polite && offerCollision;
        if (link.ignoreOffer) return;

        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        for (const cand of link.pendingCandidates) {
          await pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
        }
        link.pendingCandidates = [];

        await pc.setLocalDescription();
        if (pc.localDescription) {
          this.sendSignal({
            type: 'rtc:answer',
            to: fromId,
            sdp: pc.localDescription.toJSON(),
          });
        }
      } else if (type === 'rtc:answer' && sdp) {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        for (const cand of link.pendingCandidates) {
          await pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
        }
        link.pendingCandidates = [];
      } else if (type === 'rtc:ice' && candidate) {
        if (pc.remoteDescription) {
          await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
        } else {
          link.pendingCandidates.push(candidate);
        }
      }
    } catch {
      // Ignore malformed/stale WebRTC signaling packets
    }
  }

  public updateProximity(localHead: THREE.Vector3, peerPositions: Map<string, THREE.Vector3>): void {
    for (const [peerId, peer] of this.peers.entries()) {
      const remotePos = peerPositions.get(peerId);
      if (!remotePos) continue;
      const dist = localHead.distanceTo(remotePos);
      // Full volume within 5m, smooth falloff to 42m
      const t = Math.max(0, Math.min(1, (dist - 5) / 37));
      const gain = Math.pow(1 - t, 1.5);
      peer.audioEl.volume = Math.max(0, Math.min(1, gain));
    }
  }

  private clearPeers(): void {
    for (const peer of this.peers.values()) {
      peer.pc.close();
      peer.audioEl.srcObject = null;
      peer.audioEl.remove();
    }
    this.peers.clear();
  }

  public dispose(): void {
    this.disposed = true;
    this.clearPeers();
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
      this.localStream = null;
    }
    if (this.analyserCtx) {
      this.analyserCtx.close().catch(() => {});
      this.analyserCtx = null;
    }
  }
}
