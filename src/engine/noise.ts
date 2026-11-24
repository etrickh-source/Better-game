export class SimplexNoise2D {
  private perm: Uint8Array;
  private permMod12: Uint8Array;

  private static readonly F2 = 0.5 * (Math.sqrt(3.0) - 1.0);
  private static readonly G2 = (3.0 - Math.sqrt(3.0)) / 6.0;
  private static readonly GRAD3: ReadonlyArray<[number, number]> = [
    [1, 1], [-1, 1], [1, -1], [-1, -1],
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 0], [-1, 0], [0, 1], [0, -1],
  ];

  constructor(seed: number) {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;

    let state = (seed | 0) || 1337;
    const rand = () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = p[i];
      p[i] = p[j];
      p[j] = tmp;
    }

    this.perm = new Uint8Array(512);
    this.permMod12 = new Uint8Array(512);
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.permMod12[i] = this.perm[i] % 12;
    }
  }

  public noise2D(xin: number, yin: number): number {
    const { F2, G2, GRAD3 } = SimplexNoise2D;
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const X0 = i - t;
    const Y0 = j - t;
    const x0 = xin - X0;
    const y0 = yin - Y0;

    const i1 = x0 > y0 ? 1 : 0;
    const j1 = x0 > y0 ? 0 : 1;

    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1.0 + 2.0 * G2;
    const y2 = y0 - 1.0 + 2.0 * G2;

    const ii = i & 255;
    const jj = j & 255;
    const gi0 = this.permMod12[ii + this.perm[jj]];
    const gi1 = this.permMod12[ii + i1 + this.perm[jj + j1]];
    const gi2 = this.permMod12[ii + 1 + this.perm[jj + 1]];

    let n0 = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 >= 0) {
      t0 *= t0;
      const g = GRAD3[gi0];
      n0 = t0 * t0 * (g[0] * x0 + g[1] * y0);
    }

    let n1 = 0;
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 >= 0) {
      t1 *= t1;
      const g = GRAD3[gi1];
      n1 = t1 * t1 * (g[0] * x1 + g[1] * y1);
    }

    let n2 = 0;
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 >= 0) {
      t2 *= t2;
      const g = GRAD3[gi2];
      n2 = t2 * t2 * (g[0] * x2 + g[1] * y2);
    }

    return 70.0 * (n0 + n1 + n2);
  }

  public fbm(x: number, z: number, octaves = 3, lacunarity = 2.0, gain = 0.5): number {
    let total = 0;
    let frequency = 1;
    let amplitude = 1;
    let maxVal = 0;
    for (let o = 0; o < octaves; o++) {
      total += this.noise2D(x * frequency, z * frequency) * amplitude;
      maxVal += amplitude;
      amplitude *= gain;
      frequency *= lacunarity;
    }
    return total / maxVal;
  }
}

