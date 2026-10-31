/**
 * Animated "jelly orb" mascot (canvas 2D) — TypeScript port of the vanilla
 * JellyBlobMascot. Used as the hero on the welcome screen, as the small avatar
 * in the chat header and inside the launcher button.
 *
 *   const orb = new Orb(canvas, { size: 190 });
 *   orb.start();            // begin animating (call stop() when hidden)
 *   orb.setMood('thinking'); // idle | listening | thinking | happy
 *   orb.poke();             // little squash bounce
 */
export type OrbMood = 'idle' | 'listening' | 'thinking' | 'happy';

interface MoodParams {
  speed: number;
  wave: number;
  level: number;
  glow: number;
  wobble: number;
  pulse: number;
}

const MOODS: Record<OrbMood, MoodParams> = {
  idle: { speed: 1.0, wave: 0.035, level: 0.0, glow: 1.0, wobble: 0.0, pulse: 0.0 },
  listening: { speed: 1.7, wave: 0.07, level: -0.25, glow: 1.15, wobble: 0.01, pulse: 1.0 },
  thinking: { speed: 2.8, wave: 0.1, level: -0.1, glow: 1.25, wobble: 0.035, pulse: 0.0 },
  happy: { speed: 1.9, wave: 0.06, level: -0.35, glow: 1.3, wobble: 0.05, pulse: 0.0 },
};

export interface OrbOptions {
  /** CSS pixel size used when the canvas has no layout yet (hidden panel). */
  size?: number;
  /** Sphere radius relative to the canvas width. */
  radius?: number;
  mood?: OrbMood;
}

export class Orb {
  private readonly c: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly size: number;
  private readonly radiusRatio: number;
  private mood: OrbMood;
  private p: MoodParams;
  private ph = 0;
  private t = 0;
  private s = 0;
  private v = 0;
  private last = 0;
  private raf = 0;
  private dpr = 1;
  private readonly reduced: boolean;

