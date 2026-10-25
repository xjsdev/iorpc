// extract values
const recuFilter = (tree, copy, valCreator) => {
  const recu = (tree, copy) => {
    if (typeof tree === 'object') {
      for (let k of Object.keys(tree)) {
        if (['__proto__', 'constructor', 'prototype'].includes(k)) continue;
        copy[k] = {};
        if (tree[k] instanceof Function || typeof tree[k] === "function") {
          copy[k] = valCreator(tree[k]);
        } else {
          recu(tree[k], copy[k]);
          if (Object.keys(copy[k]).length === 0) delete copy[k];
        }
      }
    }
  };
  recu(tree, copy);
};
// replace values
const recuPatch = (tree, target, patchFn) => {
  const recu = (tree, target) => {
    for (let k of Object.keys(tree)) {
      if (['__proto__', 'constructor', 'prototype'].includes(k)) continue;
      if (typeof tree[k] === 'object') {
        recu(tree[k], target[k]);
      } else {
        patchFn(tree, target, k);
      }
    }
  };
  recu(tree, target);
};
// copy values from args
const recuCopy = (tree, mutable) => {
  const copy = [];
  const recu = (tree, mutable, copy) => {
    for (let k of Object.keys(tree)) {
      if (['__proto__', 'constructor', 'prototype'].includes(k)) continue;
      if (typeof tree[k] === 'object') {
        if (k in mutable) {
          if (Array.isArray(tree[k])) copy[k] = [];else copy[k] = {};
          recu(tree[k], mutable[k], copy[k]);
        } else {
          copy[k] = tree[k];
        }
      } else {
        copy[k] = tree[k];
      }
    }
  };
  recu(tree, mutable, copy);
  return copy;
};
/**
 * Create new iorpc instance
 *
 * @param {function} sendFn - Function to send data to the iorpc instance on the other side.
 * @param {object} [localApi] - An object containing methods callable from the remote side;
 *                              this is optional if you don't need the remote side to call methods back on this side.
 * @param {object} [options] - Configuration options.
 * @param {number} [options.maxPendingResponses=10000] - Maximum number of unresolved function calls allowed at a time.
 *                                                       Prevents memory overuse or flooding; throws error if exceeded.
 * @param {boolean} [options.allowNestedFunctions=true] - If true, allows functions to be passed inside arrays or objects.
 *                                                        They will be automatically serialized and wrapped for remote calls.
 * @param {boolean} [options.exposeErrors=true] - If true, remote errors (including stack traces) will be forwarded.
 *                                                If false, remote errors will be replaced with a generic message.
 * @param {boolean} [options.injectToThis=true] - If true, 'this' inside a function will be replaced with the iorpc object.
 *                                                Useful for context-aware APIs.
 * @param {boolean} [options.ignoreCallbackUnavailable=false] - If true, missing-callback errors are ignored.
 * @param {number} [options.callTimeout=0] - Milliseconds before a pending remote call is rejected with
 *                                           an Error whose `code === 'IORPC_TIMEOUT'`. `0` disables timers (default).
 * @param {function} [options.cbIdGenerator] - Custom callback-id generator `() => number|string`.
 *                                             Defaults to a random integer. Collision check against the local map remains.
 * @param {boolean} [options.taggedPackets=false] - If true, packets carry an explicit `kind: 'call'|'cb'` and routing
 *                                                  uses it instead of the isNaN heuristic. Both sides must match. Default keeps
 *                                                  the wire-format identical to 9.2.2.
 * @param {function} [options.onTrim] - Called as `(removedIds: Array)` whenever clbsTrim evicts entries.
 *
 * @returns {{ remoteApi: object, routeInput: function, pending: function, rejectAll: function, bindings: function }}
 *    - `remoteApi`: proxy API to call remote functions,
 *    - `routeInput`: function to pass incoming messages from the other side,
 *    - `pending`: returns the size of the waiting list to check if it is overflowing,
 *    - `rejectAll(err?)`: rejects all pending response promises and clears bindings (use on transport close),
 *    - `bindings()`: returns `{ calls, callbacks }` diagnostic breakdown of `pending`.
 */
