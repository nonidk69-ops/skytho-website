// The SKYTHO quadcopter, as the team modelled it (Tinkercad → Blender → models/drone.glb).
// The model is the real airframe at its real size in metres; the page shows it larger (SCALE) so it reads
// from far away. Moving parts are separate in the file, each turning about its own origin:
// four propellers, the LIDAR head, and the release mechanism (servo arm, pin) that lets the aid kit fall.
import * as THREE from "../vendor/three.module.min.js";
import { GLTFLoader } from "../vendor/GLTFLoader.js";
import { MeshoptDecoder } from "../vendor/meshopt_decoder.module.js";
import { mergeGeometries } from "../vendor/BufferGeometryUtils.js";

export const SCALE = 3.42; // model metres → world units
export let LEGS = 0.52; // origin height above the ground when standing on its legs (world units)
export let KIT_REST_Y = -0.11; // kit centre under the airframe (model metres)
export const KIT_SHOW = 0.07; // how far the studio view lowers the kit (model metres)
// Points on the airframe (model metres) that the studio views look at
export const PARTS = {};

// Layers used only when the drone's shadow is drawn: what always casts, the still blades, the spinning discs
export const BODY = 1, BLADES = 2, DISCS = 3;

let file = null;

// ── Finishes: carbon bars and legs, a white pearl centre, black propellers under polished caps, a blue battery
// with white lettering, a red LIDAR head on a black base, a black GPS with white lettering, an all-red kit whose
// raised lettering and plus are white, and a Raspberry Pi 5 coloured part by part (the parts are split in Blender).
const std = (o) => new THREE.MeshStandardMaterial({ envMapIntensity: 0.6, ...o });
const coat = (o) => new THREE.MeshPhysicalMaterial({ envMapIntensity: 0.6, clearcoatRoughness: 0.06, ...o });
const metal = (color, roughness) => std({ color, roughness, metalness: 1, envMapIntensity: 1 });
// Twill-woven carbon under a clear coat, drawn from the model's own coordinates: three fibre bands per 2.4 mm cell,
// turning a quarter in alternate cells, slightly glossier along the fibres
const carbon = () => {
  const material = coat({ roughness: 0.42, metalness: 0.15, clearcoat: 1 });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uDark = { value: new THREE.Color(0x0b0c0d) };
    shader.uniforms.uLight = { value: new THREE.Color(0x2c3034) };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vModel;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvModel = position;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vModel; uniform vec3 uDark; uniform vec3 uLight; float weave;")
      .replace("#include <color_fragment>", `#include <color_fragment>
        vec3 q = vModel / 0.0024;
        float cell = mod(floor(q.x) + floor(q.y) + floor(q.z), 2.0);
        weave = mix(0.5 + 0.5 * sin(q.x * 18.85), 0.5 + 0.5 * sin(q.z * 18.85 + q.y * 6.0), cell);
        diffuseColor.rgb *= mix(uDark, uLight, weave);`)
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = mix(0.5, 0.3, weave);");
  };
  material.customProgramCacheKey = () => "carbon";
  return material;
};
const glow = (color) => std({ color: 0x111111, emissive: color, emissiveIntensity: 3 });
const pearl = () => coat({ color: 0xf3f3f0, roughness: 0.17, clearcoat: 0.8 });
const FINISH = {
  DRN_center: pearl,
  DRN_shell: pearl,
  DRN_carbon: carbon,
  DRN_legs: carbon,
  DRN_cap: () => metal(0xd7dbde, 0.16),
  DRN_accent: () => metal(0xd7dbde, 0.16),
  DRN_motor: () => metal(0x2a2d31, 0.34),
  DRN_prop: () => coat({ color: 0x101113, roughness: 0.28, clearcoat: 0.6 }),
  DRN_battery: () => std({ color: 0x1f4f9e, roughness: 0.5 }),
  DRN_battery_text: () => std({ color: 0xf5f6f4, roughness: 0.4 }),
  DRN_lidar_head: () => coat({ color: 0xc01a24, roughness: 0.2, clearcoat: 0.8 }),
  DRN_lidar_base: () => std({ color: 0x121416, roughness: 0.45 }),
  DRN_gps: () => coat({ color: 0x0e0f11, roughness: 0.12, clearcoat: 0.9 }),
  DRN_gps_text: () => std({ color: 0xf5f6f4, roughness: 0.35 }),
  DRN_kit: () => coat({ color: 0xb8121c, roughness: 0.3, clearcoat: 0.5 }),
  DRN_kit_text: () => coat({ color: 0xffffff, roughness: 0.3, clearcoat: 0.4 }),
  DRN_fc_case: () => std({ color: 0x34383d, roughness: 0.5 }),
  DRN_pcb: () => coat({ color: 0x1f7a43, roughness: 0.3, clearcoat: 0.5 }),
  DRN_port: () => std({ color: 0xe2e5e8, roughness: 0.3, metalness: 0.85, envMapIntensity: 1 }),
  DRN_lid: () => metal(0xc9cdd1, 0.22),
  DRN_gold: () => metal(0xd9ad4f, 0.25),
  DRN_connector: () => std({ color: 0xeeeae0, roughness: 0.5 }),
  DRN_chip: () => std({ color: 0x0b0c0d, roughness: 0.3 }),
  DRN_board2: () => std({ color: 0x1d2226, roughness: 0.35 }),
  DRN_servo: () => std({ color: 0x2a5db0, roughness: 0.45 }),
  DRN_glass: () => coat({ color: 0x05080a, roughness: 0.02, clearcoat: 1 }),
  DRN_led_red: () => glow(0xff2020),
  DRN_led_green: () => glow(0x20ff60),
  // motors: a dark anodised bell with a bright band at its foot, on a dark clamp; a polished nut on each propeller
  DRN_bell: () => std({ color: 0x1c1e21, roughness: 0.3, metalness: 0.75, envMapIntensity: 0.9 }),
  DRN_bell_ring: () => metal(0xb9bec4, 0.24),
  DRN_stator: () => std({ color: 0x26292d, roughness: 0.42, metalness: 0.5 }),
  // the 4K camera, white with a black face, in a gimbal anodised red with bright hubs
  DRN_cam_body: () => coat({ color: 0xf1f1ee, roughness: 0.3, clearcoat: 0.5 }),
  DRN_cam_face: () => std({ color: 0x16181b, roughness: 0.35 }),
  DRN_cam_ring: () => metal(0xc9cdd1, 0.22),
  DRN_gimbal: () => coat({ color: 0xc01a24, roughness: 0.3, metalness: 0.35, clearcoat: 0.6 }),
  DRN_gimbal_hub: () => metal(0xc9cdd1, 0.2),
  DRN_lens: () => std({ color: 0x0a1220, roughness: 0.04, metalness: 0.3, envMapIntensity: 1.4 }),
  DRN_rec: () => glow(0xff2a2a),
  DRN_ribbon: () => std({ color: 0xc98a2c, roughness: 0.45 }),
  DRN_label: () => std({ color: 0xf2f2f0, roughness: 0.5 }),
  // the LIDAR's optical window and its two lenses
  DRN_lidar_window: () => coat({ color: 0x07090c, roughness: 0.05, clearcoat: 1, envMapIntensity: 1.1 }),
  DRN_lidar_lens: () => std({ color: 0x1a1030, roughness: 0.03, metalness: 0.3, envMapIntensity: 1.4 }),
};
// The studio picks one part at a time: everything further than a radius from it fades towards the paper colour.
export const FOCUS = { uFocus: { value: new THREE.Vector3() }, uFocusR: { value: 1 }, uFocusOn: { value: 0 }, uGhost: { value: new THREE.Color(0xe9ece8) } };
const focusable = (material) => {
  const before = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    before?.call(material, shader, renderer);
    Object.assign(shader.uniforms, FOCUS);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vFocusWorld;")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvFocusWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vFocusWorld; uniform vec3 uFocus; uniform float uFocusR; uniform float uFocusOn; uniform vec3 uGhost;")
      .replace("#include <dithering_fragment>", `#include <dithering_fragment>
        float away = smoothstep(uFocusR, uFocusR * 1.7, distance(vFocusWorld, uFocus)) * uFocusOn;
        gl_FragColor.rgb = mix(gl_FragColor.rgb, uGhost, away * 0.72);`);
  };
  const key = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => (key ? key() : "") + "|focus";
  return material;
};
// Anything else in the file keeps its own colour
const plainFrom = (m) => std({ color: m.color, roughness: m.roughness, metalness: m.metalness });

