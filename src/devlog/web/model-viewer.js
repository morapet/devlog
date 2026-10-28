// 3D model viewer for ![[model:N]] embeds. Loaded on demand (dynamic import)
// by app.js — kept as its own ES module so the Three.js `import`s resolve via
// the import map declared in index.html. Three.js + the loaders are vendored
// locally under /static/vendor/three (local-first, works offline).

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { ThreeMFLoader } from "three/addons/loaders/3MFLoader.js";

// Theme-dependent colors for the scene chrome. The model itself keeps a
// neutral material so it reads the same in both themes.
const THEME = {
  light: { bg: 0xf8fafc, grid1: 0xcbd5e1, grid2: 0xe2e8f0, model: 0x64748b },
  dark:  { bg: 0x0f172a, grid1: 0x334155, grid2: 0x1e293b, model: 0x94a3b8 },
};

function parseMesh(format, buf) {
  const fmt = (format || "stl").toLowerCase();
  if (fmt === "obj") {
    const text = new TextDecoder().decode(buf);
    return new OBJLoader().parse(text);
  }
  if (fmt === "3mf") {
    return new ThreeMFLoader().parse(buf);
  }
  // Default: STL (binary or ASCII — STLLoader auto-detects).
  const geo = new STLLoader().parse(buf);
  geo.computeVertexNormals();
  return geo;
}

function buildObject(parsed, color, fmt) {
  const material = new THREE.MeshStandardMaterial({
    color, metalness: 0.1, roughness: 0.65, flatShading: false,
  });
  material.userData.themed = true; // setTheme recolors only these
  // STLLoader returns a BufferGeometry; OBJ / 3MF return an Object3D tree.
  if (parsed.isBufferGeometry) {
    return new THREE.Mesh(parsed, material);
  }
  parsed.traverse((n) => {
    if (!n.isMesh) return;
    // 3MFLoader emits position-only geometry (it relies on flatShading), so
    // a lit material without normals renders solid black.
    if (!n.geometry.attributes.normal) n.geometry.computeVertexNormals();
    const src = n.material;
    // 3MF carries per-part display colors (SolidCraft writes basematerials):
    // keep them, as a lit Standard material with the file's opacity.
    if (fmt === "3mf" && src && !Array.isArray(src) && src.color) {
      const m = new THREE.MeshStandardMaterial({
        color: src.color, metalness: 0.1, roughness: 0.65, flatShading: true,
        transparent: src.transparent, opacity: src.opacity,
        depthWrite: !src.transparent, side: src.transparent ? THREE.DoubleSide : THREE.FrontSide,
      });
      src.dispose();
      n.material = m;
      return;
    }
    // Otherwise give un-materialed meshes our neutral material so the whole
    // model is uniformly shaded.
    if (!src || (!Array.isArray(src) && !src.isMeshStandardMaterial)) {
      n.material = material;
    }
  });
  return parsed;
}

// SolidCraft (and STL / 3MF generally) is Z-up; Three.js is Y-up. Stand the
// model upright inside a wrapper so its own transforms stay untouched.
function zUpToYUp(object) {
  const wrap = new THREE.Group();
  object.rotation.x = -Math.PI / 2;
  wrap.add(object);
  return wrap;
}

// Center the object at the origin and return its size + framing radius so the
// camera can frame it regardless of the model's absolute scale/position.
function frame(object) {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  object.position.sub(center); // recenter at origin
  const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1;
  return { size, radius };
}

/**
 * Mount a live 3D viewer into `container`.
 * opts: { attId, format, dark }
 * Returns a controller: { dispose(), setTheme(dark), resize() }.
 */
export async function mountViewer(container, opts) {
  const { attId, format } = opts;
  let dark = !!opts.dark;
  let theme = dark ? THEME.dark : THEME.light;

  const res = await fetch(`/attachments/${attId}/mesh`);
  if (!res.ok) throw new Error("HTTP " + res.status);
  const buf = await res.arrayBuffer();
  // Prefer the server's declared type (model/stl|obj|3mf); fall back to the
  // caller's hint, then STL.
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  const fmt = ct.includes("obj") ? "obj" : ct.includes("3mf") ? "3mf"
            : ct.includes("stl") ? "stl" : (format || "stl");
  const parsed = parseMesh(fmt, buf);
  const object = zUpToYUp(buildObject(parsed, theme.model, fmt));
  const { size, radius } = frame(object);

  const scene = new THREE.Scene();
  scene.add(object);

  // Lighting: a soft hemisphere fill plus a key light that follows the camera.
  const hemi = new THREE.HemisphereLight(0xffffff, 0x444455, 1.0);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  scene.add(key);

  // Ground grid for spatial reference, at the model's base. GridHelper bakes
  // its colors into vertex colors, so a theme change rebuilds it.
  function makeGrid(t) {
    const g = new THREE.GridHelper(radius * 6, 24, t.grid1, t.grid2);
    g.position.y = -size.y / 2 - radius * 0.01;
    g.material.transparent = true;
    g.material.opacity = 0.5;
    return g;
  }
  let grid = makeGrid(theme);
  scene.add(grid);

  const camera = new THREE.PerspectiveCamera(45, 1, radius * 0.05, radius * 100);
  camera.position.set(radius * 2.2, radius * 1.8, radius * 2.6);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(theme.bg, 1);
  renderer.domElement.style.display = "block";
  renderer.domElement.style.width = "100%";
  renderer.domElement.style.height = "100%";
  renderer.domElement.style.outline = "none";
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 0, 0);
  controls.update();

  let disposed = false;
  let needsRender = true;
  controls.addEventListener("change", () => { needsRender = true; });

  function sizeToContainer() {
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    needsRender = true;
  }
  sizeToContainer();

  const ro = new ResizeObserver(sizeToContainer);
  ro.observe(container);

  // Render loop — only draws a frame when something changed (or damping is
  // still settling), so idle inline viewers cost nothing.
  function loop() {
    if (disposed) return;
    const moving = controls.update(); // returns true while damping settles
    if (needsRender || moving) {
      key.position.copy(camera.position);
      renderer.render(scene, camera);
      needsRender = false;
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  return {
    dispose() {
      disposed = true;
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      scene.traverse((n) => {
        if (n.geometry) n.geometry.dispose();
        if (n.material) {
          const mats = Array.isArray(n.material) ? n.material : [n.material];
          mats.forEach((m) => m.dispose());
        }
      });
      renderer.domElement.remove();
    },
    setTheme(nextDark) {
      dark = !!nextDark;
      theme = dark ? THEME.dark : THEME.light;
      renderer.setClearColor(theme.bg, 1);
      scene.remove(grid);
      grid.geometry.dispose();
      grid.material.dispose();
      grid = makeGrid(theme);
      scene.add(grid);
      object.traverse((n) => { if (n.isMesh && n.material?.userData.themed) n.material.color.setHex(theme.model); });
      needsRender = true;
    },
    resize: sizeToContainer,
  };
}
