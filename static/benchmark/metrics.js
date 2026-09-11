import * as THREE from 'three';
import { ObjectViewer } from '../viewer/viewer.js';
import { metricJointValue } from './metric_pose.mjs';

// Protocol state mapping is copied from 8793. These overlays are GT illustrations,
// not evaluator results; no prediction or score is manufactured here.
export function poseModel(model, example, metric, t) {
  model.joints.forEach(joint => joint.reset());
  for (const meta of example.joints) {
    const joint = model.joints.find(j => j.usdPath === meta.usd_path);
    if (!joint) throw new Error(`Missing runtime joint: ${meta.id}`);
    const range = meta.eval_range?.map(value => meta.limits_unit === 'degrees' ? value * Math.PI / 180 : value);
    const value = metricJointValue(metric, meta.type, range, t);
    if (!Number.isFinite(value)) throw new Error(`Missing evaluation range: ${meta.id}`);
    joint.setValueUnclamped(value);
  }
  model.root.updateMatrixWorld(true);
}

export function mappedParts(model, example) {
  const meshes = [];
  model.root.traverse(node => { if (node.isMesh) meshes.push(node); });
  const claimed = new Set();
  const parts = example.parts.filter(p => p.role === 'movable').map(spec => {
    const links = [...spec.source_links, ...spec.fixed_attachments.map(label => example.gtParts[label]).filter(Boolean)];
    const members = meshes.filter(mesh => !claimed.has(mesh) && links.some(link => {
      const path = String(mesh.userData.usdPath || '');
      return link.startsWith('/') ? path === link || path.startsWith(link + '/') : path.split('/').includes(link);
    }));
    if (!members.length) throw new Error(`Missing part geometry: ${spec.label}`);
    members.forEach(mesh => claimed.add(mesh));
    return { ...spec, meshes: members };
  });
  parts.push({ label: 'base', role: 'base', parent: null, meshes: meshes.filter(mesh => !claimed.has(mesh)) });
  return parts;
}

export function partBox(part) {
  const box = new THREE.Box3();
  for (const mesh of part.meshes) box.expandByObject(mesh);
  return box;
}

export function siblingPairs(parts) {
  const pairs = [];
  parts.forEach((left, i) => parts.slice(i + 1).forEach(right => {
    if (left.role === 'movable' && right.role === 'movable' && left.parent && left.parent === right.parent) {
      const intersection = partBox(left).intersect(partBox(right));
      pairs.push({ left, right, intersection });
    }
  }));
  return pairs;
}

// Deterministic mesh vertices, intentionally labeled as a surface preview.
// Formal CD uses evaluator surface samples and squared nearest-point distances.
export function previewPoints(parts, budget = 1800) {
  const points = [], point = new THREE.Vector3();
  const perPart = Math.max(1, Math.floor(budget / parts.length));
  for (const part of parts) {
    const attrs = part.meshes.filter(m => m.geometry.getAttribute('position')?.count);
    const total = attrs.reduce((sum, mesh) => sum + mesh.geometry.getAttribute('position').count, 0);
    let remaining = perPart;
    for (const [i, mesh] of attrs.entries()) {
      const position = mesh.geometry.getAttribute('position');
      const count = Math.min(position.count, remaining, i === attrs.length - 1 ? remaining : Math.round(perPart * position.count / total));
      mesh.updateWorldMatrix(true, false);
      for (let j = 0; j < count; j++) {
        point.fromBufferAttribute(position, Math.floor((j + 0.5) * position.count / count)).applyMatrix4(mesh.matrixWorld);
        points.push(point.x, point.y, point.z);
      }
      remaining -= count;
    }
  }
  return points;
}

function disposeOverlay(group) {
  group?.traverse(node => {
    node.geometry?.dispose();
    for (const material of [].concat(node.material || [])) material.dispose();
  });
  group?.removeFromParent();
}

export class MetricViewer extends ObjectViewer {
  async load(example, viewport, signal, onProgress) {
    await super.load(example, viewport, signal, onProgress);
    this.parts = mappedParts(this.model, example);
    this.originalMaterials = new Map();
    this.model.root.traverse(node => {
      if (!node.isMesh) return;
      for (const material of [].concat(node.material || [])) {
        if (this.originalMaterials.has(material)) continue;
        this.originalMaterials.set(material, { opacity: material.opacity, transparent: material.transparent, depthWrite: material.depthWrite });
        material.opacity = Math.min(material.opacity, 0.28); material.transparent = true; material.depthWrite = false;
        material.needsUpdate = true;
      }
    });
  }

  show(metric, t) {
    disposeOverlay(this.overlay);
    this.overlay = new THREE.Group(); this.scene.add(this.overlay);
    poseModel(this.model, this.item, metric, t);
    const moving = this.parts.filter(p => p.role === 'movable');
    const size = Math.max(...this.bounds.getSize(new THREE.Vector3()).toArray());
    let count = moving.length;
    const box = (part, color) => {
      const helper = new THREE.Box3Helper(partBox(part), color);
      helper.material.depthTest = false; helper.renderOrder = 5;
      this.overlay.add(helper);
    };
    if (metric.endsWith('IoU')) moving.forEach(part => box(part, 0x0891b2));
    if (metric.endsWith('cDist')) {
      moving.forEach(part => {
        box(part, 0x94a3b8);
        const marker = new THREE.Mesh(new THREE.SphereGeometry(size * 0.009, 10, 8), new THREE.MeshBasicMaterial({ color: 0x7c3aed, depthTest: false }));
        marker.position.copy(partBox(part).getCenter(new THREE.Vector3())); marker.renderOrder = 6;
        this.overlay.add(marker);
      });
    }
    if (metric.endsWith('CD')) {
      const positions = previewPoints(this.parts);
      count = positions.length / 3;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      const points = new THREE.Points(geometry, new THREE.PointsMaterial({ color: 0x0f766e, size: size * 0.006, depthTest: false }));
      points.renderOrder = 6; this.overlay.add(points);
    }
    let overlaps = 0;
    if (metric === 'AOR') {
      moving.forEach(part => box(part, 0xd97706));
      const pairs = siblingPairs(this.parts); count = pairs.length;
      for (const pair of pairs) {
        const extent = pair.intersection.getSize(new THREE.Vector3());
        if (pair.intersection.isEmpty() || extent.x * extent.y * extent.z <= 1e-12) continue;
        overlaps++;
        const volume = new THREE.Mesh(new THREE.BoxGeometry(...extent.toArray()), new THREE.MeshBasicMaterial({ color: 0xdc2626, transparent: true, opacity: 0.4, depthWrite: false, depthTest: false }));
        volume.position.copy(pair.intersection.getCenter(new THREE.Vector3())); volume.renderOrder = 7;
        this.overlay.add(volume);
      }
    }
    return { count, overlaps };
  }

  clear() {
    disposeOverlay(this.overlay); this.overlay = null;
    for (const [material, original] of this.originalMaterials || []) Object.assign(material, original);
    this.originalMaterials = null; this.parts = null;
    super.clear();
  }
}
