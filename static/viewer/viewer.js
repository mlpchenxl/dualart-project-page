import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';
import { RoomEnvironment } from './vendor/RoomEnvironment.js';
import { loadRealAppliance } from './realappliance_usd.js';

export function movableJoints(model) {
  return model.joints.filter(j => Number.isFinite(j.lower) && Number.isFinite(j.upper) && j.upper > j.lower);
}

export function applyProgress(joints, fraction) {
  const t = Math.min(1, Math.max(0, fraction));
  for (const joint of joints) joint.setValue(joint.lower + t * (joint.upper - joint.lower));
}

export function formatValue(joint) {
  return joint.type === 'revolute'
    ? `${THREE.MathUtils.radToDeg(joint.value).toFixed(1)}°`
    : `${(joint.value * 1000).toFixed(1)} mm`;
}

export function restorePose(model, presentation) {
  for (const joint of model.joints) joint.reset();
  for (const [name, value] of Object.entries(presentation?.initial_joint_values || {})) {
    const joint = model.joints.find(j => j.id === name || j.usdPath.split('/').pop() === name);
    if (joint && Number.isFinite(Number(value))) {
      joint.setValue(Number(value) * (joint.type === 'revolute' && presentation.unit !== 'radians' ? Math.PI / 180 : 1));
    }
  }
}

export class ObjectViewer {
  constructor() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.canvas = this.renderer.domElement;
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('aria-label', '3D object. Drag to orbit, scroll to zoom, arrow keys to pan.');
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xe7ecf2);
    const room = new RoomEnvironment();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.environment = pmrem.fromScene(room, 0.04);
    this.scene.environment = this.environment.texture;
    this.scene.environmentIntensity = 0.85;
    room.dispose(); pmrem.dispose();
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xaeb8c5, 1.5));
    for (const [color, intensity, position] of [[0xffffff, 2.4, [4, 7, 5]], [0xdbeafe, 0.9, [-5, 3, -4]]]) {
      const light = new THREE.DirectionalLight(color, intensity);
      light.position.set(...position); this.scene.add(light);
    }
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.001, 1000);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.listenToKeyEvents(this.canvas);
    this.wrapper = new THREE.Group(); this.scene.add(this.wrapper);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.visibilityObserver = new IntersectionObserver(entries => {
      this.visible = entries[0].isIntersecting; this.updateLoop();
    });
    this.onVisibilityChange = () => this.updateLoop();
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.canvas.addEventListener('webglcontextlost', event => {
      event.preventDefault(); this.playing = false; this.renderer.setAnimationLoop(null);
      this.onError?.('The graphics context was lost. Reload the page to try again.');
    });
  }

  async load(item, viewport, signal, onProgress) {
    this.clear();
    this.viewport = viewport; this.item = item;
    viewport.append(this.canvas);
    this.resizeObserver.observe(viewport); this.visibilityObserver.observe(viewport);
    this.resize();
    const url = new URL(item.model, document.baseURI);
    const model = await loadRealAppliance({ url: url.href, signal, onProgress });
    if (signal.aborted) { model.dispose(); throw new DOMException('Cancelled', 'AbortError'); }
    this.model = model; this.joints = movableJoints(model);
    const up = model.root.userData.upAxis === 'Z';
    const assetQuat = Array.isArray(item.frontQuat) && item.frontQuat.length === 4
      ? new THREE.Quaternion(item.frontQuat[1], item.frontQuat[2], item.frontQuat[3], item.frontQuat[0]).normalize()
      : new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...(up ? [0, 0, 1] : [0, 1, 0])), THREE.MathUtils.degToRad(item.frontYaw || 0));
    const basis = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), up ? -Math.PI / 2 : 0);
    this.wrapper.quaternion.copy(basis).multiply(assetQuat).multiply(basis.clone().invert());
    this.wrapper.add(model.root);
    // Fit the sampled motion envelope once; joint playback never orbits the camera.
    this.bounds = new THREE.Box3();
    restorePose(model, item.presentation);
    this.bounds.union(new THREE.Box3().setFromObject(this.wrapper));
    for (const t of [0, 0.5, 1]) {
      applyProgress(this.joints, t);
      this.bounds.union(new THREE.Box3().setFromObject(this.wrapper));
    }
    restorePose(model, item.presentation);
    if (this.bounds.isEmpty()) throw new Error('This asset contains no visible geometry.');
    this.phase = 0; this.fit(); this.updateLoop();
    return this.joints;
  }

  fit() {
    if (!this.model || !this.bounds) return;
    const center = this.bounds.getCenter(new THREE.Vector3());
    const size = Math.max(...this.bounds.getSize(new THREE.Vector3()).toArray(), 0.001);
    const halfV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const distance = size / (2 * Math.min(halfV, halfV * this.camera.aspect)) * 1.5;
    this.camera.position.copy(center).addScaledVector(new THREE.Vector3(1.15, 0.75, 1.15).normalize(), distance);
    this.camera.near = Math.max(size / 2000, 0.00001); this.camera.far = distance * 30;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center); this.controls.minDistance = size * 0.1; this.controls.maxDistance = size * 12;
    this.controls.update();
  }

  resize() {
    if (!this.viewport) return;
    const width = this.viewport.clientWidth, height = this.viewport.clientHeight;
    if (!width || !height) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height; this.camera.updateProjectionMatrix();
  }

  updateLoop() {
    this.lastTime = null;
    this.renderer.setAnimationLoop(this.model && this.visible && !document.hidden ? time => {
      if (this.playing) {
        this.phase += this.lastTime === null ? 0 : Math.min((time - this.lastTime) / 1000, 0.1);
        applyProgress(this.joints, (1 - Math.cos(this.phase * Math.PI / 3)) / 2);
        this.onValues?.();
      }
      this.lastTime = time;
      this.controls.update(); this.renderer.render(this.scene, this.camera);
    } : null);
  }

  reset() {
    this.playing = false; this.phase = 0;
    restorePose(this.model, this.item.presentation); this.fit(); this.onValues?.();
  }

  dispose() {
    this.clear();
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.controls.dispose(); this.environment.dispose();
    this.renderer.dispose(); this.renderer.forceContextLoss();
  }

  clear() {
    this.renderer.setAnimationLoop(null); this.playing = false; this.visible = false;
    this.resizeObserver.disconnect(); this.visibilityObserver.disconnect();
    this.wrapper.clear(); this.model?.dispose(); this.model = null;
    this.bounds = null; this.viewport = null; this.onValues = null; this.onError = null;
    this.canvas.remove(); this.renderer.renderLists.dispose();
  }
}
