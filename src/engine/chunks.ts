import * as THREE from 'three';
import { WorldGenerator } from './noise';

export const CHUNK_SIZE = 16;
export const CHUNK_HEIGHT = 48;

interface FaceDef {
  dir: [number, number, number];
  corners: [
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number]
  ];
  uAxis: [number, number, number];
  vAxis: [number, number, number];
  uvs: [[number, number], [number, number], [number, number], [number, number]];
  shade: number;
}

// Counter-clockwise outward-facing quad definitions for all 6 block faces
const FACES: FaceDef[] = [
  {
    // +X (Right)
    dir: [1, 0, 0],
    corners: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]],
    uAxis: [0, 0, -1],
    vAxis: [0, 1, 0],
    uvs: [[0, 0], [1, 0], [1, 1], [0, 1]],
    shade: 0.96,
  },
  {
    // -X (Left)
    dir: [-1, 0, 0],
    corners: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]],
    uAxis: [0, 0, 1],
    vAxis: [0, 1, 0],
    uvs: [[0, 0], [1, 0], [1, 1], [0, 1]],
    shade: 0.94,
  },
  {
    // +Y (Top)
    dir: [0, 1, 0],
    corners: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]],
    uAxis: [1, 0, 0],
    vAxis: [0, 0, -1],
    uvs: [[0, 0], [1, 0], [1, 1], [0, 1]],
    shade: 1.0,
  },
  {
    // -Y (Bottom)
    dir: [0, -1, 0],
    corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
    uAxis: [1, 0, 0],
    vAxis: [0, 0, 1],
    uvs: [[0, 0], [1, 0], [1, 1], [0, 1]],
    shade: 0.84,
  },
  {
    // +Z (Front)
    dir: [0, 0, 1],
    corners: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
    uAxis: [1, 0, 0],
    vAxis: [0, 1, 0],
    uvs: [[0, 0], [1, 0], [1, 1], [0, 1]],
    shade: 0.95,
  },
  {
    // -Z (Back)
    dir: [0, 0, -1],
    corners: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]],
    uAxis: [-1, 0, 0],
    vAxis: [0, 1, 0],
    uvs: [[0, 0], [1, 0], [1, 1], [0, 1]],
    shade: 0.92,
  },
];

// Corner sign multipliers in face-local (u, v) space matching FACES[i].corners order
const CORNER_UV_SIGNS: ReadonlyArray<[number, number]> = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

const AO_CURVE = [0.68, 0.81, 0.91, 1.0];

function computeVertexAO(side1: boolean, side2: boolean, corner: boolean): number {
  if (side1 && side2) return 0;
  return 3 - (Number(side1) + Number(side2) + Number(corner));
}

export interface ChunkEntry {
  cx: number;
  cz: number;
  voxels: Uint8Array;
  mesh: THREE.Mesh | null;
}

export class ChunkManager {
  public readonly group = new THREE.Group();
  public worldGen: WorldGenerator;
  public renderDistance: number;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly chunks = new Map<string, ChunkEntry>();
  private readonly castShadows: boolean;

  constructor(seed: number, renderDistance: number, material: THREE.MeshStandardMaterial, castShadows: boolean) {
    this.worldGen = new WorldGenerator(seed);
    this.renderDistance = renderDistance;
    this.material = material;
    this.castShadows = castShadows;
    this.group.name = 'VoxelWorld';
  }

  public get loadedChunkCount(): number {
    return this.chunks.size;
  }

  private key(cx: number, cz: number): string {
    return `${cx},${cz}`;
  }

  private voxelIndex(lx: number, ly: number, lz: number): number {
    return (ly * CHUNK_SIZE + lz) * CHUNK_SIZE + lx;
  }

