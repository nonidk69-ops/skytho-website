// How the page moves, and how sharply the scene is drawn.
import Lenis from "../vendor/lenis.mjs";

// Smooth wheel scrolling with Lenis. The page's own scroll position stays the single source of truth,
// so everything that reads scrollY (the pinned words and the 3D scene) moves together.
// Touch, keys and the scrollbar keep their native behaviour.
export function smoothScroll() {
  const lenis = new Lenis({ autoRaf: false, lerp: 0.1, wheelMultiplier: 1, smoothWheel: true, syncTouch: false, anchors: true });
  return (now) => lenis.raf(now);
}

// How sharply the scene is drawn, decided frame by frame.
// The canvas is allocated once, at the sharpest size worth having. A lower quality is drawn into a corner
// of it, and the browser stretches that corner over the screen: changing quality costs nothing and never
// stalls a frame. While the page moves, quality follows what the graphics card keeps up with at the
// display's own rate; whenever the page rests, the scene is drawn at full sharpness.
export function sharpness(renderer, canvas) {
  let vw = 1, vh = 1, top = 1, fractions = [1], level = 0, applied = 0, fixed = false;
  let interval = 16.7, calm = 0, patience = 90, sinceRise = 1e4, lates = 0, at = 0;
  const costs = []; // what the start-up timing measured, for the test harness
  const recent = new Uint8Array(40);
  const forget = () => {
    recent.fill(0);
    lates = calm = 0;
  };
  const use = (fraction) => {
    if (fraction === applied) return;
    applied = fraction;
    renderer.setViewport(0, 0, vw * fraction, vh * fraction);
    canvas.style.transform = fraction === 1 ? "" : `scale(${1 / fraction})`;
  };

  return {
    get fraction() { return applied; },
    get ratio() { return top * applied; },
    get costs() { return costs; },
    // Call when the window changes size. Tests can fix the resolution (`ratio`) or the level (`soft`).
    size(width, height, { ratio = 0, soft = 0 } = {}) {
      const density = devicePixelRatio || 1;
      vw = width;
      vh = height;
      // up to 2 pixels per CSS pixel; on ordinary screens the extra pixels smooth the edges
      top = ratio || Math.max(1, Math.min(Math.max(density, 1.5), 2, Math.sqrt(5e6 / (width * height))));
      const least = Math.min(top, 1);
      fractions = [];
      for (let step = top; step > least + 0.01; step -= 0.25) fractions.push(step / top);
      fractions.push(least / top);
      if (ratio) fractions = [1];
      if (soft) fractions = [soft];
      fixed = !!soft;
      level = Math.min(level, fractions.length - 1);
      renderer.setPixelRatio(top);
      renderer.setSize(width, height, false);
      applied = 0;
      use(fractions[level]);
    },
    // Before the first frame: time real frames of a busy view and start at the sharpest level that is comfortable.
    start(draw) {
      const gl = renderer.getContext(), pixel = new Uint8Array(4);
      const finish = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel); // waits for the graphics card
      for (level = 0; level < fractions.length - 1; level++) {
        use(fractions[level]);
        draw();
        finish();
        let least = Infinity;
        for (let run = 0; run < 2; run++) {
          const began = performance.now();
          for (let i = 0; i < 4; i++) draw();
          finish();
          least = Math.min(least, (performance.now() - began) / 4);
        }
        costs.push(+least.toFixed(1));
        if (least < 9) break;
      }
      use(fractions[level]);
    },
    // Call for every frame that is drawn, before drawing it.
    frame(dt, moving) {
      const ms = dt * 1000;
      if (moving && ms > 4 && ms < 200) {
        interval = ms < interval ? ms : interval + (ms - interval) * 0.002; // the display's own frame time
        const late = ms > interval * 1.45 ? 1 : 0;
        lates += late - recent[at];
        recent[at] = late;
        at = (at + 1) % recent.length;
        calm = late ? 0 : calm + 1;
        sinceRise++;
        if (lates >= 4 && level < fractions.length - 1) {
          level++; // not keeping up: one step softer
          if (sinceRise < 300) patience = Math.min(patience * 2, 3600); // the last step up was a mistake: wait longer next time
          forget();
        } else if (calm > patience && level > 0) {
          level--; // steady for a while: one step sharper
          sinceRise = 0;
          forget();
        }
      }
      use(moving || fixed ? fractions[level] : 1);
    },
  };
}
