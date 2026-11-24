import * as THREE from 'three';
import {
  applyCustomHandTransform,
  applyHandTextureAndTint,
  CustomHandTransform,
  disposeObject3D,
} from './customHandLoader';

export interface MonkeyHandRig {
  group: THREE.Group;
  setContactState: (active: boolean) => void;
  setFurColor?: (hex: string) => void;
  setCustomModel: (model: THREE.Group | null) => void;
  updateCustomTransform: (transform: CustomHandTransform) => void;
  applyTextureAndTint: (
    textureDataUrl: string | null,
    tintColor: string,
    flipY: boolean,
    brightness?: number
  ) => Promise<void>;
  hasCustomModel: () => boolean;
}

export function createMonkeyHand(side: 'left' | 'right', furColorHex = '#2c2623'): MonkeyHandRig {
  const isLeft = side === 'left';
  const sign = isLeft ? -1 : 1;

  const group = new THREE.Group();
  group.name = isLeft ? 'LeftGorillaHand' : 'RightGorillaHand';

  const defaultRig = new THREE.Group();
  defaultRig.name = 'DefaultGorillaMesh';
  group.add(defaultRig);

  let customModel: THREE.Group | null = null;

  const furMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(furColorHex),
    roughness: 0.92,
    metalness: 0.0,
  });

  const skinMat = new THREE.MeshStandardMaterial({
    color: 0xd4a688,
    roughness: 0.84,
    metalness: 0.0,
  });

  // 1. Smooth tapered gorilla forearm extending back toward wrist/elbow
  const armGeo = new THREE.CapsuleGeometry(0.038, 0.14, 6, 12);
  armGeo.rotateX(Math.PI / 2);
  const arm = new THREE.Mesh(armGeo, furMat);
  arm.position.set(0, 0.012, 0.095);
  arm.rotation.x = 0.18;
  arm.castShadow = true;
  defaultRig.add(arm);

  // 2. Smooth rounded gorilla palm (back of hand)
  const palmGeo = new THREE.SphereGeometry(0.056, 14, 12);
  palmGeo.scale(1.02, 0.56, 1.12);
  const palm = new THREE.Mesh(palmGeo, furMat);
  palm.position.set(0, 0.0, -0.015);
  palm.castShadow = true;
  defaultRig.add(palm);

  // 3. Soft flush tan palm pad underneath
  const padGeo = new THREE.SphereGeometry(0.048, 12, 10);
  padGeo.scale(0.92, 0.24, 1.0);
  const pad = new THREE.Mesh(padGeo, skinMat);
  pad.position.set(0, -0.024, -0.016);
  defaultRig.add(pad);

  // 4-7. Smooth curled gorilla fingers
  const fingerX = [-0.034, -0.011, 0.012, 0.035];
  const fingerScale = [0.92, 1.05, 1.0, 0.86];
  for (let i = 0; i < 4; i++) {
    const fCluster = new THREE.Group();
    fCluster.position.set(fingerX[i], -0.002, -0.062);
    fCluster.rotation.x = 0.72;

    const fingerGeo = new THREE.CapsuleGeometry(0.0125, 0.034 * fingerScale[i], 5, 10);
    fingerGeo.rotateX(Math.PI / 2);
    const finger = new THREE.Mesh(fingerGeo, furMat);
    finger.position.set(0, 0, -0.018 * fingerScale[i]);
    finger.castShadow = true;
    fCluster.add(finger);

    const tipGeo = new THREE.SphereGeometry(0.012, 8, 8);
    const tip = new THREE.Mesh(tipGeo, skinMat);
    tip.position.set(0, -0.004, -0.036 * fingerScale[i]);
    fCluster.add(tip);

    defaultRig.add(fCluster);
  }

  // 8. Smooth rounded opposable thumb
  const thumbGroup = new THREE.Group();
  thumbGroup.position.set(-sign * 0.048, -0.01, -0.018);
  thumbGroup.rotation.y = sign * 0.55;
  thumbGroup.rotation.x = 0.25;

  const thumbGeo = new THREE.CapsuleGeometry(0.013, 0.032, 5, 10);
  thumbGeo.rotateX(Math.PI / 2);
  const thumb = new THREE.Mesh(thumbGeo, furMat);
  thumb.position.set(0, 0, -0.018);
  thumb.castShadow = true;
  thumbGroup.add(thumb);

  const thumbTipGeo = new THREE.SphereGeometry(0.0125, 8, 8);
  const thumbTip = new THREE.Mesh(thumbTipGeo, skinMat);
  thumbTip.position.set(0, -0.002, -0.036);
  thumbGroup.add(thumbTip);

  defaultRig.add(thumbGroup);

  const setContactState = (active: boolean) => {
    skinMat.emissive.setHex(active ? 0x3b2314 : 0x000000);
    skinMat.emissiveIntensity = active ? 0.35 : 0;
  };

  const setFurColor = (hex: string) => {
    furMat.color.set(hex);
  };

  const setCustomModel = (model: THREE.Group | null) => {
    if (customModel) {
      group.remove(customModel);
      disposeObject3D(customModel);
      customModel = null;
    }
    if (model) {
      customModel = model;
      group.add(customModel);
      defaultRig.visible = false;
    } else {
      defaultRig.visible = true;
    }
  };

  const updateCustomTransform = (transform: CustomHandTransform) => {
    if (customModel) {
      applyCustomHandTransform(customModel, transform);
    }
  };

  const applyTextureAndTint = async (
    textureDataUrl: string | null,
    tintColor: string,
    flipY: boolean,
    brightness = 1.0
  ) => {
    if (customModel) {
      await applyHandTextureAndTint(customModel, textureDataUrl, tintColor, flipY, brightness);
    }
  };

  const hasCustomModel = () => customModel !== null;

  return {
    group,
    setContactState,
    setFurColor,
    setCustomModel,
    updateCustomTransform,
    applyTextureAndTint,
    hasCustomModel,
  };
}