const createIorpc = (sendFn, localApi = {}, {
  maxPendingResponses = 10000,
  allowNestedFunctions = false,
  exposeErrors = true,
  injectToThis = true,
  ignoreCallbackUnavailable = false,
  callTimeout = 0,
  cbIdGenerator = null,
  taggedPackets = false,
  onTrim = null
}) => {
  const clbs = {};
  let trimWarningFired = false;
  let noWait = false;
  // taggedPackets: set right before invoking a remote callback wrapper, so the
  // outgoing packet is tagged kind:'cb'. Reset after each remoteApi access.
  let cbInvoke = false;
  let pending = 0;
  const clbsTrim = () => {
    if (!trimWarningFired) {
      console.warn(`maxPendingResponses > ${maxPendingResponses}. Check if callback bindings are being released after use. The oldest ones have been removed, this operation requires some extra resources. Now the oldest ones may not work.`);
      trimWarningFired = true;
    }
    const clbsArr = Object.values(clbs);
    clbsArr.sort((a, b) => a.lastAck - b.lastAck);
    const removed = clbsArr.slice(0, pending - maxPendingResponses).map(v => v.cbId);
    removed.forEach(cbId => {
      pending--;
      delete clbs[cbId];
    });
    if (onTrim && removed.length) {
      try {
        onTrim(removed);
      } catch (e) {/* user callback must not break trimming */}
    }
  };
  const genCbid = () => {
    while (true) {
      const cbId = cbIdGenerator ? cbIdGenerator() : Math.round(Math.random() * Number.MAX_SAFE_INTEGER);
      if (cbId in clbs) continue;
      return cbId;
    }
  };

  /**
   * An proxy-object with remoteApi callers
   */
  const remoteApi = new Proxy({}, {
    get: (_, thisArg) => {
      if (thisArg === 'noWait') {
        noWait = true;
        return remoteApi;
      } else {
        // Capture and reset the callback-invoke flag at access time: the cb
        // wrapper sets it immediately before reading remoteApi[cbId].
        const isCbInvoke = cbInvoke;
        cbInvoke = false;
        return function (...args) {
          const packet = {
            apiFunc: thisArg,
            cbId: false,
            args,
            argsTransform: allowNestedFunctions ? {} : []
          };
          // taggedPackets: mark whether apiFunc is a named method call or a callback id.
          // Added only when the option is enabled so the default wire-format stays
          // byte-identical to 9.2.2.
          if (taggedPackets) {
            packet.kind = isCbInvoke ? 'cb' : 'call';
          }
          if (!noWait) packet.cbId = genCbid();
          if (allowNestedFunctions) {
            recuFilter(args, packet.argsTransform, resolve => {
              const newCbId = genCbid();
              pending++;
              clbs[newCbId] = {
                resolve: resolve,
                cbId: newCbId,
                lastAck: Date.now()
              };
              return newCbId;
            });
            packet.args = recuCopy(args, packet.argsTransform); // making the data immutable
            recuPatch(packet.argsTransform, packet.args, (at, a, k) => {
              a[k] = at[k];
              at[k] = 1;
            });
          } else {
            for (let i = 0; i < args.length; i++) {
              packet.args[i] = args[i];
              if (packet.args[i] instanceof Function || typeof packet.args[i] === "function") {
                const newCbId = genCbid();
                const resolve = packet.args[i];
                pending++;
                clbs[newCbId] = {
                  resolve: resolve,
                  cbId: newCbId,
                  lastAck: Date.now()
                };
                packet.args[i] = newCbId;
                packet.argsTransform.push(i);
              }
            }
          }
          sendFn(packet);
          if (!noWait) {
            const delayPromise = new Promise((resolve, reject) => {
              if (pending > maxPendingResponses) clbsTrim();
              pending++;
              let timer = null;
              if (callTimeout > 0) {
                timer = setTimeout(() => {
                  if (!(packet.cbId in clbs)) return;
                  delete clbs[packet.cbId];
                  pending--;
                  // free the mirror record on the other side, if any
                  noWait = true;
                  remoteApi.iorpcUnbind(packet.cbId);
                  const err = new Error('iorpc: call timeout');
                  err.code = 'IORPC_TIMEOUT';
                  reject(err);
                }, callTimeout);
                if (timer && typeof timer.unref === 'function') timer.unref();
              }
              clbs[packet.cbId] = {
                resolve: arg => {
                  if (timer) clearTimeout(timer);
                  delete clbs[packet.cbId];
                  pending--;
                  return resolve(arg);
                },
                reject,
                timer,
                cbId: packet.cbId,
                lastAck: Date.now()
              };
            });
            return delayPromise.catch(e => {
              if (e && e.code === 'IORPC_TIMEOUT') throw e;
              let err = e;
              if (e instanceof Error) {
                err = new RemoteError(e.stack, e.message);
              }
              throw err;
            });
          }
          noWait = false;
        };
      }
    }
  });
  /**
   * Input message handler
   * @param message
   */
  const routeInput = message => {
    if (message.apiFunc === 'iorpcThrowError') {
      const [cbId, e, stack] = message.args;
      const rec = clbs[cbId];
      // The waiter may be gone already (rejectAll on transport close, timeout, or a
      // late/duplicate error packet). Ignore instead of throwing on undefined.
      if (!rec) return;
      if (rec.timer) clearTimeout(rec.timer);
      if (stack) {
        const err = new Error(e);
        err.stack = stack;
        rec.reject(err);
      } else {
        rec.reject(e);
      }
      pending--;
      delete clbs[cbId];
      return;
    }
    if (message.apiFunc === 'iorpcUnbind') {
      const rec = clbs[message.args[0]];
      if (rec && rec.timer) clearTimeout(rec.timer);
      pending--;
      delete clbs[message.args[0]];
      return;
    }
    let fn;
    // With taggedPackets both sides agree on routing via `kind`.
    // A 'cb' packet must never resolve a localApi method, and vice-versa.
    if (taggedPackets && (message.kind === 'call' || message.kind === 'cb')) {
      if (message.kind === 'call') {
        if (message.apiFunc in localApi) fn = localApi[message.apiFunc];
      } else {
        if (message.apiFunc in clbs) {
          clbs[message.apiFunc].lastAck = Date.now();
          fn = clbs[message.apiFunc].resolve;
        }
      }
    } else if (message.apiFunc in localApi) {
      fn = localApi[message.apiFunc];
    } else {
      if (message.apiFunc in clbs) {
        clbs[message.apiFunc].lastAck = Date.now();
        fn = clbs[message.apiFunc].resolve;
      }
    }
    if (fn) {
      if (allowNestedFunctions) {
        recuPatch(message.argsTransform, message.args, (at, a, k) => {
          const cbId = a[k];
          a[k] = function (...args) {
            cbInvoke = true;
            return remoteApi[cbId](...args);
          };
          a[k].unbind = () => {
            noWait = true;
            remoteApi.iorpcUnbind(cbId);
          };
        });
      } else {
        for (let i of message.argsTransform) {
          const cbId = message.args[i];
          message.args[i] = function (...args) {
            cbInvoke = true;
            return remoteApi[cbId](...args);
          };
          message.args[i].unbind = () => {
            noWait = true;
            remoteApi.iorpcUnbind(cbId);
          };
        }
      }
      let retCb;
      let suc = true;
      try {
        if (injectToThis) {
          retCb = fn.apply({
            remoteApi,
            iorpcPending: () => pending
          }, message.args);
        } else {
          retCb = fn(...message.args);
        }
      } catch (e) {
        if (exposeErrors) {
          suc = false;
          noWait = true;
          if (e instanceof Error) {
            remoteApi.iorpcThrowError(message.cbId, e.message, e.stack);
          } else {
            remoteApi.iorpcThrowError(message.cbId, e, false);
          }
        } else {
          throw e;
        }
      }
      if (suc) {
        if (message.cbId === false) return;
        if (retCb instanceof Function || typeof retCb === "function") {
          cbInvoke = true;
          remoteApi[message.cbId](retCb); // function as return
        } else {
          Promise.resolve(retCb).then(ret => {
            noWait = true;
            cbInvoke = true;
            remoteApi[message.cbId](ret);
          }).catch(e => {
            noWait = true;
            if (e instanceof Error) {
              remoteApi.iorpcThrowError(message.cbId, e.message, e.stack);
            } else {
              remoteApi.iorpcThrowError(message.cbId, e, false);
            }
          });
        }
      }
    } else {
      noWait = true;
      let errMsg;
      // Prefer the explicit kind tag when available; fall back to the isNaN heuristic.
      const isCallback = taggedPackets && (message.kind === 'cb' || message.kind === 'call') ? message.kind === 'cb' : !isNaN(message.apiFunc);
      if (!isCallback) {
        errMsg = `Function '${message.apiFunc}' is not registered for the iorpc API. Please verify it is properly defined and exposed.`;
      } else {
        if (ignoreCallbackUnavailable) return;
        errMsg = `Callback '${message.apiFunc}' is unavailable. It might have been removed from the waiting queue (maxPendingResponses overflow) or via unbind().`;
      }
      const e = new Error(errMsg);
      remoteApi.iorpcThrowError(message.cbId, e.message, e.stack);
    }
  };
  /**
   * Reject every pending response promise and clear all bindings.
   * Used when the transport dies (e.g. ws 'close'). Sends nothing to the wire.
   */
  const rejectAll = (err = new Error('iorpc: transport closed')) => {
    for (const cbId of Object.keys(clbs)) {
      const rec = clbs[cbId];
      if (rec && rec.timer) clearTimeout(rec.timer);
      if (rec && typeof rec.reject === 'function') {
        try {
          rec.reject(err);
        } catch (e) {/* ignore */}
      }
      delete clbs[cbId];
    }
    pending = 0;
  };
  /**
   * Diagnostic breakdown of `pending`:
   *  - calls: response waiters (have a reject handler)
   *  - callbacks: stored inbound callbacks (resolve-only records)
   */
  const bindings = () => {
    let calls = 0;
    let callbacks = 0;
    for (const cbId of Object.keys(clbs)) {
      if (typeof clbs[cbId].reject === 'function') calls++;else callbacks++;
    }
    return {
      calls,
      callbacks
    };
  };
  return {
    remoteApi /* Object with remote functions */,
    routeInput /* Function to handle incoming messages */,
    pending: () => pending,
    rejectAll,
    bindings
  };
};
class RemoteError extends Error {
  constructor(stack = "", message, ...args) {
    super("\n" + stack, ...args);
    this.name = 'RemoteError';
    const stack2 = this.stack;
    Object.defineProperties(this, {
      message: {
        value: message
      },
      stack: {
        value: stack2
      }
    });
  }
}
const iorpc = {
  /**
   * Creates an RPC interface with support for local and remote method calls,
   * and a system for handling pending responses.
   *
   * @param {Function} on - A function to subscribe to incoming messages. Takes a callback: (data) => void.
   * @param {Function} send - A function to send messages: (data: any) => void.
   * @param {Object} local - An object containing local methods that can be called remotely.
   * @param {Object} [options] - Optional configuration parameters.
   * @param {number} [options.maxPendingResponses=10000] - Maximum number of unresolved function calls allowed at a time.
   *        Prevents memory overuse or flooding; throws an error if the limit is exceeded.
   * @param {boolean} [options.allowNestedFunctions=true] - If true, allows functions to be passed inside arrays or objects.
   *        These functions will be automatically serialized and wrapped for remote calls.
   * @param {boolean} [options.exposeErrors=true] - If true, remote errors (including stack traces) will be forwarded.
   *        If false, remote errors will be replaced with a generic message.
   * @param {boolean} [options.injectToThis=true] - If true, the `this` context inside a function will be replaced with the iorpc object.
   *        Useful for context-aware APIs.
   *
   * @returns {{
   *   pending: Function,                   // A function that returns a promise awaiting a response from the remote side.
   *   remote: Object,                      // An object with remote methods that can be called locally.
   *   local: Object                        // An object with registered local methods callable remotely.
   * }}
   */

  pair({
    on,
    send,
    local = {},
    options = {}
  }) {
    const {
      routeInput,
      remoteApi,
      pending,
      rejectAll,
      bindings
    } = createIorpc(send, local, options);
    on(routeInput);
    return {
      local,
      remote: remoteApi,
      pending,
      rejectAll,
      bindings
    };
  }
};
// ─── binChannel ─────────────────────────────────────────────────────────────
// Бінарний слой між iorpc і DataChannel (zero-copy + чанкування). Ховає
// (де)серіалізацію packet з бінарними значеннями (Buffer/TypedArray/ArrayBuffer)
// поверх транспорту, що зберігає межі повідомлень і порядок (reliable+ordered).
//   transport = { sendBin(u8), onBin(handler), maxMessageSize? }
// Повертає { send, on, reset } — drop-in для pair({ send, on }).
const _hasBuffer = typeof Buffer !== 'undefined' && typeof Buffer.from === 'function';
const _isBin = v => v != null && (ArrayBuffer.isView(v) || v instanceof ArrayBuffer);
const _toU8 = v => v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
const _wrap = u8 => _hasBuffer ? Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength) : u8;
const _enc = new TextEncoder(),
  _dec = new TextDecoder();
