// Optional native regression: every wrapped GPU call delegates to the actual API.
// Preload the GPU module: the experiment controls create() suspension, not import timing.
import { mountOrb } from '../src/renderer/src/orb/mount.ts';
import { OrbRuntime } from '../src/renderer/src/orb/runtime.ts';

const CASES = ['single', 'late-texture', 'late-pipeline', 'fresh-canvas', 'late-frame'];
let started = false;

window.runOrbCase = async function runOrbCase(name) {
  if (started || !CASES.includes(name)) throw new Error('One named case per fresh page');
  started = true;
  const trace = [], cleanups = [], mounts = [], creations = [], devices = [];
  const owners = new Map(), deviceIds = new WeakMap(), deviceContexts = new Map();
  const contextIds = new WeakMap(), adapterIds = new WeakMap();
  const nativeErrors = [], failures = [];
  const state = { name, status: 'running', trace, nativeErrors, failures, ready: {}, frames: {}, cleanup: {} };
  window.orbProbe = state;
  const record = (kind, fields = {}) => { trace.push({ n: trace.length, at: performance.now(), kind, ...fields }); };
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const wait = async (predicate, description, timeout = 15000) => {
    const until = performance.now() + timeout;
    while (!predicate()) {
      if (performance.now() >= until) throw new Error('Timed out: ' + description);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  const checkpoint = async label => {
    record('checkpoint', { label });
    if (typeof window.orbCheckpoint === 'function') await window.orbCheckpoint(label);
  };
  const gate = label => {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    let open = false;
    return { promise, release() { if (!open) { open = true; record('release', { label }); release(); } } };
  };
  const texture = gate('texture-A'), pipeline = gate('pipeline-A'), rendered = gate('frame-A');
  const held = { texture: false, pipeline: false, frame: false };
  const creationState = new Map();
  const patch = (target, key, wrap) => {
    const own = Object.getOwnPropertyDescriptor(target, key);
    const original = target[key];
    check(typeof original === 'function', 'Missing native method ' + key);
    Object.defineProperty(target, key, { configurable: true, writable: true, value: wrap(original) });
    cleanups.push(() => own ? Object.defineProperty(target, key, own) : delete target[key]);
  };
  let destroying = null;
  const onUnhandled = event => { failures.push({ kind: 'unhandledrejection', message: String(event.reason) }); };
  window.addEventListener('unhandledrejection', onUnhandled);
  cleanups.push(() => window.removeEventListener('unhandledrejection', onUnhandled));
  const makeCanvas = id => {
    const host = document.createElement('div'); host.className = 'host';
    const canvas = document.createElement('canvas'); canvas.id = id;
    canvas.width = canvas.height = 192; host.append(canvas);
    document.querySelector('#canvases').append(host);
    const context = canvas.getContext('webgpu');
    check(context, 'No real WebGPU canvas context'); contextIds.set(context, id); owners.set(id, null);
    return { host, canvas, id };
  };
  const mount = (id, surface) => {
    record('mount', { id, canvas: surface.id });
    const value = mountOrb(surface.host, surface.canvas, {
      compact: true, signal: 'quiet', mood: 'idle', material: 'water',
      onReady() { state.ready[id] = true; record('ready', { id, frames: Number(surface.canvas.dataset.frames || 0) }); },
      onUnavailable() { failures.push({ kind: 'fallback', id }); record('fallback', { id }); },
    });
    mounts.push(value); return value;
  };
  const dispose = (id, value) => { record('dispose', { id }); value.dispose(); };
  const ready = async id => {
    await wait(() => state.ready[id] || failures.some(f => f.id === id), id + ' first submitted frame');
    check(state.ready[id], id + ' became unavailable before its first frame');
  };
  const frame = async (id, value, signal, requireHealthy) => {
    const before = trace.length;
    value.setSignal(signal);
    await wait(() => trace.slice(before).some(e => e.id === id && ['render-done', 'render-error', 'fallback'].includes(e.kind)), id + ' redraw');
    // A successful render promise is distinct from the asynchronous native validation event.
    // Two animation turns allow the owned event queue to deliver that event; no key/input timing is involved.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (requireHealthy) {
      check(trace.slice(before).some(e => e.id === id && e.kind === 'render-done'), id + ' redraw did not finish');
      check(!failures.some(f => f.id === id), id + ' fell back');
      check(!nativeErrors.some(e => e.id === id), id + ' emitted native validation errors');
    }
  };
  try {
    if (!navigator.gpu) { state.status = 'blocked'; state.reason = 'navigator.gpu unavailable'; return state; }
    check(matchMedia('(prefers-reduced-motion: reduce)').matches, 'Use reduced motion to bound frame activity');
    check(!document.hidden, 'Probe must be visible');
    patch(navigator.gpu, 'requestAdapter', original => async function (...args) {
      const adapter = await original.apply(this, args);
      if (!adapter) { record('no-adapter'); return adapter; }
      const id = adapterIds.get(adapter) || 'adapter-' + (trace.filter(e => e.kind === 'adapter').length + 1);
      adapterIds.set(adapter, id);
      const info = adapter.info;
      record('adapter', { id, fallback: adapter.isFallbackAdapter ?? null, info: info ? {
        vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description,
      } : null });
      return adapter;
    });
    patch(GPUAdapter.prototype, 'requestDevice', original => async function (...args) {
      check(devices.length < 2, 'Only two native devices are allowed in one case');
      const device = await original.apply(this, args);
      const id = devices.length === 0 ? 'A' : 'B'; devices.push(device); deviceIds.set(device, id);
      record('device', { id, adapter: adapterIds.get(this) });
      device.addEventListener('uncapturederror', event => {
        const value = { id, message: event.error.message }; nativeErrors.push(value); record('native-error', value);
      });
      void device.lost.then(info => record('device-lost', { id, reason: info.reason, message: info.message }));
      return device;
    });
    patch(GPUCanvasContext.prototype, 'configure', original => function (configuration) {
      const canvas = contextIds.get(this), id = deviceIds.get(configuration.device);
      const previous = owners.get(canvas); const answer = original.call(this, configuration);
      owners.set(canvas, id); deviceContexts.set(id, canvas); record('configure', { id, canvas, previous }); return answer;
    });
    patch(GPUCanvasContext.prototype, 'unconfigure', original => function (...args) {
      const canvas = contextIds.get(this), previous = owners.get(canvas);
      record('unconfigure', { id: destroying, canvas, previous });
      const answer = original.apply(this, args); owners.set(canvas, null); return answer;
    });
    patch(GPUDevice.prototype, 'destroy', original => function (...args) {
      record('device-destroy', { id: deviceIds.get(this) }); return original.apply(this, args);
    });
    patch(window, 'fetch', original => async function (input, init) {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
      check(url.origin === location.origin, 'Only this owned origin may be fetched');
      const response = await original.call(this, input, init);
      record('fetch', { path: url.pathname, status: response.status });
      if (['late-texture', 'fresh-canvas'].includes(name) && !held.texture && /\/room-[^/]+\.png$/.test(url.pathname)) {
        held.texture = true; record('gate', { label: 'texture-A' }); await texture.promise;
      }
      return response;
    });
    patch(GPUDevice.prototype, 'createRenderPipelineAsync', original => function (descriptor) {
      const id = deviceIds.get(this);
      return original.call(this, descriptor).then(async value => {
        record('pipeline-native-done', { id, label: descriptor.label });
        if (!['single', 'late-frame'].includes(name) && id === 'A' && descriptor.label === 'Wanigan glass vessel') {
          check(!held.pipeline, 'One pipeline hold only'); held.pipeline = true;
          record('gate', { label: 'pipeline-A' }); await pipeline.promise;
        }
        return value;
      });
    });
    patch(OrbRuntime, 'create', original => function (...args) {
      const [canvas] = args, id = creations.length === 0 ? 'A' : 'B';
      creationState.set(id, 'pending');
      const pending = original.apply(this, args).then(value => {
        creationState.set(id, 'fulfilled');
        record('create-done', { id: deviceIds.get(value.device), canvas: canvas.id }); return value;
      }, error => { creationState.set(id, 'rejected'); record('create-error', { id, canvas: canvas.id, errorName: error?.name, message: String(error) }); throw error; });
      creations.push(pending); return pending;
    });
    patch(OrbRuntime.prototype, 'render', original => async function (...args) {
      const id = deviceIds.get(this.device), canvas = deviceContexts.get(id);
      record('render-start', { id, canvas, owner: owners.get(canvas) });
      try { const value = await original.apply(this, args); state.frames[id] = (state.frames[id] || 0) + 1;
        record('render-done', { id, frames: state.frames[id] });
        if (name === 'late-frame' && id === 'A' && !held.frame) {
          held.frame = true; record('gate', { label: 'frame-A' }); await rendered.promise;
          record('render-delivered', { id });
        }
        return value;
      } catch (error) { record('render-error', { id, message: String(error) }); throw error; }
    });
    patch(OrbRuntime.prototype, 'destroy', original => function (...args) {
      const old = destroying; destroying = deviceIds.get(this.device);
      record('runtime-destroy', { id: destroying });
      try { return original.apply(this, args); } finally { destroying = old; }
    });

    const first = makeCanvas('canvas-A'), a = mount('A', first);
    if (name === 'single') {
      await ready('A'); await frame('A', a, 'working', true); await checkpoint('healthy');
      state.status = 'healthy';
    } else if (name === 'late-frame') {
      await wait(() => held.frame, 'A actual native first frame completed before mount receives it');
      check(state.ready.A === undefined, 'A must still be pending at the controlled render boundary');
      dispose('A', a);
      const b = mount('B', first); await ready('B');
      await checkpoint('replacement-ready');
      rendered.release();
      await wait(() => trace.some(e => e.kind === 'render-delivered' && e.id === 'A'), 'A native render result delivered');
      // The native result was already real; only its promise delivery was held.
      // B's requested native redraw also gives the old mount continuation a turn.
      await frame('B', b, 'working', true);
      state.status = 'observed';
      state.observation = { staleReady: state.ready.A === true };
      await checkpoint('after-stale-creation');
    } else {
      const firstGate = name === 'late-pipeline' ? 'pipeline-A' : 'texture-A';
      await wait(() => trace.some(e => e.kind === 'gate' && e.label === firstGate) || failures.some(f => f.id === 'A'), firstGate);
      check(trace.some(e => e.kind === 'gate' && e.label === firstGate), 'A failed before the selected real suspension');
      dispose('A', a);
      const second = name === 'fresh-canvas' ? makeCanvas('canvas-B') : first;
      const b = mount('B', second); await ready('B');
      record('B-before-release', { frames: state.frames.B, owner: owners.get(second.id) });
      await checkpoint('replacement-ready');
      if (name !== 'late-pipeline') {
        texture.release(); await wait(() => held.pipeline || creationState.get('A') === 'rejected', 'A native pipeline completion or actual canceled creation after texture release');
        await frame('B', b, 'working', name === 'fresh-canvas');
      }
      pipeline.release();
      await wait(() => trace.some(e => e.kind === 'device-destroy' && e.id === 'A'), 'stale A native device destruction');
      if (!failures.some(f => f.id === 'B')) await frame('B', b, 'attention', name === 'fresh-canvas');
      const overwritten = trace.some(e => e.kind === 'configure' && e.id === 'A' && e.previous === 'B');
      const staleUnconfigure = trace.some(e => e.kind === 'unconfigure' && e.id === 'A' && e.previous === 'B');
      const wrongOwner = trace.some(e => e.kind === 'render-start' && e.id === 'B' && e.owner !== 'B');
      const functionalFailure = failures.some(f => f.id === 'B') || nativeErrors.some(e => e.id === 'B') || trace.some(e => e.kind === 'render-error' && e.id === 'B');
      state.observation = { overwritten, staleUnconfigure, wrongOwner, functionalFailure };
      state.status = name === 'fresh-canvas' ? 'healthy' : functionalFailure ? 'reproduced' : 'ownership-only';
      await checkpoint('after-stale-creation');
    }
  } catch (error) {
    state.status = trace.some(e => e.kind === 'no-adapter') ? 'blocked' : 'failed'; state.reason = String(error);
  } finally {
    texture.release(); pipeline.release(); rendered.release();
    for (const value of mounts) value.dispose();
    let settled = false;
    void Promise.allSettled(creations).then(() => { settled = true; });
    try { await wait(() => settled, 'creation cleanup', 10000); }
    catch (error) { state.cleanup.error = String(error); }
    // This emergency path only touches actual device handles returned to this page.
    const untouched = devices.filter(device => !trace.some(e => e.kind === 'device-destroy' && e.id === deviceIds.get(device)));
    for (const device of untouched) device.destroy();
    state.cleanup.emergencyDeviceDestructions = untouched.length;
    state.cleanup.creationsSettled = settled;
    state.cleanup.destroyedIds = [...new Set(trace.filter(e => e.kind === 'device-destroy').map(e => e.id))];
    state.cleanup.owners = Object.fromEntries(owners);
    for (const restore of cleanups.reverse()) restore();
    state.cleanup.wrappersRestored = true;
    state.cleanup.unhandledCount = failures.filter(f => f.kind === 'unhandledrejection').length;
  }
  return state;
};
