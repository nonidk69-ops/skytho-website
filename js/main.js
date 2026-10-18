// SKYTHO 3D — the direction of the film.
// The page is a list of "shots" (<section data-shot>). Scrolling through a shot moves its progress p
// from 0 to 1; each shot places the drone and the camera for that p. Shots that follow each other in
// the same place are continuous; jumps between far-apart places are hidden by a title band or a dip.
// Words are pinned while their moment plays: they light up as you scroll, rest, and only then move on.
import * as THREE from "../vendor/three.module.min.js";
import { buildWorld } from "./world.js";
import { SCALE, LEGS, KIT_REST_Y, KIT_SHOW, PARTS, FOCUS, loadDrone } from "./drone.js";
import { smoothScroll, sharpness } from "./scroll.js";

const $ = (id) => document.getElementById(id);
const canvas = $("scene");
const params = new URLSearchParams(location.search);
const still = params.has("still"); // no easing, for screenshots
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const EN = document.documentElement.lang === "en";

// The loading screen: a bar for the two models' download, gone once the first frame is drawn and the person is in
const loader = $("loader"), loaderBar = $("loader-bar"), got = { drone: 0, hiker: 0 };
const showLoad = (extra = 0) => loaderBar && (loaderBar.style.transform = `scaleX(${(0.08 + 0.42 * got.drone + 0.42 * got.hiker + extra).toFixed(3)})`);
addEventListener("skytho:progress", (e) => {
  got[e.detail.name] = Math.max(got[e.detail.name], e.detail.fraction);
  showLoad();
});
const doneLoading = () => {
  if (!loader || loader.classList.contains("is-done")) return;
  showLoad(0.08);
  loader.classList.add("is-done");
  loader.setAttribute("aria-busy", "false");
};
setTimeout(doneLoading, 25000); // whatever happens, the page is never hidden for long
showLoad();

let world;
try {
  await loadDrone(); // the team's model of the drone; the scene is built around it
  world = buildWorld(canvas);
} catch (error) {
  // No WebGL: the page reads as a plain article, and nothing locks
  console.error(error);
  document.documentElement.classList.add("no-webgl");
  doneLoading();
  for (const block of document.querySelectorAll("[data-pin]")) block.classList.add("no-pin");
}
if (world) direct(world);