const _extract = (node, bins) => {
  if (_isBin(node)) return {
    __bin: bins.push(_toU8(node)) - 1
  };
  if (node && typeof node === 'object') {
    const out = Array.isArray(node) ? [] : {};
    for (const k of Object.keys(node)) out[k] = _extract(node[k], bins);
    return out;
  }
  return node;
};
const _inject = (node, bins) => {
  if (node && typeof node === 'object') {
    if (node.__bin !== undefined && Object.keys(node).length === 1) return bins[node.__bin];
    for (const k of Object.keys(node)) node[k] = _inject(node[k], bins);
  }
  return node;
};
const _finalize = (chunks, assemble) => {
  if (chunks.length === 1 && !assemble) return _wrap(chunks[0]);
  let len = 0;
  for (const c of chunks) len += c.length;
  if (!assemble) return {
    __binChunks: chunks.map(_wrap),
    length: len
  };
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return _wrap(out);
};
/**
 * Create a binary adapter over a message-boundary transport.
 *
 * @param {object} transport - { sendBin(u8), onBin(handler), maxMessageSize? }
 * @param {object} [opts]
 * @param {number}  [opts.chunkSize=200000] - chunk size / threshold (< maxMessageSize).
 * @param {boolean} [opts.assembleBins=false] - false: zero-copy view / { __binChunks } array;
 *                                              true: merge into one contiguous buffer (copy).
 * @param {number}  [opts.pendingTTL=30000] - ms to drop an unfinished packet (disconnect / lost chunk). 0 disables.
 * @param {function}[opts.onError] - (err) => void: decode / TTL errors.
 * @returns {{ send: function, on: function, reset: function }}
 */