export function hash2i(x: number, z: number, seed: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(z, 668265263) + Math.imul(seed, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

export interface MacroFeature {
  gx: number;
  gz: number;
  type: 'pillar' | 'arch' | 'terrace' | 'none';
  cx: number;
  cz: number;
  baseY: number;
  height: number;
  span: number;
  axisX: boolean;
}

const CELL_SIZE = 32;

export class WorldGenerator {
  public readonly seed: number;
  private readonly terrainNoise: SimplexNoise2D;
  private readonly biomeNoise: SimplexNoise2D;
  private readonly featureCache = new Map<string, MacroFeature>();

  constructor(seed: number) {
    this.seed = seed | 0;
    this.terrainNoise = new SimplexNoise2D(this.seed);
    this.biomeNoise = new SimplexNoise2D(this.seed + 7919);
  }

  public getBaseHeight(wx: number, wz: number): number {
    const distFromOriginSq = wx * wx + wz * wz;

    // Gentle multi-octave rolling white hills & open plains
    const n1 = this.terrainNoise.fbm(wx * 0.014, wz * 0.014, 3, 2.0, 0.5);
    const biome = this.biomeNoise.fbm(wx * 0.007 + 31.7, wz * 0.007 - 19.3, 2, 2.0, 0.5);

    let h = 6;
    if (biome < -0.15) {
      // Flat open plains
      h = 6 + Math.round(n1 * 0.9);
    } else if (biome < 0.15) {
      // Gentle 1-block stepped platforms
      const raw = (n1 + 1.0) * 0.5;
      const steps = Math.floor(raw * 5.0);
      h = 5 + steps;
    } else {
      // Smooth rolling white hills
      const hill = (n1 + 1.0) * 0.5;
      h = 6 + Math.round(hill * 9);
    }

    // Wide open flat spawn plains (radius 18m) transitioning smoothly outward
    if (distFromOriginSq < 676) {
      const dist = Math.sqrt(distFromOriginSq);
      if (dist <= 18) {
        h = 6;
      } else {
        const t = (dist - 18) / 8;
        const smooth = t * t * (3 - 2 * t);
        h = Math.round(6 * (1 - smooth) + h * smooth);
      }
    }

    return Math.max(2, Math.min(28, h));
  }

  private getMacroFeature(gx: number, gz: number): MacroFeature {
    const key = `${gx},${gz}`;
    const cached = this.featureCache.get(key);
    if (cached) return cached;

    // Keep spawn cell (0,0) and adjacent cells clear of sudden obstacles right next to spawn
    if (gx === 0 && gz === 0) {
      const f: MacroFeature = {
        gx,
        gz,
        type: 'none',
        cx: 0,
        cz: 0,
        baseY: 6,
        height: 0,
        span: 0,
        axisX: true,
      };
      this.featureCache.set(key, f);
      return f;
    }

    const rType = hash2i(gx, gz, this.seed + 101);
    const rOffX = hash2i(gx, gz, this.seed + 211);
    const rOffZ = hash2i(gx, gz, this.seed + 307);
    const rSize = hash2i(gx, gz, this.seed + 409);
    const rAxis = hash2i(gx, gz, this.seed + 503);

    const cx = gx * CELL_SIZE + Math.floor(8 + rOffX * (CELL_SIZE - 16));
    const cz = gz * CELL_SIZE + Math.floor(8 + rOffZ * (CELL_SIZE - 16));
    const baseY = this.getBaseHeight(cx, cz);

    // Occasional pillars, arches, and stepped platforms with plenty of open space
    let type: MacroFeature['type'] = 'none';
    if (rType < 0.22) type = 'pillar';
    else if (rType < 0.38) type = 'arch';
    else if (rType < 0.54) type = 'terrace';

    const height = Math.floor(8 + rSize * 12);
    const span = Math.floor(5 + rSize * 3);

    const feature: MacroFeature = {
      gx,
      gz,
      type,
      cx,
      cz,
      baseY,
      height,
      span,
      axisX: rAxis > 0.5,
    };

    if (this.featureCache.size > 2000) {
      this.featureCache.clear();
    }
    this.featureCache.set(key, feature);
    return feature;
  }

  private isInsideMacroFeature(f: MacroFeature, wx: number, wy: number, wz: number): boolean {
    if (f.type === 'none') return false;
    const dx = wx - f.cx;
    const dz = wz - f.cz;

    if (f.type === 'pillar') {
      if (Math.abs(dx) > 2 || Math.abs(dz) > 2) return false;
      const topY = f.baseY + f.height;
      if (wy < f.baseY - 2 || wy > topY) return false;

      if (dx >= 0 && dx <= 1 && dz >= 0 && dz <= 1) return true;

      const relY = wy - f.baseY;
      if (relY > 1 && relY < f.height - 1) {
        if (dx === -1 && dz === 0 && relY % 3 === 1) return true;
        if (dx === 2 && dz === 1 && relY % 3 === 2) return true;
        if (dz === -1 && dx === 1 && relY % 3 === 0) return true;
        if (dz === 2 && dx === 0 && relY % 3 === 1) return true;
      }
      return false;
    }

    if (f.type === 'arch') {
      const along = f.axisX ? dx : dz;
      const across = f.axisX ? dz : dx;
      if (Math.abs(across) > 1 || Math.abs(along) > f.span + 1) return false;
      const apex = f.baseY + Math.min(12, Math.max(7, Math.floor(f.height * 0.75)));
      if (wy < f.baseY - 2 || wy > apex + 2) return false;

      if (Math.abs(along) >= f.span - 1 && Math.abs(along) <= f.span) {
        return wy <= apex - 1;
      }

      const norm = along / f.span;
      const archBottom = apex - 2 - norm * norm * (apex - f.baseY - 2);
      const archTop = archBottom + 2.2;
      return wy >= Math.floor(archBottom) && wy <= Math.floor(archTop);
    }

    if (f.type === 'terrace') {
      const maxR = 4;
      if (Math.abs(dx) > maxR || Math.abs(dz) > maxR) return false;
      const cheb = Math.max(Math.abs(dx), Math.abs(dz));
      const tierHeight = f.baseY + (maxR - cheb);
      return wy >= f.baseY - 2 && wy <= tierHeight;
    }

    return false;
  }

  public isSolid(wx: number, wy: number, wz: number): boolean {
    if (wy < 0) return true;
    if (wy >= 47) return false;

    const baseH = this.getBaseHeight(wx, wz);
    if (wy <= baseH) return true;

    // Occasional distant pillars, arches, and stepped platforms (outside 20m spawn plaza)
    if (wx * wx + wz * wz > 400) {
      const gx = Math.floor(wx / CELL_SIZE);
      const gz = Math.floor(wz / CELL_SIZE);
      for (let ox = -1; ox <= 1; ox++) {
        for (let oz = -1; oz <= 1; oz++) {
          const f = this.getMacroFeature(gx + ox, gz + oz);
          if (this.isInsideMacroFeature(f, wx, wy, wz)) {
            return true;
          }
        }
      }
    }

    return false;
  }
}
