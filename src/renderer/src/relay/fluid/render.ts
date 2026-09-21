/**
 * Screen-space fluid rendering for the sluice, in WebGL2.
 *
 * The companion traces an 80³ density volume through a refracting glass shell
 * on the GPU; this is the same idea in screen space, which is what makes the
 * water read as a surface rather than a smudge. Four passes:
 *
 *   1. depth      — every particle as a view-space sphere, nearest wins, the
 *                   eye-space z written to a float target
 *   2. thickness  — the same sprites accumulated additively, no depth test:
 *                   how much water a pixel looks through
 *   3. blur       — a narrow-range filter over the depth, twice in each axis
 *                   (the companion runs three separable smoothing passes); a
 *                   neighbour whose depth is far away is a different surface
 *                   and is dropped rather than averaged in
 *   4. composite  — normals from the smoothed depth's derivatives, one-sided at
 *                   a silhouette so the rim does not smear; then the shading
 *                   `optics.ts` uses — Fresnel at IOR 1.333 against studio
 *                   softboxes, refraction, Beer–Lambert through the thickness,
 *                   a broad specular sheen
 *
 * Orthographic down the column, so one world unit is the same number of
 * pixels wherever the water happens to be. The projection is derived from the
 * rig's own width and height; nothing here knows a basin from a pipe.
 *
 * `createFluidRenderer` returns null where WebGL2 or float render targets are
 * missing — that is the signal the view uses to fall back to the Simple tier,
 * never a thrown error — and `dispose()` deletes every GL object it made,
 * because this pane is mounted and unmounted inside a long-lived Electron
 * window.
 */
import type { RigLayout } from '@shared/relay-rig';
import { BLUR_FRAG, COMPOSITE_FRAG, DEPTH_FRAG, DEPTH_VERT, QUAD_VERT, THICKNESS_FRAG } from './shaders';

export type FluidTheme = 'dark' | 'light';

export type FluidRenderer = {
  resize(width: number, height: number): void;
  /** `positions` is xyz interleaved, world units; `n` particles are drawn. */
  draw(positions: Float32Array, n: number, rig: RigLayout, theme: FluidTheme): void;
  /**
   * True once a render target could not be allocated completely.
   *
   * A renderer can fail after it was built: targets are made on the first
   * resize, which happens once the canvas has a size. A caller that sees this
   * should dispose and fall back rather than keep calling `draw`, because
   * there is nothing this can usefully put on screen.
   */
  failed(): boolean;
  dispose(): void;
};

type Target = { texture: WebGLTexture; framebuffer: WebGLFramebuffer };

/** The particle sprite radius, in world units, relative to the spacing. */
const SPRITE_RADIUS_SPACINGS = 1.15;
/** The thickness sprite is a little larger so the body reads as continuous. */
const THICKNESS_SPRITE_SCALE = 1.3;
/** Blur sweeps: horizontal then vertical, twice. */
const BLUR_PASSES = 2;

/** True when this context can run the renderer at all. */
/**
 * Whether this machine can run the fluid, asked by doing the thing.
 *
 * The extension being present is necessary and not sufficient: it says the
 * driver advertises float colour buffers, not that RGBA16F attaches to a
 * framebuffer completely on this GPU. Drivers exist where it does not, and the
 * failure is silent — every draw into an incomplete framebuffer no-ops, the
 * textures keep whatever was in that memory, and the composite pass turns that
 * into a full-canvas block of colour. In a dark theme, where the tint is
 * (1, 1, 1), that block is white.
 *
 * So the probe allocates the exact attachment the renderer uses and asks
 * whether it is complete. A machine that cannot do it reports `false` and gets
 * the CSS rail, which is the fallback that already exists and looks right.
 */
export function fluidAvailableIn(canvas: HTMLCanvasElement): boolean {
  const gl = canvas.getContext('webgl2');
  if (!gl || !gl.getExtension('EXT_color_buffer_float')) return false;
  const texture = gl.createTexture();
  const framebuffer = gl.createFramebuffer();
  if (!texture || !framebuffer) return false;
  try {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 2, 2, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    return gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  } catch {
    return false;
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
  }
}

