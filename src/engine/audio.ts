const BG_MUSIC_URL =
  '/assets/aistudio/croxroc-piano-guy-finally-adds-drum-kit-instrumental-433826_0e7e9515.mp3';
const FUNK_EDIT_URL =
  '/assets/aistudio/HEAVENLY_JUMPSTYLE_0eff810a.mp3';

export class ProceduralAudio {
  private ctx: AudioContext | null = null;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private enabled = true;
  private lastHitTime = 0;

  private bgAudio: HTMLAudioElement | null = null;
  private funkAudio: HTMLAudioElement | null = null;
  private bgStarted = false;
  private killEditPlaying = false;

  private ensureMusicElements(): void {
    if (typeof window === 'undefined') return;
    if (!this.bgAudio) {
      const bg = new Audio(BG_MUSIC_URL);
      bg.loop = true;
      bg.preload = 'auto';
      bg.volume = 0.28;
      this.bgAudio = bg;
    }
    if (!this.funkAudio) {
      const funk = new Audio(FUNK_EDIT_URL);
      funk.loop = true;
      funk.preload = 'auto';
      funk.volume = 0.72;
      this.funkAudio = funk;
    }
  }

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      if (this.windGain && this.ctx) {
        this.windGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
      }
      this.bgAudio?.pause();
      this.funkAudio?.pause();
    } else {
      if (this.killEditPlaying) {
        this.funkAudio?.play().catch(() => {});
      } else if (this.bgStarted) {
        this.bgAudio?.play().catch(() => {});
      }
    }
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public unlock(): void {
    if (!this.enabled) return;
    this.ensureMusicElements();
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
        this.initNoiseAndWind();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    if (this.bgStarted && !this.killEditPlaying && this.bgAudio?.paused) {
      this.bgAudio.play().catch(() => {});
    }
  }

  public startBackgroundMusic(): void {
    this.bgStarted = true;
    this.ensureMusicElements();
    if (!this.enabled || this.killEditPlaying) return;
    if (this.bgAudio && this.bgAudio.paused) {
      this.bgAudio.play().catch(() => {});
    }
  }

  public startKillEditMusic(seekSec = 49.5): void {
    this.ensureMusicElements();
    this.killEditPlaying = true;
    this.bgAudio?.pause();
    if (!this.enabled || !this.funkAudio) return;

    const funk = this.funkAudio;
    const applySeekAndPlay = () => {
      try {
        if (Number.isFinite(funk.duration) && funk.duration > seekSec + 2) {
          funk.currentTime = seekSec;
        } else if (funk.readyState >= 1) {
          funk.currentTime = Math.min(seekSec, Math.max(0, (funk.duration || 0) * 0.4));
        }
      } catch {
        // Seek optional before metadata loads
      }
      funk.play().catch(() => {});
    };

    if (funk.readyState >= 1) {
      applySeekAndPlay();
    } else {
      const onMeta = () => {
        funk.removeEventListener('loadedmetadata', onMeta);
        if (this.killEditPlaying && this.enabled) {
          applySeekAndPlay();
        }
      };
      funk.addEventListener('loadedmetadata', onMeta);
      funk.play().catch(() => {});
    }
  }

  public stopKillEditMusic(): void {
    this.killEditPlaying = false;
    if (this.funkAudio) {
      this.funkAudio.pause();
      try {
        this.funkAudio.currentTime = 0;
      } catch {
        // Ignore reset error
      }
    }
    if (this.enabled && this.bgStarted && this.bgAudio) {
      this.bgAudio.play().catch(() => {});
    }
  }

  private initNoiseAndWind(): void {
    if (!this.ctx) return;
    const sampleRate = this.ctx.sampleRate;
    const length = sampleRate * 2;
    const buffer = this.ctx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    this.noiseBuffer = buffer;

    const windSource = this.ctx.createBufferSource();
    windSource.buffer = buffer;
    windSource.loop = true;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 320;
    filter.Q.value = 1.4;

    const gain = this.ctx.createGain();
    gain.gain.value = 0;

    windSource.connect(filter);
    filter.connect(gain);
    gain.connect(this.ctx.destination);
    windSource.start();

    this.windFilter = filter;
    this.windGain = gain;
  }

  public playSurfaceHit(impactSpeed: number): void {
    if (!this.enabled || !this.ctx || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    if (now - this.lastHitTime < 0.055) return;
    this.lastHitTime = now;

    const strength = Math.min(1, Math.max(0.12, impactSpeed / 10));

    // Tactile crisp thud oscillator
    const osc = this.ctx.createOscillator();
    const oscGain = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(140 + strength * 70, now);
    osc.frequency.exponentialRampToValueAtTime(52, now + 0.075);

    oscGain.gain.setValueAtTime(0.18 * strength, now);
    oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);

    osc.connect(oscGain);
    oscGain.connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + 0.085);

    // Subtle crisp matte tap noise burst
    if (this.noiseBuffer) {
      const noise = this.ctx.createBufferSource();
      noise.buffer = this.noiseBuffer;

      const filter = this.ctx.createBiquadFilter();
      filter.type = 'highpass';
      filter.frequency.value = 900;

      const nGain = this.ctx.createGain();
      nGain.gain.setValueAtTime(0.06 * strength, now);
      nGain.gain.exponentialRampToValueAtTime(0.001, now + 0.035);

      noise.connect(filter);
      filter.connect(nGain);
      nGain.connect(this.ctx.destination);
      noise.start(now, Math.random() * 1.5, 0.04);
    }
  }

  public updateWind(airspeed: number): void {
    if (!this.enabled || !this.ctx || !this.windGain || !this.windFilter || this.ctx.state !== 'running') {
      return;
    }
    const normalized = Math.min(1, Math.max(0, (airspeed - 4.5) / 14));
    const targetGain = normalized * normalized * 0.09;
    const targetFreq = 260 + normalized * 680;
    this.windGain.gain.setTargetAtTime(targetGain, this.ctx.currentTime, 0.08);
    this.windFilter.frequency.setTargetAtTime(targetFreq, this.ctx.currentTime, 0.08);
  }

  public playUiTap(pitch = 680): void {
    if (!this.enabled || !this.ctx || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(pitch, now);
    osc.frequency.exponentialRampToValueAtTime(pitch * 1.35, now + 0.038);

    gain.gain.setValueAtTime(0.11, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.048);

    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + 0.05);
  }

  public playKnifeThrow(): void {
    if (!this.enabled || !this.ctx || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(620, now);
    osc.frequency.exponentialRampToValueAtTime(190, now + 0.14);

    gain.gain.setValueAtTime(0.14, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + 0.17);
  }

  public playKnifeHitWall(): void {
    if (!this.enabled || !this.ctx || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(1250, now);
    osc.frequency.exponentialRampToValueAtTime(340, now + 0.09);

    gain.gain.setValueAtTime(0.16, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + 0.13);
  }

  public playSuperJump(): void {
    if (!this.enabled || !this.ctx || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.exponentialRampToValueAtTime(1180, now + 0.24);

    gain.gain.setValueAtTime(0.22, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + 0.30);
  }

  public playRoundAlert(kind: 'start' | 'hunt' | 'innocentWin' | 'murdererWin'): void {
    if (!this.enabled || !this.ctx || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    const notes =
      kind === 'innocentWin'
        ? [523.25, 659.25, 783.99]
        : kind === 'murdererWin'
          ? [196, 155.56, 130.81]
          : kind === 'hunt'
            ? [293.66, 277.18]
            : [440, 523.25];

    notes.forEach((freq, idx) => {
      if (!this.ctx) return;
      const t = now + idx * 0.11;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = kind === 'murdererWin' ? 'sawtooth' : 'triangle';
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(0.15, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.38);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(t);
      osc.stop(t + 0.4);
    });
  }

  public dispose(): void {
    this.killEditPlaying = false;
    this.bgStarted = false;
    if (this.bgAudio) {
      this.bgAudio.pause();
      this.bgAudio.src = '';
      this.bgAudio = null;
    }
    if (this.funkAudio) {
      this.funkAudio.pause();
      this.funkAudio.src = '';
      this.funkAudio = null;
    }
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }
}
