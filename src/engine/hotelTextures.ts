import * as THREE from 'three';

export interface HotelTextureSet {
  wallpaperMap: THREE.CanvasTexture;
  wallpaperBump: THREE.CanvasTexture;
  carpetMap: THREE.CanvasTexture;
  carpetBump: THREE.CanvasTexture;
  woodMap: THREE.CanvasTexture;
  woodBump: THREE.CanvasTexture;
  marbleMap: THREE.CanvasTexture;
  stoneMap: THREE.CanvasTexture;
  stoneBump: THREE.CanvasTexture;
  ceilingMap: THREE.CanvasTexture;
  fabricMap: THREE.CanvasTexture;
  portraitMaps: THREE.CanvasTexture[];
  dispose: () => void;
}

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  return [c, ctx];
}

function makeTexture(
  canvas: HTMLCanvasElement,
  anisotropy: number,
  repeatX: number,
  repeatY: number,
  isColor = true
): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.anisotropy = anisotropy;
  if (isColor) {
    tex.colorSpace = THREE.SRGBColorSpace;
  }
  tex.needsUpdate = true;
  return tex;
}

function seededRand(seed: number): () => number {
  let s = seed | 0 || 12345;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createHotelTextures(maxAnisotropy: number): HotelTextureSet {
  const aniso = Math.max(1, Math.min(8, maxAnisotropy || 4));
  const rand = seededRand(90210);
  const allTextures: THREE.CanvasTexture[] = [];

  // 1. Haunted Crimson & Charcoal Damask Wallpaper
  const [wpC, wpCtx] = makeCanvas(512, 512);
  const [wpBC, wpBCtx] = makeCanvas(512, 512);
  wpCtx.fillStyle = '#331217';
  wpCtx.fillRect(0, 0, 512, 512);
  wpBCtx.fillStyle = '#686868';
  wpBCtx.fillRect(0, 0, 512, 512);

  // Vertical faded Victorian stripes
  for (let x = 0; x < 512; x += 64) {
    wpCtx.fillStyle = 'rgba(20, 6, 9, 0.42)';
    wpCtx.fillRect(x, 0, 26, 512);
    wpBCtx.fillStyle = 'rgba(130, 130, 130, 0.35)';
    wpBCtx.fillRect(x, 0, 26, 512);
  }

  // Ornate damask medallions
  const drawDamask = (ctx: CanvasRenderingContext2D, color: string, x: number, y: number) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, -44);
    ctx.bezierCurveTo(28, -22, 32, 16, 0, 46);
    ctx.bezierCurveTo(-32, 16, -28, -22, 0, -44);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(0, 0, 10, 0, Math.PI * 2);
    ctx.fill();

    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(s * 12, -8);
      ctx.quadraticCurveTo(s * 36, -28, s * 28, 6);
      ctx.quadraticCurveTo(s * 34, 28, s * 10, 18);
      ctx.stroke();
    }
    ctx.restore();
  };

  for (let gy = 0; gy < 512; gy += 128) {
    for (let gx = 0; gx < 512; gx += 128) {
      drawDamask(wpCtx, 'rgba(92, 24, 34, 0.65)', gx + 64, gy + 64);
      drawDamask(wpCtx, 'rgba(92, 24, 34, 0.45)', gx, gy);
      drawDamask(wpBCtx, 'rgba(210, 210, 210, 0.6)', gx + 64, gy + 64);
    }
  }

  // Aged grime, water stains & peeling wear
  for (let i = 0; i < 420; i++) {
    const x = rand() * 512;
    const y = rand() * 512;
    const r = 4 + rand() * 24;
    const g = wpCtx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(10, 6, 8, ${0.08 + rand() * 0.14})`);
    g.addColorStop(1, 'rgba(10, 6, 8, 0)');
    wpCtx.fillStyle = g;
    wpCtx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // Dark oak wainscoting on lower 28%
  wpCtx.fillStyle = '#1c120d';
  wpCtx.fillRect(0, 368, 512, 144);
  wpCtx.fillStyle = '#2c1c14';
  wpCtx.fillRect(0, 368, 512, 12);
  for (let px = 8; px < 512; px += 64) {
    wpCtx.strokeStyle = '#0e0806';
    wpCtx.lineWidth = 4;
    wpCtx.strokeRect(px, 392, 48, 102);
    wpBCtx.fillStyle = '#a5a5a5';
    wpBCtx.fillRect(px, 392, 48, 102);
  }

  const wallpaperMap = makeTexture(wpC, aniso, 1, 1, true);
  const wallpaperBump = makeTexture(wpBC, aniso, 1, 1, false);
  allTextures.push(wallpaperMap, wallpaperBump);

  // 2. Vintage Creepy Geometric Hotel Carpet (Overlook-style worn hexagon pattern)
  const [cpC, cpCtx] = makeCanvas(512, 512);
  const [cpBC, cpBCtx] = makeCanvas(512, 512);
  cpCtx.fillStyle = '#4e1318';
  cpCtx.fillRect(0, 0, 512, 512);
  cpBCtx.fillStyle = '#707070';
  cpBCtx.fillRect(0, 0, 512, 512);

  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      const cx = col * 128 + 64;
      const cy = row * 128 + 64;
      // Amber-orange outer frame
      cpCtx.strokeStyle = '#a1461b';
      cpCtx.lineWidth = 14;
      cpCtx.beginPath();
      cpCtx.moveTo(cx, cy - 48);
      cpCtx.lineTo(cx + 42, cy - 22);
      cpCtx.lineTo(cx + 42, cy + 22);
      cpCtx.lineTo(cx, cy + 48);
      cpCtx.lineTo(cx - 42, cy + 22);
      cpCtx.lineTo(cx - 42, cy - 22);
      cpCtx.closePath();
      cpCtx.stroke();

      // Dark obsidian inner core
      cpCtx.fillStyle = '#240b0e';
      cpCtx.beginPath();
      cpCtx.moveTo(cx, cy - 24);
      cpCtx.lineTo(cx + 22, cy - 11);
      cpCtx.lineTo(cx + 22, cy + 11);
      cpCtx.lineTo(cx, cy + 24);
      cpCtx.lineTo(cx - 22, cy + 11);
      cpCtx.lineTo(cx - 22, cy - 11);
      cpCtx.closePath();
      cpCtx.fill();

      cpBCtx.strokeStyle = '#c8c8c8';
      cpBCtx.lineWidth = 10;
      cpBCtx.strokeRect(col * 128 + 18, row * 128 + 18, 92, 92);
    }
  }
  // Carpet weave grain & worn dark traffic stains
  for (let i = 0; i < 4000; i++) {
    const x = rand() * 512;
    const y = rand() * 512;
    const dark = rand() > 0.5;
    cpCtx.fillStyle = dark ? 'rgba(0,0,0,0.16)' : 'rgba(255,200,160,0.06)';
    cpCtx.fillRect(x, y, 2, 2);
    cpBCtx.fillStyle = dark ? '#555555' : '#969696';
    cpBCtx.fillRect(x, y, 2, 2);
  }

  const carpetMap = makeTexture(cpC, aniso, 2, 2, true);
  const carpetBump = makeTexture(cpBC, aniso, 2, 2, false);
  allTextures.push(carpetMap, carpetBump);

  // 3. Aged Dark Oak Wood Planks
  const [wdC, wdCtx] = makeCanvas(512, 512);
  const [wdBC, wdBCtx] = makeCanvas(512, 512);
  wdCtx.fillStyle = '#362116';
  wdCtx.fillRect(0, 0, 512, 512);
  wdBCtx.fillStyle = '#909090';
  wdBCtx.fillRect(0, 0, 512, 512);

  for (let p = 0; p < 8; p++) {
    const y = p * 64;
    const shade = Math.floor((rand() - 0.5) * 18);
    wdCtx.fillStyle = `rgb(${54 + shade}, ${32 + shade}, ${21 + Math.floor(shade * 0.6)})`;
    wdCtx.fillRect(0, y + 2, 512, 60);
    // Plank seam
    wdCtx.fillStyle = '#120a06';
    wdCtx.fillRect(0, y, 512, 3);
    wdBCtx.fillStyle = '#202020';
    wdBCtx.fillRect(0, y, 512, 3);
    // Wood grain lines
    for (let g = 0; g < 18; g++) {
      const gy = y + 4 + rand() * 56;
      wdCtx.strokeStyle = rand() > 0.5 ? 'rgba(20,10,6,0.35)' : 'rgba(96,62,40,0.22)';
      wdCtx.lineWidth = 1 + rand() * 1.5;
      wdCtx.beginPath();
      wdCtx.moveTo(0, gy);
      wdCtx.bezierCurveTo(160, gy + (rand() - 0.5) * 8, 340, gy + (rand() - 0.5) * 8, 512, gy);
      wdCtx.stroke();
    }
  }
  const woodMap = makeTexture(wdC, aniso, 1, 1, true);
  const woodBump = makeTexture(wdBC, aniso, 1, 1, false);
  allTextures.push(woodMap, woodBump);

  // 4. Moody Veined Dark Lobby Marble
  const [mbC, mbCtx] = makeCanvas(512, 512);
  mbCtx.fillStyle = '#1f2329';
  mbCtx.fillRect(0, 0, 512, 512);
  for (let ty = 0; ty < 4; ty++) {
    for (let tx = 0; tx < 4; tx++) {
      const alt = (tx + ty) % 2 === 0;
      mbCtx.fillStyle = alt ? '#232830' : '#181b21';
      mbCtx.fillRect(tx * 128 + 2, ty * 128 + 2, 124, 124);
    }
  }
  for (let v = 0; v < 42; v++) {
    mbCtx.strokeStyle = `rgba(180, 175, 165, ${0.06 + rand() * 0.14})`;
    mbCtx.lineWidth = 1 + rand() * 2;
    mbCtx.beginPath();
    let vx = rand() * 512;
    let vy = rand() * 512;
    mbCtx.moveTo(vx, vy);
    for (let s = 0; s < 5; s++) {
      vx += (rand() - 0.5) * 140;
      vy += (rand() - 0.5) * 140;
      mbCtx.lineTo(vx, vy);
    }
    mbCtx.stroke();
  }
  const marbleMap = makeTexture(mbC, aniso, 2, 2, true);
  allTextures.push(marbleMap);

  // 5. Weathered Maze Stone & Mossy Hedge Masonry
  const [stC, stCtx] = makeCanvas(512, 512);
  const [stBC, stBCtx] = makeCanvas(512, 512);
  stCtx.fillStyle = '#25292c';
  stCtx.fillRect(0, 0, 512, 512);
  stBCtx.fillStyle = '#383838';
  stBCtx.fillRect(0, 0, 512, 512);

  for (let row = 0; row < 8; row++) {
    const offset = (row % 2) * 42;
    for (let col = -1; col < 7; col++) {
      const bx = col * 84 + offset + 3;
      const by = row * 64 + 3;
      const v = 38 + Math.floor(rand() * 26);
      stCtx.fillStyle = `rgb(${v}, ${v + 3}, ${v + 4})`;
      stCtx.fillRect(bx, by, 78, 58);
      stBCtx.fillStyle = `rgb(${120 + Math.floor(rand() * 70)}, ${120 + Math.floor(rand() * 70)}, ${120 + Math.floor(rand() * 70)})`;
      stBCtx.fillRect(bx, by, 78, 58);

      if (rand() < 0.34) {
        stCtx.fillStyle = 'rgba(32, 54, 34, 0.45)';
        stCtx.fillRect(bx + rand() * 20, by + rand() * 20, 26, 20);
      }
    }
  }
  const stoneMap = makeTexture(stC, aniso, 1, 1, true);
  const stoneBump = makeTexture(stBC, aniso, 1, 1, false);
  allTextures.push(stoneMap, stoneBump);

  // 6. Cracked Coffered Ceiling Plaster
  const [clC, clCtx] = makeCanvas(512, 512);
  clCtx.fillStyle = '#241f1c';
  clCtx.fillRect(0, 0, 512, 512);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      clCtx.strokeStyle = '#15110f';
      clCtx.lineWidth = 8;
      clCtx.strokeRect(x * 128 + 6, y * 128 + 6, 116, 116);
      clCtx.strokeStyle = '#38302a';
      clCtx.lineWidth = 2;
      clCtx.strokeRect(x * 128 + 16, y * 128 + 16, 96, 96);
    }
  }
  for (let i = 0; i < 80; i++) {
    clCtx.strokeStyle = 'rgba(8,6,6,0.45)';
    clCtx.lineWidth = 1;
    clCtx.beginPath();
    const sx = rand() * 512;
    const sy = rand() * 512;
    clCtx.moveTo(sx, sy);
    clCtx.lineTo(sx + (rand() - 0.5) * 90, sy + (rand() - 0.5) * 90);
    clCtx.stroke();
  }
  const ceilingMap = makeTexture(clC, aniso, 2, 2, true);
  allTextures.push(ceilingMap);

  // 7. Velvet Upholstery Fabric
  const [fbC, fbCtx] = makeCanvas(256, 256);
  fbCtx.fillStyle = '#4c141c';
  fbCtx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 1600; i++) {
    fbCtx.fillStyle = rand() > 0.5 ? 'rgba(0,0,0,0.18)' : 'rgba(140,40,55,0.12)';
    fbCtx.fillRect(rand() * 256, rand() * 256, 2, 2);
  }
  const fabricMap = makeTexture(fbC, aniso, 1, 1, true);
  allTextures.push(fabricMap);

  // 8. Three Eerie Vintage Hotel Wall Portraits
  const portraitMaps: THREE.CanvasTexture[] = [];
  const themes = [
    { bg: '#191417', coat: '#2b1b1e', face: '#8d7d73', eyeGlow: '#b91c1c' },
    { bg: '#12181c', coat: '#1e272e', face: '#7f837a', eyeGlow: '#d97706' },
    { bg: '#1b1713', coat: '#2f2419', face: '#8a7a6c', eyeGlow: '#991b1b' },
  ];
  for (const t of themes) {
    const [pC, pCtx] = makeCanvas(256, 320);
    pCtx.fillStyle = t.bg;
    pCtx.fillRect(0, 0, 256, 320);
    // Vignette
    const vg = pCtx.createRadialGradient(128, 130, 20, 128, 160, 160);
    vg.addColorStop(0, 'rgba(60, 50, 45, 0.25)');
    vg.addColorStop(1, 'rgba(0, 0, 0, 0.85)');
    pCtx.fillStyle = vg;
    pCtx.fillRect(0, 0, 256, 320);
    // Silhouette shoulders
    pCtx.fillStyle = t.coat;
    pCtx.beginPath();
    pCtx.ellipse(128, 290, 82, 95, 0, Math.PI, Math.PI * 2);
    pCtx.fill();
    // Pale gaunt face
    pCtx.fillStyle = t.face;
    pCtx.beginPath();
    pCtx.ellipse(128, 126, 36, 48, 0, 0, Math.PI * 2);
    pCtx.fill();
    // Hollow dark sockets + faint eerie pinprick eyes
    pCtx.fillStyle = '#090707';
    pCtx.beginPath();
    pCtx.ellipse(112, 120, 8, 6, 0, 0, Math.PI * 2);
    pCtx.ellipse(144, 120, 8, 6, 0, 0, Math.PI * 2);
    pCtx.fill();
    pCtx.fillStyle = t.eyeGlow;
    pCtx.fillRect(111, 119, 3, 3);
    pCtx.fillRect(143, 119, 3, 3);
    // Aged frame inner border
    pCtx.strokeStyle = '#5c4322';
    pCtx.lineWidth = 10;
    pCtx.strokeRect(5, 5, 246, 310);

    const pt = makeTexture(pC, aniso, 1, 1, true);
    portraitMaps.push(pt);
    allTextures.push(pt);
  }

  return {
    wallpaperMap,
    wallpaperBump,
    carpetMap,
    carpetBump,
    woodMap,
    woodBump,
    marbleMap,
    stoneMap,
    stoneBump,
    ceilingMap,
    fabricMap,
    portraitMaps,
    dispose: () => {
      for (const tex of allTextures) {
        tex.dispose();
      }
    },
  };
}
