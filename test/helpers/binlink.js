// Симуляція бінарного транспорту, що зберігає МЕЖІ повідомлень (як DataChannel/WS).
// За замовчуванням reliable + ordered (FIFO). Опційно: затримка, drop, обрив.

/**
 * @param {object} [opts]
 * @param {number}  [opts.delay=0]          - фіксована затримка доставки (мс); 0 => microtask
 * @param {number}  [opts.jitter=0]         - рандомна затримка 0..jitter мс перед кожним sendBin;
 *                                            FIFO-порядок ЗБЕРІГАЄТЬСЯ (як ordered DataChannel)
 * @param {number}  [opts.maxMessageSize]   - прокидається у transport.maxMessageSize
 * @param {Function}[opts.dropFilter]       - (dir, msgIndex) => boolean: true => повідомлення згубити
 * @returns {{ tA, tB, cut(): void, restore(): void, sentA, sentB }}
 */
export function createBinLink({ delay = 0, jitter = 0, maxMessageSize, dropFilter } = {}) {
  let live = true;
  let idxAtoB = 0, idxBtoA = 0;
  const sentA = []; // що сторона A відправила
  const sentB = [];

  const clone = u8 => {
    // справжній транспорт віддає СВІЙ буфер на прийомі; копіюємо, щоб зловити
    // помилкові посилання на буфер відправника
    const c = new Uint8Array(u8.byteLength);
    c.set(u8);
    return c;
  };

  // FIFO-черга доставки на кожен напрям: рандомний jitter не порушує порядок
  const mkQueue = getHandler => {
    const q = [];
    let busy = false;
    const pump = () => {
      if (busy || !q.length) return;
      busy = true;
      const out = q.shift();
      const wait = jitter > 0 ? Math.random() * jitter : delay;
      const fire = () => {
        const h = getHandler();
        if (live && h) h(out);
        busy = false;
        pump();
      };
      if (wait > 0) setTimeout(fire, wait);
      else queueMicrotask(fire);
    };
    return msg => { if (!live) return; q.push(clone(msg)); pump(); };
  };

  // A відправляє -> B приймає; B відправляє -> A приймає
  const hA = { fn: null };
  const hB = { fn: null };
  const toB = mkQueue(() => hB.fn);
  const toA = mkQueue(() => hA.fn);

  const tA = {
    maxMessageSize,
    sendBin: u8 => {
      const view = u8 instanceof ArrayBuffer ? new Uint8Array(u8)
        : new Uint8Array(u8.buffer, u8.byteOffset, u8.byteLength);
      const i = idxAtoB++;
      sentA.push(view.byteLength);
      if (dropFilter && dropFilter('a2b', i)) return;
      toB(view);
    },
    onBin: h => { hA.fn = h; }
  };
  const tB = {
    maxMessageSize,
    sendBin: u8 => {
      const view = u8 instanceof ArrayBuffer ? new Uint8Array(u8)
        : new Uint8Array(u8.buffer, u8.byteOffset, u8.byteLength);
      const i = idxBtoA++;
      sentB.push(view.byteLength);
      if (dropFilter && dropFilter('b2a', i)) return;
      toA(view);
    },
    onBin: h => { hB.fn = h; }
  };

  return {
    tA, tB, sentA, sentB,
    cut() { live = false; },     // обрив каналу
    restore() { live = true; }
  };
}

export const tick = (n = 0) => new Promise(r => setTimeout(r, n));
