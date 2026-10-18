// Everything that exists in the 3D scene: the mountain, the forest, the drone, the injured person
// and the mission overlays. The timeline in main.js only moves these around.
//
// Nothing here uses a real-time shadow map. The mountain's shading and the forest's shadows are worked
// out once while the page loads, and the drone's shadow is its own outline, drawn into a small texture
// and laid over the ground. It looks softer than a shadow map and costs a fraction of one.
import * as THREE from "../vendor/three.module.min.js";
import { GLTFLoader } from "../vendor/GLTFLoader.js";
import { MeshoptDecoder } from "../vendor/meshopt_decoder.module.js";
import { height, normal as groundNormal, steepness, HOME as HOME_XZ, TARGET as TARGET_XZ, TREELINE } from "./terrain.js";
import { buildDrone, progress, BODY, BLADES, DISCS } from "./drone.js";

export const BG = 0xf2f4f1; // the page's paper: cuts between places and the studio pass through it
export const HAZE = 0xdbe9ef; // the air at the horizon, where the land meets the sky
const v3 = (x, y, z) => new THREE.Vector3(x, y, z);
const rand = (() => { let n = 11; return () => (n = (n * 16807) % 2147483647) / 2147483647; })();
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function buildWorld(canvas) {
  // No multisampling: on laptop graphics it more than doubles the cost of a frame. Edges are kept clean by
  // drawing more pixels than the screen needs whenever the graphics card has time (see sharpness in scroll.js).
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, stencil: false, powerPreference: "high-performance" });
  if (!renderer.capabilities.isWebGL2) throw new Error("WebGL 2 is not available");
  renderer.setClearColor(BG);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(HAZE, 95, 540);
  const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 900);

  // Soft studio reflections for the metal and glossy parts of the drone
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new THREE.Scene();
  room.add(new THREE.Mesh(new THREE.BoxGeometry(20, 20, 20), new THREE.MeshBasicMaterial({ color: 0x9aa3a6, side: THREE.BackSide })));
  for (const [x, y, z, w, h] of [[0, 9.5, 0, 12, 12], [-9.5, 2, 0, 8, 6], [9.5, 3, 3, 6, 5]]) {
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 5, 5), side: THREE.DoubleSide }));
    panel.position.set(x, y, z);
    panel.lookAt(0, 0, 0);
    room.add(panel);
  }
  scene.environment = pmrem.fromScene(room, 0.04).texture;
  pmrem.dispose();

  // ── Places and directions ─────────────────────────────────────────────
  const onGround = (x, z, lift = 0) => v3(x, height(x, z) + lift, z);
  const HOME = onGround(HOME_XZ.x, HOME_XZ.z);
  const TARGET = onGround(TARGET_XZ.x, TARGET_XZ.z);
  const ahead = v3(TARGET.x - HOME.x, 0, TARGET.z - HOME.z).normalize(); // launch site → person
  const side = v3(-ahead.z, 0, ahead.x); // to the right of `ahead`
  const DROP = onGround(TARGET.x + side.x * 1.2, TARGET.z + side.z * 1.2); // where the kit lands: within reach, to their left
  const YAW = Math.atan2(-ahead.x, -ahead.z);

  // ── Light ─────────────────────────────────────────────────────────────
  scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa3a0, 1.6));
  const sunDir = side.clone().multiplyScalar(-0.62).addScaledVector(ahead, -0.3).setY(0.72).normalize();
  const sun = new THREE.DirectionalLight(0xfff6ea, 2.05);
  sun.position.copy(sunDir).multiplyScalar(140);
  scene.add(sun);
  const sunFlat = Math.hypot(sunDir.x, sunDir.z);
  const SUN_RISE = sunDir.y / sunFlat; // height gained per unit of ground covered towards the sun
  const fallX = -sunDir.x / sunFlat, fallZ = -sunDir.z / sunFlat; // the way shadows fall across the ground

  // ── The drone's shadow: its outline seen from the sun, kept in a small texture ──
  const SIL_SIZE = 512, SIL_SPAN = 6.4;
  const silTarget = new THREE.WebGLRenderTarget(SIL_SIZE, SIL_SIZE, { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
  const lightCam = new THREE.OrthographicCamera(-SIL_SPAN / 2, SIL_SPAN / 2, SIL_SPAN / 2, -SIL_SPAN / 2, 0.1, 80);
  lightCam.position.copy(sunDir).multiplyScalar(30);
  lightCam.lookAt(0, 0, 0);
  lightCam.updateMatrixWorld();
  const shadowUniforms = {
    uSil: { value: silTarget.texture },
    uSilC: { value: v3(0, 0, 0) },
    uSilR: { value: v3(0, 0, 0).setFromMatrixColumn(lightCam.matrixWorld, 0) },
    uSilU: { value: v3(0, 0, 0).setFromMatrixColumn(lightCam.matrixWorld, 1) },
    uSunDir: { value: sunDir },
  };
  // The further below the drone a surface is, the softer and fainter the shadow that reaches it.
  const SHADOW_GLSL = `
    uniform sampler2D uSil; uniform vec3 uSilC; uniform vec3 uSilR; uniform vec3 uSilU; uniform vec3 uSunDir;
    float droneShadow(vec3 p, float soften) {
      vec3 rel = p - uSilC;
      float below = -dot(rel, uSunDir);
      vec2 uv = 0.5 + vec2(dot(rel, uSilR), dot(rel, uSilU)) / ${SIL_SPAN.toFixed(1)};
      float lod = min(6.5, log2(max(1.0, (0.008 + soften + below * 0.05) * ${(SIL_SIZE / SIL_SPAN).toFixed(1)})));
      float window = smoothstep(0.0, 0.08, min(min(uv.x, uv.y), min(1.0 - uv.x, 1.0 - uv.y)));
      return min(1.0, textureLod(uSil, uv, lod).r * 1.5) * window * smoothstep(0.0, 0.25, below);
    }`;

  // ── Mountain: a pale relief model with contour lines ──────────────────
  const land = new THREE.Group();
  scene.add(land);
  // Sky: a clear day, pale where it meets the land, deep blue overhead, with a band of soft clouds
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(850, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { uHorizon: { value: new THREE.Color(HAZE) }, uMid: { value: new THREE.Color(0xa9d0ea) }, uZenith: { value: new THREE.Color(0x4f93d2) } },
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform vec3 uHorizon; uniform vec3 uMid; uniform vec3 uZenith; varying vec3 vDir;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y); }
        void main(){
          float y = vDir.y;
          vec3 c = mix(uHorizon, uMid, smoothstep(0.0, 0.1, y));
          c = mix(c, uZenith, smoothstep(0.1, 0.65, y));
          // clouds: noise on a ceiling seen in perspective, stretched sideways, only in a band above the horizon
          vec2 q = vDir.xz / (y + 0.12) * vec2(0.9, 2.2);
          float n = 0.55 * vnoise(q * 1.1) + 0.3 * vnoise(q * 2.3 + 4.0) + 0.15 * vnoise(q * 5.1 - 2.0);
          float cloud = smoothstep(0.56, 0.78, n) * smoothstep(0.02, 0.12, y) * (1.0 - smoothstep(0.35, 0.75, y));
          c = mix(c, vec3(0.97, 0.98, 0.99), cloud * 0.8);
          gl_FragColor = vec4(c, 1.0);
          #include <colorspace_fragment>
        }`,
    }),
  );
  sky.renderOrder = 10; // after everything solid, so it only fills what is still empty
  land.add(sky);

  const SIZE = 680, SEG = 320, N = SEG + 1, CELL = SIZE / SEG;
  const X0 = 38 - SIZE / 2, Z0 = -62 - SIZE / 2;
  const ground = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG).rotateX(-Math.PI / 2).translate(38, 0, -62);
  const gp = ground.attributes.position;
  const heights = new Float32Array(N * N); // row by row: x grows along a row, z from row to row
  for (let i = 0; i < gp.count; i++) gp.setY(i, (heights[i] = height(gp.getX(i), gp.getZ(i))));
  ground.computeVertexNormals();

  // Relief shading, worked out once: slopes that the ridge in front hides from the sun are in shade,
  // and hollows are a little darker than crests.
  const heightAt = (ix, iz) => heights[clamp(iz, 0, SEG) * N + clamp(ix, 0, SEG)];
  const RING = [];
  for (const r of [4, 10]) for (let k = 0; k < 8; k++) RING.push([Math.round(Math.cos(k * 0.785) * r), Math.round(Math.sin(k * 0.785) * r)]);
  let shade = new Float32Array(N * N);
  for (let iz = 0; iz < N; iz++) {
    for (let ix = 0; ix < N; ix++) {
      const h = heights[iz * N + ix];
      let lit = 1;
      for (let d = 3; d < 150 && lit > 0; d *= 1.22) {
        const there = heightAt(Math.round(ix - (fallX * d) / CELL), Math.round(iz - (fallZ * d) / CELL));
        lit = Math.min(lit, ((h + SUN_RISE * d + 0.8 - there) / d) * 7);
      }
      let around = 0;
      for (const [dx, dz] of RING) around += heightAt(ix + dx, iz + dz);
      const hollow = around / RING.length - h;
      shade[iz * N + ix] = (0.3 + 0.7 * clamp(lit, 0, 1)) * clamp(1 - hollow * 0.03, 0.74, 1.05);
    }
  }
  const blurred = new Float32Array(N * N);
  for (let iz = 0; iz < N; iz++) {
    for (let ix = 0; ix < N; ix++) {
      let sum = 0;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) sum += shade[clamp(iz + dz, 0, SEG) * N + clamp(ix + dx, 0, SEG)];
      blurred[iz * N + ix] = sum / 9;
    }
  }
  shade = blurred;
  ground.setAttribute("aShade", new THREE.BufferAttribute(shade, 1));

  // Where the forest grows (the same rule that places the trees below, softened): its floor is dark from afar
  const toRoute = (x, z) => {
    const dx = TARGET.x - HOME.x, dz = TARGET.z - HOME.z;
    const t = THREE.MathUtils.clamp(((x - HOME.x) * dx + (z - HOME.z) * dz) / (dx * dx + dz * dz), 0, 1);
    return Math.hypot(x - HOME.x - dx * t, z - HOME.z - dz * t);
  };
  const fromHome = (x, z) => Math.hypot(x - HOME.x, z - HOME.z);
  const fromTarget = (x, z) => Math.hypot(x - TARGET.x, z - TARGET.z);
  const clumpAt = (x, z) => Math.sin(x * 0.09 + 3) * Math.cos(z * 0.08) + Math.sin(x * 0.031 - z * 0.047);
  const smoothJs = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const woods = new Float32Array(gp.count);
  for (let i = 0; i < gp.count; i++) {
    const x = gp.getX(i), z = gp.getZ(i), h = gp.getY(i), clump = clumpAt(x, z);
    woods[i] = smoothJs(-0.75, -0.35, clump) * smoothJs(TREELINE - 1 + clump * 4, TREELINE - 5 + clump * 4, h)
      * smoothJs(1.3, 1.0, steepness(x, z)) * smoothJs(4.5, 9, toRoute(x, z)) * smoothJs(40, 52, fromHome(x, z)) * smoothJs(20, 30, fromTarget(x, z));
  }
  ground.setAttribute("aWoods", new THREE.BufferAttribute(woods, 1));

  const groundUniforms = {
    uMeadowA: { value: new THREE.Color(0x5a9637) },
    uMeadowB: { value: new THREE.Color(0x86b64b) },
    uDry: { value: new THREE.Color(0xbfc26a) },
    uAlpine: { value: new THREE.Color(0x8fae5c) },
    uWoods: { value: new THREE.Color(0x24503a) },
    uRock: { value: new THREE.Color(0x8d9198) },
    uSnow: { value: new THREE.Color(0xf4f8fb) },
    uShadeTint: { value: new THREE.Color().setRGB(0.52, 0.6, 0.74) },
    uBlobs: { value: null },
    uBounds: { value: v3(X0, Z0, 1 / SIZE) },
    ...shadowUniforms,
  };
  const groundMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  groundMat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, groundUniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float aShade; attribute float aWoods; varying float vH; varying float vSteep; varying float vShade; varying float vWoods; varying vec3 vPlace;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvH = position.y; vSteep = 1.0 - normal.y; vShade = aShade; vWoods = aWoods; vPlace = position;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        varying float vH; varying float vSteep; varying float vShade; varying float vWoods; varying vec3 vPlace;
        uniform vec3 uMeadowA; uniform vec3 uMeadowB; uniform vec3 uDry; uniform vec3 uAlpine; uniform vec3 uWoods;
        uniform vec3 uRock; uniform vec3 uSnow;
        uniform vec3 uShadeTint; uniform sampler2D uBlobs; uniform vec3 uBounds;
        ${SHADOW_GLSL}
        float hash2(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash2(i), hash2(i + vec2(1, 0)), u.x), mix(hash2(i + vec2(0, 1)), hash2(i + vec2(1, 1)), u.x), u.y); }`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        {
          // meadow: big soft patches of two greens, drier spots, and a fine mottle that fades with distance
          vec2 at = vPlace.xz;
          float big = vnoise(at * 0.045) * 0.65 + vnoise(at * 0.11 + 3.0) * 0.35;
          vec3 c = mix(uMeadowA, uMeadowB, smoothstep(0.3, 0.72, big));
          c = mix(c, uDry, smoothstep(0.62, 0.82, vnoise(at * 0.07 + 9.0)) * 0.6);
          float near = smoothstep(120.0, 20.0, length(vViewPosition));
          c *= 1.0 + (vnoise(at * 0.9) - 0.5) * 0.22 * near;
          c = mix(c, uAlpine, smoothstep(13.0, 26.0, vH));
          c = mix(c, uWoods, smoothstep(0.15, 0.6, vWoods));
          c = mix(c, uRock, smoothstep(0.16, 0.5, vSteep) * smoothstep(8.0, 26.0, vH));
          c = mix(c, uSnow, smoothstep(40.0, 50.0, vH - vSteep * 16.0));
          float shadowed = max(texture2D(uBlobs, (vPlace.xz - uBounds.xy) * uBounds.z).r, droneShadow(vPlace, 0.0));
          float light = clamp(vShade, 0.0, 1.0) * (1.0 - 0.7 * shadowed);
          diffuseColor.rgb = c * mix(uShadeTint, vec3(1.0), light);
        }`,
      );
  };
  const terrain = new THREE.Mesh(ground, groundMat);
  terrain.renderOrder = -1;
  land.add(terrain);

  // ── Forest below the treeline, boulders above ─────────────────────────
  const scatter = (count, accept) => {
    const out = [];
    for (let tries = 0; out.length < count && tries < count * 30; tries++) {
      const x = 38 + (rand() - 0.5) * 520, z = -62 + (rand() - 0.5) * 520;
      const h = height(x, z);
      if (accept(x, z, h)) out.push([x, h, z, rand(), rand()]);
    }
    return out;
  };
  const trees = scatter(11000, (x, z, h) => {
    const clump = clumpAt(x, z);
    return h < TREELINE - 3 + clump * 4 && clump > -0.75 && steepness(x, z) < 1.15 && toRoute(x, z) > 4.5 && fromHome(x, z) > 40 && fromTarget(x, z) > 20;
  });
  // One kind of tree = one mesh drawn many times. All are about 4.6 units tall before scaling.
  const seeded = (seed) => { let n = seed; return () => (n = (n * 16807) % 2147483647) / 2147483647; };
  const faceted = (positions, indices) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    g.setIndex(indices);
    const flat = g.toNonIndexed();
    flat.computeVertexNormals();
    return flat;
  };
  const spruce = (seed, tiers, points, slender, droop, under) => {
    const r = seeded(seed), pos = [], idx = [];
    const vert = (x, y, z) => (pos.push(x, y, z), pos.length / 3 - 1);
    const H = 4.6;
    const foot = [], neck = [];
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * 6.283;
      foot.push(vert(Math.cos(a) * 0.13, -0.15, Math.sin(a) * 0.13));
      neck.push(vert(Math.cos(a) * 0.05, 1.3, Math.sin(a) * 0.05));
    }
    for (let k = 0; k < 5; k++) idx.push(foot[k], neck[(k + 1) % 5], neck[k], foot[k], foot[(k + 1) % 5], neck[(k + 1) % 5]);
    for (let k = 0; k < tiers; k++) {
      const t = k / (tiers - 1);
      const base = (0.09 + t * 0.72) * H, tall = 0.24 * (1 - 0.45 * t) * H;
      const rad = slender * (1 - 0.86 * t) * H * (0.9 + 0.2 * r()), turn = r() * 3.14;
      const top = vert(0, base + tall, 0), ring = [];
      for (let i = 0; i < points * 2; i++) {
        const a = turn + (Math.PI * i) / points, out = i % 2 === 0;
        const rr = rad * (out ? 0.85 + 0.3 * r() : 0.5 + 0.12 * r());
        ring.push(vert(Math.cos(a) * rr, base - droop * rr * (out ? 1 : 0.35), Math.sin(a) * rr));
      }
      const m = ring.length;
      for (let i = 0; i < m; i++) idx.push(ring[i], top, ring[(i + 1) % m]);
      if (under) {
        const u = vert(0, base + 0.04 * H, 0);
        for (let i = 0; i < m; i++) idx.push(ring[(i + 1) % m], u, ring[i]);
      }
    }
    return faceted(pos, idx);
  };
  const broadleaf = (seed) => {
    const r = seeded(seed), parts = [];
    for (let k = 0; k < 4; k++) {
      const blob = new THREE.IcosahedronGeometry(0.75 + r() * 0.45, 1);
      const p = blob.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const lump = 1 + (r() - 0.5) * 0.22;
        p.setXYZ(i, p.getX(i) * lump, p.getY(i) * lump * 0.85, p.getZ(i) * lump);
      }
      blob.translate((r() - 0.5) * 1.2, 2.5 + r() * 1.2, (r() - 0.5) * 1.2);
      parts.push(blob);
    }
    parts.push(new THREE.CylinderGeometry(0.07, 0.14, 2.4, 6).translate(0, 1.1, 0));
    const pos = [], idx = [];
    let base = 0;
    for (const part of parts) {
      const flat = part.index ? part : part;
      pos.push(...flat.attributes.position.array);
      if (flat.index) for (const i of flat.index.array) idx.push(i + base);
      else for (let i = 0; i < flat.attributes.position.count; i++) idx.push(i + base);
      base += flat.attributes.position.count;
    }
    return faceted(pos, idx);
  };
  const treeMat = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
  treeMat.onBeforeCompile = (shader) => {
    // darker towards the foot of each tree: it gives the forest depth without any shadow maths
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying float vUp;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvUp = position.y;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vUp;")
      .replace("#include <color_fragment>", "#include <color_fragment>\ndiffuseColor.rgb *= mix(0.62, 1.1, smoothstep(0.3, 4.4, vUp));");
  };
  const KINDS = [
    { geo: spruce(11, 7, 8, 0.21, 0.32, true), tones: [0x1f4c36, 0x27583c, 0x316643, 0x22524a, 0x3c6f3f] },
    { geo: spruce(23, 8, 7, 0.19, 0.38, true), tones: [0x1f4c36, 0x27583c, 0x316643, 0x22524a, 0x3c6f3f] },
    { geo: spruce(37, 6, 9, 0.24, 0.26, true), tones: [0x1f4c36, 0x27583c, 0x316643, 0x22524a, 0x3c6f3f] },
    { geo: spruce(51, 3, 6, 0.21, 0.3, false), tones: [0x22503a, 0x2a5a3f, 0x2f6243] }, // far away
    { geo: broadleaf(61), tones: [0x4e8a35, 0x5c983b, 0x6ba843, 0x7fb04a] },
    { geo: broadleaf(73), tones: [0x4e8a35, 0x5c983b, 0x6ba843, 0x7fb04a] },
  ];
  const kindOf = (x, z, h, roll) => {
    if (h < 9 && roll < 0.3) return 4 + Math.floor(roll * 6.6); // broadleaf low in the valley
    const near = toRoute(x, z) < 70 || fromHome(x, z) < 120 || fromTarget(x, z) < 90;
    return near ? Math.floor(roll * 3) : 3;
  };
  const groups = KINDS.map(() => []);
  for (const tree of trees) groups[kindOf(tree[0], tree[2], tree[1], rand())].push(tree);
  const item = new THREE.Object3D(), tone = new THREE.Color();
  // Each kind is split into square plots, each its own mesh with its own bounds, so the plots outside the view
  // are not drawn at all (the forest is most of what the graphics card has to draw)
  const PLOT = 110;
  KINDS.forEach((kind, k) => {
    const plots = new Map();
    for (const tree of groups[k]) {
      const key = `${Math.floor(tree[0] / PLOT)},${Math.floor(tree[2] / PLOT)}`;
      if (!plots.has(key)) plots.set(key, []);
      plots.get(key).push(tree);
    }
    for (const list of plots.values()) {
      const forest = new THREE.InstancedMesh(kind.geo, treeMat, list.length);
      list.forEach(([x, h, z, a, b], i) => {
        item.position.set(x, h - 0.1, z);
        item.scale.setScalar(0.6 + a * 0.6);
        item.rotation.set(0, b * 6.28, 0);
        item.updateMatrix();
        forest.setMatrixAt(i, item.matrix);
        forest.setColorAt(i, tone.setHex(kind.tones[Math.floor(b * kind.tones.length)]));
      });
      forest.computeBoundingSphere();
      forest.renderOrder = -2; // before the ground, so the ground behind the trees is never shaded
      land.add(forest);
    }
  });

  const stone = new THREE.IcosahedronGeometry(1, 0);
  const stoneMat = new THREE.MeshLambertMaterial({ color: 0x92969e, flatShading: true });
  const boulders = scatter(520, (x, z, h) => h > 9 && h < 46 && toRoute(x, z) > 3 && fromTarget(x, z) > 27);
  for (let i = 0; i < 70; i++) {
    const angle = rand() * 6.28, far = 4.4 + rand() * 12;
    const x = TARGET.x + Math.cos(angle) * far, z = TARGET.z + Math.sin(angle) * far;
    boulders.push([x, height(x, z), z, rand() * 0.25, rand() * 0.3]);
  }
  const stones = new THREE.InstancedMesh(stone, stoneMat, boulders.length);
  boulders.forEach(([x, h, z, a, b], i) => {
    item.position.set(x, h, z);
    item.scale.set(0.3 + a * 1.5, 0.22 + b * 0.9, 0.3 + b * 1.3);
    item.rotation.set(a * 3, b * 6.28, a);
    item.updateMatrix();
    stones.setMatrixAt(i, item.matrix);
  });
  stones.renderOrder = -2;
  land.add(stones);

  // Shadows of the trees and boulders, painted once into a map of the whole mountain
  {
    const MAP = 2048, k = MAP / SIZE;
    const sheet = document.createElement("canvas");
    sheet.width = sheet.height = MAP;
    const pen = sheet.getContext("2d", { willReadFrequently: true });
    pen.fillStyle = "#000";
    pen.fillRect(0, 0, MAP, MAP);
    pen.globalCompositeOperation = "lighten"; // overlapping shadows do not add up
    const turn = Math.atan2(fallZ, fallX);
    const streak = (x, z, length, half) => {
      const px = (x - X0 + fallX * length * 0.5) * k, pz = (z - Z0 + fallZ * length * 0.5) * k;
      for (const [grow, tone] of [[1.4, 105], [1, 235]]) {
        pen.fillStyle = `rgb(${tone},${tone},${tone})`;
        pen.beginPath();
        pen.ellipse(px, pz, (length * 0.5 + half * 0.6) * k * grow, half * k * grow, turn, 0, 6.2832);
        pen.fill();
      }
    };
    for (const [x, , z, a] of trees) {
      const size = 0.6 + a * 0.6;
      streak(x, z, (4.5 * size) / SUN_RISE, 0.78 * size);
    }
    for (const [x, , z, a, b] of boulders) streak(x, z, (0.5 + b * 0.9) / SUN_RISE, 0.35 + a * 1.3);
    const rgba = pen.getImageData(0, 0, MAP, MAP).data, red = new Uint8Array(MAP * MAP);
    for (let i = 0; i < red.length; i++) red[i] = rgba[i * 4];
    const blobs = new THREE.DataTexture(red, MAP, MAP, THREE.RedFormat);
    blobs.minFilter = THREE.LinearMipmapLinearFilter;
    blobs.magFilter = THREE.LinearFilter;
    blobs.generateMipmaps = true;
    blobs.needsUpdate = true;
    groundUniforms.uBlobs.value = blobs;
  }

  // ── Drone ─────────────────────────────────────────────────────────────
  const droneParts = buildDrone();
  droneParts.drone.traverse((o) => {
    if (o.isMesh && !o.material.transparent) o.renderOrder = -3; // first of all: it is always in front
  });
  scene.add(droneParts.drone);

  // Redraw the drone's outline for the sun. `key` names everything that changes its shape.
  const solid = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, fog: false });
  const faint = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, fog: false, blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor });
  faint.color.setRGB(0.3, 0.3, 0.3);
  let outline = null, kitCasts = true;
  const castDrone = (key, flying, withKit) => {
    shadowUniforms.uSilC.value.copy(droneParts.drone.position);
    if (key === outline) return;
    outline = key;
    if (withKit !== kitCasts) {
      kitCasts = withKit;
      for (const mesh of droneParts.kitMeshes) mesh.layers[withKit ? "enable" : "disable"](BODY);
    }
    lightCam.position.copy(droneParts.drone.position).addScaledVector(sunDir, 30);
    lightCam.updateMatrixWorld();
    const target = renderer.getRenderTarget(), auto = renderer.autoClear;
    renderer.setRenderTarget(silTarget);
    renderer.setClearColor(0x000000);
    scene.overrideMaterial = solid;
    lightCam.layers.set(BODY);
    if (!flying) lightCam.layers.enable(BLADES);
    renderer.autoClear = true;
    renderer.render(scene, lightCam);
    if (flying) {
      scene.overrideMaterial = faint;
      lightCam.layers.set(DISCS);
      renderer.autoClear = false;
      renderer.render(scene, lightCam);
    }
    scene.overrideMaterial = null;
    renderer.autoClear = auto;
    renderer.setRenderTarget(target);
    renderer.setClearColor(BG);
  };

  // A soft dark patch for things that lie on the ground
  const patchGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const patch = (opacity) =>
    new THREE.Mesh(
      patchGeo,
      new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
        uniforms: { uOpacity: { value: opacity } },
        vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `uniform float uOpacity; varying vec2 vUv; void main(){ float r = distance(vUv, vec2(0.5)) * 2.0; gl_FragColor = vec4(0.1, 0.13, 0.17, uOpacity * smoothstep(1.0, 0.2, r)); }`,
      }),
    );

  // ── The injured person: sitting on the ground, the hurt left leg out in front (models/hiker.glb, made in Blender) ──
  // They face the meadow the drone waits in, turned a little so the camera sees the hurt leg. The model is a skinned
  // body with one scene the page plays by scroll, pose(frame): 1-96 holding the leg, the phone out of the chest
  // pocket, one press of the thumb on SOS, waiting; 97-150 looking up at the drone, the phone down, turning to the
  // kit it dropped and reaching out. Colours and shading are baked into its vertices.
  const person = new THREE.Group();
  person.position.copy(TARGET);
  person.rotation.y = Math.atan2(-ahead.x, -ahead.z) + 0.35;
  land.add(person);
  const seat = patch(0.5); // under the body and the outstretched leg
  seat.scale.set(1.1, 1, 1.7);
  seat.position.set(0.02, 0.03, 0.4);
  person.add(seat);
  const hiker = {
    ready: false, person, onReady: null,
    pose() {},
    screenAt() { return false; },
    headAt(out) { return out.copy(TARGET).setY(TARGET.y + 0.75); },
    setScreen() {},
    showHead() {},
  };
  // The phone's screen: the same SKYTHO app the page's phone shows, drawn here so the hand-over is seamless.
  // Sizes are in hundredths of the screen's width, like the page phone's cqw.
  const SCREEN_W = 512, SCREEN_H = 1108;
  const WORDS = document.documentElement.lang === "en"
    ? { sent: "SOS sent", located: "Your GPS location has been sent.", press: "Press for help" }
    : { sent: "SOS trimis", located: "Locația ta GPS a fost trimisă.", press: "Apasă pentru ajutor" };
  const screenCanvas = document.createElement("canvas");
  screenCanvas.width = SCREEN_W;
  screenCanvas.height = SCREEN_H;
  const screenTexture = new THREE.CanvasTexture(screenCanvas);
  screenTexture.colorSpace = THREE.SRGBColorSpace;
  screenTexture.anisotropy = 4;
  screenTexture.flipY = false; // glTF texture coordinates run top to bottom
  let screenState = "";
  // state: "off" (dark glass), "app" (waiting for the press), "press" (the button held down), "sent"
  const drawScreen = (state) => {
    if (state === screenState) return;
    screenState = state;
    const g = screenCanvas.getContext("2d"), u = SCREEN_W / 100;
    const font = (size, weight) => `${weight} ${size * u}px Archivo, "Segoe UI", system-ui, sans-serif`;
    if (state === "off") {
      g.fillStyle = "#07090a";
      g.fillRect(0, 0, SCREEN_W, SCREEN_H);
      screenTexture.needsUpdate = true;
      return;
    }
    g.fillStyle = "#fff";
    g.fillRect(0, 0, SCREEN_W, SCREEN_H);
    // status bar: time, the camera, the battery
    g.textBaseline = "middle";
    g.textAlign = "left";
    g.fillStyle = "#1d2320";
    g.font = font(3.5, 560);
    g.fillText("14:02", 8 * u, 5 * u);
    g.strokeStyle = "#1d2320";
    g.lineWidth = 0.45 * u;
    g.strokeRect(86 * u, 3.5 * u, 6 * u, 3 * u);
    g.fillRect(86.9 * u, 4.4 * u, 3 * u, 1.2 * u);
    g.fillStyle = "#121517";
    g.beginPath();
    g.arc(50 * u, 4.9 * u, 1.9 * u, 0, Math.PI * 2);
    g.fill();
    // SKYTHO
    g.font = font(5.4, 600);
    const sky = g.measureText("SKY").width, tho = g.measureText("THO").width, x0 = 50 * u - (sky + tho) / 2;
    g.fillStyle = "#15211c";
    g.fillText("SKY", x0, 18.7 * u);
    g.fillStyle = "#d42a32";
    g.fillText("THO", x0 + sky, 18.7 * u);
    // the button, with its two faint rings, and the line under it (laid out as the page's column is)
    g.textAlign = "center";
    const r = 25 * u, cy = ((SCREEN_H / u - 76.8) / 2 + 25) * u, pressed = state === "press";
    for (const [grow, alpha] of [[11, 0.06], [5, 0.13]]) {
      g.fillStyle = `rgba(212, 42, 50, ${alpha})`;
      g.beginPath();
      g.arc(50 * u, cy, r + grow * u, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = pressed ? "#a81d24" : "#d42a32";
    g.beginPath();
    g.arc(50 * u, cy, pressed ? r * 0.95 : r, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#fff";
    g.font = font(13, 640);
    g.fillText("SOS", 50 * u, cy + 0.6 * u);
    const ty = cy + r + 12 * u;
    if (state === "sent") {
      g.fillStyle = "#15211c";
      g.font = font(6.2, 560);
      g.fillText(WORDS.sent, 50 * u, ty + 4.1 * u);
      g.fillStyle = "#56655d";
      g.font = font(4.2, 400);
      g.fillText(WORDS.located, 50 * u, ty + 12.1 * u);
    } else {
      g.fillStyle = "#56655d";
      g.font = font(4.6, 400);
      g.fillText(WORDS.press, 50 * u, ty + 4.1 * u);
    }
    screenTexture.needsUpdate = true;
  };
  drawScreen("off");
  new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).load("/models/hiker.glb", (gltf) => {
    const model = gltf.scene;
    const LOOKS = {
      HK2_Cloth: () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, envMapIntensity: 0.5, side: THREE.DoubleSide }), // the insides of cuffs and collar show
      // skin: a soft sheen at grazing angles, as skin has
      HK2_Skin: () => new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.55, envMapIntensity: 0.5, sheen: 0.35, sheenRoughness: 0.6, sheenColor: 0xffc9b0 }),
      HK2_Nail: () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.25, envMapIntensity: 0.8 }),
      HK2_Lens: () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.06, metalness: 0.7, envMapIntensity: 1.2 }),
      HK2_Phone: () => new THREE.MeshStandardMaterial({ color: 0x24272b, roughness: 0.32, metalness: 0.65, envMapIntensity: 0.9 }),
      HK2_PhoneBack: () => new THREE.MeshStandardMaterial({ color: 0x1a1c1f, roughness: 0.3, metalness: 0.3 }),
      HK2_Screen: () => new THREE.MeshBasicMaterial({ map: screenTexture, toneMapped: false }),
    };
    const looks = new Map();
    let screen = null;
    model.traverse((o) => {
      if (!o.isMesh) return;
      const name = o.material.name;
      if (!looks.has(name)) looks.set(name, (LOOKS[name] || (() => new THREE.MeshStandardMaterial({ color: o.material.color })))());
      o.material = looks.get(name);
      o.frustumCulled = false; // skinned: its bounds move with the pose
      if (name === "HK2_Screen") screen = o;
    });
    // the screen's four corners, on its front face, in the screen's own space (+z faces the person's eyes)
    screen.geometry.computeBoundingBox();
    const box = screen.geometry.boundingBox;
    const corners = [[box.min.x, box.min.y], [box.max.x, box.min.y], [box.max.x, box.max.y], [box.min.x, box.max.y]]
      .map(([x, y]) => v3(x, y, box.max.z));
    const eyes = model.getObjectByName("hk2_eyes"), probe = v3(0, 0, 0);
    // when the camera looks through their eyes, their own head is not in the picture
    const ownHead = ["hk2_head", "hk2_beanie", "hk2_glasses", "hk2_collar"].map((name) => model.getObjectByName(name));
    let headShown = true;
    hiker.showHead = (show) => {
      if (show === headShown) return;
      headShown = show;
      for (const o of ownHead) o.visible = show;
    };
    // the Blender export keeps one animation per moving part; played together they are one clip
    const clip = new THREE.AnimationClip("sos", -1, gltf.animations.flatMap((a) => a.tracks));
    const mixer = new THREE.AnimationMixer(model);
    const action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
    let shown = -1;
    hiker.pose = (frame) => {
      if (frame === shown) return;
      shown = frame;
      mixer.setTime(Math.max(0, frame - 1) / 24);
      person.updateMatrixWorld(true);
    };
    hiker.screenAt = (centre, normal, rect, up) => {
      const m = screen.matrixWorld;
      if (Math.abs(m.determinant()) < 1e-12) return false; // the phone is still in the pocket
      centre.set(0, 0, 0);
      corners.forEach((corner, i) => {
        probe.copy(corner).applyMatrix4(m);
        centre.add(probe);
        if (rect) rect[i].copy(probe);
      });
      centre.multiplyScalar(0.25);
      normal.set(0, 0, 1).transformDirection(m);
      if (up) up.set(0, 1, 0).transformDirection(m);
      return true;
    };
    hiker.headAt = (out) => eyes.getWorldPosition(out);
    hiker.setScreen = drawScreen;
    hiker.screen = screen;
    // the app's lettering needs the page's font: draw the screen again once it has arrived
    document.fonts?.ready.then(() => {
      const state = screenState;
      screenState = "";
      drawScreen(state);
    });
    // compile the materials with this scene's lights before the model joins it, so nothing stalls mid-scroll
    renderer.compileAsync(model, camera, scene).then(() => {
      person.add(model);
      warmUp(); // draw it once, a few pixels large: some drivers finish a shader only at its first real draw
      hiker.pose(1);
      hiker.ready = true;
      hiker.onReady?.();
    });
  }, (e) => progress("hiker", e));

  // Under the kit, once it has been let go
  const kitShadow = patch(0);
  kitShadow.scale.set(0.5, 1, 0.5);
  land.add(kitShadow);

  // SOS: rings spreading over the ledge, and a point of light that reads from far away
  const rings = [0, 1, 2].map((i) => {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.955, 1, 72).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xd42a32, transparent: true, depthWrite: false, fog: false }),
    );
    ring.position.set(TARGET.x, TARGET.y + 0.1, TARGET.z);
    ring.userData.offset = i / 3;
    land.add(ring);
    return ring;
  });
  const dot = document.createElement("canvas");
  dot.width = dot.height = 64;
  const g = dot.getContext("2d");
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(212,42,50,1)");
  grad.addColorStop(0.28, "rgba(212,42,50,0.9)");
  grad.addColorStop(0.32, "rgba(212,42,50,0.28)");
  grad.addColorStop(1, "rgba(212,42,50,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const beacon = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(dot), transparent: true, depthTest: false, sizeAttenuation: false, fog: false }));
  beacon.position.set(TARGET.x, TARGET.y + 0.8, TARGET.z);
  beacon.renderOrder = 5;
  land.add(beacon);

  // Planned route: dots lying on the slope, revealed in order
  const routeLength = Math.hypot(DROP.x - HOME.x, DROP.z - HOME.z);
  const ROUTE_DOTS = Math.floor(routeLength / 1.7);
  const route = new THREE.InstancedMesh(
    new THREE.CircleGeometry(0.26, 16).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xd42a32, transparent: true }),
    ROUTE_DOTS,
  );
  const n = v3(0, 1, 0), upAxis = v3(0, 1, 0);
  for (let i = 0; i < ROUTE_DOTS; i++) {
    const t = (i + 2) / (ROUTE_DOTS + 3);
    const x = HOME.x + (DROP.x - HOME.x) * t, z = HOME.z + (DROP.z - HOME.z) * t;
    groundNormal(x, z, n);
    item.position.set(x, height(x, z), z).addScaledVector(n, 0.14);
    item.quaternion.setFromUnitVectors(upAxis, n);
    item.scale.setScalar(1);
    item.updateMatrix();
    route.setMatrixAt(i, item.matrix);
  }
  route.count = 0;
  land.add(route);

  // ── LIDAR: a real 2D scan, not a picture of one ──────────────────────
  // 720 rays, half a degree apart, in the plane of the spinning head. Each frame casts only the rays the head has
  // turned past since the last one, so the picture builds the way the sensor does: a red beam sweeps round, and
  // each point stays where it hit (anchored to the world, so in flight the trees fall behind as a map), fading
  // as it ages. Close hits are red, far ones blue. The rays meet the slope and the tree crowns.
  const SCAN = 720, SCAN_STEP = (Math.PI * 2) / SCAN;
  const scanPos = new Float32Array(SCAN * 3), scanTime = new Float32Array(SCAN).fill(-1e3), scanNear = new Float32Array(SCAN);
  const scanGeo = new THREE.BufferGeometry();
  scanGeo.setAttribute("position", new THREE.BufferAttribute(scanPos, 3).setUsage(THREE.DynamicDrawUsage));
  scanGeo.setAttribute("aTime", new THREE.BufferAttribute(scanTime, 1).setUsage(THREE.DynamicDrawUsage));
  scanGeo.setAttribute("aNear", new THREE.BufferAttribute(scanNear, 1).setUsage(THREE.DynamicDrawUsage));
  const scanMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, fog: false,
    uniforms: { uTime: { value: 0 }, uOpacity: { value: 0 }, uSize: { value: 60 }, uFade: { value: 0.32 } },
    vertexShader: `attribute float aTime; attribute float aNear; uniform float uTime; uniform float uSize; uniform float uFade;
      varying float vA; varying float vNear;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float age = uTime - aTime;
        vA = age < 0.0 ? 0.0 : exp(-age * uFade);
        vNear = aNear;
        gl_PointSize = clamp(uSize / -mv.z * (0.85 + 0.9 * exp(-age * 5.0)), 2.0, 22.0);
      }`,
    fragmentShader: `uniform float uOpacity; varying float vA; varying float vNear;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        if (d > 0.5) discard;
        vec3 colour = mix(vec3(0.16, 0.5, 0.86), vec3(0.86, 0.14, 0.18), vNear);
        gl_FragColor = vec4(colour, uOpacity * vA * smoothstep(0.5, 0.15, d));
      }`,
  });
  const scanPoints = new THREE.Points(scanGeo, scanMat);
  scanPoints.frustumCulled = false;
  scene.add(scanPoints);
  // the beam: a thin bright rod from the head's window to where it hits
  const beamMat = new THREE.MeshBasicMaterial({ color: 0xe0262f, transparent: true, opacity: 0, depthWrite: false, fog: false });
  const scanBeam = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 6, 1, true).translate(0, 0.5, 0).rotateX(Math.PI / 2), beamMat);
  scanBeam.frustumCulled = false;
  scene.add(scanBeam);

  // what the rays meet out on the mountain: the ground rising to the head's height, and tree crowns
  const TREE_CELL = 6, treeGrid = new Map();
  trees.forEach((tree, i) => {
    const key = `${Math.floor(tree[0] / TREE_CELL)},${Math.floor(tree[2] / TREE_CELL)}`;
    if (!treeGrid.has(key)) treeGrid.set(key, []);
    treeGrid.get(key).push(i);
  });
  const hitOutside = (o, dx, dz, range) => {
    // the slope: a metre at a time, then halve in on the crossing
    let best = range;
    for (let r = 1; r <= range; r += 1) {
      if (height(o.x + dx * r, o.z + dz * r) >= o.y) {
        let lo = r - 1, hi = r;
        for (let i = 0; i < 4; i++) { const m = (lo + hi) / 2; if (height(o.x + dx * m, o.z + dz * m) >= o.y) hi = m; else lo = m; }
        best = hi;
        break;
      }
    }
    const x0 = Math.floor(Math.min(o.x, o.x + dx * best) / TREE_CELL) - 1, x1 = Math.floor(Math.max(o.x, o.x + dx * best) / TREE_CELL) + 1;
    const z0 = Math.floor(Math.min(o.z, o.z + dz * best) / TREE_CELL) - 1, z1 = Math.floor(Math.max(o.z, o.z + dz * best) / TREE_CELL) + 1;
    for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
      for (const i of treeGrid.get(`${cx},${cz}`) || []) {
        const [tx, ty, tz, a] = trees[i], size = 0.6 + a * 0.6, H = 4.6 * size, up = o.y - ty;
        if (up < 0 || up > H) continue;
        // a cone of needles above a short trunk
        const radius = up < H * 0.2 ? 0.14 * size : 1.2 * size * (1 - (up - H * 0.2) / (H * 0.8));
        const px = tx - o.x, pz = tz - o.z, along = px * dx + pz * dz;
        if (along <= 0) continue;
        const off2 = px * px + pz * pz - along * along;
        if (off2 > radius * radius) continue;
        const t = along - Math.sqrt(radius * radius - off2);
        if (t > 0.3 && t < best) best = t;
      }
    }
    return best;
  };
  let scanLast = null;
  // origin: the head (world); heading: the window's direction round the vertical (radians). In the studio there is
  // nothing round the drone to measure: only the beam shows, short, turning with the head.
  const scan = (origin, heading, time, strength, studio) => {
    scanMat.uniforms.uTime.value = time;
    scanMat.uniforms.uOpacity.value = strength;
    scanBeam.visible = strength > 0.01;
    scanPoints.visible = scanBeam.visible && !studio;
    if (strength <= 0.01) {
      scanLast = null;
      return;
    }
    if (studio) {
      scanBeam.position.copy(origin);
      scanBeam.rotation.set(0, heading, 0);
      scanBeam.scale.set(0.004, 0.004, 0.45);
      beamMat.opacity = 0.6 * strength;
      return;
    }
    const range = 14;
    const now = Math.round(heading / SCAN_STEP);
    if (scanLast === null || Math.abs(now - scanLast) > SCAN / 2) scanLast = now - 1;
    const dir = Math.sign(now - scanLast) || 1;
    if (Math.abs(now - scanLast) > 40) scanLast = now - dir * 40; // after a pause, only the newest rays
    let hitAt = range;
    for (let k = scanLast + dir; dir > 0 ? k <= now : k >= now; k += dir) {
      const angle = k * SCAN_STEP, dx = Math.sin(angle), dz = Math.cos(angle);
      const t = hitOutside(origin, dx, dz, range);
      const i = ((k % SCAN) + SCAN) % SCAN;
      if (t < range) {
        scanPos[i * 3] = origin.x + dx * t;
        scanPos[i * 3 + 1] = origin.y;
        scanPos[i * 3 + 2] = origin.z + dz * t;
        scanTime[i] = time;
        scanNear[i] = 1 - Math.min(1, t / 9);
      }
      hitAt = t;
    }
    scanLast = now;
    scanGeo.attributes.position.needsUpdate = scanGeo.attributes.aTime.needsUpdate = scanGeo.attributes.aNear.needsUpdate = true;
    // the beam, at the head's height, along the window's direction
    scanBeam.position.copy(origin);
    scanBeam.rotation.set(0, heading, 0);
    // when the ray meets nothing in range, only a short stub of it shows
    const open = hitAt >= range;
    beamMat.opacity = (open ? 0.25 : 0.7) * strength;
    scanBeam.scale.set(0.012, 0.012, open ? range * 0.25 : hitAt);
  };


  // What the camera sees while searching: a cone from the drone down to the ground
  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(1, 1, 48, 1, true).translate(0, -0.5, 0),
    new THREE.MeshBasicMaterial({ color: 0xf0b400, transparent: true, opacity: 0, side: THREE.DoubleSide, forceSinglePass: true, depthWrite: false, fog: false }),
  );
  scene.add(cone);

  // Studio: an invisible floor that only shows the drone's shadow
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 60).rotateX(-Math.PI / 2),
    new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: shadowUniforms,
      vertexShader: `varying vec3 vPlace; void main(){ vec4 world = modelMatrix * vec4(position, 1.0); vPlace = world.xyz; gl_Position = projectionMatrix * viewMatrix * world; }`,
      fragmentShader: `varying vec3 vPlace; ${SHADOW_GLSL}
        void main(){ gl_FragColor = vec4(0.08, 0.11, 0.14, droneShadow(vPlace, 0.05) * 0.42); }`,
    }),
  );
  floor.visible = false;
  scene.add(floor);

  // Every material is compiled on its first use, which stalls a frame. Use them all once now, drawn into
  // a few pixels while the page is still loading, so nothing stalls later in the middle of a scroll.
  const warmUp = () => {
    const hidden = [], culled = [];
    scene.traverse((o) => {
      if (!o.visible) hidden.push(o);
      if (o.frustumCulled) culled.push(o);
      o.visible = true;
      o.frustumCulled = false;
    });
    const shown = route.count;
    route.count = ROUTE_DOTS;
    castDrone("warm-still", false, true);
    castDrone("warm-flying", true, true);
    outline = null;
    const full = renderer.getSize(new THREE.Vector2());
    renderer.setViewport(0, 0, 4, 4);
    renderer.setScissor(0, 0, 4, 4);
    renderer.setScissorTest(true);
    renderer.render(scene, camera);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, full.x, full.y);
    route.count = shown;
    for (const o of hidden) o.visible = false;
    for (const o of culled) o.frustumCulled = true;
  };

  return {
    renderer, scene, camera, land, floor, warmUp, castDrone,
    HOME, TARGET, DROP, ahead, side, YAW,
    ...droneParts,
    kitShadow, rings, beacon, route, ROUTE_DOTS, scan, cone, hiker, sky,
    groundAt: height,
  };
}