// Download progress for the page's loading screen (servers that compress the file give no total: estimate it)
export const progress = (name, e) =>
  dispatchEvent(new CustomEvent("skytho:progress", { detail: { name, fraction: e.lengthComputable && e.total ? e.loaded / e.total : Math.min(0.95, e.loaded / 820000) } }));

// Fetch and decode the model; buildDrone() needs it, so the page waits for this first.
export async function loadDrone() {
  file = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync("/models/drone.glb", (e) => progress("drone", e));
}

export function buildDrone() {
  const source = file.scene;
  // The file's front (the camera side) faces +z; the page flies the drone with its front towards -z.
  const model = new THREE.Group();
  model.rotation.y = Math.PI;
  for (const child of [...source.children[0].children]) model.add(child);
  const part = (name) => model.getObjectByName(name);

  // The colours and finishes chosen in Blender, by material name (the file carries the names; the looks live here)
  const looks = new Map();
  const look = (m) => {
    if (!looks.has(m.name)) {
      const finish = focusable((FINISH[m.name] || (() => plainFrom(m)))());
      finish.name = m.name;
      looks.set(m.name, finish);
    }
    return looks.get(m.name);
  };
  model.traverse((o) => {
    if (!o.isMesh) return;
    o.material = look(o.material);
    // occlusion baked in Blender into every vertex: darker in the gaps between parts, untouched in the open
    if (o.geometry.attributes.color) o.material.vertexColors = true;
  });

  // Propellers: blades fade while spinning, a soft disc takes their place
  const discMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: { uOpacity: { value: 0 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform float uOpacity; varying vec2 vUv; void main(){ float r = distance(vUv, vec2(0.5)) * 2.0; gl_FragColor = vec4(vec3(0.07), uOpacity * smoothstep(1.0, 0.9, r) * smoothstep(0.08, 0.5, r)); }`,
  });
  const bladeMats = new Map();
  const props = ["prop_1", "prop_2", "prop_3", "prop_4"].map((name, i) => {
    const prop = part(name);
    let reach = 0;
    prop.traverse((o) => {
      if (!o.isMesh) return;
      // blades get their own see-through copies (they fade while spinning); the nut on top stays solid
      const name = o.material.name || "";
      if (name === "DRN_prop") {
        if (!bladeMats.has(name)) {
          const own = focusable((FINISH[name] || (() => plainFrom(o.material)))());
          own.transparent = true;
          own.vertexColors = !!o.geometry.attributes.color;
          bladeMats.set(name, own);
        }
        o.material = bladeMats.get(name);
      } else {
        o.material = look(o.material);
        if (o.geometry.attributes.color) o.material.vertexColors = true;
      }
      o.layers.enable(BLADES);
      o.geometry.computeBoundingSphere();
      reach = Math.max(reach, o.geometry.boundingSphere.radius);
    });
    const blades = new THREE.Box3();
    prop.traverse((o) => o.isMesh && blades.union(o.geometry.boundingBox || (o.geometry.computeBoundingBox(), o.geometry.boundingBox)));
    const disc = new THREE.Mesh(new THREE.CircleGeometry(reach, 48).rotateX(-Math.PI / 2), discMat);
    disc.position.y = 0.004;
    disc.layers.enable(DISCS);
    prop.add(disc);
    // on show in the studio the blades stand across the arm (tangential), so they never hide the motor under them
    const size = blades.getSize(new THREE.Vector3());
    const across = size.x > size.z ? Math.atan2(prop.position.x, prop.position.z) : Math.atan2(-prop.position.z, prop.position.x);
    prop.userData = { dir: i % 2 ? -1 : 1, rest: Math.random() * 3, across };
    return prop;
  });

  const kit = part("kit");
  const kitMeshes = [];
  kit.traverse((o) => o.isMesh && kitMeshes.push(o));
  const kitBox = new THREE.Box3().setFromObject(kit, true);
  const kitHalf = (kitBox.max.y - kitBox.min.y) / 2;
  KIT_REST_Y = kit.position.y;

  // Everything else casts the drone's shadow
  model.traverse((o) => {
    if (o.isMesh && o.layers.mask === 1) o.layers.enable(BODY);
  });

  // Standing height: from the origin down to the feet
  const body = part("body");
  const bodyBox = new THREE.Box3().setFromObject(body, true);
  LEGS = -bodyBox.min.y * SCALE;

  // The parts that never move (the airframe, the four motors, the camera) are joined into one mesh per finish:
  // the same picture in far fewer draws
  model.updateMatrixWorld(true);
  const toModel = model.matrixWorld.clone().invert(), local = new THREE.Matrix4();
  const byFinish = new Map();
  for (const name of ["body", "motor_1", "motor_2", "motor_3", "motor_4", "camera"]) {
    const piece = part(name);
    if (!piece) continue;
    piece.traverse((o) => {
      if (!o.isMesh) return;
      local.multiplyMatrices(toModel, o.matrixWorld);
      // the file's attributes are packed (quantised, interleaved): unpack them to plain floats first
      const g = new THREE.BufferGeometry();
      for (const key of ["position", "normal", "color"]) {
        const at = o.geometry.getAttribute(key);
        if (!at) continue;
        const out = new Float32Array(at.count * at.itemSize);
        const read = [at.getX, at.getY, at.getZ, at.getW].slice(0, at.itemSize);
        for (let i = 0; i < at.count; i++) read.forEach((get, c) => (out[i * at.itemSize + c] = get.call(at, i)));
        g.setAttribute(key, new THREE.BufferAttribute(out, at.itemSize));
      }
      if (o.geometry.index) g.setIndex(new THREE.BufferAttribute(Uint32Array.from(o.geometry.index.array), 1));
      g.applyMatrix4(local);
      if (!byFinish.has(o.material)) byFinish.set(o.material, []);
      byFinish.get(o.material).push(g.index ? g : g.setIndex([...Array(g.attributes.position.count).keys()]));
    });
    piece.removeFromParent();
  }
  for (const [finish, list] of byFinish) {
    const joined = new THREE.Mesh(mergeGeometries(list), finish);
    joined.name = "airframe_" + finish.name;
    joined.layers.enable(BODY);
    model.add(joined);
  }

  // Studio points, turned the way the model is turned
  const point = (name) => part(name).position.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI).toArray();
  for (const name of ["computer", "camera", "lidar", "kit", "motor", "gps", "battery"]) PARTS[name] = point("part_" + name);

  const servoArm = part("servo_arm"), releasePin = part("release_pin");
  const release = { servoArm, releasePin, pinRest: releasePin.position.z, armRest: servoArm.rotation.x };

  model.scale.setScalar(SCALE);
  const drone = new THREE.Group();
  drone.add(model);

  return { drone, props, kit, kitMeshes, lidarHead: part("lidar"), gimbalCamera: part("camera"), bladeMats: [...bladeMats.values()], discMat, kitHalf, release };
}