  constructor(canvas: HTMLCanvasElement, opts: OrbOptions = {}) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.size = opts.size ?? 210;
    this.radiusRatio = opts.radius ?? 0.345;
    this.mood = opts.mood ?? 'idle';
    this.p = { ...MOODS[this.mood] };
    this.reduced =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.resize();
    canvas.addEventListener('pointerdown', () => this.poke());
  }

  /** Re-measure the canvas (call after it becomes visible / changes size). */
  resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    const css = this.c.clientWidth || this.size;
    this.c.width = this.c.height = Math.round(css * this.dpr);
  }

  setMood(m: OrbMood): void {
    if (MOODS[m]) this.mood = m;
  }

  poke(amount = 0.22): void {
    this.v += amount * 9;
  }

  start(): void {
    if (this.raf || !this.ctx) return;
    this.last = 0;
    this.raf = requestAnimationFrame(this.loop);
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private loop = (now: number): void => {
    const dt = Math.min(0.05, (now - (this.last || now)) / 1000);
    this.last = now;
    this.t += dt;
    const target = MOODS[this.mood];
    const k = 1 - Math.pow(0.0015, dt);
    for (const key of Object.keys(target) as (keyof MoodParams)[]) {
      this.p[key] += (target[key] - this.p[key]) * k;
    }
    if (!this.reduced) this.ph += (dt * this.p.speed * Math.PI * 2) / 5.27;
    // squash spring
    this.v += (-70 * this.s - 5.5 * this.v) * dt;
    this.s += this.v * dt;
    this.draw();
    this.raf = requestAnimationFrame(this.loop);
  };

  private draw(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const p = this.p;
    const W = this.c.width;
    const R = this.radiusRatio * W;
    const t = this.t;
    const ph = this.ph;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, W);
    const audio = p.pulse * (0.5 + 0.5 * Math.sin(t * 9) * Math.sin(t * 3.3 + 1));
    const wob = p.wobble * Math.sin(t * 7.5);
    const sq = this.s * 0.12 + wob;
    const breathe = 1 + 0.012 * Math.sin(t * 1.6) + audio * 0.045;
    ctx.translate(W / 2, W / 2 + Math.sin(t * 1.3) * W * 0.004);
    ctx.scale(breathe * (1 + sq), breathe * (1 - sq));

    const level = 0.86 * Math.cos(ph) + p.level * 0.4; // liquid surface height (down = +)
    const tilt = 0.14 * Math.sin(ph * 0.7 + 1.0) + 0.05 * Math.sin(t * 2.1) * (1 + p.wobble * 10);
    const curve = 0.2 + 0.05 * Math.sin(ph * 1.3);
    const wave = p.wave + audio * 0.05;
    const surf = (x: number): number =>
      level * R +
      curve * R * (1 - (x / R) * (x / R)) +
      wave * R * Math.sin((x / R) * 3.4 + ph * 2.6) * (1 - Math.abs(x / R) * 0.4);
    const circ = (): void => {
      ctx.beginPath();
      ctx.arc(0, 0, R, 0, Math.PI * 2);
    };
    const g = p.glow;

    // where the liquid surface meets the sphere (rotated frame)
    const ends: { x: number; y: number }[] = [];
    for (const sgn of [-1, 1]) {
      let x = sgn * R * 0.9;
      for (let i = 0; i < 5; i++) {
        const y = surf(x);
        const yy = Math.max(-R * 0.999, Math.min(R * 0.999, y));
        x = sgn * Math.sqrt(R * R - yy * yy);
      }
      ends.push({ x, y: surf(x) });
    }

    // sphere body
    circ();
    ctx.save();
    ctx.clip();
    const body = ctx.createRadialGradient(0, -R * 0.2, R * 0.1, 0, 0, R);
    body.addColorStop(0, '#04060a');
    body.addColorStop(0.75, '#05070c');
    body.addColorStop(1, '#0b1424');
    ctx.fillStyle = body;
    ctx.fillRect(-R, -R, 2 * R, 2 * R);

    // liquid (rotated frame)
    ctx.save();
    ctx.rotate(tilt);
    const reach = R * 2.4;
    const step = R / 24;
    const liquidPath = (): void => {
      ctx.beginPath();
      ctx.moveTo(-reach, surf(-reach * 0.5));
      for (let x = -R * 1.3; x <= R * 1.3; x += step) ctx.lineTo(x, surf(x));
      ctx.lineTo(R * 1.3, R * 2.5);
      ctx.lineTo(-R * 1.3, R * 2.5);
      ctx.closePath();
    };
    const y0 = level * R + curve * R * 0.5;
    const fillG = ctx.createLinearGradient(0, y0 - R * 0.1, 0, y0 + R * 1.0);
    fillG.addColorStop(0, `rgba(80,140,255,${0.85 * Math.min(1, g)})`);
    fillG.addColorStop(0.3, 'rgba(40,90,220,0.42)');
    fillG.addColorStop(0.7, 'rgba(20,40,120,0.12)');
    fillG.addColorStop(1, 'rgba(0,0,0,0)');
    liquidPath();
    ctx.fillStyle = fillG;
    ctx.fill();

    ctx.globalCompositeOperation = 'lighter';
    for (const e of ends) {
      // orange glow at the two meeting points
      const og = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, R * 0.55);
      og.addColorStop(0, `rgba(255,170,60,${0.95 * Math.min(1, g)})`);
      og.addColorStop(0.35, 'rgba(255,120,30,0.45)');
      og.addColorStop(1, 'rgba(255,80,0,0)');
      ctx.fillStyle = og;
      ctx.fillRect(e.x - R, e.y - R, 2 * R, 2 * R);
    }

    // glowing rim below the surface
    ctx.save();
    liquidPath();
    ctx.clip();
    const rimG = ctx.createLinearGradient(-R, 0, R, 0);
    rimG.addColorStop(0, 'rgba(255,150,50,1)');
    rimG.addColorStop(0.28, 'rgba(255,200,140,.8)');
    rimG.addColorStop(0.5, 'rgba(190,215,255,.95)');
    rimG.addColorStop(0.72, 'rgba(255,200,140,.8)');
    rimG.addColorStop(1, 'rgba(255,150,50,1)');
    ctx.beginPath();
    ctx.arc(0, 0, R - 1.2 * this.dpr, 0, Math.PI * 2);
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = rimG;
    ctx.lineWidth = 2.2 * this.dpr;
    ctx.shadowColor = 'rgba(120,170,255,.9)';
    ctx.shadowBlur = 14 * this.dpr;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.restore();

    // surface line
    const lineG = ctx.createLinearGradient(-R, 0, R, 0);
    lineG.addColorStop(0, 'rgba(255,160,60,.95)');
    lineG.addColorStop(0.22, 'rgba(255,215,160,.9)');
    lineG.addColorStop(0.42, 'rgba(150,195,255,1)');
    lineG.addColorStop(0.5, 'rgba(225,238,255,1)');
    lineG.addColorStop(0.58, 'rgba(150,195,255,1)');
    lineG.addColorStop(0.78, 'rgba(255,215,160,.9)');
    lineG.addColorStop(1, 'rgba(255,160,60,.95)');
    const strokeSurf = (w: number, a: number): void => {
      ctx.beginPath();
      ctx.moveTo(-R * 1.1, surf(-R * 1.1));
      for (let x = -R * 1.1; x <= R * 1.1; x += step) ctx.lineTo(x, surf(x));
      ctx.globalAlpha = a;
      ctx.lineWidth = w;
      ctx.strokeStyle = lineG;
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.globalAlpha = 1;
    };
    ctx.shadowColor = 'rgba(90,150,255,.95)';
    ctx.shadowBlur = 16 * this.dpr;
    strokeSurf(7 * this.dpr, 0.22);
    strokeSurf(2.4 * this.dpr, 0.95);
    ctx.shadowBlur = 0;
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore(); // end rotation

    // glass: top highlight
    ctx.globalCompositeOperation = 'lighter';
    ctx.save();
    ctx.translate(0, -R * 0.93);
    ctx.scale(1, 0.4);
    const topG = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 0.85);
    topG.addColorStop(0, 'rgba(190,215,255,.95)');
    topG.addColorStop(0.25, 'rgba(100,150,255,.6)');
    topG.addColorStop(0.6, 'rgba(50,90,200,.18)');
    topG.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = topG;
    ctx.fillRect(-R, -R, 2 * R, 2 * R);
    ctx.restore();
    // glass: bottom reflection
    ctx.save();
    ctx.translate(0, R * 0.96);
    ctx.scale(1, 0.26);
    const botG = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 0.8);
    botG.addColorStop(0, 'rgba(210,225,255,.55)');
    botG.addColorStop(0.5, 'rgba(120,160,230,.16)');
    botG.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = botG;
    ctx.fillRect(-R, -R, 2 * R, 2 * R);
    ctx.restore();
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore(); // end clip

    // crisp edge + upper rim light
    circ();
    ctx.lineWidth = 1 * this.dpr;
    ctx.strokeStyle = 'rgba(255,255,255,.13)';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, R - 0.8 * this.dpr, Math.PI * 1.17, Math.PI * 1.83);
    const arcG = ctx.createLinearGradient(-R * 0.7, 0, R * 0.7, 0);
    arcG.addColorStop(0, 'rgba(160,190,255,0)');
    arcG.addColorStop(0.5, 'rgba(200,222,255,.8)');
    arcG.addColorStop(1, 'rgba(160,190,255,0)');
    ctx.strokeStyle = arcG;
    ctx.lineWidth = 1.6 * this.dpr;
    ctx.stroke();
  }
}
