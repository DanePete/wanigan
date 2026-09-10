# Animation libraries for Wanigan

Research checked 2026-09-09 against official documentation and source. The brief is a UI with substantial personality: an expressive companion, liquid/bubble accents, and satisfying buttons. These are implementation candidates, not an approved design. No libraries were installed and no Electron performance was measured.

## Recommended combinations

1. **Motion + an original SVG companion + one Paper Shaders accent.** Recommended first implementation: springy controls, a blinking/pointer-following character built from editable SVG, and a contained liquid or bubble surface. This keeps ordinary UI and character behavior in React while reserving WebGL for a specific visual moment. SVG character feasibility is a design inference from Motion's SVG/gesture support, not a supplied mascot asset. [Motion SVG](https://motion.dev/docs/react-svg-animation), [gestures](https://motion.dev/docs/react-gestures), [Paper gallery](https://shaders.paper.design/).
2. **Motion + an authored Rive companion + Paper Shaders.** Strongest option for a character with multiple coordinated poses, gaze, blinking and reactions. Rive supplies state machines and pointer listeners; the actual character and its animations still need authoring. It adds a `.riv` asset and matching WASM runtime to package locally. [Rive React](https://rive.app/docs/runtimes/react/react), [listeners](https://rive.app/docs/editor/state-machine/listeners), [WASM hosting](https://rive.app/docs/runtimes/web/preloading-wasm).
3. **Motion + selected React Bits effects.** Best for rapidly exploring different looks. Treat the collection as individually reviewed source components; dependencies and lifecycle behavior vary by effect. Its TypeScript/CSS variant fits Wanigan better than adding a Tailwind stack. [React Bits repository](https://github.com/DavidHDev/react-bits).

These rankings reflect fit for Wanigan, not benchmark results or a claim about industry popularity.

## Motion: the UI foundation

- The `motion` package imports through `motion/react`; official installation docs require React 18.2 or later, covering Wanigan's declared React 19 dependency. [Installation](https://motion.dev/docs/react-installation).
- Hover, press, focus, drag and in-view gestures can drive coordinated variants. Native `motion.button` elements are suitable for a restrained squash, spring return, or icon reaction while retaining button semantics. [Gestures](https://motion.dev/docs/react-gestures).
- `MotionConfig reducedMotion="user"` disables transform/layout animation when the OS requests reduced motion, but preserves other animated properties. `useReducedMotion()` lets us also disable character wandering, sparks and shader motion explicitly. It is not an automatic switch for third-party canvases. [Accessibility](https://motion.dev/docs/react-accessibility).
- `LazyMotion`/`m` and selective imports can defer animation features. Measure the built Wanigan bundle rather than quoting a vendor size as an observed application cost. [Bundle guidance](https://motion.dev/docs/react-reduce-bundle-size).
- The core repository is MIT licensed. Paid Motion+ components are separate and are unnecessary for basic springs, gestures, and an original SVG companion. [Core license](https://github.com/motiondivision/motion/blob/main/LICENSE.md), [gesture documentation](https://motion.dev/docs/react-gestures).

## Rive: an expressive authored companion

- The current React quick start uses `@rive-app/react-webgl2` and `useRive`. React 19 appears in the repository's peer dependency range. [React guide](https://rive.app/docs/runtimes/react/react), [package source](https://github.com/rive-app/rive-react/blob/main/package.json).
- Pointer enter/exit/move/down/up/click listeners and Align Target can drive gaze and interactions inside the tracked canvas area. A blink is an authored animation; Rive does not supply Wanigan's character design automatically. [Listeners](https://rive.app/docs/editor/state-machine/listeners).
- New integrations should use data binding: `useStateMachineInput` is marked deprecated in current documentation. Keep companion reactions connected to observed app events; a decorative idle blink should never imply an agent is running. [React API](https://rive.app/docs/runtimes/react/parameters-and-return-values), [repository guardrails](../../AGENTS.md).
- Rive can load a local `.riv` file. Configure `RuntimeLoader.setWasmUrl()` to a bundled WASM asset; default runtime loading may contact a CDN, and the WASM version must match its runtime package. Bundle any referenced art assets too. [React guide](https://rive.app/docs/runtimes/react/react), [WASM hosting](https://rive.app/docs/runtimes/web/preloading-wasm).
- `stopRendering()`/`startRendering()` control the render loop; `cleanup()` disposes runtime resources. Use a static pose for reduced motion and suspend hidden/inactive artwork deliberately. These are integration requirements, not verified automatic behavior in Wanigan. [Runtime API](https://rive.app/docs/runtimes/web/rive-parameters).
- The React runtime is MIT licensed; that identifies the code license, not permission to reuse any community character asset. [Runtime license](https://github.com/rive-app/rive-react/blob/main/LICENSE).

## Paper Shaders: water and merging bubbles

- `Water` provides caustic distortion, waves and highlights, as an image effect or standalone texture. `Metaballs` produces smoothly merging animated blobs with configurable count, size and palette. [Water demo](https://shaders.paper.design/water), [Metaballs demo](https://shaders.paper.design/metaballs).
- `@paper-design/shaders-react` depends on the core shader package and declares React 18/19 compatibility. Its repository asks users to pin the dependency because breaking changes can occur within `0.0.x`. [Package source](https://github.com/paper-design/shaders/blob/main/packages/shaders-react/package.json), [repository guidance](https://github.com/paper-design/shaders).
- `speed={0}` stops scheduling animation frames; `frame` chooses a still pose. `minPixelRatio` and `maxPixelCount` control rendering resolution. Current source pauses for document invisibility and offscreen intersection, exposes disposal, and requires WebGL2. Add a static fallback and map Wanigan's reduced-motion preference to speed explicitly. [Renderer source](https://github.com/paper-design/shaders/blob/main/packages/shaders/src/shader-mount.ts), [Water props](https://shaders.paper.design/water).
- Procedural effects need no remote image. For image-based effects, supply bundled assets instead of the remote URLs shown in examples. The React wrapper loads supplied image URLs and disposes its shader mount on cleanup. [Wrapper source](https://github.com/paper-design/shaders/blob/main/packages/shaders-react/src/shader-mount.tsx).
- Apache-2.0 license; retain the distributed license/notice information. [Repository license information](https://github.com/paper-design/shaders#license-and-use).

## React Bits: visual experiments to select carefully

Useful demos: [Splash Cursor](https://reactbits.dev/animations/splash-cursor), [Meta Balls](https://reactbits.dev/animations/meta-balls), [Blob Cursor](https://reactbits.dev/animations/blob-cursor), [Magnet](https://reactbits.dev/animations/magnet), [Click Spark](https://reactbits.dev/animations/click-spark).

The repository offers copied components in JS/TS with CSS/Tailwind variants. This is not one uniform animation runtime. Blob Cursor imports GSAP; Meta Balls imports OGL; Magnet and Click Spark use React/browser APIs. Magnet exposes `disabled`; the inspected canvas components require an explicit reduced-motion/visibility policy instead of assuming a shared library setting. [Repository](https://github.com/DavidHDev/react-bits), [Blob Cursor source](https://github.com/DavidHDev/react-bits/blob/main/src/ts-default/Animations/BlobCursor/BlobCursor.tsx), [Meta Balls source](https://github.com/DavidHDev/react-bits/blob/main/src/ts-default/Animations/MetaBalls/MetaBalls.tsx), [Magnet source](https://github.com/DavidHDev/react-bits/blob/main/src/ts-default/Animations/Magnet/Magnet.tsx), [Click Spark source](https://github.com/DavidHDev/react-bits/blob/main/src/ts-default/Animations/ClickSpark/ClickSpark.tsx).

Its current license is **MIT + Commons Clause**, with additional restrictions on selling, sublicensing or redistributing the components themselves. Do not label it plain MIT or assume Wanigan's MIT license replaces the component's terms. [License text](https://github.com/DavidHDev/react-bits/blob/main/LICENSE.md).

## Integration checks before shipping

Use shared Wanigan controls and tokens; adapt copied example CSS. Keep visual effects behind content and out of terminal text selection. Verify both themes, keyboard input, reduced motion, inactive/unmounted views, packaged offline asset loading and a WebGL-unavailable fallback. Record before/after screenshots and run the repository's required checks after a code change. These are proposed checks, not results. [Repository rules](../../AGENTS.md).
