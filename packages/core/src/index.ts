/**
 * @sih/core — shared contracts for the SIH26171 privacy vision browser agent.
 *
 * Deliberately dependency-free and side-effect-free. Everything here is either
 * a type, a pure function, or a policy constant, so it can be imported from a
 * content script, a service worker, an offscreen document, or a Node test with
 * no environment assumptions.
 */

export * from './geometry.ts';
export * from './element.ts';
export * from './pii.ts';
export * from './checksum.ts';
export * from './vault.ts';
export * from './provider.ts';
export * from './action.ts';
export * from './capabilities.ts';
export * from './platform.ts';