function direct(W) {
  const { renderer, scene, camera, HOME, TARGET, DROP, ahead, side, YAW, groundAt, drone, props, kit } = W;
  const V = THREE.Vector3;
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = (t) => t * t * (3 - 2 * t);
  const easeIn = (t) => t * t;
  const smooth = (a, b, v) => ease(clamp01((v - a) / (b - a)));
  const UP = new V(0, 1, 0);
  const a = new V(), b = new V(), c = new V(), tangent = new V(), eye = new V();
  const facing = new V(), left = new V(), right = new V(), shoulder = new V(), round = new V(), normal = new V(), head = new V();
  const screenAt = new V(), sight = new V(), behind = new V(), beside = new V(), pov = new V(), swing = new V();
  const scanFrom = new V(), scanDir = new V();
  let vw = innerWidth, vh = innerHeight;

  // ── Fixed points of the story ─────────────────────────────────────────
  const G0 = HOME.clone().setY(HOME.y + LEGS); // drone standing in the meadow
  const REST_YAW = YAW + Math.PI - 0.05; // waiting, it faces away from the mountain
  const CRUISE = 8.5, TAKEOFF = 3.2;
  const HOVER_AGL = 5.4, DELIVER_AGL = 2.0;
  const OVERHEAD = DROP.clone().addScaledVector(ahead, -2.2).setY(DROP.y + HOVER_AGL + 7);
  const TAG_PERSON = TARGET.clone().setY(TARGET.y + 1.25);
  // The person (sitting, facing the meadow): which way they look, and their left and right
  facing.set(0, 0, 1).applyQuaternion(W.hiker.person.quaternion);
  left.set(1, 0, 0).applyQuaternion(W.hiker.person.quaternion);
  right.copy(left).negate();
  // S.anim is the frame of the person's scene. In the sos shot frames 1-96 play while p goes ANIM_FROM → ANIM_TO:
  // the screen lights at frame 36, the thumb touches SOS at 58 and lets go at 62. Frames 97-150 belong to the drone's
  // arrival: they hear it (102), look up at it (112), follow it down (122), see the kit (132) and reach for it (150)
  const ANIM_FROM = 0.06, ANIM_TO = 0.38, at = (frame) => ANIM_FROM + ((ANIM_TO - ANIM_FROM) * (frame - 1)) / 95;
  const SCREEN_ON = at(36), PRESSED = at(58), RELEASED = at(62);
  const SCREEN_STATES = ["off", "app", "press", "sent"];
  const SCREEN_H_M = 0.1469, ZOOM_FOV = 41; // the phone screen's height (m); the lens when the page's phone takes over
  const STUDIO = new V(0, 700, 0), STUDIO_YAW = 0.4;

  // Flight path: straight over the map, keeping a safe height above the ground ahead
  const SAMPLES = 96, groundProfile = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const t = i / SAMPLES;
    groundProfile.push(groundAt(lerp(HOME.x, DROP.x, t), lerp(HOME.z, DROP.z, t)));
  }
  let alt = groundProfile.map((_, i) => Math.max(...groundProfile.slice(Math.max(0, i - 5), i + 6)) + CRUISE);
  for (let pass = 0; pass < 3; pass++) {
    alt = alt.map((_, i) => {
      const window = alt.slice(Math.max(0, i - 4), i + 5);
      return window.reduce((sum, v) => sum + v, 0) / window.length;
    });
  }
  const pathPoints = [];
  for (let i = 0; i <= SAMPLES; i += 4) {
    const t = i / SAMPLES, landing = smooth(0.86, 1, t);
    const climbing = lerp(HOME.y + TAKEOFF, alt[i], smooth(0, 0.16, t));
    pathPoints.push(new V(lerp(HOME.x, DROP.x, t), lerp(climbing, DROP.y + HOVER_AGL + 1.6, landing), lerp(HOME.z, DROP.z, t)));
  }
  const curve = new THREE.CatmullRomCurve3(pathPoints);
  const P0 = curve.getPointAt(0), HOVER = curve.getPointAt(1);

  // ── State of one frame ────────────────────────────────────────────────
  const S = {
    pos: new V(), yaw: 0, pitch: 0, air: 0, still: false, kit: 0, kitLower: 0,
    cam: new V(), look: new V(), focus: new V(), ax: 0.5, ay: 0.5, fov: 32,
    route: 0, lidar: 0, detect: 0, sos: 0, beacon: 0, studio: false, hud: 0, spec: -1,
    tagAt: null, tagText: "", tagOp: 0, pinAt: new V(), pinOp: 0,
    anim: 1, screen: 0, phone: -1, minEye: 0.8, release: 0, // the person's frame, their phone's screen, the page phone, the kit's release
    routeOp: 1, // the flight plan's opacity
    focusOn: 0, // the studio: how much the rest of the drone fades round the part on show
    up: new V(0, 1, 0), // which way is up for the camera (it leans to read the phone)
  };
  const reset = () => {
    Object.assign(S, { yaw: YAW, pitch: 0, air: 0, still: false, kit: 0, kitLower: 0, ax: 0.5, ay: 0.5, fov: 32, route: 0, lidar: 0, detect: 0, sos: 0, beacon: 0, studio: false, hud: 0, spec: -1, tagAt: null, tagOp: 0, pinOp: 0, anim: 1, screen: 0, phone: -1, minEye: 0.8, release: 0, focusOn: 0, routeOp: 1 });
    S.up.copy(UP);
  };
  // Where on screen the subject sits: text takes the other side (or the bottom, on phones)
  const frame = (x, y, yPhone = 0.36) => {
    const wide = vw / vh > 0.9;
    S.ax = wide ? x : 0.5;
    S.ay = wide ? y : yPhone;
  };

  // The studio's stops. spec: the card it shows; az/el/r: where the camera stands round the part (radians, units);
  // aim: how far the view turns from the drone's centre to the part; reach: the radius left in full colour (model metres).
  const VIEWS = [
    { part: "computer", spec: 0, az: 0.75, el: 0.62, r: 2.0, aim: 0.9, reach: 0.085 },
    { part: "camera", spec: 1, az: 0.3, el: 0.08, r: 1.1, aim: 1, reach: 0.04 },
    { part: "lidar", spec: 2, az: -0.9, el: 0.3, r: 1.4, aim: 1, reach: 0.05 },
    { part: "motor", spec: 3, az: 2.35, el: 0.32, r: 1.2, aim: 1, reach: 0.04 },
    { part: "gps", spec: 4, az: 3.0, el: 0.62, r: 1.4, aim: 1, reach: 0.04 },
    { part: "battery", spec: 5, az: 0.55, el: -0.06, r: 1.7, aim: 0.95, reach: 0.065 },
    { part: "kit", spec: 6, az: -3.75, el: -0.3, r: 2.6, aim: 0.8, reach: 0.08 },
  ];
  const partPoint = (name, out) => {
    out.fromArray(PARTS[name]);
    if (name === "kit") out.y -= S.kitLower;
    return out.multiplyScalar(SCALE).applyAxisAngle(UP, STUDIO_YAW).add(STUDIO);
  };

  // ── The shots ─────────────────────────────────────────────────────────
  // Each one finishes its move a little before its words leave, so there is a moment of rest.
  const shots = {
    // The drone waits in the meadow; the camera lifts to show how far away the mountain is.
    intro(p) {
      S.pos.copy(G0);
      S.yaw = REST_YAW;
      const e1 = ease(clamp01(p / 0.4)), e2 = ease(clamp01((p - 0.3) / 0.48));
      a.copy(G0).addScaledVector(ahead, -lerp(3.3, 3.0, e1)).addScaledVector(side, lerp(1.9, 0.6, e1)).setY(HOME.y + lerp(0.4, 0.62, e1));
      b.copy(G0).addScaledVector(ahead, -12).addScaledVector(side, 3.5).setY(HOME.y + 3.0);
      S.cam.lerpVectors(a, b, e2);
      a.copy(G0);
      b.copy(G0).addScaledVector(ahead, 40).setY(HOME.y + 3.4);
      S.look.lerpVectors(a, b, e2);
      S.focus.copy(G0);
      S.fov = lerp(32, 40, e2);
      frame(lerp(0.69, 0.5, e2), lerp(0.6, 0.5, e2), lerp(0.36, 0.46, e2));
      S.beacon = S.sos = smooth(0.6, 0.74, p);
      S.tagAt = TAG_PERSON;
      S.tagText = EN ? "You are here, 1.5 km away" : "Aici ești tu, la 1,5 km";
      S.tagOp = smooth(0.68, 0.8, p);
    },

    // On the mountain: the camera comes to the person, holding the hurt leg, who takes the phone from the chest
    // pocket. While it comes up the camera goes round their right side to look over the shoulder, and sees the
    // thumb press SOS. Then it moves in along their line of sight until the screen is the size of the phone on
    // the page, which takes over: the conversation with AMI plays in it.
    sos(p) {
      S.pos.copy(G0);
      S.yaw = REST_YAW;
      S.anim = 1 + 95 * clamp01((p - ANIM_FROM) / (ANIM_TO - ANIM_FROM));
      S.screen = p < SCREEN_ON ? 0 : p < PRESSED - 0.004 ? 1 : p < RELEASED ? 2 : 3;
      S.sos = smooth(PRESSED, PRESSED + 0.05, p);
      S.phone = p;
      S.minEye = 0.2;
      const near = ease(clamp01(p / 0.1)), closer = ease(clamp01((p - 0.09) / 0.09));
      const turn = ease(clamp01((p - 0.165) / 0.07)), zoom = ease(clamp01((p - 0.275) / 0.085));
      // from afar to a three-quarter view from the hurt side, then a little closer while the hand goes to the pocket
      a.copy(TARGET).addScaledVector(ahead, -7).addScaledVector(side, -4.8).setY(TARGET.y + 2.8);
      b.copy(TARGET).addScaledVector(facing, 2.4).addScaledVector(left, 1.3).setY(TARGET.y + 0.9);
      c.copy(TARGET).addScaledVector(facing, 1.55).addScaledVector(left, 0.55).setY(TARGET.y + 0.78);
      S.cam.lerpVectors(a, b, near).lerp(c, closer);
      a.copy(TARGET).setY(TARGET.y + 0.3);
      b.copy(TARGET).addScaledVector(facing, 0.3).setY(TARGET.y + 0.42);
      S.look.lerpVectors(a, b, near);
      S.fov = lerp(32, 30, near);
      S.up.copy(UP);
      S.focus.copy(TARGET);
      if (turn > 0 && W.hiker.ready) {
        W.hiker.pose(S.anim);
        if (W.hiker.screenAt(screenAt, normal, null, tangent)) {
          W.hiker.headAt(head);
          // over the right shoulder: behind and above the right ear, the head to one side, the screen below
          sight.subVectors(head, screenAt).normalize();
          shoulder.copy(head).addScaledVector(sight, 0.15).addScaledVector(right, 0.3);
          shoulder.y += 0.1;
          // then round the right side of the head and in between the face and the phone: what they see, with
          // the screen square on and as big as the page's phone
          const across = (phoneH * 0.967) / vh, reach = SCREEN_H_M / 2 / Math.tan((ZOOM_FOV * Math.PI) / 360) / across;
          if (zoom > 0) {
            beside.copy(head).addScaledVector(right, 0.2).addScaledVector(sight, 0.04);
            beside.y += 0.03;
            pov.copy(normal).multiplyScalar(reach).add(screenAt);
            swing.copy(shoulder).addScaledVector(right, 0.04).addScaledVector(sight, -0.05);
            const v = 1 - zoom, j0 = v * v * v, j1 = 3 * v * v * zoom, j2 = 3 * v * zoom * zoom, j3 = zoom * zoom * zoom;
            shoulder.multiplyScalar(j0).addScaledVector(swing, j1).addScaledVector(beside, j2).addScaledVector(pov, j3);
          }
          // the way round to the shoulder: out to their front right, then behind the right shoulder
          round.copy(TARGET).addScaledVector(right, 1.5).addScaledVector(facing, 0.9).setY(TARGET.y + 1.0);
          behind.copy(TARGET).addScaledVector(right, 0.95).addScaledVector(facing, -0.45).setY(TARGET.y + 1.15);
          const u = 1 - turn, k0 = u * u * u, k1 = 3 * u * u * turn, k2 = 3 * u * turn * turn, k3 = turn * turn * turn;
          S.cam.multiplyScalar(k0).addScaledVector(round, k1).addScaledVector(behind, k2).addScaledVector(shoulder, k3);
          S.look.lerp(screenAt, turn);
          S.focus.lerp(screenAt, turn);
          S.fov = lerp(lerp(30, 34, turn), ZOOM_FOV, zoom);
          S.sos *= 1 - zoom;
          // and turns with the phone, so its screen ends up straight, the way the page shows it
          S.up.lerp(tangent, zoom).normalize();
        }
      }
      frame(0.66, 0.53, 0.36);
    },

    // The propellers start, the drone lifts and turns towards the mountain, then flies the planned route.
    flight(p) {
      const CLIMB = 0.3;
      S.anim = 96;
      S.screen = 3;
      S.air = clamp01((p - 0.05) / 0.05);
      S.route = clamp01((p - 0.08) / 0.1);
      S.hud = 1;
      S.sos = 1 - smooth(0.85, 1, p); // the rings over the person fade before the drone gets there
      let u = 0;
      if (p < CLIMB) {
        S.pos.lerpVectors(G0, P0, ease(clamp01((p - 0.12) / 0.15)));
        S.yaw = lerp(REST_YAW, YAW, ease(clamp01((p - 0.1) / 0.15)));
      } else {
        const t = (p - CLIMB) / (1 - CLIMB);
        u = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        curve.getPointAt(u, S.pos);
        curve.getTangentAt(u, tangent);
        S.yaw = Math.atan2(-tangent.x, -tangent.z);
        S.pitch = -0.24 * Math.sin(Math.PI * u);
      }
      a.copy(G0).addScaledVector(ahead, -8).addScaledVector(side, 2.6).setY(HOME.y + 1.1); // behind, watching it lift
      b.copy(S.pos).addScaledVector(ahead, -4.3).addScaledVector(side, lerp(-1.7, 3.1, u)); // chase
      b.y += lerp(1.15, 1.9, u);
      const chase = smooth(0.2, 0.44, p);
      S.cam.lerpVectors(a, b, chase);
      S.look.copy(S.pos).addScaledVector(ahead, lerp(0, 2.2, chase) * (1 - u * 0.8));
      S.focus.copy(S.pos);
      S.fov = lerp(32, 38, Math.sin(Math.PI * u));
      frame(0.66, lerp(0.42, 0.5, chase));
      S.lidar = smooth(0.52, 0.6, p) * (1 - smooth(0.86, 0.94, p));
      S.beacon = 0.85 * (1 - smooth(0.6, 0.85, p));
    },

    // Above the ledge: the camera rises to look straight down, the way the drone's own camera does.
    detect(p) {
      S.air = S.route = S.hud = 1;
      S.sos = 0; // no rings round the person once the drone is over them
      S.routeOp = 1 - smooth(0.05, 0.4, p); // the flight plan, done with: it fades
      S.anim = 96 + 6 * smooth(0.2, 0.45, p) + 10 * smooth(0.5, 0.95, p); // hears it, then looks up at it overhead
      S.screen = 3;
      const e = ease(p), over = ease(clamp01(p / 0.55));
      S.pos.copy(HOVER).setY(lerp(HOVER.y, DROP.y + HOVER_AGL, e));
      S.yaw = YAW + 0.5 * e;
      a.copy(S.pos).addScaledVector(ahead, -4.3).addScaledVector(side, 3.1);
      a.y += 1.9;
      b.copy(S.pos).addScaledVector(ahead, -2.2);
      b.y += 7;
      S.cam.lerpVectors(a, b, over);
      a.copy(S.pos).addScaledVector(ahead, 0.44);
      b.copy(TARGET).lerp(DROP, 0.5);
      S.look.lerpVectors(a, b, over);
      S.focus.copy(DROP);
      frame(0.66, 0.5, 0.38);
      S.detect = smooth(0.45, 0.62, p);
    },

    // The drone comes down, lets the kit go beside the person, and backs off.
    deliver(p) {
      S.air = S.route = S.hud = 1;
      S.routeOp = 0;
      S.anim = 112 + 10 * smooth(0, 0.36, p) + 10 * smooth(0.42, 0.6, p) + 18 * smooth(0.62, 0.92, p); // follows it down, the kit, reaches
      S.screen = 3;
      const down = ease(clamp01(p / 0.36)), rise = ease(clamp01((p - 0.62) / 0.22)), low = ease(clamp01(p / 0.4));
      S.pos.copy(DROP).setY(lerp(DROP.y + HOVER_AGL, DROP.y + DELIVER_AGL, down) + rise * 0.6);
      S.yaw = YAW + 0.5;
      S.release = smooth(0.33, 0.4, p); // the servo pulls the pin, then the kit falls
      S.kit = easeIn(clamp01((p - 0.4) / 0.14));
      // above the ledge, looking down a little: the person, the kit and the drone all stay in frame,
      // and stepping back for a narrow screen moves the camera up and out over the valley, not into the slope
      b.copy(TARGET).addScaledVector(ahead, -7.4).addScaledVector(side, 4.2).setY(TARGET.y + 3.4);
      S.cam.lerpVectors(OVERHEAD, b, low);
      a.copy(TARGET).lerp(DROP, 0.5);
      b.copy(a).setY(a.y + 0.5);
      S.look.lerpVectors(a, b, low);
      S.focus.copy(DROP);
      S.fov = lerp(32, 34, low);
      frame(0.66, lerp(0.5, 0.56, low), 0.38);
      S.detect = 1 - smooth(0, 0.1, p);
    },

    // Out of the landscape: the drone alone, turned to show one part at a time.
    studio(p) {
      S.studio = true;
      S.air = 1;
      S.still = true; // floating on show, propellers stopped so their black blades and polished caps can be seen
      S.pos.copy(STUDIO);
      S.yaw = STUDIO_YAW;
      // a stop holds still for the first 55% of its stretch, then the camera travels to the next
      const seg = Math.min(p * 1.04 * VIEWS.length, VIEWS.length - 1e-4), i = Math.floor(seg);
      const j = Math.min(i + 1, VIEWS.length - 1), w = smooth(0.55, 1, seg - i);
      const from = VIEWS[i], to = VIEWS[j];
      const weight = (name) => (from.part === name ? 1 - w : 0) + (to.part === name ? w : 0);
      S.kitLower = KIT_SHOW * Math.min(1, weight("kit"));
      partPoint(from.part, a);
      partPoint(to.part, b);
      S.look.copy(STUDIO).lerp(c.lerpVectors(a, b, w), lerp(from.aim, to.aim, w));
      // travelling between two parts, the camera swings out a little so it never passes through the drone
      const azimuth = STUDIO_YAW + Math.PI + lerp(from.az, to.az, w), elevation = lerp(from.el, to.el, w);
      const radius = lerp(from.r, to.r, w) + Math.sin(Math.PI * w) * (from.part === to.part ? 0 : 0.9);
      S.cam.set(
        S.look.x + Math.sin(azimuth) * Math.cos(elevation) * radius,
        S.look.y + Math.sin(elevation) * radius,
        S.look.z + Math.cos(azimuth) * Math.cos(elevation) * radius,
      );
      S.focus.copy(c);
      S.spec = (w > 0.5 ? to : from).spec;
      S.pinAt.copy(w > 0.5 ? b : a);
      S.pinOp = (from.spec === to.spec ? 1 : Math.abs(1 - 2 * w)) * smooth(0, 0.03, p);
      // everything but the part fades towards the paper
      FOCUS.uFocus.value.copy(c);
      FOCUS.uFocusR.value = lerp(from.reach, to.reach, w) * SCALE;
      S.focusOn = smooth(0.0, 0.04, p) * (1 - smooth(0.97, 1, p));
      S.lidar = Math.min(1, weight("lidar"));
      S.fov = 30;
      frame(0.64, 0.46, 0.32);
    },
  };

  // ── Words that light up as you scroll ─────────────────────────────────
  // data-reveal="a b": the text's words turn on one by one while a number goes from a to b.
  // data-steps="a b":  the element's children do. With data-focus only the newest one is marked.
  // For a film beat the number is 0 when the beat arrives and 1 when it leaves;
  // for a pinned block it is 0 when the block locks and 1 when it lets go.
  const readersIn = (root) =>
    [...root.querySelectorAll("[data-reveal], [data-steps]")].map((el) => {
      let parts;
      if (el.hasAttribute("data-reveal")) {
        const words = el.textContent.trim().split(/\s+/);
        el.textContent = "";
        parts = words.map((word, i) => {
          const span = document.createElement("span");
          span.className = "w";
          span.textContent = word;
          el.append(span, i < words.length - 1 ? " " : "");
          return span;
        });
      } else {
        parts = [...el.children];
        for (const part of parts) part.classList.add("step");
      }
      const [from, to] = (el.dataset.reveal || el.dataset.steps).split(" ").map(Number);
      return { parts, from, to, focus: el.hasAttribute("data-focus"), on: 0 };
    });
  const read = (reader, h) => {
    const on = Math.round(clamp01((h - reader.from) / (reader.to - reader.from)) * reader.parts.length);
    if (on === reader.on) return;
    for (let i = Math.min(on, reader.on); i < Math.max(on, reader.on); i++) reader.parts[i].classList.toggle("on", i < on);
    if (reader.focus) {
      reader.parts[reader.on - 1]?.classList.remove("now");
      reader.parts[on - 1]?.classList.add("now");
    }
    reader.on = on;
  };

  // ── Page ↔ timeline ───────────────────────────────────────────────────
  const dip = $("dip"), hud = $("hud"), hudDist = $("hud-dist"), tag = $("tag"), tagLabel = tag.querySelector("span"), detect = $("detect"), pin = $("pin");
  const bar = document.querySelector(".bar");
  const specs = [...document.querySelectorAll("[data-spec]")], specSteps = [...document.querySelectorAll(".spec-steps li")];
  const pinLabel = pin.querySelector(".pin-label"), overlay = document.querySelector(".overlay");
  const film = [...document.querySelectorAll("[data-shot]")].map((el) => ({
    el,
    play: shots[el.dataset.shot],
    dips: el.hasAttribute("data-dip"),
    beats: [...el.querySelectorAll(".beat")].map((beat) => {
      const range = beat.dataset.range ? beat.dataset.range.split(" ").map(Number) : null;
      return { el: beat, moves: !!range, from: range ? range[0] : 0, to: range ? range[1] : 1, readers: readersIn(beat) };
    }),
    start: 0, end: 0, length: 1, stuckFrom: 0, stuckTo: 1,
  }));
  const pins = [...document.querySelectorAll("[data-pin]")].map((el) => ({
    el, stick: el.firstElementChild, solid: el.classList.contains("band"), readers: readersIn(el),
    from: 0, travel: 1, top: 0, bottom: 0,
  }));
  const shotNamed = (name) => film.find((shot) => shot.el.dataset.shot === name);

  // The phone on the page: it appears exactly over the 3D phone's screen, settles into its place,
  // turns from "SOS sent" to the chat, and the chat's messages arrive one by one as you scroll
  const phone = $("phone"), chat = readersIn(phone)[0];
  const corners = [new V(), new V(), new V(), new V()];
  let phoneW = 300, phoneH = 612, phoneRelease = 0;
  const PHONE_IN = 0.37, SETTLED = 0.45, CHAT_FROM = 0.47, CHAT_TO = 0.9;
  const sizePhone = () => {
    const wide = vw / vh > 0.9;
    phoneH = Math.round(wide ? Math.min((vh - barHeight - 64) * 0.86, 720) : Math.min(vh * 0.62, (vw - 80) / 0.49, 600));
    phoneW = Math.round(phoneH * 0.49);
    phone.style.width = `${phoneW}px`;
    phone.style.height = `${phoneH}px`;
    phone.style.setProperty("--bezel", `${Math.round(phoneW * 0.034)}px`);
    const sos = shotNamed("sos").el;
    phoneRelease = sos.offsetTop + sos.offsetHeight - vh; // from here the words ride up the page, and the phone with them
  };
  const placePhone = () => {
    const p = S.phone;
    const shown = p < 0 ? 0 : smooth(PHONE_IN, PHONE_IN + 0.025, p) * (1 - smooth(0.95, 0.99, p));
    setOpacity(phone, shown);
    read(chat, p < 0 ? 0 : (p - CHAT_FROM) / (CHAT_TO - CHAT_FROM));
    if (shown < 0.01) return;
    const wide = vw / vh > 0.9;
    const lift = Math.max(0, scrollY - phoneRelease);
    const x1 = (wide ? S.ax : 0.5) * vw, y1 = (wide ? (barHeight + vh - 64) / 2 : barHeight + 0.025 * vh + phoneH / 2) - lift;
    let x = x1, y = y1, h = phoneH;
    if (W.hiker.ready && W.hiker.screenAt(c, normal, corners)) {
      let x0 = Infinity, x9 = -Infinity, top = Infinity, bottom = -Infinity;
      for (const corner of corners) {
        corner.project(camera);
        const px = ((corner.x + 1) / 2) * vw, py = ((1 - corner.y) / 2) * vh;
        x0 = Math.min(x0, px); x9 = Math.max(x9, px);
        top = Math.min(top, py); bottom = Math.max(bottom, py);
      }
      const settle = ease(clamp01((p - PHONE_IN) / (SETTLED - PHONE_IN)));
      x = lerp((x0 + x9) / 2, x1, settle);
      y = lerp((top + bottom) / 2, y1, settle);
      // the screen is 96.7% of the phone's height; never start much larger than its place (a huge first paint stalls)
      h = lerp(Math.min((bottom - top) / 0.967, phoneH * 1.15), phoneH, settle);
    }
    const s = h / phoneH;
    phone.style.transform = `translate(${(x - (phoneW * s) / 2).toFixed(1)}px, ${(y - h / 2).toFixed(1)}px) scale(${s.toFixed(4)})`;
    const chatOn = smooth(SETTLED - 0.02, CHAT_FROM, p).toFixed(3);
    if (phone._c !== chatOn) phone.style.setProperty("--chat", (phone._c = chatOn));
  };
  // The page phone's first paint, in a browser that has not drawn its kind of content yet, stalls the GPU for
  // 150-200 ms (Skia compiles its shaders on first use). Draw it once at load, at 1% and both screens half on, so
  // that happens now and not when the phone takes over from the 3D one mid-scroll.
  const warmPhone = async () => {
    // the wallpaper decoded first, so this first paint includes it
    const wall = new Image();
    wall.src = "/images/chat-wallpaper.webp";
    await wall.decode().catch(() => {});
    if (S.phone >= 0) return;
    phone.style.setProperty("--chat", "0.5");
    setOpacity(phone, 0.01);
    setTimeout(() => {
      if (S.phone >= 0) return; // reached on the way: placePhone has it now
      phone._c = undefined;
      phone.style.setProperty("--chat", "0");
      setOpacity(phone, 0);
    }, 400);
  };
  W.hiker.onReady = () => {
    resized = true; // draw again now that the person is there
  };

  const quality = sharpness(renderer, canvas);
  let filmEnd = 0, barHeight = 56, resized = true;
  const measure = () => {
    vw = document.documentElement.clientWidth;
    vh = innerHeight;
    for (const shot of film) {
      const top = shot.el.offsetTop, tall = shot.el.offsetHeight;
      shot.start = Math.max(0, top - vh / 2);
      shot.end = top + tall - vh / 2;
      shot.length = shot.end - shot.start;
      shot.stuckFrom = (top - shot.start) / shot.length; // the words are locked in place between these two
      shot.stuckTo = (top + tall - vh - shot.start) / shot.length;
    }
    for (const block of pins) {
      // a block locks only where its content fits on one screen
      block.el.classList.remove("no-pin");
      let style = getComputedStyle(block.stick);
      if (style.position === "sticky" && block.stick.scrollHeight > block.stick.clientHeight + 2) {
        block.el.classList.add("no-pin");
        style = getComputedStyle(block.stick);
      }
      const locks = style.position === "sticky";
      block.el.classList.toggle("is-pinned", locks);
      block.top = block.el.offsetTop;
      block.bottom = block.top + block.el.offsetHeight;
      if (locks) {
        block.from = block.top - (parseFloat(style.top) || 0);
        block.travel = Math.max(1, block.el.offsetHeight - block.stick.offsetHeight);
      } else {
        // on small screens nothing locks: the block just lights up as it comes into view
        block.from = block.top - vh * 0.8;
        block.travel = Math.max(1, block.el.offsetHeight * 0.8);
      }
    }
    filmEnd = film[film.length - 1].end;
    barHeight = bar.offsetHeight;
    sizePhone();
    quality.size(vw, vh, { ratio: +params.get("pr"), soft: +params.get("soft") });
    camera.aspect = vw / vh;
    resized = true;
  };
  addEventListener("resize", measure);
  addEventListener("load", measure);
  measure();
  if (document.fonts?.ready) document.fonts.ready.then(measure);

  // Which shot plays at scroll position y, and how far through it we are
  const locate = (y) => {
    for (let i = 0; i < film.length; i++) {
      const shot = film[i];
      if (y >= shot.end) continue;
      if (y >= shot.start) return [i, (y - shot.start) / shot.length];
      if (i === 0) return [0, 0];
      return y < (film[i - 1].end + shot.start) / 2 ? [i - 1, 1] : [i, 0]; // inside a title band
    }
    return [film.length - 1, 1];
  };

  const setOpacity = (el, value) => {
    const rounded = Math.round(value * 100) / 100;
    if (el._o === rounded) return;
    el._o = rounded;
    el.style.opacity = rounded;
    el.style.visibility = rounded < 0.01 ? "hidden" : "visible";
  };
  const shift = (el, y) => {
    const hidden = Math.abs(y) > vh;
    const value = hidden ? null : Math.round(y * 2) / 2;
    if (el._y === value) return;
    el._y = value;
    el.style.visibility = hidden ? "hidden" : "visible";
    if (!hidden) el.style.transform = `translate3d(0, ${value}px, 0)`;
  };
  const place = (el, point, opacity) => {
    c.copy(point).project(camera);
    if (c.z > 1) opacity = 0; // behind the camera
    setOpacity(el, opacity);
    if (opacity < 0.01) return;
    el.style.transform = `translate(${(((c.x + 1) / 2) * vw).toFixed(1)}px, ${(((1 - c.y) / 2) * vh).toFixed(1)}px)`;
  };

  // Everything in the page that follows the scroll position, apart from the 3D scene
  let specOn = -2;
  const pageAt = (sy, index, p) => {
    film.forEach((shot, i) => {
      const q = i < index ? 1 : i > index ? 0 : p;
      for (const beat of shot.beats) {
        // a beat with a range waits below, rides up at scroll speed, locks, then rides out the top, fading as it
        // goes (on a narrow screen its words would otherwise cross the middle of the picture on the way out)
        if (beat.moves) {
          const out = beat.to < 1 && q > beat.to ? (q - beat.to) * shot.length : 0;
          shift(beat.el, q < beat.from ? (beat.from - q) * shot.length : -out);
          const fade = (Math.round((1 - clamp01(out / (vh * 0.3))) * 100) / 100).toString();
          if (beat.el._fade !== fade) beat.el.style.opacity = beat.el._fade = fade; // shift alone decides whether it shows
        }
        const arrives = Math.max(beat.from, shot.stuckFrom), leaves = Math.min(beat.to, shot.stuckTo);
        const h = (q - arrives) / (leaves - arrives);
        for (const reader of beat.readers) read(reader, h);
      }
    });
    for (const block of pins) {
      const h = (sy - block.from) / block.travel;
      for (const reader of block.readers) read(reader, h);
    }
    if (S.spec !== specOn) {
      specOn = S.spec;
      for (const list of [specs, specSteps]) {
        list.forEach((el, n) => {
          el.classList.toggle("is-active", n === S.spec);
          el.classList.toggle("is-past", n < S.spec);
        });
      }
      if (S.spec >= 0) pinLabel.textContent = specs[S.spec].querySelector("h3").textContent;
    }
    // A cut between two far-apart places passes through the paper colour
    let cover = 0;
    for (const shot of film) if (shot.dips) cover = Math.max(cover, 1 - clamp01(Math.abs(sy - shot.start) / (vh * 0.22)));
    // while the conversation plays, the scene rests behind a veil of paper so the phone and the words read cleanly
    if (S.phone >= 0) cover = Math.max(cover, 0.93 * smooth(PHONE_IN + 0.05, PHONE_IN + 0.12, S.phone));
    setOpacity(dip, cover);
  };

  // Is the scene out of sight? After the film, or while a chapter band fills the whole screen.
  const outOfSight = (sy) => {
    if (sy > filmEnd + vh * 0.7) return true;
    for (const block of pins) if (block.solid && block.top <= sy + barHeight && block.bottom >= sy + vh) return true;
    return false;
  };

  // ── One frame of the scene ────────────────────────────────────────────
  let spin = 0, lidarAngle = 0;
  const stage = (time, dt) => {
    // Drone
    drone.position.copy(S.pos);
    const ground = S.studio ? -1e9 : groundAt(S.pos.x, S.pos.z);
    drone.position.y = Math.max(drone.position.y, ground + LEGS);
    if (!reduced) drone.position.y += Math.sin(time * 1.6) * 0.022 * S.air;
    drone.rotation.set(S.pitch, S.yaw, reduced ? 0 : Math.sin(time * 1.1) * 0.012 * S.air, "YXZ");
    const whirl = S.still ? 0 : S.air;
    spin += dt * 40 * whirl;
    for (const prop of props) prop.rotation.y = S.still ? prop.userData.across : prop.userData.rest + spin * prop.userData.dir;
    for (const blades of W.bladeMats) blades.opacity = lerp(1, 0.3, whirl);
    W.discMat.uniforms.uOpacity.value = 0.2 * whirl;
    if (S.lidar > 0.02) lidarAngle -= dt * 9;
    W.lidarHead.rotation.y = lidarAngle;

    // Kit: under the airframe, lowered in the studio, or lying where it fell
    W.release.servoArm.rotation.x = W.release.armRest + 0.9 * S.release;
    W.release.releasePin.position.z = W.release.pinRest - 0.022 * S.release;
    const fall = Math.max(0, (drone.position.y + KIT_REST_Y * SCALE - (ground + W.kitHalf * SCALE + 0.01)) / SCALE);
    kit.position.y = KIT_REST_Y - (S.studio ? S.kitLower : S.kit * fall);
    const dropped = !S.studio && S.kit > 0.02;
    W.kitShadow.visible = dropped;
    if (dropped) {
      W.kitShadow.position.set(drone.position.x, ground + 0.03, drone.position.z);
      W.kitShadow.material.uniforms.uOpacity.value = 0.5 * smooth(0.5, 1, S.kit);
    }
    // the drone's shadow is redrawn only when its outline changes
    W.castDrone(`${S.studio}|${S.yaw.toFixed(2)}|${S.pitch.toFixed(2)}|${whirl > 0.5}|${dropped}|${S.kitLower.toFixed(2)}`, whirl > 0.5, !dropped);

    // Camera. On narrow screens it keeps its place and widens its lens instead, so the whole subject fits
    // without the camera ever backing into the mountainside.
    const narrow = clamp01((0.9 - vw / vh) / 0.45);
    eye.copy(S.cam);
    if (!S.studio) eye.y = Math.max(eye.y, groundAt(eye.x, eye.z) + S.minEye);
    W.sky.position.copy(eye);
    camera.position.copy(eye);
    if (W.hiker.ready) W.hiker.showHead(W.hiker.headAt(head).distanceTo(eye) > 0.17);
    camera.up.copy(S.up);
    camera.lookAt(S.look);
    camera.fov = S.fov * (1 + 0.9 * narrow);
    camera.setViewOffset(vw, vh, (0.5 - S.ax) * vw, (0.5 - S.ay) * vh, vw, vh);

    // World
    W.land.visible = !S.studio;
    W.floor.visible = S.studio;
    W.floor.position.set(S.pos.x, S.pos.y - 0.78, S.pos.z);
    scene.fog.near = S.studio ? 500 : 95;
    scene.fog.far = S.studio ? 3000 : 540;

    W.route.count = S.routeOp > 0.001 ? Math.round(S.route * W.ROUTE_DOTS) : 0;
    W.route.material.opacity = S.routeOp;
    for (const ring of W.rings) {
      const t = (time * 0.4 + ring.userData.offset) % 1;
      ring.scale.setScalar(0.6 + t * 5);
      ring.material.opacity = (1 - t) * 0.8 * S.sos;
    }
    W.beacon.material.opacity = S.beacon * (0.6 + 0.4 * Math.sin(time * 4));
    W.beacon.scale.setScalar(0.034);
    if (W.hiker.ready) {
      W.hiker.pose(S.anim);
      W.hiker.setScreen(SCREEN_STATES[S.screen]);
    }

    FOCUS.uFocusOn.value = S.focusOn;
    // the LIDAR scan, from the head's window as it turns
    W.lidarHead.getWorldPosition(scanFrom);
    W.lidarHead.getWorldDirection(scanDir);
    W.scan(scanFrom, Math.atan2(scanDir.x, scanDir.z), time, S.lidar, S.studio);

    W.cone.visible = S.detect > 0.01;
    const agl = drone.position.y - ground;
    W.cone.position.copy(drone.position);
    W.cone.scale.set(agl * 0.62, agl, agl * 0.62);
    W.cone.material.opacity = 0.08 * S.detect;
  };

  // Labels pinned to things in the scene
  const labels = () => {
    place(tag, S.tagAt || HOME, S.tagAt ? S.tagOp : 0);
    if (tagLabel.textContent !== S.tagText) tagLabel.textContent = S.tagText;
    place(detect, a.copy(TARGET).setY(TARGET.y + 0.3), S.detect);
    place(pin, S.pinAt, S.studio ? S.pinOp : 0);
    placePhone();
    setOpacity(hud, S.hud);
    const metres = Math.round(Math.hypot(DROP.x - drone.position.x, DROP.z - drone.position.z) * 10);
    const text = metres >= 1000 ? (metres / 1000).toFixed(1).replace(".", EN ? "." : ",") + " km" : Math.round(metres / 10) * 10 + " m";
    if (hudDist.textContent !== text) hudDist.textContent = text;
  };

  // ── Before the first frame ────────────────────────────────────────────
  // Compile every material now, then find the sharpest level this graphics card draws comfortably,
  // timed on a busy view of the film. Both happen while the canvas is still hidden.
  const compose = (index, p) => {
    reset();
    film[index].play(p);
  };
  W.warmUp();
  compose(film.indexOf(shotNamed("flight")), 0.62);
  stage(1, 0.016);
  quality.start(() => renderer.render(scene, camera));

  // ── Frame loop ────────────────────────────────────────────────────────
  const glide = still || reduced ? () => {} : smoothScroll();
  let last = performance.now(), lastY = -1, movedAt = 0, started = false, barY = 0;
  renderer.setAnimationLoop((now) => {
    const dt = Math.min(0.1, (now - last) / 1000), time = now / 1000;
    last = now;
    glide(now);
    const sy = scrollY; // the page's real position drives everything: words and scene cannot drift apart
    const moved = sy !== lastY || resized;
    // the top bar steps out of the way while you read down, and comes back as soon as you scroll up
    if (Math.abs(sy - barY) > 6) {
      const hide = sy > barY && sy > barHeight * 3;
      if (bar._hidden !== hide) bar.classList.toggle("is-hidden", (bar._hidden = hide));
      barY = sy;
    }
    lastY = sy;
    resized = false;

    if (moved) {
      const [index, p] = locate(sy);
      window.__film = { index, p, sy, quality, hiker: W.hiker.ready }; // read by the test harness
      compose(index, p);
      pageAt(sy, index, p);
      movedAt = now;
    }
    // Draw only when something on screen can have changed: the page moved, something is animating by itself,
    // or the page has just come to rest and the last frame was drawn below full sharpness.
    const moving = now - movedAt < 250;
    const alive = !reduced && (S.air > 0 || S.sos > 0.01 || S.beacon > 0.01 || S.lidar > 0.01);
    // once the film is off screen its labels go too: the last one shown (a part's name in the studio) would
    // otherwise stay pinned over the sections below
    const hidden = outOfSight(sy);
    if (overlay._hidden !== hidden) overlay.style.opacity = (overlay._hidden = hidden) ? "0" : "";
    // ready once the person is in and a frame is on screen (or the page was opened further down, past the film)
    if (W.hiker.ready && (started || hidden)) doneLoading();
    if ((moved || alive || !started || (!moving && quality.fraction < 1)) && !hidden) {
      quality.frame(dt, moving);
      stage(time, dt);
      renderer.render(scene, camera);
      labels();
      if (!started) {
        started = true;
        canvas.classList.add("is-ready");
        warmPhone();
      }
    }
  });
}
