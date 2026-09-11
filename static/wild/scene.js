// Adapted from src/benchmark/wild_web/static/scene.js; see website/README.md.
import * as THREE from "three";
import { OrbitControls } from "../viewer/vendor/OrbitControls.js";
import { OBJLoader } from "../viewer/vendor/OBJLoader.js";
import { MTLLoader } from "../viewer/vendor/MTLLoader.js";
import { parsePly } from "./ply.mjs";

// muted, high-contrast; part 0 is the base and stays grey
const PART_COLORS = [
  0x8a9099, 0x2f80ed, 0xf2994a, 0x27ae60, 0x9b51e0,
  0xeb5757, 0x2d9cdb, 0xf2c94c, 0x56ccf2, 0xbb6bd9,
];

async function fetchText(url) {
  const response = await fetch(url, { cache: "force-cache" });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.text();
}

function matrixFromRows(rows) {
  return new THREE.Matrix4().set(...rows.flat().map(Number));
}

// One source OBJ with its MTL and texture images, baked into the part's frame.
// `transform` takes raw OBJ vertices into object_rest_world and is recorded by
// the runner in meshes/textured.json; there is no GT here to align to, so the
// transform is the whole story.
async function loadTexturedSource(url, transform) {
  const dir = url.slice(0, url.lastIndexOf("/") + 1);
  const objText = await fetchText(url);
  const mtlName = /^\s*mtllib\s+(.+?)\s*$/m.exec(objText)?.[1];
  let materials = null;
  if (mtlName) {
    try {
      const mtl = new MTLLoader();
      mtl.setResourcePath(dir);
      mtl.setMaterialOptions({ side: THREE.DoubleSide });
      materials = mtl.parse(await fetchText(dir + mtlName), dir);
      materials.preload();
    } catch (error) {
      console.warn("MTL unavailable, using untextured OBJ", url, error);
    }
  }
  const loader = new OBJLoader();
  if (materials) loader.setMaterials(materials);
  const object = loader.parse(objText);
  let meshes = 0;
  object.traverse((child) => { if (child.isMesh) meshes += 1; });
  if (!meshes) throw new Error(`no triangles in ${url}`);
  const full = Array.isArray(transform) && transform.length === 4
    ? matrixFromRows(transform) : new THREE.Matrix4();
  object.traverse((child) => {
    if (!child.isMesh) return;
    child.geometry.applyMatrix4(full);
    child.geometry.computeVertexNormals();
    for (const material of [].concat(child.material || [])) {
      if (!material) continue;
      material.side = THREE.DoubleSide;
      material.needsUpdate = true;
    }
  });
  return object;
}

// A part whose materials are all untextured (plain "Kd 1 1 1") renders as an
// invisible white blob, so it takes the part colour instead. PartNet-Mobility
// exports often carry an untextured face set coincident with the textured one,
// which z-fights and shows through as white; those faces are pushed back a hair
// so the textured surface wins where they overlap.
function tintUntexturedPart(group, color) {
  const materials = new Set();
  group.traverse((child) => {
    if (child.isMesh) for (const material of [].concat(child.material || [])) if (material) materials.add(material);
  });
  const textured = [...materials].some((material) => material.map);
  const nearWhite = (material) => {
    const { r, g, b } = material.color || {};
    return [r, g, b].every((channel) => Number.isFinite(channel) && channel > 0.9);
  };
  for (const material of materials) {
    if (textured && !material.map) {
      material.polygonOffset = true;
      material.polygonOffsetFactor = 2;
      material.polygonOffsetUnits = 2;
    } else if (!textured && nearWhite(material)) {
      material.color.set(color);
    }
    material.needsUpdate = true;
  }
}

function fetchPly(url, signal) {
  return fetch(url, { cache: "force-cache", signal }).then((response) => {
    if (!response.ok) return null;
    return response.arrayBuffer().then((buffer) => parsePly(buffer));
  }).catch(() => null);
}

