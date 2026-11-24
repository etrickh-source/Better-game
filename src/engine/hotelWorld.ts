import * as THREE from 'three';
import { createHotelTextures, HotelTextureSet } from './hotelTextures';

export interface ColliderBox {
  id: number;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  isGate?: boolean;
  lastStamp?: number;
}

export interface WorldCollider {
  resolveSphere(
    center: THREE.Vector3,
    radius: number,
    outCenter: THREE.Vector3,
    outNormal: THREE.Vector3
  ): boolean;
  isPointSolid(wx: number, wy: number, wz: number): boolean;
  getFloorHeightAt(wx: number, wz: number): number;
}

const GRID_CELL = 4;
const WALL_H = 4.6;
const FLOOR2_Y = 4.6;
const ROOF_Y = 9.4;

function cellKey(gx: number, gz: number): string {
  return `${gx},${gz}`;
}

export class HotelWorld implements WorldCollider {
  public readonly group = new THREE.Group();
  public readonly gateBarrierGroup = new THREE.Group();
  public readonly chandelierGroup = new THREE.Group();
  public readonly textures: HotelTextureSet;

  private readonly colliders: ColliderBox[] = [];
  private readonly gateColliders: ColliderBox[] = [];
  private readonly grid = new Map<string, ColliderBox[]>();
  private readonly safeSpots: THREE.Vector3[] = [];
  private readonly lobbySpawns: THREE.Vector3[] = [];
  private readonly innocentSpawns: THREE.Vector3[] = [];
  private readonly flickeringLights: Array<{ light: THREE.PointLight; baseIntensity: number; phase: number }> = [];
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly castShadows: boolean;

  private testStamp = 1;
  private gatesLocked = false;

  // Shared PBR Materials
  private readonly wallpaperMat: THREE.MeshStandardMaterial;
  private readonly carpetMat: THREE.MeshStandardMaterial;
  private readonly woodMat: THREE.MeshStandardMaterial;
  private readonly darkWoodMat: THREE.MeshStandardMaterial;
  private readonly marbleMat: THREE.MeshStandardMaterial;
  private readonly stoneMat: THREE.MeshStandardMaterial;
  private readonly ceilingMat: THREE.MeshStandardMaterial;
  private readonly velvetMat: THREE.MeshStandardMaterial;
  private readonly brassMat: THREE.MeshStandardMaterial;
  private readonly ironMat: THREE.MeshStandardMaterial;
  private readonly beddingMat: THREE.MeshStandardMaterial;
  private readonly bulbMat: THREE.MeshStandardMaterial;
  private readonly gateMat: THREE.MeshStandardMaterial;

  constructor(maxAnisotropy: number, castShadows: boolean) {
    this.group.name = 'HauntedHotelWorld';
    this.castShadows = castShadows;
    this.textures = createHotelTextures(maxAnisotropy);

    this.wallpaperMat = new THREE.MeshStandardMaterial({
      map: this.textures.wallpaperMap,
      bumpMap: this.textures.wallpaperBump,
      bumpScale: 0.03,
      roughness: 0.86,
      metalness: 0.02,
    });
    this.carpetMat = new THREE.MeshStandardMaterial({
      map: this.textures.carpetMap,
      bumpMap: this.textures.carpetBump,
      bumpScale: 0.025,
      roughness: 0.94,
      metalness: 0.0,
    });
    this.woodMat = new THREE.MeshStandardMaterial({
      map: this.textures.woodMap,
      bumpMap: this.textures.woodBump,
      bumpScale: 0.02,
      roughness: 0.68,
      metalness: 0.05,
    });
    this.darkWoodMat = new THREE.MeshStandardMaterial({
      map: this.textures.woodMap,
      color: 0x7a5c4b,
      roughness: 0.58,
      metalness: 0.06,
    });
    this.marbleMat = new THREE.MeshStandardMaterial({
      map: this.textures.marbleMap,
      roughness: 0.28,
      metalness: 0.08,
    });
    this.stoneMat = new THREE.MeshStandardMaterial({
      map: this.textures.stoneMap,
      bumpMap: this.textures.stoneBump,
      bumpScale: 0.05,
      roughness: 0.92,
      metalness: 0.03,
    });
    this.ceilingMat = new THREE.MeshStandardMaterial({
      map: this.textures.ceilingMap,
      roughness: 0.9,
      metalness: 0.02,
    });
    this.velvetMat = new THREE.MeshStandardMaterial({
      map: this.textures.fabricMap,
      roughness: 0.9,
      metalness: 0.0,
    });
    this.brassMat = new THREE.MeshStandardMaterial({
      color: 0xb78b3e,
      roughness: 0.34,
      metalness: 0.86,
    });
    this.ironMat = new THREE.MeshStandardMaterial({
      color: 0x1a1d22,
      roughness: 0.48,
      metalness: 0.78,
    });
    this.beddingMat = new THREE.MeshStandardMaterial({
      color: 0xc2b8a3,
      roughness: 0.92,
      metalness: 0.0,
    });
    this.bulbMat = new THREE.MeshStandardMaterial({
      color: 0xffd79b,
      emissive: 0xffa94d,
      emissiveIntensity: 1.85,
      roughness: 0.3,
    });
    this.gateMat = new THREE.MeshStandardMaterial({
      color: 0x991b1b,
      emissive: 0x7f1d1d,
      emissiveIntensity: 0.75,
      transparent: true,
      opacity: 0.48,
      roughness: 0.35,
    });

    this.materials.push(
      this.wallpaperMat,
      this.carpetMat,
      this.woodMat,
      this.darkWoodMat,
      this.marbleMat,
      this.stoneMat,
      this.ceilingMat,
      this.velvetMat,
      this.brassMat,
      this.ironMat,
      this.beddingMat,
      this.bulbMat,
      this.gateMat
    );

    this.buildEntireHotel();
  }

