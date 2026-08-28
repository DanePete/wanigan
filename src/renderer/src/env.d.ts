import type { WaniganApi } from '../../preload/index';

declare global {
  interface Window { wanigan: WaniganApi }
}
export {};
