(defineExport => {
  /**
   * Create new iorpc instance
   * @param {function} sendFn Function to send data to the iorpc instance on the other side.
   * @param {object} [localApi] An object containing methods callable from the remote side; this is optional if you don't need the remote side to call methods back on this side.
   * @param {number} [waitQueueSize] Maximum number of functions waiting in queue (default 10000).
   * @returns Returns an object with remoteApi (remote API functions) and routeInput (input message handler).
   */
  const createIorpc = (sendFn, localApi = {}, waitQueueSize = 10000) => {
    const clbs = {};
    let trimWarningFired = false;
    let noWait = false;
    let clbsSize = 0;
    const clbsTrim = () => {
      if (!trimWarningFired) {
        console.warn(`waitQueueSize > ${waitQueueSize}. Check if callback bindings are being released after use. The oldest ones have been removed, this operation requires some extra resources. Now the oldest ones may not work.`);
        trimWarningFired = true;
      }
      const clbsArr = Object.values(clbs);
      clbsArr.sort((a, b) => a.lastAck - b.lastAck);
      clbsArr.slice(0, clbsSize - waitQueueSize).map(v => v.cbId).forEach(cbId => {
        clbsSize--;
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
              argsTransform: []
            };
            if (!noWait) packet.cbId = genCbid();
            for (let i = 0; i < args.length; i++) {
              packet.args[i] = args[i];
              if (packet.args[i] instanceof Function || typeof packet.args[i] === "function") {
                const newCbId = genCbid();
                const resolve = packet.args[i];
                clbsSize++;
                clbs[newCbId] = {
                  resolve: resolve,
                  cbId: newCbId,
                  lastAck: Date.now()
                };
                packet.args[i] = newCbId;
                packet.argsTransform.push(i);
              }
            }
            sendFn(packet);
            if (!noWait) {
              const delayPromise = new Promise((resolve, reject) => {
                if (clbsSize > waitQueueSize) clbsTrim();
                clbsSize++;
                clbs[packet.cbId] = {
                  resolve: arg => {
                    delete clbs[packet.cbId];
                    clbsSize--;
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
        clbsSize--;
        delete clbs[cbId];
        return;
      }
      if (message.apiFunc === 'iorpcUnbind') {
        clbsSize--;
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
        let retCb;
        let suc = true;
        try {
          retCb = fn.apply({
            remoteApi,
            iorpcClbsSize: () => clbsSize
          }, message.args);
        } catch (e) {
          suc = false;
          noWait = true;
          if (e instanceof Error) {
            remoteApi.iorpcThrowError(message.cbId, e.message, e.stack);
          } else {
            remoteApi.iorpcThrowError(message.cbId, e, false);
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
          errMsg = `Callback '${message.apiFunc}' is unavailable. It might have been removed from the waiting queue (waitQueueSize overflow) or via unbind().`;
        }
        const e = new Error(errMsg);
        remoteApi.iorpcThrowError(message.cbId, e.message, e.stack);
      }
    };
    return {
      remoteApi /* Object with remote functions */,
      routeInput /* Function to handle incoming messages */,
      clbsSize: () => clbsSize
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
  defineExport(createIorpc);
})(_createIorpc => {
  if (typeof exports !== 'undefined') {
    module.exports = _createIorpc;
    module.exports.default = _createIorpc;
  } else if (typeof define === 'function') define(() => {
    return _createIorpc;
  });else (typeof self !== 'undefined' ? self : this).createIorpc = _createIorpc; // browser export
  return _createIorpc;
});
