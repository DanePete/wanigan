export interface LiquidParams {
  box: [number, number, number]; spacing: number; restDensity: number; gravity: number;
  substeps: number; iterations: number; cfmEpsilonRel: number; sCorrK: number;
  sCorrDq: number; xsphC: number; omega: number; sorAverage: boolean; surfaceTensionK: number;
}
type Side = 'A' | 'B';
export class Sim {
  constructor(device: GPUDevice);
  reset(params: LiquidParams): void;
  step(dt: number): void;
  applyRayImpulse(origin: number[], direction: number[], impulse: number[], radius: number, speedLimit: number): void;
  readonly n: number;
  readonly h: number;
  readonly parity: 0 | 1;
  readonly gridDim: [number, number, number];
  readonly scene: { readonly mass: number };
  readonly buf: Readonly<Record<`pos${Side}` | `vel${Side}` | 'density' | 'cellStart', GPUBuffer>>;
}