const binChannel = (transport, {
  chunkSize = 200000,
  assembleBins = false,
  pendingTTL = 30000,
  onError = () => {}
} = {}) => {
  // Wire-формат (кожне повідомлення ≤ chunk + HEAD байт):
  //   type 0 — скелет цілком:   [0][msgId:u32][binsCount:u16] + JSON
  //   type 1 — шматок бінара:   [1][msgId:u32][binIdx:u16][seq:u16][total:u16] + байти
  //   type 2 — шматок скелета:  [2][msgId:u32][binsCount:u16][seq:u16][total:u16] + частина JSON
  // type 2 вживається лише коли type 0 не вміщується у chunk + HEAD.
  const HEAD = 11,
    SKEL_HEAD = 7,
    U16 = 0xffff;
  const max = transport.maxMessageSize;
  const chunk = Math.max(1, Math.floor(Math.min(chunkSize, (max || Infinity) - HEAD)));
  let msgId = 0;
  const pending = new Map();

  // Вихідна черга: гарантує, що повідомлення кожного packet виходять у transport.sendBin
  // суцільним блоком і у порядку постановки — навіть якщо sendBin реентрантно
  // викличе send() ще раз (тоді новий packet просто додається в хвіст, не вклинюючись).
  // Якщо sendBin кидає (обрив / over-limit), повідомлення лишається в голові черги
  // (не губиться, без дірки), sending скидається, а виняток летить наверх до викликача.
  const outQ = [];
  let sending = false;
  const flushOut = () => {
    if (sending) return;
    sending = true;
    try {
      while (outQ.length) {
        transport.sendBin(outQ[0]); // peek: видаляємо лише після успіху
        outQ.shift();
      }
    } finally {
      sending = false;
    }
  };
  const send = packet => {
    const bins = [];
    const skel = _enc.encode(JSON.stringify(_extract(packet, bins)));
    // Ліміти u16 перевіряємо ДО постановки в outQ — щоб не лишити в черзі пів-packet.
    if (bins.length > U16) throw new RangeError('binChannel: too many binary values in packet: ' + bins.length + ' > ' + U16);
    const skelTotal = SKEL_HEAD + skel.length > chunk + HEAD ? Math.ceil(skel.length / chunk) : 0;
    if (skelTotal > U16) throw new RangeError('binChannel: skeleton too large: ' + skel.length + ' bytes needs ' + skelTotal + ' chunks > ' + U16);
    const binTotals = bins.map((b, bi) => {
      const t = Math.max(1, Math.ceil(b.length / chunk));
      if (t > U16) throw new RangeError('binChannel: binary #' + bi + ' too large: ' + b.length + ' bytes needs ' + t + ' chunks > ' + U16);
      return t;
    });
    const id = msgId = msgId + 1 >>> 0;
    if (!skelTotal) {
      // скелет вміщується: формат type 0, побайтово як у попередніх версіях
      const h = new Uint8Array(SKEL_HEAD + skel.length),
        dv = new DataView(h.buffer);
      dv.setUint8(0, 0);
      dv.setUint32(1, id);
      dv.setUint16(5, bins.length);
      h.set(skel, SKEL_HEAD);
      outQ.push(_wrap(h));
    } else {
      // великий скелет: type 2 = [2][msgId:4][binsCount:2][seq:2][total:2] + частина JSON
      for (let seq = 0; seq < skelTotal; seq++) {
        const part = skel.subarray(seq * chunk, (seq + 1) * chunk);
        const m = new Uint8Array(HEAD + part.length),
          mv = new DataView(m.buffer);
        mv.setUint8(0, 2);
        mv.setUint32(1, id);
        mv.setUint16(5, bins.length);
        mv.setUint16(7, seq);
        mv.setUint16(9, skelTotal);
        m.set(part, HEAD);
        outQ.push(_wrap(m));
      }
    }
    for (let bi = 0; bi < bins.length; bi++) {
      const b = bins[bi],
        total = binTotals[bi];
      for (let seq = 0; seq < total; seq++) {
        const part = b.subarray(seq * chunk, (seq + 1) * chunk);
        const m = new Uint8Array(HEAD + part.length),
          mv = new DataView(m.buffer);
        mv.setUint8(0, 1);
        mv.setUint32(1, id);
        mv.setUint16(5, bi);
        mv.setUint16(7, seq);
        mv.setUint16(9, total);
        m.set(part, HEAD);
        outQ.push(_wrap(m));
      }
    }
    flushOut();
  };
  const drop = (id, err) => {
    const p = pending.get(id);
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    pending.delete(id);
    if (err) onError(err);
  };
  const arm = id => {
    if (!pendingTTL) return null;
    const t = setTimeout(() => drop(id, new Error('binChannel: pending timeout msgId=' + id)), pendingTTL);
    if (t && typeof t.unref === 'function') t.unref();
    return t;
  };
  const flush = id => {
    const p = pending.get(id);
    drop(id);
    p.handler(_inject(p.skeleton, p.bins));
  };
  const on = handler => {
    transport.onBin(raw => {
      try {
        const u8 = _toU8(raw);
        const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
        const type = dv.getUint8(0);
        if (type === 0) {
          const id = dv.getUint32(1),
            count = dv.getUint16(5);
          const skeleton = JSON.parse(_dec.decode(u8.subarray(SKEL_HEAD)));
          if (!count) return handler(_inject(skeleton, []));
          if (pending.has(id)) drop(id);
          pending.set(id, {
            skeleton,
            bins: new Array(count),
            parts: {},
            needed: count,
            handler,
            timer: arm(id)
          });
        } else if (type === 2) {
          const id = dv.getUint32(1),
            count = dv.getUint16(5),
            seq = dv.getUint16(7),
            total = dv.getUint16(9);
          let p = pending.get(id);
          if (p && p.skel && (p.skel.total !== total || p.bins.length !== count)) {
            drop(id);
            throw new Error('binChannel: skeleton chunk header mismatch msgId=' + id);
          }
          if (seq >= total) {
            drop(id);
            throw new Error('binChannel: bad skeleton chunk seq=' + seq + ' total=' + total + ' msgId=' + id);
          }
          if (!p || !p.skel) {
            if (p) drop(id); // застарілий запис з тим самим msgId (переповнення лічильника)
            p = {
              skeleton: undefined,
              skel: {
                arr: new Array(total),
                got: 0,
                total,
                len: 0
              },
              bins: new Array(count),
              parts: {},
              needed: count,
              handler,
              timer: arm(id)
            };
            pending.set(id, p);
          }
          const s = p.skel;
          if (s.arr[seq] === undefined) {
            const c = u8.subarray(HEAD);
            s.arr[seq] = c;
            s.got++;
            s.len += c.length;
          }
          if (s.got === total) {
            const all = new Uint8Array(s.len);
            let o = 0;
            for (const c of s.arr) {
              all.set(c, o);
              o += c.length;
            }
            p.skel = null;
            try {
              p.skeleton = JSON.parse(_dec.decode(all));
            } catch (e) {
              drop(id);
              throw e;
            }
            if (p.needed === 0) flush(id);
          }
        } else if (type === 1) {
          const id = dv.getUint32(1),
            bi = dv.getUint16(5),
            seq = dv.getUint16(7),
            total = dv.getUint16(9);
          const p = pending.get(id);
          if (!p) return;
          if (bi >= p.bins.length || seq >= total) {
            drop(id);
            throw new Error('binChannel: bad bin chunk binIdx=' + bi + ' seq=' + seq + ' total=' + total + ' msgId=' + id);
          }
          const payload = u8.subarray(HEAD);
          if (total === 1) {
            if (p.bins[bi] === undefined) p.needed--;
            p.bins[bi] = _finalize([payload], assembleBins);
          } else {
            const slot = p.parts[bi] || (p.parts[bi] = {
              arr: new Array(total),
              got: 0
            });
            if (slot.arr[seq] === undefined) {
              slot.arr[seq] = payload;
              slot.got++;
            }
            if (slot.got === total) {
              p.bins[bi] = _finalize(slot.arr, assembleBins);
              p.needed--;
            }
          }
          if (p.needed === 0 && p.skeleton !== undefined) flush(id);
        } else {
          throw new Error('binChannel: unknown message type ' + type);
        }
      } catch (e) {
        onError(e);
      }
    });
  };

  // Чистить недозібрані вхідні packet-и ТА недовідправлену вихідну чергу (обрив каналу).
  const reset = () => {
    for (const id of [...pending.keys()]) drop(id);
    outQ.length = 0;
  };
  return {
    send,
    on,
    reset
  };
};
iorpc.binChannel = binChannel;
export const pair = iorpc.pair;
export { binChannel };
export default iorpc;
