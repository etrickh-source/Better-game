import * as THREE from 'three';

export interface KnifeVisualRig {
  group: THREE.Group;
  dispose: () => void;
}

/**
 * Standard Placeholder 3D Murderer Knife (Composite 6-part PBR model).
 * Blade points forward along -Z so attaching to hand or orienting along flight velocity is direct.
 */
export function createKnifeModel(scale = 1.0): KnifeVisualRig {
  const group = new THREE.Group();
  group.name = 'MurdererKnifePlaceholder';

  const bladeMat = new THREE.MeshStandardMaterial({
    color: 0xd4dbe3,
    roughness: 0.22,
    metalness: 0.92,
    envMapIntensity: 1.25,
  });

  const edgeMat = new THREE.MeshStandardMaterial({
    color: 0xf1f5f9,
    roughness: 0.12,
    metalness: 0.98,
    emissive: 0x3f0a0a,
    emissiveIntensity: 0.12,
  });

  const brassMat = new THREE.MeshStandardMaterial({
    color: 0xb68b42,
    roughness: 0.32,
    metalness: 0.88,
  });

  const gripMat = new THREE.MeshStandardMaterial({
    color: 0x26150e,
    roughness: 0.78,
    metalness: 0.05,
  });

  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [bladeMat, edgeMat, brassMat, gripMat];

  // 1. Bowie / Combat Blade Profile extruded along X, rotated so blade spine points along -Z
  const bladeShape = new THREE.Shape();
  bladeShape.moveTo(0, -0.014);
  bladeShape.lineTo(0.20, -0.014);
  bladeShape.lineTo(0.26, -0.002); // Keen clip point
  bladeShape.lineTo(0.20, 0.022);
  bladeShape.lineTo(0.03, 0.022);
  bladeShape.lineTo(0, 0.015);
  bladeShape.closePath();

  const bladeGeo = new THREE.ExtrudeGeometry(bladeShape, {
    depth: 0.004,
    bevelEnabled: true,
    bevelThickness: 0.0022,
    bevelSize: 0.002,
    bevelSegments: 2,
  });
  bladeGeo.center();
  // Rotate so length runs along -Z (tip at -Z, hilt at +Z) and blade flat face is vertical
  bladeGeo.rotateY(Math.PI / 2);
  bladeGeo.translate(0, 0, -0.145);
  geometries.push(bladeGeo);

  const bladeMesh = new THREE.Mesh(bladeGeo, bladeMat);
  bladeMesh.castShadow = true;
  group.add(bladeMesh);

  // 2. Gleaming Bottom Cutting Edge Strip
  const edgeGeo = new THREE.BoxGeometry(0.0026, 0.0055, 0.215);
  edgeGeo.translate(0, -0.016, -0.132);
  geometries.push(edgeGeo);
  const edgeMesh = new THREE.Mesh(edgeGeo, edgeMat);
  group.add(edgeMesh);

  // 3. Fuller Blood-Groove Accent on Spine
  const fullerGeo = new THREE.BoxGeometry(0.0075, 0.0042, 0.14);
  fullerGeo.translate(0, 0.006, -0.115);
  geometries.push(fullerGeo);
  const fullerMesh = new THREE.Mesh(fullerGeo, brassMat);
  group.add(fullerMesh);

  // 4. Sculpted Brass Crossguard
  const guardGeo = new THREE.BoxGeometry(0.022, 0.064, 0.014);
  guardGeo.translate(0, 0.002, -0.012);
  geometries.push(guardGeo);
  const guardMesh = new THREE.Mesh(guardGeo, brassMat);
  guardMesh.castShadow = true;
  group.add(guardMesh);

  // 5. Turned Wooden Grip Handle (LatheGeometry)
  const handlePts = [
    new THREE.Vector2(0.002, 0.0),
    new THREE.Vector2(0.015, 0.008),
    new THREE.Vector2(0.018, 0.045),
    new THREE.Vector2(0.016, 0.082),
    new THREE.Vector2(0.019, 0.112),
    new THREE.Vector2(0.002, 0.118),
  ];
  const handleGeo = new THREE.LatheGeometry(handlePts, 14);
  handleGeo.rotateX(Math.PI / 2);
  handleGeo.translate(0, 0, -0.005);
  geometries.push(handleGeo);
  const handleMesh = new THREE.Mesh(handleGeo, gripMat);
  handleMesh.castShadow = true;
  group.add(handleMesh);

  // 6. Brass Pommel Cap & Grip Rings
  const pommelGeo = new THREE.CylinderGeometry(0.018, 0.014, 0.022, 12);
  pommelGeo.rotateX(Math.PI / 2);
  pommelGeo.translate(0, 0, 0.114);
  geometries.push(pommelGeo);
  const pommelMesh = new THREE.Mesh(pommelGeo, brassMat);
  group.add(pommelMesh);

  group.scale.setScalar(scale);

  return {
    group,
    dispose: () => {
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
    },
  };
}
