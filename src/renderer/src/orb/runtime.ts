import { Sim } from './vendor/sim.js';
import { densityWGSL } from './vendor/density.js';
import { Bubbles } from './bubbles';
import { loadRoom, loadStudio } from './environment';
import { Fire, EMBERS } from './fire';
import { Handling } from './handling';
import { Ink } from './ink';
import { Lens } from './lens';
import { Mist } from './mist';
import { OPTICS, VIEW_FLOATS } from './optics';
import { Ripples } from './ripples';
import { ShellDrag } from './shell-drag';
import { Wakes } from './wakes';
import { Wax } from './wax';
import { IMPACTS, Weather } from './weather';

/** Edge of the reconstructed water volume, in voxels. */
const RESOLUTION = 80;
/** Seconds the fire chamber keeps stepping after a performance, while its heat dies down. */
const EMBERS_COOL = 4;
/** The rainstorm: the cloud gathers for 1.5 s, rain falls from 1.5 s to about
 * 8 s, the cloud clears by 10 s and the last drops and dew are gone by 16 s. */
const RAIN_SECONDS = 16;
/** A shake rocks the glass side to side, dying away over this long. */
const SHAKE_SECONDS = 0.8;
/** How long a burst's extra bubbles can live (they are retired after 4 s). */
const BURST_SECONDS = 5;

// A canvas context can outlive one mount. Only its current device may release it.
const CONTEXT_OWNERS = new WeakMap<GPUCanvasContext, GPUDevice>();
function releaseContext(context: GPUCanvasContext, device: GPUDevice): void {
  if (CONTEXT_OWNERS.get(context) !== device) return;
  CONTEXT_OWNERS.delete(context);
  context.unconfigure();
}

/** Things he can do with the water. Spin belongs to the expression. */
export type OrbPlay = 'splash' | 'burst' | 'rain' | 'bloom' | 'shake';

/** Everything one drawn frame needs from the character's expression and story. */
export type OrbFrame = {
  /** Seconds to simulate; 0 draws the current state without advancing it. */
  dt: number;
  time: number;
  light: boolean;
  gazeX: number; gazeY: number; blink: number;
  lean: number; energy: number; curiosity: number; warmth: number;
  yaw: number; angularVelocity: number; roll: number; pitch: number; accelX: number; accelY: number;
  wink: number; surprise: number; bubbleInterest: number;
  tint: readonly [number, number, number]; tintStrength: number;
  /** 0 water .. 1 wax. */
  lava: number;
  /** The thinking swirl. */
  vortex: number;
  /** A completion's fountain and burst, 1 at the instant it happens. */
  celebration: number;
  /** The failure fire whirl and the recovery flame, 0..1 each. */
  whirl: number; recovery: number;
};

/** A dedicated GPU device that simulates and draws the water. It never shares a
 * device or a frame loop with anything else, and destroying it frees everything.
 * Everything beyond the resting water runs only while it is on show: the wax
 * while the lamp is lit, the rain for its sixteen seconds, ink until it clears,
 * and the fire chamber, which is built the first time something fails. */
export class OrbRuntime {
  readonly device: GPUDevice;
  private readonly canvas: HTMLCanvasElement;
  private readonly context: GPUCanvasContext;
  private readonly liquid: Sim;
  private readonly water: GPUTexture;
  private readonly densityPipeline: GPUComputePipeline;
  private readonly densityGroups: [GPUBindGroup, GPUBindGroup];
  private readonly smoothing: { pipeline: GPUComputePipeline; group: GPUBindGroup }[];
  private readonly mist: Mist;
  private readonly bubbles: Bubbles;
  private readonly wakes: Wakes;
  private readonly shell: ShellDrag;
  private readonly weather: Weather;
  private readonly ripples: Ripples;
  private readonly wax: Wax;
  private readonly handling = new Handling();
  private readonly lens: Lens;
  private readonly layout: GPUBindGroupLayout;
  /** The optics compiled without play terms, and with them; see OPTICS. */
  private pipelines: { rest: GPURenderPipeline; play: GPURenderPipeline } | undefined;
  private readonly view: GPUBuffer;
  private readonly studio: GPUTexture;
  private readonly room: GPUTexture;
  private readonly sampler: GPUSampler;
  private group: GPUBindGroup;
  private fire: Fire | undefined;
  private ink: Ink | undefined;
  private impulse = 0;
  private stroke = { x: 0, y: -0.4, strength: 0 };
  private kick = 0;
  private party = 0;
  private previousCelebration = 0;
  private rainAge = RAIN_SECONDS;
  private shakeAge = SHAKE_SECONDS;
  private fireAge = EMBERS_COOL;
  private burstAge = BURST_SECONDS;
  private disposed = false;

