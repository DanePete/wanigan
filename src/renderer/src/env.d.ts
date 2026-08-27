import type { ForemanApi } from '../../preload/index';

declare global {
  interface Window { foreman: ForemanApi }
}
export {};