// Revolute ranges are degrees, prismatic ranges are metres; both are relative to
// the rest pose, which is t = 0.
export function jointMatrix(joint, t) {
  const matrix = new THREE.Matrix4();
  if (!joint || !joint.type || joint.type === "fixed") return matrix;
  const axis = joint.axis || {};
  const direction = new THREE.Vector3(...(axis.direction || [0, 0, 0]).map(Number));
  if (direction.lengthSq() < 1e-18) return matrix;
  direction.normalize();
  const [start, end] = (joint.range || [0, 0]).map(Number);
  const value = start + (end - start) * t;
  if (joint.type === "prismatic") {
    return matrix.makeTranslation(direction.x * value, direction.y * value, direction.z * value);
  }
  const origin = new THREE.Vector3(...(axis.origin || [0, 0, 0]).map(Number));
  return matrix
    .makeTranslation(origin.x, origin.y, origin.z)
    .multiply(new THREE.Matrix4().makeRotationAxis(direction, THREE.MathUtils.degToRad(value)))
    .multiply(new THREE.Matrix4().makeTranslation(-origin.x, -origin.y, -origin.z));
}

export function createStage(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const views = [];

  function renderAll() {
    const width = canvas.clientWidth || 1;
    const height = canvas.clientHeight || 1;
    if (canvas.width !== Math.floor(width * renderer.getPixelRatio())
        || canvas.height !== Math.floor(height * renderer.getPixelRatio())) {
      renderer.setSize(width, height, false);
    }
    // wipe the whole canvas first: a rectangle no view covers this frame would
    // otherwise keep whatever was drawn there before the page scrolled
    renderer.setScissorTest(false);
    renderer.setClearColor(0xffffff, 0);
    renderer.clear();
    renderer.setClearColor(0xffffff, 1);
    renderer.setScissorTest(true);
    const origin = canvas.getBoundingClientRect();
    for (const view of views) {
      const rect = view.element.getBoundingClientRect();
      const box = { w: rect.right - rect.left, h: rect.bottom - rect.top };
      if (box.w < 1 || box.h < 1) continue;
      const left = rect.left - origin.left, top = rect.top - origin.top;
      const right = Math.min(width, left + box.w), bottom = Math.min(height, top + box.h);
      if (right <= 0 || bottom <= 0 || left >= width || top >= height) continue;
      // The viewport stays full size while the scissor clips horizontally scrolled cards.
      renderer.setViewport(left, height - top - box.h, box.w, box.h);
      renderer.setScissor(Math.max(0, left), height - bottom, right - Math.max(0, left), bottom - Math.max(0, top));
      view.draw(box.w / box.h);
    }
    renderer.setScissorTest(false);
  }

  function addView(element) {
    const view = createView(renderer, element);
    views.push(view);
    return view;
  }

  return { addView, renderAll };
}

