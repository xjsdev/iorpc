// Simulates a communication channel between two iorpc instances.
// Messages are serialized to JSON (like a real transport would do)
// and delivered asynchronously (next tick) to mimic network/IPC latency.

/**
 * Creates a pair of { send, on } transports connected to each other.
 *
 * @param {object} [opts]
 * @param {number} [opts.delay=0] - artificial delivery delay in ms
 * @param {boolean} [opts.dropAll=false] - if true, messages are swallowed (simulates dead transport)
 * @returns {{ sideA: {send, on}, sideB: {send, on}, setDrop: (boolean)=>void }}
 */
export function createLink({ delay = 0, dropAll = false } = {}) {
  let drop = dropAll;
  let handlerA = null;
  let handlerB = null;

  const deliver = (handler, message) => {
    if (drop) return;
    // round-trip through JSON to catch any non-serializable usage bugs
    const json = JSON.stringify(message);
    const parsed = JSON.parse(json);
    if (delay > 0) {
      setTimeout(() => handler && handler(parsed), delay);
    } else {
      queueMicrotask(() => handler && handler(parsed));
    }
  };

  const sideA = {
    send: message => deliver(handlerB, message),
    on: handler => { handlerB = handler; } // wired below, see note
  };
  const sideB = {
    send: message => deliver(handlerA, message),
    on: handler => { handlerA = handler; }
  };

  // NOTE: sideA.send delivers to handlerB (B's incoming handler)
  //       sideB.on registers handlerB -> but we assigned it to handlerA slot above.
  // To avoid confusion, redo wiring explicitly below.
  let onA = null;
  let onB = null;
  sideA.send = message => deliver(onB, message);
  sideA.on = handler => { onA = handler; };
  sideB.send = message => deliver(onA, message);
  sideB.on = handler => { onB = handler; };

  return {
    sideA,
    sideB,
    setDrop: value => { drop = value; }
  };
}