export function createFluidRenderer(canvas: HTMLCanvasElement, spacing: number): FluidRenderer | null {
  const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: false, antialias: false });
  if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;

  const shaders: WebGLShader[] = [];
  const programs: WebGLProgram[] = [];
  const compile = (type: number, source: string): WebGLShader => {
    const shader = gl.createShader(type);
    if (!shader) throw new Error('WebGL2 could not create a shader.');
    shaders.push(shader);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader) ?? 'A fluid shader did not compile.');
    }
    return shader;
  };
  const link = (vertex: string, fragment: string): WebGLProgram => {
    const program = gl.createProgram();
    if (!program) throw new Error('WebGL2 could not create a program.');
    programs.push(program);
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) ?? 'A fluid program did not link.');
    }
    return program;
  };

  let depthProgram: WebGLProgram, thickProgram: WebGLProgram, blurProgram: WebGLProgram, compProgram: WebGLProgram;
  try {
    depthProgram = link(DEPTH_VERT, DEPTH_FRAG);
    thickProgram = link(DEPTH_VERT, THICKNESS_FRAG);
    blurProgram = link(QUAD_VERT, BLUR_FRAG);
    compProgram = link(QUAD_VERT, COMPOSITE_FRAG);
  } catch {
    for (const p of programs) gl.deleteProgram(p);
    for (const s of shaders) gl.deleteShader(s);
    return null;
  }

  const vbo = gl.createBuffer();
  const particleVao = gl.createVertexArray();
  const quadVao = gl.createVertexArray();
  const depthBuffer = gl.createRenderbuffer();
  if (!vbo || !particleVao || !quadVao || !depthBuffer) return null;

  gl.bindVertexArray(particleVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  let width = 0, height = 0;
  let capacity = 0;
  let targets: { a: Target; b: Target; thick: Target } | null = null;
  const uploaded = new Float32Array(0);
  let staging = uploaded;
  /** Set once this renderer can no longer draw: a bad target, or a lost context. */
  let broken = false;

  /**
   * A lost context is silent, and this app invites one.
   *
   * Every GL call on a lost context succeeds and does nothing, so without this
   * the fluid keeps ticking into a dead context for the life of the window
   * while the canvas holds whatever pixels were in its buffer when the context
   * went. Wanigan runs the companion orb on WebGPU and a renderer per terminal
   * besides this one, and a machine under that much context pressure evicts
   * the one it thinks is least busy. That is why this fails after working
   * rather than instead of working, and why nothing about the GPU's
   * capabilities predicts it.
   *
   * `preventDefault` is deliberately not called: it asks the browser to
   * prepare a restore, and a half-restored simulation that resumes mid-frame
   * is a worse picture than the CSS rail. The mount drops to that instead.
   */
  const onLost = (event: Event) => { event.stopPropagation(); broken = true; };
  canvas.addEventListener('webglcontextlost', onLost);

  const makeTarget = (): Target | null => {
    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    if (!texture || !framebuffer) return null;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    // Unchecked, an incomplete attachment is silent: every draw into it is
    // dropped, the texture keeps whatever was in that memory, and the
    // composite pass reads it as if it were water. Asking costs one call.
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteFramebuffer(framebuffer);
      gl.deleteTexture(texture);
      return null;
    }
    return { texture, framebuffer };
  };
  const dropTargets = () => {
    if (!targets) return;
    for (const t of [targets.a, targets.b, targets.thick]) {
      gl.deleteFramebuffer(t.framebuffer);
      gl.deleteTexture(t.texture);
    }
    targets = null;
  };

  const resize = (w: number, h: number) => {
    if (broken) return;
    if (w === width && h === height && targets) return;
    width = Math.max(2, w | 0);
    height = Math.max(2, h | 0);
    dropTargets();
    const a = makeTarget(), b = makeTarget(), thick = makeTarget();
    if (!a || !b || !thick) {
      for (const t of [a, b, thick]) {
        if (!t) continue;
        gl.deleteFramebuffer(t.framebuffer);
        gl.deleteTexture(t.texture);
      }
      broken = true;
      targets = null;
      return;
    }
    targets = { a, b, thick };
    gl.bindRenderbuffer(gl.RENDERBUFFER, depthBuffer);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.a.framebuffer);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthBuffer);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  };

  const u = (program: WebGLProgram, name: string) => gl.getUniformLocation(program, name);

  const draw = (positions: Float32Array, n: number, rig: RigLayout, theme: FluidTheme) => {
    if (!broken && gl.isContextLost()) broken = true;
    if (broken || !targets || n <= 0) return;
    const halfW = rig.width / 2, halfH = rig.height / 2, halfD = rig.depth / 2;

    // Centre the world on the origin for the orthographic projection.
    if (staging.length < n * 3) { staging = new Float32Array(n * 3); capacity = 0; }
    for (let i = 0; i < n; i++) {
      staging[i * 3] = positions[i * 3] - halfW;
      staging[i * 3 + 1] = positions[i * 3 + 1] - halfH;
      staging[i * 3 + 2] = positions[i * 3 + 2] - halfD;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    if (capacity < n * 3) {
      gl.bufferData(gl.ARRAY_BUFFER, staging.byteLength, gl.DYNAMIC_DRAW);
      capacity = staging.length;
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, staging.subarray(0, n * 3));

    // Orthographic: x,y to clip space by the rig's half extents; z scaled so
    // gl_FragDepth in the depth shader lands in [0,1] for the slab.
    const proj = new Float32Array([
      1 / halfW, 0, 0, 0,
      0, 1 / halfH, 0, 0,
      0, 0, -0.25, 0,
      0, 0, 0.5, 1,
    ]);
    const pxPerUnit = height / rig.height;
    const radiusWorld = spacing * SPRITE_RADIUS_SPACINGS;
    const spritePx = 2 * radiusWorld * pxPerUnit;

    gl.viewport(0, 0, width, height);
    gl.bindVertexArray(particleVao);

    // 1 · depth
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.a.framebuffer);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.disable(gl.BLEND);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(depthProgram);
    gl.uniformMatrix4fv(u(depthProgram, 'uProj'), false, proj);
    gl.uniform1f(u(depthProgram, 'uSize'), spritePx);
    gl.uniform1f(u(depthProgram, 'uRadW'), radiusWorld);
    gl.drawArrays(gl.POINTS, 0, n);

    // 2 · thickness
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.thick.framebuffer);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(thickProgram);
    gl.uniformMatrix4fv(u(thickProgram, 'uProj'), false, proj);
    gl.uniform1f(u(thickProgram, 'uSize'), spritePx * THICKNESS_SPRITE_SCALE);
    gl.drawArrays(gl.POINTS, 0, n);
    gl.disable(gl.BLEND);

    // 3 · blur, ping-pong; the smoothed depth ends back in target a
    gl.bindVertexArray(quadVao);
    gl.useProgram(blurProgram);
    gl.uniform1i(u(blurProgram, 'uSrc'), 0);
    gl.activeTexture(gl.TEXTURE0);
    for (let pass = 0; pass < BLUR_PASSES; pass++) {
      for (const [src, dst, dx, dy] of [
        [targets.a, targets.b, 1 / width, 0],
        [targets.b, targets.a, 0, 1 / height],
      ] as const) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, dst.framebuffer);
        gl.bindTexture(gl.TEXTURE_2D, src.texture);
        gl.uniform2f(u(blurProgram, 'uDir'), dx, dy);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
    }

    // 4 · composite onto the canvas
    const light = theme === 'light';
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(compProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, targets.a.texture);
    gl.uniform1i(u(compProgram, 'uDepth'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, targets.thick.texture);
    gl.uniform1i(u(compProgram, 'uThick'), 1);
    gl.uniform2f(u(compProgram, 'uTexel'), 1 / width, 1 / height);
    gl.uniform2f(u(compProgram, 'uHalf'), halfW, halfH);
    gl.uniform3f(u(compProgram, 'uTint'), light ? 0.72 : 1, light ? 0.86 : 1, 1);
    gl.uniform1f(u(compProgram, 'uLight'), light ? 0.55 : 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  };

  const dispose = () => {
    canvas.removeEventListener('webglcontextlost', onLost);
    dropTargets();
    gl.deleteRenderbuffer(depthBuffer);
    gl.deleteVertexArray(particleVao);
    gl.deleteVertexArray(quadVao);
    gl.deleteBuffer(vbo);
    for (const p of programs) gl.deleteProgram(p);
    for (const s of shaders) gl.deleteShader(s);
    const lose = gl.getExtension('WEBGL_lose_context');
    lose?.loseContext();
  };

  return { resize, draw, failed: () => broken, dispose };
}
