import * as THREE from 'three';

export function createVoxelWhiteTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  if (ctx) {
    // Clean matte off-white base so directional lighting & AO never clip to pure 255
    ctx.fillStyle = '#f4f7fb';
    ctx.fillRect(0, 0, size, size);

    // Subtle procedural matte grain for velocity and depth cues
    const imgData = ctx.getImageData(0, 0, size, size);
    const data = imgData.data;
    let seed = 42197;
    for (let i = 0; i < data.length; i += 4) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const delta = ((seed >>> 24) % 9) - 4;
      data[i] = Math.min(255, Math.max(0, data[i] + delta));
      data[i + 1] = Math.min(255, Math.max(0, data[i + 1] + delta));
      data[i + 2] = Math.min(255, Math.max(0, data[i + 2] + delta));
    }
    ctx.putImageData(imgData, 0, 0);

    // Subtle 2x2 architectural sub-grid lines inside each block face
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.14)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(size * 0.5, 12);
    ctx.lineTo(size * 0.5, size - 12);
    ctx.moveTo(12, size * 0.5);
    ctx.lineTo(size - 12, size * 0.5);
    ctx.stroke();

    // Soft bevel shading around perimeter of each block face
    const bevelWidth = 22;
    const topGrad = ctx.createLinearGradient(0, 0, 0, bevelWidth);
    topGrad.addColorStop(0, 'rgba(255, 255, 255, 0.85)');
    topGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = topGrad;
    ctx.fillRect(0, 0, size, bevelWidth);

    const leftGrad = ctx.createLinearGradient(0, 0, bevelWidth, 0);
    leftGrad.addColorStop(0, 'rgba(255, 255, 255, 0.7)');
    leftGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = leftGrad;
    ctx.fillRect(0, 0, bevelWidth, size);

    const bottomGrad = ctx.createLinearGradient(0, size - bevelWidth, 0, size);
    bottomGrad.addColorStop(0, 'rgba(148, 163, 184, 0)');
    bottomGrad.addColorStop(1, 'rgba(148, 163, 184, 0.24)');
    ctx.fillStyle = bottomGrad;
    ctx.fillRect(0, size - bevelWidth, size, bevelWidth);

    const rightGrad = ctx.createLinearGradient(size - bevelWidth, 0, size, 0);
    rightGrad.addColorStop(0, 'rgba(148, 163, 184, 0)');
    rightGrad.addColorStop(1, 'rgba(148, 163, 184, 0.20)');
    ctx.fillStyle = rightGrad;
    ctx.fillRect(size - bevelWidth, 0, bevelWidth, size);

    // Crisp outer grid hairline for clear block separation
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.42)';
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, size - 4, size - 4);

    // Subtle inner bevel chamfer line
    ctx.strokeStyle = 'rgba(203, 213, 225, 0.35)';
    ctx.lineWidth = 2;
    ctx.strokeRect(14, 14, size - 28, size - 28);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = maxAnisotropy;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}
