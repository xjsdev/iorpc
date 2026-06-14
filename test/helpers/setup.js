import { pair } from '../../index.esm.js';
import { createLink } from './link.js';

/**
 * Creates two connected iorpc instances (server/client) over a simulated link.
 *
 * @param {object} [config]
 * @param {object} [config.localA] - local API for side A
 * @param {object} [config.localB] - local API for side B
 * @param {object} [config.optionsA] - iorpc options for side A
 * @param {object} [config.optionsB] - iorpc options for side B
 * @param {object} [config.linkOpts] - options for createLink (delay, dropAll)
 * @returns {{ a: object, b: object, link: object }}
 */
export function createPair({
  localA = {},
  localB = {},
  optionsA = {},
  optionsB = {},
  linkOpts = {}
} = {}) {
  const link = createLink(linkOpts);

  const a = pair({
    send: link.sideA.send,
    on: link.sideA.on,
    local: localA,
    options: optionsA
  });

  const b = pair({
    send: link.sideB.send,
    on: link.sideB.on,
    local: localB,
    options: optionsB
  });

  return { a, b, link };
}

/** Wait for pending microtasks/timers to flush */
export const tick = (n = 0) => new Promise(resolve => setTimeout(resolve, n));
