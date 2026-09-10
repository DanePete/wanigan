export interface LiquidParams {
  box: number[]; spacing: number; restDensity: number; gravity: number;
  substeps: number; iterations: number; cfmEpsilonRel: number; sCorrK: number;
  sCorrDq: number; xsphC: number; omega: number; sorAverage: boolean;
  surfaceTensionK: number; bodies: string[]; pour: boolean;
}
export class Sim {
  constructor(device: GPUDevice);
  reset(params: LiquidParams): void;
  step(dt: number): void;
  applyRayImpulse(origin: number[], direction: number[], impulse: number[], radius: number, limit: number): void;
  params: LiquidParams;
  n: number;
  h: number;
  parity: number;
  gridDim: number[];
  scene: { mass: number };
  buf: Record<string, GPUBuffer>;
  stats: { avgRho: number; maxRho: number; maxSpeed: number };
}