  private generateChunkVoxels(cx: number, cz: number): Uint8Array {
    const voxels = new Uint8Array(CHUNK_SIZE * CHUNK_HEIGHT * CHUNK_SIZE);
    const ox = cx * CHUNK_SIZE;
    const oz = cz * CHUNK_SIZE;

    for (let ly = 0; ly < CHUNK_HEIGHT; ly++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const wz = oz + lz;
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const wx = ox + lx;
          if (this.worldGen.isSolid(wx, ly, wz)) {
            voxels[this.voxelIndex(lx, ly, lz)] = 1;
          }
        }
      }
    }
    return voxels;
  }

  public isSolidAt(wx: number, wy: number, wz: number): boolean {
    if (wy < 0) return true;
    if (wy >= CHUNK_HEIGHT) return false;

    const ix = Math.floor(wx);
    const iy = Math.floor(wy);
    const iz = Math.floor(wz);

    const cx = Math.floor(ix / CHUNK_SIZE);
    const cz = Math.floor(iz / CHUNK_SIZE);
    const chunk = this.chunks.get(this.key(cx, cz));
    if (chunk) {
      const lx = ix - cx * CHUNK_SIZE;
      const lz = iz - cz * CHUNK_SIZE;
      return chunk.voxels[this.voxelIndex(lx, iy, lz)] === 1;
    }

    return this.worldGen.isSolid(ix, iy, iz);
  }

  private buildChunkMesh(entry: ChunkEntry): THREE.Mesh | null {
    const { cx, cz, voxels } = entry;
    const ox = cx * CHUNK_SIZE;
    const oz = cz * CHUNK_SIZE;

    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];

    let vertCount = 0;

    for (let ly = 0; ly < CHUNK_HEIGHT; ly++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const wz = oz + lz;
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          if (voxels[this.voxelIndex(lx, ly, lz)] === 0) continue;
          const wx = ox + lx;

          for (let f = 0; f < 6; f++) {
            const face = FACES[f];
            const nx = wx + face.dir[0];
            const ny = ly + face.dir[1];
            const nz = wz + face.dir[2];

            // Face culling: skip faces hidden by an adjacent solid block
            if (ny < 0) continue;
            if (ny < CHUNK_HEIGHT && this.isSolidAt(nx, ny, nz)) continue;

            const aos: [number, number, number, number] = [3, 3, 3, 3];

            for (let c = 0; c < 4; c++) {
              const corner = face.corners[c];
              positions.push(lx + corner[0], ly + corner[1], lz + corner[2]);
              normals.push(face.dir[0], face.dir[1], face.dir[2]);
              uvs.push(face.uvs[c][0], face.uvs[c][1]);

              // Compute baked corner AO
              const [su, sv] = CORNER_UV_SIGNS[c];
              const s1x = nx + face.uAxis[0] * su;
              const s1y = ny + face.uAxis[1] * su;
              const s1z = nz + face.uAxis[2] * su;

              const s2x = nx + face.vAxis[0] * sv;
              const s2y = ny + face.vAxis[1] * sv;
              const s2z = nz + face.vAxis[2] * sv;

              const crx = nx + face.uAxis[0] * su + face.vAxis[0] * sv;
              const cry = ny + face.uAxis[1] * su + face.vAxis[1] * sv;
              const crz = nz + face.uAxis[2] * su + face.vAxis[2] * sv;

              const side1 = s1y >= 0 && s1y < CHUNK_HEIGHT && this.isSolidAt(s1x, s1y, s1z);
              const side2 = s2y >= 0 && s2y < CHUNK_HEIGHT && this.isSolidAt(s2x, s2y, s2z);
              const diag = cry >= 0 && cry < CHUNK_HEIGHT && this.isSolidAt(crx, cry, crz);

              const aoLevel = computeVertexAO(side1, side2, diag);
              aos[c] = aoLevel;
              const lum = AO_CURVE[aoLevel] * face.shade;
              colors.push(lum, lum, lum);
            }

            // Flip quad diagonal to eliminate AO interpolation artifacts
            if (aos[0] + aos[2] > aos[1] + aos[3]) {
              indices.push(
                vertCount, vertCount + 1, vertCount + 2,
                vertCount, vertCount + 2, vertCount + 3
              );
            } else {
              indices.push(
                vertCount + 1, vertCount + 2, vertCount + 3,
                vertCount + 1, vertCount + 3, vertCount
              );
            }

            vertCount += 4;
          }
        }
      }
    }

    if (vertCount === 0) return null;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    geometry.computeBoundingSphere();

    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.position.set(ox, 0, oz);
    mesh.castShadow = this.castShadows;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    return mesh;
  }

  public updateAroundPlayer(wx: number, wz: number, maxBuildsPerFrame = 3): void {
    const playerCx = Math.floor(wx / CHUNK_SIZE);
    const playerCz = Math.floor(wz / CHUNK_SIZE);
    const rd = this.renderDistance;

    // 1. Unload distant chunks
    for (const [k, entry] of this.chunks.entries()) {
      const dx = Math.abs(entry.cx - playerCx);
      const dz = Math.abs(entry.cz - playerCz);
      if (dx > rd + 1 || dz > rd + 1) {
        if (entry.mesh) {
          this.group.remove(entry.mesh);
          entry.mesh.geometry.dispose();
          entry.mesh = null;
        }
        this.chunks.delete(k);
      }
    }

    // 2. Gather missing chunks within render distance sorted closest-first
    const missing: Array<{ cx: number; cz: number; distSq: number }> = [];
    for (let dz = -rd; dz <= rd; dz++) {
      for (let dx = -rd; dx <= rd; dx++) {
        if (dx * dx + dz * dz > (rd + 0.5) * (rd + 0.5)) continue;
        const cx = playerCx + dx;
        const cz = playerCz + dz;
        const k = this.key(cx, cz);
        if (!this.chunks.has(k)) {
          missing.push({ cx, cz, distSq: dx * dx + dz * dz });
        }
      }
    }

    if (missing.length === 0) return;
    missing.sort((a, b) => a.distSq - b.distSq);

    const limit = Math.min(maxBuildsPerFrame, missing.length);
    for (let i = 0; i < limit; i++) {
      const { cx, cz } = missing[i];
      const voxels = this.generateChunkVoxels(cx, cz);
      const entry: ChunkEntry = { cx, cz, voxels, mesh: null };
      this.chunks.set(this.key(cx, cz), entry);
      const mesh = this.buildChunkMesh(entry);
      entry.mesh = mesh;
      if (mesh) {
        this.group.add(mesh);
      }
    }
  }

  public preloadImmediate(wx: number, wz: number, radius = 2): void {
    const playerCx = Math.floor(wx / CHUNK_SIZE);
    const playerCz = Math.floor(wz / CHUNK_SIZE);

    // Generate voxel arrays first so cross-chunk face culling is exact
    const toBuild: ChunkEntry[] = [];
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const cx = playerCx + dx;
        const cz = playerCz + dz;
        const k = this.key(cx, cz);
        if (!this.chunks.has(k)) {
          const entry: ChunkEntry = {
            cx,
            cz,
            voxels: this.generateChunkVoxels(cx, cz),
            mesh: null,
          };
          this.chunks.set(k, entry);
          toBuild.push(entry);
        }
      }
    }

    for (const entry of toBuild) {
      entry.mesh = this.buildChunkMesh(entry);
      if (entry.mesh) {
        this.group.add(entry.mesh);
      }
    }
  }

  public resetWorld(newSeed: number, spawnX = 0, spawnZ = 0): void {
    this.disposeAllChunks();
    this.worldGen = new WorldGenerator(newSeed);
    this.preloadImmediate(spawnX, spawnZ, 2);
  }

  public disposeAllChunks(): void {
    for (const entry of this.chunks.values()) {
      if (entry.mesh) {
        this.group.remove(entry.mesh);
        entry.mesh.geometry.dispose();
        entry.mesh = null;
      }
    }
    this.chunks.clear();
  }
}