  private addCollider(
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
    isGate = false
  ): ColliderBox {
    const box: ColliderBox = {
      id: this.colliders.length + 1,
      minX: Math.min(minX, maxX),
      minY: Math.min(minY, maxY),
      minZ: Math.min(minZ, maxZ),
      maxX: Math.max(minX, maxX),
      maxY: Math.max(minY, maxY),
      maxZ: Math.max(minZ, maxZ),
      isGate,
    };
    this.colliders.push(box);
    if (isGate) this.gateColliders.push(box);

    const gx0 = Math.floor(box.minX / GRID_CELL);
    const gx1 = Math.floor(box.maxX / GRID_CELL);
    const gz0 = Math.floor(box.minZ / GRID_CELL);
    const gz1 = Math.floor(box.maxZ / GRID_CELL);
    for (let gz = gz0; gz <= gz1; gz++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const k = cellKey(gx, gz);
        let bucket = this.grid.get(k);
        if (!bucket) {
          bucket = [];
          this.grid.set(k, bucket);
        }
        bucket.push(box);
      }
    }
    return box;
  }

  private addBox(
    cx: number,
    cy: number,
    cz: number,
    w: number,
    h: number,
    d: number,
    mat: THREE.Material,
    collide = true,
    castShadow = false,
    parent: THREE.Object3D = this.group
  ): THREE.Mesh {
    const geo = new THREE.BoxGeometry(w, h, d);
    this.geometries.push(geo);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(cx, cy, cz);
    mesh.castShadow = castShadow && this.castShadows;
    mesh.receiveShadow = true;
    parent.add(mesh);

    if (collide) {
      this.addCollider(cx - w / 2, cy - h / 2, cz - d / 2, cx + w / 2, cy + h / 2, cz + d / 2);
    }
    return mesh;
  }

  private addWallSegment(
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    baseY: number,
    height: number,
    thickness: number,
    mat: THREE.Material,
    hasDoorway = false
  ): void {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    if (len < 0.05) return;
    const cx = (x0 + x1) * 0.5;
    const cz = (z0 + z1) * 0.5;
    const isAlongX = Math.abs(dx) >= Math.abs(dz);

    if (!hasDoorway || len < 3.4) {
      const w = isAlongX ? len : thickness;
      const d = isAlongX ? thickness : len;
      this.addBox(cx, baseY + height / 2, cz, w, height, d, mat, true, false);
      return;
    }

    // Wall with dark oak trimmed doorway (2.4m wide x 3.1m tall)
    const doorW = 2.4;
    const doorH = 3.1;
    const sideLen = (len - doorW) * 0.5;

    if (isAlongX) {
      const sign = dx >= 0 ? 1 : -1;
      const leftCx = x0 + sign * (sideLen * 0.5);
      const rightCx = x1 - sign * (sideLen * 0.5);
      this.addBox(leftCx, baseY + height / 2, cz, sideLen, height, thickness, mat, true, false);
      this.addBox(rightCx, baseY + height / 2, cz, sideLen, height, thickness, mat, true, false);
      // Lintel above door
      this.addBox(cx, baseY + doorH + (height - doorH) / 2, cz, doorW, height - doorH, thickness, mat, true, false);
      // Dark oak door jambs & header trim
      this.addBox(cx - doorW / 2 + 0.08, baseY + doorH / 2, cz, 0.16, doorH, thickness + 0.08, this.darkWoodMat, false);
      this.addBox(cx + doorW / 2 - 0.08, baseY + doorH / 2, cz, 0.16, doorH, thickness + 0.08, this.darkWoodMat, false);
      this.addBox(cx, baseY + doorH + 0.08, cz, doorW + 0.16, 0.16, thickness + 0.08, this.darkWoodMat, false);
    } else {
      const sign = dz >= 0 ? 1 : -1;
      const topCz = z0 + sign * (sideLen * 0.5);
      const botCz = z1 - sign * (sideLen * 0.5);
      this.addBox(cx, baseY + height / 2, topCz, thickness, height, sideLen, mat, true, false);
      this.addBox(cx, baseY + height / 2, botCz, thickness, height, sideLen, mat, true, false);
      this.addBox(cx, baseY + doorH + (height - doorH) / 2, cz, thickness, height - doorH, doorW, mat, true, false);
      this.addBox(cx, baseY + doorH / 2, cz - doorW / 2 + 0.08, thickness + 0.08, doorH, 0.16, this.darkWoodMat, false);
      this.addBox(cx, baseY + doorH / 2, cz + doorW / 2 - 0.08, thickness + 0.08, doorH, 0.16, this.darkWoodMat, false);
      this.addBox(cx, baseY + doorH + 0.08, cz, thickness + 0.08, 0.16, doorW + 0.16, this.darkWoodMat, false);
    }
  }

  private addStaircase(
    startX: number,
    startY: number,
    startZ: number,
    dirX: number,
    dirZ: number,
    width: number,
    totalRise: number,
    totalRun: number,
    steps: number
  ): void {
    const stepH = totalRise / steps;
    const stepRun = totalRun / steps;
    const alongX = Math.abs(dirX) > Math.abs(dirZ);

    for (let i = 0; i < steps; i++) {
      const progress = i + 0.5;
      const yTop = startY + (i + 1) * stepH;
      const cx = startX + dirX * progress * stepRun;
      const cz = startZ + dirZ * progress * stepRun;
      const w = alongX ? stepRun + 0.06 : width;
      const d = alongX ? width : stepRun + 0.06;
      const h = (i + 1) * stepH;
      this.addBox(cx, startY + h * 0.5, cz, w, h, d, this.darkWoodMat, true, false);
      // Crimson stair runner strip
      this.addBox(
        cx,
        yTop + 0.015,
        cz,
        alongX ? stepRun * 0.9 : width * 0.58,
        0.03,
        alongX ? width * 0.58 : stepRun * 0.9,
        this.carpetMat,
        false
      );
    }
  }

  private addWallSconce(x: number, y: number, z: number, nx: number, nz: number, withLight = false): void {
    const sconce = new THREE.Group();
    sconce.position.set(x, y, z);

    const plateGeo = new THREE.BoxGeometry(0.16, 0.28, 0.04);
    const armGeo = new THREE.CylinderGeometry(0.02, 0.025, 0.22, 8);
    const shadeGeo = new THREE.CylinderGeometry(0.08, 0.05, 0.16, 10);
    const bulbGeo = new THREE.SphereGeometry(0.045, 8, 8);
    this.geometries.push(plateGeo, armGeo, shadeGeo, bulbGeo);

    const plate = new THREE.Mesh(plateGeo, this.brassMat);
    const arm = new THREE.Mesh(armGeo, this.brassMat);
    arm.rotation.x = Math.PI / 2;
    arm.position.set(0, -0.02, 0.11);
    const shade = new THREE.Mesh(shadeGeo, this.bulbMat);
    shade.position.set(0, 0.09, 0.18);
    const bulb = new THREE.Mesh(bulbGeo, this.bulbMat);
    bulb.position.set(0, 0.16, 0.18);

    sconce.add(plate, arm, shade, bulb);
    sconce.rotation.y = Math.atan2(nx, nz);
    this.group.add(sconce);

    if (withLight) {
      const pt = new THREE.PointLight(0xffa45b, 4.2, 16, 1.8);
      pt.position.set(x + nx * 0.35, y + 0.1, z + nz * 0.35);
      this.group.add(pt);
      this.flickeringLights.push({
        light: pt,
        baseIntensity: 4.2,
        phase: (x * 1.7 + z * 2.3) % 10,
      });
    }
  }

  private addReceptionDesk(cx: number, y: number, cz: number): void {
    // 5-part composite mahogany & brass hotel check-in desk
    this.addBox(cx, y + 0.56, cz, 5.4, 1.12, 1.05, this.darkWoodMat, true, true);
    this.addBox(cx, y + 1.15, cz, 5.7, 0.09, 1.25, this.marbleMat, true, false);
    // Brass front trim bar & bell
    this.addBox(cx, y + 0.16, cz + 0.55, 5.45, 0.08, 0.06, this.brassMat, false);
    const bellGeo = new THREE.CylinderGeometry(0.05, 0.09, 0.07, 12);
    const ledgerGeo = new THREE.BoxGeometry(0.45, 0.05, 0.34);
    this.geometries.push(bellGeo, ledgerGeo);
    const bell = new THREE.Mesh(bellGeo, this.brassMat);
    bell.position.set(cx + 1.1, y + 1.23, cz + 0.2);
    const ledger = new THREE.Mesh(ledgerGeo, this.velvetMat);
    ledger.position.set(cx - 0.5, y + 1.22, cz + 0.15);
    this.group.add(bell, ledger);
  }

  private addGrandChandelier(cx: number, ceilingY: number, cz: number): void {
    this.chandelierGroup.position.set(cx, ceilingY, cz);
    const chainGeo = new THREE.CylinderGeometry(0.04, 0.04, 1.5, 8);
    const hubGeo = new THREE.CylinderGeometry(0.18, 0.28, 0.65, 12);
    const ringLargeGeo = new THREE.TorusGeometry(1.45, 0.055, 8, 28);
    const ringSmallGeo = new THREE.TorusGeometry(0.85, 0.04, 8, 22);
    const candleGeo = new THREE.CylinderGeometry(0.035, 0.04, 0.22, 8);
    const flameGeo = new THREE.SphereGeometry(0.055, 8, 8);
    this.geometries.push(chainGeo, hubGeo, ringLargeGeo, ringSmallGeo, candleGeo, flameGeo);

    const chain = new THREE.Mesh(chainGeo, this.brassMat);
    chain.position.y = -0.75;
    const hub = new THREE.Mesh(hubGeo, this.brassMat);
    hub.position.y = -1.65;

    const ring1 = new THREE.Mesh(ringLargeGeo, this.brassMat);
    ring1.rotation.x = Math.PI / 2;
    ring1.position.y = -1.9;

    const ring2 = new THREE.Mesh(ringSmallGeo, this.brassMat);
    ring2.rotation.x = Math.PI / 2;
    ring2.position.y = -1.42;

    this.chandelierGroup.add(chain, hub, ring1, ring2);

    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const rx = Math.cos(a) * 1.45;
      const rz = Math.sin(a) * 1.45;
      const candle = new THREE.Mesh(candleGeo, this.beddingMat);
      candle.position.set(rx, -1.75, rz);
      const flame = new THREE.Mesh(flameGeo, this.bulbMat);
      flame.position.set(rx, -1.61, rz);
      this.chandelierGroup.add(candle, flame);
    }

    const chLight = new THREE.PointLight(0xffb46b, 14, 28, 1.4);
    chLight.position.set(0, -2.0, 0);
    this.chandelierGroup.add(chLight);
    this.flickeringLights.push({ light: chLight, baseIntensity: 14, phase: 1.5 });

    this.group.add(this.chandelierGroup);
  }

  private addFourPosterBed(cx: number, y: number, cz: number, rotY = 0): void {
    const bed = new THREE.Group();
    bed.position.set(cx, y, cz);
    bed.rotation.y = rotY;
    this.group.add(bed);

    // Bed frame + mattress + pillows + 4 tall carved posts
    const frameGeo = new THREE.BoxGeometry(1.75, 0.34, 2.35);
    const mattressGeo = new THREE.BoxGeometry(1.62, 0.28, 2.22);
    const blanketGeo = new THREE.BoxGeometry(1.66, 0.14, 1.45);
    const pillowGeo = new THREE.BoxGeometry(0.62, 0.14, 0.38);
    const postGeo = new THREE.CylinderGeometry(0.055, 0.065, 2.15, 8);
    const headGeo = new THREE.BoxGeometry(1.78, 1.35, 0.1);
    this.geometries.push(frameGeo, mattressGeo, blanketGeo, pillowGeo, postGeo, headGeo);

    const frame = new THREE.Mesh(frameGeo, this.darkWoodMat);
    frame.position.set(0, 0.25, 0);
    const mattress = new THREE.Mesh(mattressGeo, this.beddingMat);
    mattress.position.set(0, 0.54, 0);
    const blanket = new THREE.Mesh(blanketGeo, this.velvetMat);
    blanket.position.set(0, 0.64, 0.38);
    const p1 = new THREE.Mesh(pillowGeo, this.beddingMat);
    p1.position.set(-0.42, 0.72, -0.78);
    const p2 = new THREE.Mesh(pillowGeo, this.beddingMat);
    p2.position.set(0.42, 0.72, -0.78);
    const headboard = new THREE.Mesh(headGeo, this.darkWoodMat);
    headboard.position.set(0, 0.85, -1.14);

    bed.add(frame, mattress, blanket, p1, p2, headboard);
    for (const sx of [-0.82, 0.82]) {
      for (const sz of [-1.12, 1.12]) {
        const post = new THREE.Mesh(postGeo, this.darkWoodMat);
        post.position.set(sx, 1.075, sz);
        bed.add(post);
      }
    }

    // World AABB approximation for bed collision
    const hw = Math.abs(Math.cos(rotY)) * 0.9 + Math.abs(Math.sin(rotY)) * 1.2;
    const hd = Math.abs(Math.sin(rotY)) * 0.9 + Math.abs(Math.cos(rotY)) * 1.2;
    this.addCollider(cx - hw, y, cz - hd, cx + hw, y + 0.85, cz + hd);
  }

  private addVictorianArmchair(cx: number, y: number, cz: number, rotY = 0): void {
    const chair = new THREE.Group();
    chair.position.set(cx, y, cz);
    chair.rotation.y = rotY;
    this.group.add(chair);

    const seatGeo = new THREE.BoxGeometry(0.84, 0.38, 0.82);
    const backGeo = new THREE.BoxGeometry(0.84, 0.78, 0.18);
    const armGeo = new THREE.BoxGeometry(0.16, 0.42, 0.8);
    const legGeo = new THREE.CylinderGeometry(0.035, 0.025, 0.22, 6);
    this.geometries.push(seatGeo, backGeo, armGeo, legGeo);

    const seat = new THREE.Mesh(seatGeo, this.velvetMat);
    seat.position.set(0, 0.35, 0);
    const back = new THREE.Mesh(backGeo, this.velvetMat);
    back.position.set(0, 0.78, -0.32);
    const armL = new THREE.Mesh(armGeo, this.velvetMat);
    armL.position.set(-0.36, 0.56, 0);
    const armR = new THREE.Mesh(armGeo, this.velvetMat);
    armR.position.set(0.36, 0.56, 0);
    chair.add(seat, back, armL, armR);

    for (const sx of [-0.34, 0.34]) {
      for (const sz of [-0.32, 0.32]) {
        const leg = new THREE.Mesh(legGeo, this.darkWoodMat);
        leg.position.set(sx, 0.11, sz);
        chair.add(leg);
      }
    }
    this.addCollider(cx - 0.45, y, cz - 0.45, cx + 0.45, y + 0.95, cz + 0.45);
  }

  private addWardrobe(cx: number, y: number, cz: number, rotY = 0): void {
    const g = new THREE.Group();
    g.position.set(cx, y, cz);
    g.rotation.y = rotY;
    this.group.add(g);

    const bodyGeo = new THREE.BoxGeometry(1.45, 2.55, 0.74);
    const crownGeo = new THREE.BoxGeometry(1.58, 0.16, 0.84);
    const doorSplitGeo = new THREE.BoxGeometry(0.04, 2.25, 0.04);
    const knobGeo = new THREE.SphereGeometry(0.035, 8, 8);
    this.geometries.push(bodyGeo, crownGeo, doorSplitGeo, knobGeo);

    const body = new THREE.Mesh(bodyGeo, this.darkWoodMat);
    body.position.y = 1.28;
    const crown = new THREE.Mesh(crownGeo, this.woodMat);
    crown.position.y = 2.6;
    const split = new THREE.Mesh(doorSplitGeo, this.ironMat);
    split.position.set(0, 1.25, 0.37);
    const k1 = new THREE.Mesh(knobGeo, this.brassMat);
    k1.position.set(-0.1, 1.2, 0.4);
    const k2 = new THREE.Mesh(knobGeo, this.brassMat);
    k2.position.set(0.1, 1.2, 0.4);
    g.add(body, crown, split, k1, k2);

    const hw = Math.abs(Math.cos(rotY)) * 0.74 + Math.abs(Math.sin(rotY)) * 0.4;
    const hd = Math.abs(Math.sin(rotY)) * 0.74 + Math.abs(Math.cos(rotY)) * 0.4;
    this.addCollider(cx - hw, y, cz - hd, cx + hw, y + 2.68, cz + hd);
  }

  private addGrandfatherClock(cx: number, y: number, cz: number, rotY = 0): void {
    const g = new THREE.Group();
    g.position.set(cx, y, cz);
    g.rotation.y = rotY;
    this.group.add(g);

    const baseGeo = new THREE.BoxGeometry(0.74, 0.55, 0.48);
    const trunkGeo = new THREE.BoxGeometry(0.56, 1.45, 0.38);
    const hoodGeo = new THREE.BoxGeometry(0.68, 0.56, 0.44);
    const faceGeo = new THREE.CylinderGeometry(0.18, 0.18, 0.04, 16);
    faceGeo.rotateX(Math.PI / 2);
    this.geometries.push(baseGeo, trunkGeo, hoodGeo, faceGeo);

    const base = new THREE.Mesh(baseGeo, this.darkWoodMat);
    base.position.y = 0.275;
    const trunk = new THREE.Mesh(trunkGeo, this.woodMat);
    trunk.position.y = 1.27;
    const hood = new THREE.Mesh(hoodGeo, this.darkWoodMat);
    hood.position.y = 2.25;
    const face = new THREE.Mesh(faceGeo, this.beddingMat);
    face.position.set(0, 2.25, 0.22);
    g.add(base, trunk, hood, face);

    this.addCollider(cx - 0.38, y, cz - 0.38, cx + 0.38, y + 2.55, cz + 0.38);
  }

  private addPortrait(cx: number, y: number, cz: number, rotY: number, idx: number): void {
    const tex = this.textures.portraitMaps[idx % this.textures.portraitMaps.length];
    const frameGeo = new THREE.BoxGeometry(1.16, 1.46, 0.08);
    const artGeo = new THREE.PlaneGeometry(0.96, 1.24);
    const artMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.72 });
    this.geometries.push(frameGeo, artGeo);
    this.materials.push(artMat);

    const p = new THREE.Group();
    p.position.set(cx, y, cz);
    p.rotation.y = rotY;
    const frame = new THREE.Mesh(frameGeo, this.brassMat);
    const art = new THREE.Mesh(artGeo, artMat);
    art.position.z = 0.046;
    p.add(frame, art);
    this.group.add(p);
  }

  private addBanquetTable(cx: number, y: number, cz: number, length = 8.0): void {
    this.addBox(cx, y + 0.78, cz, 1.9, 0.12, length, this.darkWoodMat, true, true);
    for (let z = -length * 0.4; z <= length * 0.4; z += length * 0.4) {
      this.addBox(cx - 0.65, y + 0.38, cz + z, 0.16, 0.76, 0.16, this.woodMat, false);
      this.addBox(cx + 0.65, y + 0.38, cz + z, 0.16, 0.76, 0.16, this.woodMat, false);
    }
    // Table candelabras
    for (const tz of [-length * 0.25, length * 0.25]) {
      const stemGeo = new THREE.CylinderGeometry(0.03, 0.09, 0.42, 10);
      const flameGeo = new THREE.SphereGeometry(0.05, 8, 8);
      this.geometries.push(stemGeo, flameGeo);
      const stem = new THREE.Mesh(stemGeo, this.brassMat);
      stem.position.set(cx, y + 1.05, cz + tz);
      const flame = new THREE.Mesh(flameGeo, this.bulbMat);
      flame.position.set(cx, y + 1.3, cz + tz);
      this.group.add(stem, flame);
    }
  }

  private buildEntireHotel(): void {
    // 1. Massive Exterior Grounds + Hotel Slabs (76m x 72m footprint centered slightly north)
    // Main Ground Floor Slab (x: [-38, 38], z: [-44, 26])
    this.addBox(0, -0.35, -9, 78, 0.7, 72, this.carpetMat, true, false);
    // Grand Lobby Veined Marble Inlay (flush-safe 0.025m above carpet)
    this.addBox(0, 0.02, 0, 23.6, 0.04, 23.6, this.marbleMat, false);

    // North Stone Maze Floor
    this.addBox(0, 0.015, -28, 48, 0.03, 30, this.stoneMat, false);

    // Full Hotel Roof Ceiling (y = ROOF_Y = 9.4)
    this.addBox(0, ROOF_Y + 0.3, -9, 78, 0.6, 72, this.ceilingMat, true, false);

    // Exterior Perimeter Walls (enclosing the entire haunted hotel!)
    this.addWallSegment(-38, 25, 38, 25, 0, ROOF_Y, 0.65, this.wallpaperMat, false);
    this.addWallSegment(-38, -43, 38, -43, 0, ROOF_Y, 0.65, this.stoneMat, false);
    this.addWallSegment(-38, -43, -38, 25, 0, ROOF_Y, 0.65, this.wallpaperMat, false);
    this.addWallSegment(38, -43, 38, 25, 0, ROOF_Y, 0.65, this.wallpaperMat, false);

    // 2. GRAND ATRIUM LOBBY (x: [-12, 12], z: [-12, 12], open two-story ceiling!)
    // Lobby 4 boundary walls with ornate doorways into East, West, North, and South Foyer
    this.addWallSegment(-12, -12, 12, -12, 0, WALL_H, 0.5, this.wallpaperMat, true); // North -> Hedge/Cellar Maze
    this.addWallSegment(-12, 12, 12, 12, 0, WALL_H, 0.5, this.wallpaperMat, false); // South Atrium Wall
    this.addWallSegment(-12, -12, -12, 12, 0, WALL_H, 0.5, this.wallpaperMat, true); // West -> Ballroom
    this.addWallSegment(12, -12, 12, 12, 0, WALL_H, 0.5, this.wallpaperMat, true); // East -> Guest Maze

    // Second-Floor Atrium Mezzanine Balcony ledges (y = 4.6)
    this.addBox(-10.2, FLOOR2_Y - 0.2, 0, 3.6, 0.4, 24, this.woodMat, true);
    this.addBox(10.2, FLOOR2_Y - 0.2, 0, 3.6, 0.4, 24, this.woodMat, true);
    this.addBox(0, FLOOR2_Y - 0.2, -10.2, 16.8, 0.4, 3.6, this.woodMat, true);
    this.addBox(0, FLOOR2_Y - 0.2, 10.2, 16.8, 0.4, 3.6, this.woodMat, true);

    // Mezzanine Guard Railings (low enough to jump/vault over in Gorilla Tag, sturdy visual!)
    this.addBox(-8.5, FLOOR2_Y + 0.52, -3.5, 0.16, 1.04, 10, this.darkWoodMat, true);
    this.addBox(-8.5, FLOOR2_Y + 0.52, 5.5, 0.16, 1.04, 7, this.darkWoodMat, true);
    this.addBox(8.5, FLOOR2_Y + 0.52, -3.5, 0.16, 1.04, 10, this.darkWoodMat, true);
    this.addBox(8.5, FLOOR2_Y + 0.52, 5.5, 0.16, 1.04, 7, this.darkWoodMat, true);
    this.addBox(0, FLOOR2_Y + 0.52, -8.5, 17, 1.04, 0.16, this.darkWoodMat, true);
    this.addBox(0, FLOOR2_Y + 0.52, 8.5, 17, 1.04, 0.16, this.darkWoodMat, true);

    // Lobby Corner Marble Pillars
    for (const px of [-8.5, 8.5]) {
      for (const pz of [-8.5, 8.5]) {
        this.addBox(px, ROOF_Y / 2, pz, 0.9, ROOF_Y, 0.9, this.marbleMat, true, true);
      }
    }

    // Grand Double Staircase: Rises from z=2 up to z=-3.2 landing, then splits Left & Right onto Mezzanine!
    this.addStaircase(0, 0, 2.2, 0, -1, 3.4, 2.3, 4.6, 10);
    this.addBox(0, 1.15, -4.4, 5.4, 2.3, 2.4, this.darkWoodMat, true);
    this.addStaircase(-2.7, 2.3, -4.4, -1, 0, 2.2, 2.3, 5.8, 10);
    this.addStaircase(2.7, 2.3, -4.4, 1, 0, 2.2, 2.3, 5.8, 10);

    // Lobby Furnishings & Spooky Chandelier
    this.addReceptionDesk(0, 0, -9.2);
    this.addGrandChandelier(0, ROOF_Y, 0);
    this.addVictorianArmchair(-5.8, 0, 6.5, Math.PI * 0.85);
    this.addVictorianArmchair(5.8, 0, 6.5, -Math.PI * 0.85);
    this.addGrandfatherClock(10.8, 0, 10.6, Math.PI);
    this.addPortrait(-5.5, 2.5, 11.6, Math.PI, 0);
    this.addPortrait(5.5, 2.5, 11.6, Math.PI, 1);
    this.addPortrait(0, 7.1, 11.6, Math.PI, 2);

    this.addWallSconce(-11.6, 2.7, -5.5, 1, 0, true);
    this.addWallSconce(11.6, 2.7, 5.5, -1, 0, true);
    this.addWallSconce(-5.5, 7.0, -11.6, 0, 1, false);
    this.addWallSconce(5.5, 7.0, -11.6, 0, 1, false);

    // Hiding-Phase Spectral Gates sealing Lobby exits for 15s head-start
    this.gateBarrierGroup.visible = false;
    const gateDefs = [
      { cx: 0, cz: -12, w: 2.5, d: 0.3 },
      { cx: -12, cz: 0, w: 0.3, d: 2.5 },
      { cx: 12, cz: 0, w: 0.3, d: 2.5 },
    ];
    for (const gd of gateDefs) {
      const m = this.addBox(gd.cx, 1.55, gd.cz, gd.w, 3.1, gd.d, this.gateMat, false, false, this.gateBarrierGroup);
      m.castShadow = false;
      const box = this.addCollider(
        gd.cx - gd.w / 2,
        0,
        gd.cz - gd.d / 2,
        gd.cx + gd.w / 2,
        3.1,
        gd.cz + gd.d / 2,
        true
      );
      void box;
    }
    this.group.add(this.gateBarrierGroup);

    // 3. EAST WING — HAUNTED CORRIDOR & ROOM MAZE (x: [12, 38], z: [-24, 25], Ground + 2nd Floor!)
    // Floor slab for 2nd floor East Wing (leaving stairwell cutouts at North-East & South-East)
    this.addBox(24, FLOOR2_Y - 0.2, 0, 24, 0.4, 34, this.carpetMat, true);
    this.addStaircase(35, 0, 23, 0, -1, 3.2, FLOOR2_Y, 8.5, 16);
    this.addStaircase(35, 0, -23, 0, 1, 3.2, FLOOR2_Y, 8.5, 16);

    // Ground & Upper Haunted Maze Walls (East Wing)
    for (const floorY of [0, FLOOR2_Y]) {
      // Main spooky central spine hallway dividers with staggered doorways & dead-ends
      this.addWallSegment(18, -22, 18, -8, floorY, WALL_H, 0.38, this.wallpaperMat, true);
      this.addWallSegment(18, -8, 18, 8, floorY, WALL_H, 0.38, this.wallpaperMat, true);
      this.addWallSegment(18, 8, 18, 22, floorY, WALL_H, 0.38, this.wallpaperMat, true);

      this.addWallSegment(25, -24, 25, -10, floorY, WALL_H, 0.38, this.wallpaperMat, true);
      this.addWallSegment(25, -10, 25, 4, floorY, WALL_H, 0.38, this.wallpaperMat, true);
      this.addWallSegment(25, 4, 25, 18, floorY, WALL_H, 0.38, this.wallpaperMat, true);

      this.addWallSegment(31.5, -16, 31.5, -2, floorY, WALL_H, 0.38, this.wallpaperMat, true);
      this.addWallSegment(31.5, -2, 31.5, 14, floorY, WALL_H, 0.38, this.wallpaperMat, true);

      // Cross walls creating maze loops, rooms & hiding alcoves
      this.addWallSegment(12, -14, 25, -14, floorY, WALL_H, 0.38, this.wallpaperMat, true);
      this.addWallSegment(18, -5, 31.5, -5, floorY, WALL_H, 0.38, this.wallpaperMat, true);
      this.addWallSegment(12, 6, 25, 6, floorY, WALL_H, 0.38, this.wallpaperMat, true);
      this.addWallSegment(25, 11, 38, 11, floorY, WALL_H, 0.38, this.wallpaperMat, true);
      this.addWallSegment(18, 17, 31.5, 17, floorY, WALL_H, 0.38, this.wallpaperMat, true);
      // Dead-end maze spurs
      this.addWallSegment(21.5, -14, 21.5, -9, floorY, WALL_H, 0.35, this.wallpaperMat, false);
      this.addWallSegment(28.2, 4, 28.2, 11, floorY, WALL_H, 0.35, this.wallpaperMat, false);

      // Furnished Hotel Rooms inside East Wing
      this.addFourPosterBed(15.2, floorY, -19.5, 0);
      this.addWardrobe(13.1, floorY, -16.2, Math.PI / 2);
      this.addFourPosterBed(28.5, floorY, -11.5, Math.PI / 2);
      this.addVictorianArmchair(21.5, floorY, 1.5, -Math.PI / 2);
      this.addWardrobe(21.5, floorY, 13.5, Math.PI);
      this.addFourPosterBed(15.2, floorY, 20.5, Math.PI);
      this.addPortrait(18.25, floorY + 2.3, -1.5, Math.PI / 2, 1);
      this.addPortrait(25.25, floorY + 2.3, 8.2, Math.PI / 2, 2);
    }

    this.addWallSconce(17.7, 2.5, 0, -1, 0, true);
    this.addWallSconce(25.3, 2.5, -16, 1, 0, true);
    this.addWallSconce(24.7, FLOOR2_Y + 2.5, 7, -1, 0, false);

    // 4. WEST WING — GRAND BALLROOM, BAR & SERVICE LABYRINTH (x: [-38, -12], z: [-24, 25])
    this.addBox(-24, FLOOR2_Y - 0.2, -16, 24, 0.4, 14, this.woodMat, true);
    this.addBox(-24, FLOOR2_Y - 0.2, 16, 24, 0.4, 14, this.woodMat, true);
    this.addStaircase(-35, 0, 23, 0, -1, 3.2, FLOOR2_Y, 8.5, 16);

    // Ballroom Pillars & Banquet Feast Table
    for (const px of [-19, -29]) {
      for (const pz of [-6, 6]) {
        this.addBox(px, ROOF_Y / 2, pz, 0.85, ROOF_Y, 0.85, this.marbleMat, true, true);
      }
    }
    this.addBanquetTable(-24, 0, 0, 9.5);
    this.addReceptionDesk(-34, 0, 0); // Haunted Bar Counter
    this.addPortrait(-37.5, 2.8, 0, Math.PI / 2, 0);

    // West Service / Kitchen Maze Rooms (North & South of Ballroom)
    for (const floorY of [0, FLOOR2_Y]) {
      this.addWallSegment(-38, -11, -12, -11, floorY, WALL_H, 0.4, this.wallpaperMat, true);
      this.addWallSegment(-38, 11, -12, 11, floorY, WALL_H, 0.4, this.wallpaperMat, true);
      this.addWallSegment(-20, -24, -20, -11, floorY, WALL_H, 0.38, this.wallpaperMat, true);
      this.addWallSegment(-28, -24, -28, -11, floorY, WALL_H, 0.38, this.wallpaperMat, true);
      this.addWallSegment(-24, 11, -24, 24, floorY, WALL_H, 0.38, this.wallpaperMat, true);
      this.addWallSegment(-17, 11, -17, 24, floorY, WALL_H, 0.38, this.wallpaperMat, true);

      // Storage crates & shelves to weave/hide behind
      this.addBox(-24, floorY + 0.75, -18, 1.5, 1.5, 1.5, this.woodMat, true, false);
      this.addBox(-32, floorY + 0.9, -15, 2.2, 1.8, 1.1, this.darkWoodMat, true, false);
      this.addWardrobe(-14.2, floorY, 17, -Math.PI / 2);
      this.addVictorianArmchair(-20.5, floorY, 20.5, 0);
    }

    this.addWallSconce(-24, 2.8, -10.7, 0, 1, true);
    this.addWallSconce(-37.6, 2.8, 4, 1, 0, false);

    // 5. NORTH WING — HAUNTED STONE CELLAR & HEDGE LABYRINTH (x: [-24, 24], z: [-43, -12])
    // Connecting doors to East & West Wings
    this.addWallSegment(-24, -43, -24, -12, 0, WALL_H, 0.45, this.stoneMat, true);
    this.addWallSegment(24, -43, 24, -12, 0, WALL_H, 0.45, this.stoneMat, true);

    // Twisted Stone Maze Layout
    this.addWallSegment(-18, -37, -18, -18, 0, WALL_H, 0.45, this.stoneMat, true);
    this.addWallSegment(-11, -43, -11, -24, 0, WALL_H, 0.45, this.stoneMat, true);
    this.addWallSegment(-4, -36, -4, -19, 0, WALL_H, 0.45, this.stoneMat, true);
    this.addWallSegment(4, -36, 4, -19, 0, WALL_H, 0.45, this.stoneMat, true);
    this.addWallSegment(11, -43, 11, -24, 0, WALL_H, 0.45, this.stoneMat, true);
    this.addWallSegment(18, -37, 18, -18, 0, WALL_H, 0.45, this.stoneMat, true);

    this.addWallSegment(-18, -31, -4, -31, 0, WALL_H, 0.45, this.stoneMat, true);
    this.addWallSegment(4, -31, 18, -31, 0, WALL_H, 0.45, this.stoneMat, true);
    this.addWallSegment(-18, -19, 18, -19, 0, WALL_H, 0.45, this.stoneMat, true);

    // Climbable Gothic Stone Fountain / Pedestal inside North Maze Courtyard
    this.addBox(0, 0.45, -28, 3.2, 0.9, 3.2, this.stoneMat, true, true);
    this.addBox(0, 1.5, -28, 1.1, 1.4, 1.1, this.marbleMat, true, true);
    const eerieBlue = new THREE.PointLight(0x60a5fa, 6.5, 22, 1.6);
    eerieBlue.position.set(0, 3.2, -28);
    this.group.add(eerieBlue);
    this.flickeringLights.push({ light: eerieBlue, baseIntensity: 6.5, phase: 4.1 });

    // 6. Populate Spawn & Super-Jump Safe Teleport Destinations across all wings & floors
    this.lobbySpawns.push(
      new THREE.Vector3(0, 0.25, 6.5),
      new THREE.Vector3(-4.5, 0.25, 5.0),
      new THREE.Vector3(4.5, 0.25, 5.0),
      new THREE.Vector3(0, 0.25, 2.5)
    );

    const hideSpots: THREE.Vector3[] = [
      // East Wing Ground Floor Maze
      new THREE.Vector3(15.0, 0.25, -16.0),
      new THREE.Vector3(21.5, 0.25, -18.5),
      new THREE.Vector3(29.0, 0.25, -18.0),
      new THREE.Vector3(22.0, 0.25, -1.5),
      new THREE.Vector3(29.0, 0.25, 1.0),
      new THREE.Vector3(15.0, 0.25, 12.0),
      new THREE.Vector3(21.5, 0.25, 19.5),
      new THREE.Vector3(34.5, 0.25, 6.0),
      // East Wing 2nd Floor
      new THREE.Vector3(15.0, FLOOR2_Y + 0.25, -9.0),
      new THREE.Vector3(22.0, FLOOR2_Y + 0.25, 10.0),
      new THREE.Vector3(28.5, FLOOR2_Y + 0.25, 1.0),
      // West Wing Ballroom & Service Maze
      new THREE.Vector3(-16.5, 0.25, -4.0),
      new THREE.Vector3(-31.5, 0.25, 6.5),
      new THREE.Vector3(-24.0, 0.25, -14.5),
      new THREE.Vector3(-33.5, 0.25, -20.5),
      new THREE.Vector3(-20.5, 0.25, 14.5),
      new THREE.Vector3(-30.5, FLOOR2_Y + 0.25, -17.0),
      new THREE.Vector3(-20.5, FLOOR2_Y + 0.25, 16.0),
      // North Stone Maze
      new THREE.Vector3(-14.5, 0.25, -24.5),
      new THREE.Vector3(14.5, 0.25, -24.5),
      new THREE.Vector3(-7.5, 0.25, -39.5),
      new THREE.Vector3(7.5, 0.25, -39.5),
      new THREE.Vector3(0.0, 0.25, -35.0),
      // Lobby Mezzanine
      new THREE.Vector3(-10.2, FLOOR2_Y + 0.25, 0.0),
      new THREE.Vector3(10.2, FLOOR2_Y + 0.25, 0.0),
    ];

    this.innocentSpawns.push(...hideSpots);
    this.safeSpots.push(...this.lobbySpawns, ...hideSpots);
  }

  public setGatesLocked(locked: boolean): void {
    if (this.gatesLocked === locked) return;
    this.gatesLocked = locked;
    this.gateBarrierGroup.visible = locked;
  }

  public getLobbySpawn(): THREE.Vector3 {
    return this.lobbySpawns[Math.floor(Math.random() * this.lobbySpawns.length)].clone();
  }

  public getInnocentStartSpawn(): THREE.Vector3 {
    return this.innocentSpawns[Math.floor(Math.random() * this.innocentSpawns.length)].clone();
  }

  /**
   * Randomized Super Jump destination picked strictly from spots FAR from the Murderer.
   */
  public getFarTeleportSpot(avoidWorldPos: THREE.Vector3 | null, minCurrentDist = 6.0, selfPos?: THREE.Vector3): THREE.Vector3 {
    const candidates = this.safeSpots.map((spot) => {
      const distMurderer = avoidWorldPos ? spot.distanceTo(avoidWorldPos) : 30;
      const distSelf = selfPos ? spot.distanceTo(selfPos) : 20;
      return { spot, distMurderer, distSelf };
    });

    // Filter out spots too close to self so teleport actually moves the player far away
    let pool = candidates.filter((c) => c.distSelf >= minCurrentDist);
    if (pool.length === 0) pool = candidates;

    // Sort descending by distance from Murderer and pick randomly among top 5 farthest spots!
    pool.sort((a, b) => b.distMurderer - a.distMurderer);
    const topCount = Math.min(5, pool.length);
    const picked = pool[Math.floor(Math.random() * topCount)];
    return picked.spot.clone();
  }

  public update(elapsedTime: number): void {
    // Subtle eerie chandelier sway & antique sconce flicker
    this.chandelierGroup.rotation.z = Math.sin(elapsedTime * 0.75) * 0.028;
    this.chandelierGroup.rotation.x = Math.cos(elapsedTime * 0.55) * 0.018;

    for (const item of this.flickeringLights) {
      const flicker =
        0.86 +
        0.10 * Math.sin(elapsedTime * 7.3 + item.phase) +
        0.06 * Math.sin(elapsedTime * 19.7 + item.phase * 2.1);
      item.light.intensity = item.baseIntensity * flicker;
    }
  }

  public isPointSolid(wx: number, wy: number, wz: number): boolean {
    if (wy < 0) return true;
    const gx = Math.floor(wx / GRID_CELL);
    const gz = Math.floor(wz / GRID_CELL);
    const bucket = this.grid.get(cellKey(gx, gz));
    if (!bucket) return false;

    for (let i = 0; i < bucket.length; i++) {
      const b = bucket[i];
      if (b.isGate && !this.gatesLocked) continue;
      if (
        wx >= b.minX && wx <= b.maxX &&
        wy >= b.minY && wy <= b.maxY &&
        wz >= b.minZ && wz <= b.maxZ
      ) {
        return true;
      }
    }
    return false;
  }

  public getFloorHeightAt(wx: number, wz: number): number {
    void wx;
    void wz;
    return 0;
  }

  public resolveSphere(
    center: THREE.Vector3,
    radius: number,
    outCenter: THREE.Vector3,
    outNormal: THREE.Vector3
  ): boolean {
    outCenter.copy(center);
    outNormal.set(0, 0, 0);
    let anyHit = false;

    const stamp = ++this.testStamp;
    const gx0 = Math.floor((outCenter.x - radius) / GRID_CELL);
    const gx1 = Math.floor((outCenter.x + radius) / GRID_CELL);
    const gz0 = Math.floor((outCenter.z - radius) / GRID_CELL);
    const gz1 = Math.floor((outCenter.z + radius) / GRID_CELL);
    const rSq = radius * radius;

    for (let gz = gz0; gz <= gz1; gz++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const bucket = this.grid.get(cellKey(gx, gz));
        if (!bucket) continue;

        for (let i = 0; i < bucket.length; i++) {
          const b = bucket[i];
          if (b.lastStamp === stamp) continue;
          b.lastStamp = stamp;
          if (b.isGate && !this.gatesLocked) continue;

          if (
            outCenter.x + radius < b.minX || outCenter.x - radius > b.maxX ||
            outCenter.y + radius < b.minY || outCenter.y - radius > b.maxY ||
            outCenter.z + radius < b.minZ || outCenter.z - radius > b.maxZ
          ) {
            continue;
          }

          const qx = Math.max(b.minX, Math.min(outCenter.x, b.maxX));
          const qy = Math.max(b.minY, Math.min(outCenter.y, b.maxY));
          const qz = Math.max(b.minZ, Math.min(outCenter.z, b.maxZ));

          const dx = outCenter.x - qx;
          const dy = outCenter.y - qy;
          const dz = outCenter.z - qz;
          const distSq = dx * dx + dy * dy + dz * dz;

          if (distSq === 0) {
            // Sphere center is inside box -> push out along nearest face
            const dMinX = outCenter.x - b.minX;
            const dMaxX = b.maxX - outCenter.x;
            const dMinY = outCenter.y - b.minY;
            const dMaxY = b.maxY - outCenter.y;
            const dMinZ = outCenter.z - b.minZ;
            const dMaxZ = b.maxZ - outCenter.z;
            const m = Math.min(dMinX, dMaxX, dMinY, dMaxY, dMinZ, dMaxZ);
            let nx = 0, ny = 0, nz = 0;
            if (m === dMaxY) { ny = 1; outCenter.y = b.maxY + radius; }
            else if (m === dMinY) { ny = -1; outCenter.y = b.minY - radius; }
            else if (m === dMaxX) { nx = 1; outCenter.x = b.maxX + radius; }
            else if (m === dMinX) { nx = -1; outCenter.x = b.minX - radius; }
            else if (m === dMaxZ) { nz = 1; outCenter.z = b.maxZ + radius; }
            else { nz = -1; outCenter.z = b.minZ - radius; }
            outNormal.x += nx;
            outNormal.y += ny;
            outNormal.z += nz;
            anyHit = true;
          } else if (distSq < rSq) {
            const dist = Math.sqrt(distSq);
            const inv = 1 / dist;
            const nx = dx * inv;
            const ny = dy * inv;
            const nz = dz * inv;
            const pen = radius - dist;
            outCenter.x += nx * pen;
            outCenter.y += ny * pen;
            outCenter.z += nz * pen;
            outNormal.x += nx;
            outNormal.y += ny;
            outNormal.z += nz;
            anyHit = true;
          }
        }
      }
    }

    if (anyHit && outNormal.lengthSq() > 1e-8) {
      outNormal.normalize();
    }
    return anyHit;
  }

  public dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.textures.dispose();
  }
}
