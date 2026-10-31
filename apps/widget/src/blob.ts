/**
 * Jelly orb mascot — canvas 2D, no dependencies.
 *
 * A glass sphere with a sloshing, glowing liquid inside. It reacts to a
 * "mood" (idle / listening / thinking / happy) and wobbles like jelly when poked.
 * Hidden or detached canvases are skipped, so extra instances cost nothing.
 */
export type BlobMood = 'idle' | 'listening' | 'thinking' | 'happy';

interface MoodParams {
  speed: number;
  wave: number;
  level: number;
  glow: number;
  wobble: number;
  pulse: number;
}

const MOODS: Record<BlobMood, MoodParams> = {
  idle: { speed: 1.0, wave: 0.035, level: 0.0, glow: 1.0, wobble: 0.0, pulse: 0.0 },
  listening: { speed: 1.7, wave: 0.07, level: -0.25, glow: 1.15, wobble: 0.01, pulse: 1.0 },
  thinking: { speed: 2.8, wave: 0.1, level: -0.1, glow: 1.25, wobble: 0.035, pulse: 0.0 },
  happy: { speed: 1.9, wave: 0.06, level: -0.35, glow: 1.3, wobble: 0.05, pulse: 0.0 },
};

export interface BlobOptions {
  mood?: BlobMood;
  /** Sphere radius as a fraction of the canvas width (default 0.345 leaves room for glow). */
  radius?: number;
  /** Poke (jelly wobble) when the canvas is pressed. */
  interactive?: boolean;
}

export class JellyBlobMascot {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly radiusRatio: number;
  private mood: BlobMood;
  private p: MoodParams;
  private ph = 0;
  private t = 0;
  private s = 0;
  private v = 0;
  private last = 0;
  private raf = 0;
  private dpr = 1;
  private cssSize = 0;
  private readonly reduced: boolean;

  constructor(canvas: HTMLCanvasElement, opts: BlobOptions = {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d canvas unavailable');
    this.ctx = ctx;
    this.radiusRatio = opts.radius ?? 0.345;
    this.mood = opts.mood ?? 'idle';
    this.p = { ...MOODS[this.mood] };
    this.reduced =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (opts.interactive) canvas.addEventListener('pointerdown', () => this.poke());
    this.raf = requestAnimationFrame(this.loop);
  }

  setMood(mood: BlobMood): void {
    this.mood = mood;
  }

  /** Kick the jelly spring (0.1 = gentle, 0.3 = strong). */
  poke(amount = 0.22): void {
    this.v += amount * 9;
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
  }

  private readonly loop = (now: number): void => {
    const dt = Math.min(0.05, (now - (this.last || now)) / 1000);
    this.last = now;
    this.raf = requestAnimationFrame(this.loop);
    // Skip work while hidden (closed panel, inactive tab, detached node).
    const w = this.canvas.clientWidth;
    if (!this.canvas.isConnected || w === 0) return;
    if (w !== this.cssSize) this.resize(w);

    this.t += dt;
    const target = MOODS[this.mood];
    const k = 1 - Math.pow(0.0015, dt);
    const p = this.p;
    p.speed += (target.speed - p.speed) * k;
    p.wave += (target.wave - p.wave) * k;
    p.level += (target.level - p.level) * k;
    p.glow += (target.glow - p.glow) * k;
    p.wobble += (target.wobble - p.wobble) * k;
    p.pulse += (target.pulse - p.pulse) * k;
    if (!this.reduced) this.ph += (dt * p.speed * Math.PI * 2) / 5.27;
    this.v += (-70 * this.s - 5.5 * this.v) * dt;
    this.s += this.v * dt;
    this.draw();
  };

  private resize(cssWidth: number): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.cssSize = cssWidth;
    this.canvas.width = this.canvas.height = Math.max(1, Math.round(cssWidth * this.dpr));
  }

  private draw(): void {
    const ctx = this.ctx;
    const p = this.p;
    const W = this.canvas.width;
    const R = this.radiusRatio * W;
    const u = R / 72.45; // stroke/blur unit, so small orbs keep the same proportions
    const t = this.t;
    const ph = this.ph;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, W);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    const audio = p.pulse * (0.5 + 0.5 * Math.sin(t * 9) * Math.sin(t * 3.3 + 1));
    const sq = this.s * 0.12 + p.wobble * Math.sin(t * 7.5);
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
    const g = p.glow;

