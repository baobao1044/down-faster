/** Ghi log gọn, tự tắt khi build production. */

declare const __DEV__: boolean;

const enabled = typeof __DEV__ !== 'undefined' ? __DEV__ : true;

export function log(scope: string, ...args: unknown[]): void {
  if (enabled) console.log(`[df:${scope}]`, ...args);
}

export function warn(scope: string, ...args: unknown[]): void {
  console.warn(`[df:${scope}]`, ...args);
}

export function error(scope: string, ...args: unknown[]): void {
  console.error(`[df:${scope}]`, ...args);
}