  static async create(canvas: HTMLCanvasElement, signal?: AbortSignal): Promise<OrbRuntime> {
    signal?.throwIfAborted();
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'low-power' });
    signal?.throwIfAborted();
    if (!adapter) throw new Error('No WebGPU adapter is available');
    const device = await adapter.requestDevice();
    let context: GPUCanvasContext | null = null;
    try {
      signal?.throwIfAborted();
      device.pushErrorScope('validation');
      context = canvas.getContext('webgpu');
      if (!context) throw new Error('A WebGPU canvas is unavailable');
      const [studio, room] = await Promise.all([loadStudio(device), loadRoom(device)]);
      signal?.throwIfAborted();
      const runtime = new OrbRuntime(device, canvas, context, studio, room);
      await runtime.compile();
      signal?.throwIfAborted();
      const error = await device.popErrorScope();
      signal?.throwIfAborted();
      if (error) throw new Error(error.message);
      return runtime;
    } catch (error) {
      try { if (context) releaseContext(context, device); }
      finally { device.destroy(); }
      throw error;
    }
  }

  private constructor(device: GPUDevice, canvas: HTMLCanvasElement, context: GPUCanvasContext, studio: GPUTexture, room: GPUTexture) {
    this.device = device;
    this.canvas = canvas;
    this.context = context;
    this.studio = studio;
    this.room = room;
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: 'premultiplied' });
    CONTEXT_OWNERS.set(context, device);
    this.lens = new Lens(device, format);
    this.liquid = new Sim(device);
    this.liquid.reset({
      box: [2.4, 2.4, 2.4], spacing: 0.055, restDensity: 1000, gravity: 9.81,
      substeps: 2, iterations: 4, cfmEpsilonRel: 0.01, sCorrK: 0.1, sCorrDq: 0.3, xsphC: 0.066,
      omega: 1.03, sorAverage: false, surfaceTensionK: 0.4,
    });

    // Particles become a density field: splat, then three separable smoothing
    // passes (x, y, z). The field's yzw carry the weighted particle velocity.
    const volume = (label: string): GPUTexture => device.createTexture({
      label, size: [RESOLUTION, RESOLUTION, RESOLUTION], dimension: '3d', format: 'rgba16float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    const raw = volume('Raw liquid density'), alongX = volume('Filtered liquid X'), alongY = volume('Filtered liquid Y');
    this.water = volume('Reconstructed liquid volume');
    this.smoothing = ([[0, raw, alongX], [1, alongX, alongY], [2, alongY, this.water]] as const).map(([axis, input, output]) => {
      const step = [0, 0, 0];
      step[axis] = 1;
      const pipeline = device.createComputePipeline({ label: 'Liquid field smoothing', layout: 'auto', compute: { entryPoint: 'main', module: device.createShaderModule({ code: `
        @group(0) @binding(0) var inputField:texture_3d<f32>;
        @group(0) @binding(1) var outputField:texture_storage_3d<rgba16float,write>;
        @compute @workgroup_size(4,4,4) fn main(@builtin(global_invocation_id) id:vec3u){
          let c=vec3i(id);let axis=vec3i(${step.join(',')});
          let hi=vec3i(${RESOLUTION - 1});
          let value=textureLoad(inputField,clamp(c-axis*2,vec3i(0),hi),0)*.0625+
            textureLoad(inputField,clamp(c-axis,vec3i(0),hi),0)*.25+textureLoad(inputField,c,0)*.375+
            textureLoad(inputField,clamp(c+axis,vec3i(0),hi),0)*.25+textureLoad(inputField,clamp(c+axis*2,vec3i(0),hi),0)*.0625;
          textureStore(outputField,id,value);
        }` }) } });
      return { pipeline, group: device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: input.createView() }, { binding: 1, resource: output.createView() },
      ] }) };
    });

    const densityUniform = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const f = new Float32Array(20), ints = new Int32Array(f.buffer), h = this.liquid.h;
    ints.set([RESOLUTION, RESOLUTION, RESOLUTION]);
    f[3] = 2 / (RESOLUTION - 1);
    f.set([0.2, 0.2, 0.2, 1 / h, 0, 0, 0, h * h], 4);
    ints.set(this.liquid.gridDim, 12);
    f[15] = 315 / (64 * Math.PI * h ** 9);
    f[16] = this.liquid.scene.mass;
    f[17] = 1000;
    device.queue.writeBuffer(densityUniform, 0, f);
    this.densityPipeline = device.createComputePipeline({ label: 'Liquid density reconstruction', layout: 'auto',
      compute: { module: device.createShaderModule({ code: densityWGSL }), entryPoint: 'main' } });
    const density = (side: 'A' | 'B'): GPUBindGroup => device.createBindGroup({ layout: this.densityPipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: densityUniform } }, { binding: 1, resource: { buffer: this.liquid.buf[`pos${side}`] } },
      { binding: 2, resource: { buffer: this.liquid.buf.density } }, { binding: 3, resource: { buffer: this.liquid.buf.cellStart } },
      { binding: 4, resource: raw.createView() }, { binding: 5, resource: { buffer: this.liquid.buf[`vel${side}`] } },
    ] });
    this.densityGroups = [density('A'), density('B')];
    // Settle once, so a still frame drawn with motion off still has water in it.
    this.liquid.step(1 / 60);

    this.mist = new Mist(device, this.water);
    const impacts = device.createBuffer({ size: IMPACTS * 16, usage: GPUBufferUsage.STORAGE });
    this.ripples = new Ripples(device, impacts);
    this.weather = new Weather(device, this.water, this.mist.texture, impacts, this.ripples.texture);
    this.shell = new ShellDrag(device, this.liquid, impacts);
    this.wakes = new Wakes(device, this.water);
    this.bubbles = new Bubbles(device, this.water);
    this.wax = new Wax(device);
    this.view = device.createBuffer({ size: VIEW_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
    // An explicit layout, so the two compilations of the optics share one bind group.
    const visibility = GPUShaderStage.FRAGMENT;
    const texture = (binding: number, viewDimension: GPUTextureViewDimension): GPUBindGroupLayoutEntry => ({ binding, visibility, texture: { sampleType: 'float', viewDimension } });
    const storage = (binding: number): GPUBindGroupLayoutEntry => ({ binding, visibility, buffer: { type: 'read-only-storage' } });
    this.layout = device.createBindGroupLayout({ label: 'Optics resources', entries: [
      { binding: 0, visibility, buffer: { type: 'uniform' } }, texture(1, '3d'), texture(2, '3d'),
      { binding: 3, visibility, sampler: { type: 'filtering' } }, texture(4, '2d'), storage(5), texture(6, '2d'),
      texture(7, '3d'), storage(8), texture(9, '3d'), storage(10), texture(11, '3d'), storage(12), texture(13, '2d'), texture(14, '3d'),
    ] });
    this.group = this.bind();
  }

  /** Both compilations of the optics, in parallel, before the first frame. */
  private async compile(): Promise<void> {
    const module = this.device.createShaderModule({ label: 'Glass, water and mist optics', code: OPTICS });
    const layout = this.device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    const pipeline = (play: boolean): Promise<GPURenderPipeline> => this.device.createRenderPipelineAsync({
      label: play ? 'Wanigan glass vessel, at play' : 'Wanigan glass vessel', layout,
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float' }], constants: { PLAY: play ? 1 : 0 } },
      primitive: { topology: 'triangle-list' },
    });
    const [rest, play] = await Promise.all([pipeline(false), pipeline(true)]);
    this.pipelines = { rest, play };
  }

  /** The optics' resources. Until the fire chamber or ink exists, one-voxel
   * stand-ins hold their places; the shader never reads them. */
  private bind(): GPUBindGroup {
    const device = this.device;
    const empty = (dimension: '2d' | '3d'): GPUTextureView => device.createTexture({ size: [1, 1, 1], dimension, format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING }).createView();
    return device.createBindGroup({ layout: this.layout, entries: [
      { binding: 0, resource: { buffer: this.view } }, { binding: 1, resource: this.water.createView() },
      { binding: 2, resource: this.mist.texture.createView() }, { binding: 3, resource: this.sampler },
      { binding: 4, resource: this.studio.createView() }, { binding: 5, resource: { buffer: this.bubbles.positions } },
      { binding: 6, resource: this.room.createView() }, { binding: 7, resource: this.wakes.texture.createView() },
      { binding: 8, resource: { buffer: this.bubbles.gaze } },
      { binding: 9, resource: this.fire ? this.fire.heat.createView() : empty('3d') },
      { binding: 10, resource: { buffer: this.fire ? this.fire.embers : device.createBuffer({ size: EMBERS * 16, usage: GPUBufferUsage.STORAGE }) } },
      { binding: 11, resource: this.wax.texture.createView() }, { binding: 12, resource: { buffer: this.weather.positions } },
      { binding: 13, resource: this.ripples.texture.createView() },
      { binding: 14, resource: this.ink ? this.ink.texture.createView() : empty('3d') },
    ] });
  }

  private ignite(): Fire {
    if (!this.fire) {
      this.fire = new Fire(this.device, this.water, this.mist.texture);
      this.mist.heat(this.fire.heat);
      this.group = this.bind();
    }
    return this.fire;
  }

  private dye(): Ink {
    if (!this.ink) {
      this.ink = new Ink(this.device, this.water, this.liquid);
      this.group = this.bind();
    }
    return this.ink;
  }

  /** A flick or a stir: a bounded impulse along the camera ray through (x, y). */
  nudge(x: number, y: number, dx: number, dy: number): void {
    if (this.disposed) return;
    this.impulse = Math.max(-2, Math.min(2, dx));
    this.kick = Math.max(this.kick, Math.min(1.5, Math.hypot(dx, dy)));
    this.stroke = { x, y: Math.min(0.05, y), strength: Math.min(1.5, Math.hypot(dx, dy)) };
    this.liquid.applyRayImpulse([1.2 + x, 1.2 + y, 4], [0, 0, -1],
      [Math.max(-2.4, Math.min(2.4, dx * 3)), Math.max(-1, Math.min(1.2, dy * 2)), 0.08], 0.65, 3);
  }

  /** One of Wanigan 1's play actions, with its parameters. A shake also rocks
   * the glass: on water, Wanigan 1's shake was otherwise a splash. */
  play(kind: OrbPlay): void {
    if (this.disposed) return;
    if (kind === 'rain') { this.rainAge = 0; return; }
    if (kind === 'bloom') { this.dye().bloom(); return; }
    if (kind === 'shake') { this.kick = 1.5; this.shakeAge = 0; this.nudge(-0.25, -0.3, 1.5, 1.5); return; }
    if (kind === 'burst') { this.party = 1; return; }
    this.nudge(-0.25, -0.35, 1.2, 0.8);
  }

  grab(x: number, y: number): void {
    if (!this.disposed) this.handling.grab(x, y);
  }

  release(): void {
    this.handling.release();
  }

  async render(frame: OrbFrame): Promise<void> {
    if (this.disposed) return;
    const pixels = Math.min(900, Math.max(200, Math.round(this.canvas.clientWidth * Math.min(devicePixelRatio, 2))));
    if (this.canvas.width !== pixels) {
      this.canvas.width = pixels;
      this.canvas.height = pixels;
    }
    const scene = this.lens.target(pixels);
    const dt = Math.min(Math.max(0, frame.dt), 1 / 30);
    if (this.shakeAge < SHAKE_SECONDS && dt > 0) {
      // Through the same bounded path as a hand: the vessel tilts, the water takes the jolts.
      this.shakeAge += dt;
      const left = 1 - this.shakeAge / SHAKE_SECONDS;
      if (left > 0) this.handling.grab(Math.sin(this.shakeAge * Math.PI * 5) * left, Math.sin(this.shakeAge * Math.PI * 3.4) * 0.3 * left);
      else this.handling.release();
    }
    const handled = this.handling.step(dt);
    // The expression moves the vessel and the water receives its acceleration,
    // through the same bounded force path as a deliberate grab and flick.
    const roll = handled.roll + frame.roll, pitch = handled.pitch + frame.pitch;
    const ax = Math.max(-7, Math.min(7, handled.ax + frame.accelX)), ay = Math.max(-7, Math.min(7, handled.ay + frame.accelY));
    // A failure turns the globe into a fire chamber for a few seconds. The water
    // is kept as it was and returns when the flame is gone.
    const performance = Math.max(frame.whirl, frame.recovery);
    const chamber = performance > 0.015;
    const fireSource = chamber ? Math.max(0.65, performance) : 0;
    if (chamber) { this.ignite(); this.fireAge = 0; }
    const heat = this.fire !== undefined && this.fireAge < EMBERS_COOL;
    // Fully lit, the lamp hides the water: leave it resting until it fades back.
    const lamp = frame.lava;
    const water = !chamber && lamp < 0.995;
    const celebration = Math.max(this.party, frame.celebration);
    const burst = dt > 0 && (this.party === 1 || frame.celebration > this.previousCelebration + 0.1);
    this.previousCelebration = frame.celebration;
    // Work completing while ink is in the water blooms green (Wanigan 1's ink).
    if (burst && this.ink?.active) this.ink.bloom('green');
    const smooth = (x: number): number => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };
    const raining = this.rainAge < RAIN_SECONDS;
    const cloud = raining ? smooth(this.rainAge / 1.5) * (1 - smooth((this.rainAge - 7) / 3)) : 0;
    const rain = raining ? smooth((this.rainAge - 1.5) / 1.5) * (1 - smooth((this.rainAge - 6) / 2)) : 0;
    const inked = this.ink?.active ?? false;
    if (frame.dt > 0 && water) {
      this.shell.step(dt, { spin: frame.angularVelocity, ax, ay, vortex: frame.vortex, celebration, weather: cloud });
      if (inked) this.ink?.push(this.liquid, dt);
      this.liquid.step(dt);
    }
    const encoder = this.device.createCommandEncoder();
    if (water) {
      const density = encoder.beginComputePass();
      density.setPipeline(this.densityPipeline);
      density.setBindGroup(0, this.densityGroups[this.liquid.parity]);
      density.dispatchWorkgroups(Math.ceil(RESOLUTION ** 3 / 256));
      density.end();
      for (const { pipeline, group } of this.smoothing) {
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(RESOLUTION / 4, RESOLUTION / 4, RESOLUTION / 4);
        pass.end();
      }
    }
    if (frame.dt > 0) {
      if (heat) this.fire?.step(encoder, dt, frame.time, fireSource, frame.energy, frame.lean, performance);
      if (water || chamber) {
        this.mist.step(encoder, dt, frame.time, {
          impulse: this.impulse, lean: frame.lean, energy: frame.energy, spin: frame.angularVelocity,
          cloud, fire: fireSource, whirl: frame.whirl, recovery: frame.recovery, heat,
        });
      }
      if (water) {
        this.bubbles.step(encoder, dt, frame.time, burst, frame.bubbleInterest * (1 - lamp));
        this.wakes.step(encoder, dt, Math.max(this.stroke.strength, celebration), this.stroke.x, this.stroke.y);
        if (raining) {
          this.weather.step(encoder, dt, frame.time, rain, cloud);
          this.ripples.step(encoder, dt, cloud);
        }
        if (inked) this.ink?.step(encoder, dt);
      }
      if (lamp > 0.001) this.wax.step(encoder, dt, ax, ay, this.kick);
      this.rainAge = Math.min(RAIN_SECONDS, this.rainAge + dt);
      this.burstAge = burst ? 0 : Math.min(BURST_SECONDS, this.burstAge + dt);
      if (!chamber) this.fireAge = Math.min(EMBERS_COOL, this.fireAge + dt);
      this.party = Math.max(0, this.party - dt * 2.5);
      this.stroke.strength *= Math.exp(-dt * 3);
    }
    this.kick *= Math.exp(-dt * 5);
    this.impulse *= Math.exp(-frame.dt * 6);
    const view = new Float32Array(VIEW_FLOATS);
    view.set([
      pixels, pixels, frame.light ? 1 : 0, frame.blink, frame.gazeX, frame.gazeY, frame.curiosity, frame.warmth,
      ...frame.tint, frame.tintStrength, frame.yaw, roll, pitch, frame.wink, frame.surprise,
      frame.time, chamber ? 0 : lamp, cloud, chamber ? 1 : 0, fireSource, frame.whirl, frame.recovery,
      inked ? 1 : 0, raining ? 1 : 0,
    ]);
    this.device.queue.writeBuffer(this.view, 0, view);
    const pipelines = this.pipelines;
    if (!pipelines) throw new Error('The optics are not compiled');
    // The full optics only while something beyond the resting water is on show.
    const playing = chamber || lamp > 0.001 || raining || inked || this.burstAge < BURST_SECONDS;
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: scene.createView(),
      clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }] });
    pass.setPipeline(playing ? pipelines.play : pipelines.rest);
    pass.setBindGroup(0, this.group);
    pass.draw(3);
    pass.end();
    this.lens.render(encoder, this.context.getCurrentTexture().createView());
    this.device.queue.submit([encoder.finish()]);
    // Backpressure: decorative work never builds an unbounded queue beside the terminals.
    await this.device.queue.onSubmittedWorkDone();
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    try { releaseContext(this.context, this.device); }
    finally { this.device.destroy(); }
  }
}