export function createView(renderer, element) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
  const controls = new OrbitControls(camera, element);
  controls.enableDamping = true;
  controls.enablePan = false;
  scene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  scene.add(key);

  // z-up model in a y-up renderer, matching the explorer's convention
  const root = new THREE.Group();
  root.rotation.x = -Math.PI / 2;
  scene.add(root);

  let entries = [];
  let frame = null;
  let useMaterials = false;
  let bundle = null;
  let texturedPending = null; // one load attempt per bundle, on first use
  // Bumped by every load and clear. Comparing bundle URLs is not enough:
  // re-selecting the same object builds a fresh `entries`, and an in-flight
  // textured load would otherwise attach its groups to the discarded one.
  let serial = 0;
  let request = null;

  function draw(aspect) {
    if (camera.aspect !== aspect) {
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
    }
    controls.update();
    key.position.copy(camera.position);
    renderer.render(scene, camera);
  }

  function frameCamera() {
    if (!frame) return;
    const { center, radius } = frame;
    const distance = radius / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * 1.35;
    const target = center.clone();
    camera.position.copy(target)
      .add(new THREE.Vector3(1.1, 0.75, 1.1).normalize().multiplyScalar(distance));
    controls.target.copy(target);
    camera.near = Math.max(distance / 500, 0.001);
    camera.far = distance * 12;
    camera.updateProjectionMatrix();
    controls.update();
  }

  function disposeGroup(group) {
    group.traverse((child) => {
      if (!child.isMesh) return;
      child.geometry.dispose();
      for (const material of [].concat(child.material || [])) {
        if (!material) continue;
        for (const value of Object.values(material)) if (value?.isTexture) value.dispose();
        material.dispose();
      }
    });
  }

  function clear() {
    serial += 1;
    request?.abort();
    bundle = null;
    texturedPending = null;
    useMaterials = false;
    for (const entry of entries) {
      disposeGroup(entry.group);
      root.remove(entry.group);
    }
    entries = [];
    frame = null;
  }

  async function load(base) {
    clear();
    const token = serial;
    request = new AbortController();
    const signal = request.signal;
    bundle = base;
    const document_ = await fetch(`${base}/object.json`, { cache: "force-cache", signal }).then((r) => {
      if (!r.ok) throw new Error(`Model unavailable (${r.status})`);
      return r.json();
    });
    const nodes = document_.diffuse_tree || [];
    // Sidecar the runners write beside the PLYs: the original textured OBJs per
    // node, with the transform into object_rest_world. The PLYs are geometry
    // only, so without this the baselines have no appearance at all.
    const sidecar = await fetch(`${base}/meshes/textured.json`, { cache: "force-cache", signal })
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null);
    const meshes = await Promise.all(nodes.map((_, index) => fetchPly(`${base}/meshes/part_${index}.ply`, signal)));
    if (token !== serial) throw new DOMException('Superseded selection', 'AbortError');
    if (!nodes.length || meshes.some(mesh => !mesh?.positions.length)) throw new Error('Incomplete model geometry');

    entries = nodes.map((node, index) => {
      const group = new THREE.Group();
      group.matrixAutoUpdate = false;
      const record = (sidecar?.nodes || []).find((item) => item.id === index) || sidecar?.nodes?.[index];
      const listed = (record?.sources || []).filter((source) => typeof source?.path === "string");
      // A "#" fragment marks a URDF primitive (object.urdf#link=case/visual=0/box),
      // which is not a file: the converter builds that box itself and bakes the
      // URDF material colour into the PLY. A part built from primitives plus a
      // few OBJ assets - Articraft's boxes plus its legs and handles - therefore
      // has no complete OBJ form, so its whole appearance stays with the PLY.
      // Loading the fragments only replaces the case with four legs.
      const files = listed.filter((source) => !source.path.includes("#"));
      const sources = files.length === listed.length ? files : [];
      return {
        node, index, group, joint: node.joint || null, sources, textured: null,
        primitives: listed.length - files.length,
        palette: PART_COLORS[index % PART_COLORS.length],
      };
    });
    // a child hangs off its parent's group, so a moving parent carries it along
    for (const entry of entries) {
      const parent = entry.node.parent;
      (parent >= 0 && parent < entries.length ? entries[parent].group : root).add(entry.group);
    }

    for (const entry of entries) {
      const ply = meshes[entry.index];
      if (!ply || !ply.positions.length) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(ply.positions, 3));
      if (ply.indices && ply.indices.length) geometry.setIndex(new THREE.BufferAttribute(ply.indices, 1));
      // URDF material colours ride along as vertex colours when the converter wrote them
      const colored = ply.colors && ply.colors.length === ply.positions.length;
      if (colored) geometry.setAttribute("color", new THREE.BufferAttribute(ply.colors, 3));
      geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
        roughness: 0.62, metalness: 0.04, flatShading: true, side: THREE.DoubleSide,
      }));
      mesh.userData.colored = colored;
      mesh.userData.palette = entry.palette;
      entry.group.add(mesh);
    }
    applyColors();
    measure();
    frameCamera();
    if (useMaterials) ensureTextured();
    return {
      parts: entries.length,
      joints: entries.filter((entry) => entry.joint && entry.joint.type && entry.joint.type !== "fixed").length,
      // either form of appearance counts: baked URDF colours on the PLY, or
      // textured OBJ sources beside it
      appearance: entries.some((entry) => entry.sources.length)
        || meshes.some((ply) => ply && ply.colors && ply.colors.length),
    };
  }

  // Textured sources are megabytes of OBJ and PNG per part, so they load on the
  // first switch into material mode rather than with every bundle.
  function ensureTextured() {
    if (texturedPending) return texturedPending;
    const token = serial;
    const base = bundle;
    texturedPending = Promise.all(entries.map(async (entry) => {
      if (!entry.sources.length) return;
      const group = new THREE.Group();
      // in parallel: a PartNet-Mobility base part is twenty-odd OBJs, and one
      // at a time makes the switch take a minute
      const loaded = await Promise.all(entry.sources.map((source) =>
        loadTexturedSource(`${base}/${source.path}`, source.transform).catch((error) => {
          console.warn("textured source unavailable", source.path, error);
          return null;
        })));
      for (const object of loaded) if (object) group.add(object);
      if (serial !== token || !group.children.length) {
        disposeGroup(group);
        return;
      }
      tintUntexturedPart(group, entry.palette);
      entry.textured = group;
      entry.group.add(group);
    })).then(() => {
      if (serial === token) applyColors();
    });
    return texturedPending;
  }

  // A prediction whose joint travel is wrong is exactly what this viewer is for,
  // so the frame has to hold the fully-open pose too, not just the rest pose.
  function measure() {
    const box = new THREE.Box3();
    for (const t of [0, 1]) {
      setState(t);
      box.union(new THREE.Box3().setFromObject(root));
    }
    setState(0);
    frame = box.isEmpty()
      ? { center: new THREE.Vector3(), radius: 1 }
      : {
          center: box.getCenter(new THREE.Vector3()),
          radius: Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-3),
        };
  }

  function applyColors() {
    for (const entry of entries) {
      const showTextured = useMaterials && Boolean(entry.textured);
      if (entry.textured) entry.textured.visible = showTextured;
      for (const child of entry.group.children) {
        if (!child.isMesh) continue;
        // the flat mesh steps aside for the textured source, and otherwise
        // shows either its baked URDF colour or the part palette
        child.visible = !showTextured;
        const colored = useMaterials && child.userData.colored;
        child.material.vertexColors = colored;
        child.material.color.setHex(colored ? 0xffffff : child.userData.palette);
        child.material.needsUpdate = true;
      }
    }
  }

  // resolves once the appearance actually on screen matches the mode, so the
  // caller can say "loading" instead of showing a half-palette, half-grey model
  function setColorMode(materials) {
    useMaterials = Boolean(materials);
    applyColors();
    return useMaterials ? ensureTextured() : Promise.resolve();
  }

  function setState(t) {
    const clamped = Math.min(1, Math.max(0, Number(t) || 0));
    for (const entry of entries) {
      entry.group.matrix.copy(jointMatrix(entry.joint, clamped));
      entry.group.matrixWorldNeedsUpdate = true;
    }
    root.updateMatrixWorld(true);
  }

  // headless checks and console debugging read this; nothing in the UI does
  function describe() {
    return entries.map((entry) => ({
      index: entry.index,
      sources: entry.sources.length,
      primitives: entry.primitives,
      textured: Boolean(entry.textured),
      meshes: entry.group.children.filter((child) => child.isMesh).map((child) => ({
        colored: child.userData.colored,
        visible: child.visible,
        vertexColors: child.material.vertexColors,
        color: child.material.color.getHexString(),
      })),
    }));
  }

  return { element, draw, load, setState, setColorMode, frameCamera, clear, describe, controls };
}