    // Where the liquid surface meets the sphere (in the tilted frame).
    const ends: Array<{ x: number; y: number }> = [];
    for (const sgn of [-1, 1]) {
      let x = sgn * R * 0.9;
      for (let i = 0; i < 5; i++) {
        const yy = Math.max(-R * 0.999, Math.min(R * 0.999, surf(x)));
        x = sgn * Math.sqrt(R * R - yy * yy);
      }
      ends.push({ x, y: surf(x) });
    }

    // Sphere body, clipped.
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, Math.PI * 2);
    ctx.save();
    ctx.clip();
    const body = ctx.createRadialGradient(0, -R * 0.2, R * 0.1, 0, 0, R);
    body.addColorStop(0, '#04060a');
    body.addColorStop(0.75, '#05070c');
    body.addColorStop(1, '#0b1424');
    ctx.fillStyle = body;
    ctx.fillRect(-R, -R, 2 * R, 2 * R);

    // Liquid, in a frame tilted with the sloshing.
    ctx.save();
    ctx.rotate(tilt);
    const step = R / 24;
    const liquidPath = (): void => {
      ctx.beginPath();
      ctx.moveTo(-R * 1.3, surf(-R * 1.3));
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
      const og = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, R * 0.55);
      og.addColorStop(0, `rgba(255,170,60,${0.95 * Math.min(1, g)})`);
      og.addColorStop(0.35, 'rgba(255,120,30,0.45)');
      og.addColorStop(1, 'rgba(255,80,0,0)');
      ctx.fillStyle = og;
      ctx.fillRect(e.x - R, e.y - R, 2 * R, 2 * R);
    }

    // Glowing rim below the surface.
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
    ctx.arc(0, 0, R - 1.2 * u, 0, Math.PI * 2);
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = rimG;
    ctx.lineWidth = 2.2 * u;
    ctx.shadowColor = 'rgba(120,170,255,.9)';
    ctx.shadowBlur = 14 * u;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.restore();

    // Surface line.
    const lineG = ctx.createLinearGradient(-R, 0, R, 0);
    lineG.addColorStop(0, 'rgba(255,160,60,.95)');
    lineG.addColorStop(0.22, 'rgba(255,215,160,.9)');
    lineG.addColorStop(0.42, 'rgba(150,195,255,1)');
    lineG.addColorStop(0.5, 'rgba(225,238,255,1)');
    lineG.addColorStop(0.58, 'rgba(150,195,255,1)');
    lineG.addColorStop(0.78, 'rgba(255,215,160,.9)');
    lineG.addColorStop(1, 'rgba(255,160,60,.95)');
    const strokeSurf = (width: number, alpha: number): void => {
      ctx.beginPath();
      ctx.moveTo(-R * 1.1, surf(-R * 1.1));
      for (let x = -R * 1.1; x <= R * 1.1; x += step) ctx.lineTo(x, surf(x));
      ctx.globalAlpha = alpha;
      ctx.lineWidth = width;
      ctx.strokeStyle = lineG;
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.globalAlpha = 1;
    };
    ctx.shadowColor = 'rgba(90,150,255,.95)';
    ctx.shadowBlur = 16 * u;
    strokeSurf(7 * u, 0.22);
    strokeSurf(2.4 * u, 0.95);
    ctx.shadowBlur = 0;
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore(); // end tilt

    // Glass: top highlight + bottom reflection.
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

    // Crisp edge + upper rim light.
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, Math.PI * 2);
    ctx.lineWidth = 1 * u;
    ctx.strokeStyle = 'rgba(255,255,255,.13)';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, R - 0.8 * u, Math.PI * 1.17, Math.PI * 1.83);
    const arcG = ctx.createLinearGradient(-R * 0.7, 0, R * 0.7, 0);
    arcG.addColorStop(0, 'rgba(160,190,255,0)');
    arcG.addColorStop(0.5, 'rgba(200,222,255,.8)');
    arcG.addColorStop(1, 'rgba(160,190,255,0)');
    ctx.strokeStyle = arcG;
    ctx.lineWidth = 1.6 * u;
    ctx.stroke();
  }
}
