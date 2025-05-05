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
 *
 * @returns {{ remoteApi: object, routeInput: function, pending: function }} - Returns an object with:
 *    - `remoteApi`: proxy API to call remote functions,
 *    - `routeInput`: function to pass incoming messages from the other side,
 *    - `pending`: returns the size of the waiting list to check if it is overflowing.
 */
const createIorpc = (sendFn, localApi = {}, {
  maxPendingResponses = 10000,
  allowNestedFunctions = false,
  exposeErrors = true,
  injectToThis = true,
  ignoreCallbackUnavailable = false
}) => {
  const clbs = {};
  let trimWarningFired = false;
  let noWait = false;
  let pending = 0;
  const clbsTrim = () => {
    if (!trimWarningFired) {
      console.warn(`maxPendingResponses > ${maxPendingResponses}. Check if callback bindings are being released after use. The oldest ones have been removed, this operation requires some extra resources. Now the oldest ones may not work.`);
      trimWarningFired = true;
    }
    const clbsArr = Object.values(clbs);
    clbsArr.sort((a, b) => a.lastAck - b.lastAck);
    clbsArr.slice(0, pending - maxPendingResponses).map(v => v.cbId).forEach(cbId => {
      pending--;
      delete clbs[cbId];
    });
  };
  const genCbid = () => {
    while (true) {
      const cbId = Math.round(Math.random() * Number.MAX_SAFE_INTEGER);
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
        return function (...args) {
          const packet = {
            apiFunc: thisArg,
            cbId: false,
            args,
            argsTransform: allowNestedFunctions ? {} : []
          };
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
              clbs[packet.cbId] = {
                resolve: arg => {
                  delete clbs[packet.cbId];
                  pending--;
                  return resolve(arg);
                },
                reject,
                cbId: packet.cbId,
                lastAck: Date.now()
              };
            });
            return delayPromise.catch(e => {
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
      if (stack) {
        const err = new Error(e);
        err.stack = stack;
        clbs[cbId].reject(err);
      } else {
        clbs[cbId].reject(e);
      }
      pending--;
      delete clbs[cbId];
      return;
    }
    if (message.apiFunc === 'iorpcUnbind') {
      pending--;
      delete clbs[message.args[0]];
      return;
    }
    let fn;
    if (message.apiFunc in localApi) {
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
          remoteApi[message.cbId](retCb); // function as return
        } else {
          Promise.resolve(retCb).then(ret => {
            noWait = true;
            remoteApi[message.cbId](ret);
          });
        }
      }
    } else {
      noWait = true;
      let errMsg;
      if (isNaN(message.apiFunc)) {
        errMsg = `Function '${message.apiFunc}' is not registered for the iorpc API. Please verify it is properly defined and exposed.`;
      } else {
        if (ignoreCallbackUnavailable) return;
        errMsg = `Callback '${message.apiFunc}' is unavailable. It might have been removed from the waiting queue (maxPendingResponses overflow) or via unbind().`;
      }
      const e = new Error(errMsg);
      remoteApi.iorpcThrowError(message.cbId, e.message, e.stack);
    }
  };
  return {
    remoteApi /* Object with remote functions */,
    routeInput /* Function to handle incoming messages */,
    pending: () => pending
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
      pending
    } = createIorpc(send, local, options);
    on(routeInput);
    return {
      local,
      remote: remoteApi,
      pending
    };
  }
};
export const pair = iorpc.pair;
export default iorpc;
