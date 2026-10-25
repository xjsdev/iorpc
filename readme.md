# ioRPC

`ioRPC` is a lightweight module for remote asynchronous function calls between different scripts using various transports. It enables seamless invocation of remote APIs and handling of responses with minimal configuration. You can use it to call JavaScript functions running on another machine, in Node.js, or directly in the browser.

It's especially useful for smooth communication between different execution contexts (like a browser window and a Web Worker). A standout feature is its ability to serialize **functions as arguments or return values**, making it easy to implement things like real-time progress updates via callbacks.

---

## Why `ioRPC` is Great

### Transparent Remote Function Calls
Call remote functions just like local ones:
```js
await remote.add(1, 2)
```

### Function Serialization
You can pass functions as arguments and even receive functions as return values:

```js
let fn = await remote.getCallback()
await fn("hello")
```

### Pluggable Transport
Use any transport — WebSocket, MessagePort, iframe, or even `window.postMessage`.

### Simple API
Create a local/remote pair with a very minimal setup.

### Works Everywhere
Use in browser apps, Node.js, workers, iframes — anywhere messages can be sent.

---

## Real-World Example: UI + Web Worker
### Without `ioRPC`:
You'd have to manually:

- serialize messages to `postMessage`

- listen to `message` events and dispatch handlers

- track unique `id`s for each request

- manually wire up promise/response logic

Too much boilerplate.

---

### With `ioRPC`:
#### UI (main window)

```html
<script type="module">
  import { pair } from "https://unpkg.com/iorpc/index.esm.js"

  const worker = new Worker("worker.js")

  const {local, remote} = pair({
    send: msg => worker.postMessage(msg),
    on: handler => worker.onmessage = e => handler(e.data)
  })

  async function run() {
    await remote.processData([1, 2, 3], progress => {
      console.log("Progress:", progress)
    })
  }
  run()
</script>
```
---
#### Worker (worker.js)
```js
importScripts("https://unpkg.com/iorpc/index.js")

const { local, remote } = iorpc.pair({
  send: msg => postMessage(msg),
  on: handler => onmessage = e => handler(e.data)
})

local.processData = async function(data, onProgress) {
  for (let i = 0; i < data.length; i++) {
    await new Promise(r => setTimeout(r, 500))
    await onProgress((i + 1) / data.length)
  }
}
```
---
### Highlights
- No manual message/event plumbing

- You can pass onProgress() callback from UI to worker

- The worker just calls it like a local function

- Everything works asynchronously with await

## Example

Create functions that can be called remotely by passing function references
```javascript
// script1.js

const localApi = {
  func1(a,b) {
    return a + b
  },
  async func2(a, cb) {
    const b = await cb(a)
    return c => a + b + c
  },
  func(cb) {
    const h = setInterval(async()=>{
      await cb()
    },1000)
    return ()=>{
      cb.unbind()
      clearInterval(h)
    }
  }
}
```
Calling from another script
```javascript
// script2.js

const x1 = await remoteApi.func1("Hello"," world")
// x0 = "Hello world"

const x2 = await remoteApi.func2(2, 
  a => a*2
)
// typeof x2 === 'function'

const x3 = await x2(2) // remote, c => a + b + c
// a(2) + b(4) + c(2)

const remoteFunctionWithUnbind = await remoteApi.func(()=>{}) // function will be passed as cb:Promise
``` 
Every dynamic variable `Function` has a method `void unbind()`
```javascript
// if the function comes as an argument
// async func2(a, cb) { ...
     cb.unbind()
// }
  
// if the function comes as a result
// const x2 = await remoteApi.func2(/**/)
   x2.unbind()
```

Release bindings to dynamic functions for continuous operation. If the incoming variables are not functions, release is not necessary.

You can write in both good and bad ways, depending on the situation. Make complex things simpler.

## Preparation

Install the module:

```bash
npm install iorpc
#yarn add iorpc
```
Connect
```javascript
import { pair } from 'iorpc' 
/* or */
const { pair } = require('iorpc')
```
```html
<script type="module">
  import { pair } from "https://unpkg.com/iorpc/index.esm.js"
</script>
```
If export is not specified, it will create a global variable:
```html
<script src="https://unpkg.com/iorpc/index.js"></script>
<script>
  const { pair } = iorpc
</script>
```
RequireJS, Webpack, Vite packagers, and more.

# iorpc and websocket integration

You can try this example on stackblitz.com [HERE](https://stackblitz.com/edit/stackblitz-starters-5junm7mk?file=wsHost.js,wsClient.js).

## Example websocket host (wsHost.js)
This code snippet demonstrates the initialization of the module `iorpc` for working with WebSocket.


```javascript
//const {WebSocketServer} = require('ws') // WebSocket.Server
//const { pair } = require('iorpc')
import { WebSocketServer } from "ws"
import { pair } from 'iorpc'

const localApi = {
  /**
   * @returns {Promise<any>}
   */
  greetings(data) {
    console.log('Received:' + data) // Received:Hi
    return data + ' world'
  },
  greetings2(data) {
    return new Promise((resolve)=>{
      setTimeout(()=>{
        resolve(data + ' world')
      }, 1000)
    })
  },
  subscribeToUpdates(cbOnClient) {
    // is not an arrow function, so 'this.remoteApi' is available here
    // async this.remoteApi.fn() if functions are declared on the other side
    const hSubscribeInterval = setInterval(async() => {
      const iorpcPending = await cbOnClient(Date.now())
      console.log(`ClbsSize: remote ${iorpcPending} local ${this.iorpcPending()}`)
      // ClbsSize: remote 1 local 1
    }, 1000)
    return function () {
      cbOnClient.unbind()
      clearInterval(hSubscribeInterval)
      return 'unbinded'
    }
  },
  clbsSize() {
    return this.iorpcPending()
  },
  functionWithError() {
    const a = b + 1
  },
  functionWithThrow() {
    throw 'someError'
  },
  async functionWithErrorInCb(cb) {
    try{
      await cb()
    } catch (e) {
      console.log(e)
      /*
        RemoteError:
        ReferenceError: c is not defined
        at Object.<anonymous> (/wsClient.js:50:17)
        ...
        at async Object.functionWithErrorInCb (/wsHost.js:44:7)
      */
    }
    return () => {
      const a = d + 1
    }
  },
  async functionWithReturnOfTwoFn() {
    return {
      fn1() {
        return 'fn1 ok'
      },
      fn2() {
        return 'fn2 ok'
      }
    }
  }
}

const wss = new WebSocketServer({ port: 8080 })
wss.on('connection', ws => {
  const { remote } = pair({
    send: data => ws.send(JSON.stringify(data)),
    on: handler => ws.on('message', data => handler(JSON.parse(data))), // incoming messages are passed to 'routeInput' for processing via iorpc.
    local: localApi
  })
  ws.on('close', () => {
    console.log('Client disconnected')
  })
  ws.on('error', error => {
    console.error('WebSocket error:', error)
  })
})

console.log('WebSocket server running on port 8080')
```

## Client (wsClient.js)

```javascript
//const WebSocket = require('ws')
//const { pair } = require('iorpc')
import WebSocket from "ws"
import { pair } from 'iorpc'

const ws = new WebSocket('ws://localhost:8080')

const { remote, pending } = pair({
  send: data => ws.send(JSON.stringify(data)),
  on: handler => ws.on('message', data => handler(JSON.parse(data)))
})

ws.on('open', async () => {
  console.log('Connected to server')

  const ret = await remote.greetings2('Hello')
  console.log(ret) // Hello world

  remote.noWait.greetings('Hi') // if you don't need to wait for a result

  const unsubscribe = await remote.subscribeToUpdates(function (time) {
    // remember, in arrow functions, variables in 'this' are not available
    console.log("server time:" + time)
    return this.iorpcPending()
  })

  setTimeout(async ()=>{
    const res = await unsubscribe() // res = 'unbinded'
    unsubscribe.unbind() // notifies the remote party that we will no longer call unsubscribe()

    // overflow check
    const remoteClbsSize = await remote.clbsSize()
    const localClbsSize = pending()
    console.log(`ClbsSize final: remote ${remoteClbsSize} local ${localClbsSize}`)
    // ClbsSize final: remote 0 local 0

    // broadcast remote errors
    try {
      await remote.functionWithError()
    } catch (e) {
      console.log(e)
      /*
        RemoteError: 
        ReferenceError: b is not defined
        at Object.functionWithError (/wsHost.js:37:15)
        ...
        at async Timeout._onTimeout (/wsClient.js:35:7)
      */
    }
    try {
      await remote.functionWithThrow()
    } catch (e) {
      console.log(e) // someError
    }
    if (0) { // to check put 1
      // error without catch in console is also informative, combines 2 call stacks
      await remote.functionWithError()
      /*terminated, process console:

        node:internal/process/promises:394
        triggerUncaughtException(err, true /* fromPromise * /)
  
        RemoteError: 
        ReferenceError: b is not defined
        at Object.functionWithError (/wsHost.js:37:15)
        ...
        at async Timeout._onTimeout (/wsClient.js:35:7)
      */
    }
    // callback errors
    const cbWithErr = await remote.functionWithErrorInCb(()=>{
      const a = c + 1
    })
    try {
      await cbWithErr()
    } catch (e) {
      console.log(e)
      /*
        RemoteError:
        ReferenceError: d is not defined
        at Object.<anonymous> (/wsHost.js:49:17)
        ...
        at async Timeout._onTimeout (/wsClient.js:53:7)
      */
    }
    cbWithErr.unbind()

    if (false) { // works if allowNestedFunctions option is true
      // The ability to pass function references within objects or arrays is implemented. Make sure to unbind them when they are no longer in use.
      const {fn1, fn2} = await remote.functionWithReturnOfTwoFn()
      console.log(await fn1()) // fn1
      console.log(await fn2()) // fn2
      fn1.unbind()
      fn2.unbind()
    }
    const remoteClbsSize2 = await remote.clbsSize()
    console.log(remoteClbsSize2) // 0
  }, 3000)
})
ws.on('close', () => {
  console.log('Disconnected from server')
})
```

---

### function pair({ send, on, local, options? }): { remote, local, pending }
Creates a new ioRPC instance for asynchronous remote procedure calls. This function enables bi-directional communication between two endpoints using any message-based transport (such as WebSocket, postMessage, etc.).
```javascript
const { remote } = pair({
  send: data => ws.send(JSON.stringify(data)), // Sends data to the remote side
  on: handler => ws.on('message', data => handler(JSON.parse(data))), // Subscribes to incoming messages
  local: localApi // Local API methods that can be called remotely
})
```
`send: Function` – **Required**. A function used to send messages to the other side.
Example: `(data) => transport.send(JSON.stringify(data))`

`on: Function` – **Required**. A function to subscribe to incoming messages.
It should accept a callback which will receive parsed message objects.
`Example: handler => transport.on('message', data => handler(JSON.parse(data)))`

`local?: Object = {}` – Optional. An object containing methods that the remote side can call.

`options?: Object` – Optional configuration parameters:

- `maxPendingResponses: number = 10000` – Maximum number of unresolved async calls allowed at once. Prevents overflow. It warns once about an error if the limit is exceeded, and deletes the oldest one used.
- `allowNestedFunctions: boolean = false` – If true, allows functions to be nested in objects or arrays and passed remotely.
- `exposeErrors: boolean = true` – If true, forwards full remote error details (like stack traces). If false, replaces them with a generic message.
- `injectToThis: boolean = true` – If true, replaces this inside called functions with `this.remoteApi`.
- `ignoreCallbackUnavailable: boolean = false` – If true, errors due to missing callbacks will be ignored. Useful when integrating multiple interfaces over a single channel.
- `callTimeout: number = 0` – Milliseconds to wait for a remote response before rejecting the call. `0` disables timeouts (default, no timers — identical to previous behaviour). On timeout the promise rejects with an `Error` whose `code === 'IORPC_TIMEOUT'`, the waiting entry is removed (`pending` decremented), and an `unbind` is sent to the other side so it can release its mirror record. `noWait` calls are never timed out.
- `cbIdGenerator: () => number|string` – Optional custom generator for callback ids. Defaults to a random integer. The internal collision check against the local map is always applied. If you return **string** ids, you are responsible for ensuring they never clash with your `local` method names; pair it with `taggedPackets: true` for reliable routing.
- `taggedPackets: boolean = false` – If true, each packet carries an explicit `kind: 'call' | 'cb'` field and `routeInput` routes by it instead of the `isNaN(apiFunc)` heuristic. **Both sides must use the same value.** Default (`false`) keeps the wire-format byte-identical to the previous version; the `kind` field is only added when enabled, so an older peer simply ignores it.
- `onTrim: (removedIds: Array) => void` – Optional callback invoked whenever `maxPendingResponses` trimming evicts entries, receiving the list of removed callback ids. Useful for diagnosing binding leaks.

`Return` - An object with the following properties:
- `remote: Object` – A proxy object. Accessing `remote.someFunction()` will trigger a remote call to `someFunction` on the other side.
- `local: Object` – The original local API passed (can be extended dynamically).
- `pending: Function` – Returns the current number of active, bound remote calls (i.e., the wait queue size).
  Useful to monitor memory usage or detect forgotten `unbind()` calls.
- `rejectAll: Function` – `rejectAll(err = new Error('iorpc: transport closed')): void`. Rejects every pending response promise with `err`, drops all stored inbound callbacks, and resets `pending` to `0`. Sends **nothing** to the transport (intended for use when the transport is already dead). Example:
  ```js
  ws.on('close', () => api.rejectAll(new Error('socket closed')))
  ```
- `bindings: Function` – `bindings(): { calls: number, callbacks: number }`. Diagnostic breakdown of `pending` into response waiters (`calls`) and stored inbound callbacks (`callbacks`). Helpful to detect forgotten `unbind()` calls. `calls + callbacks === pending()`.


### async function remote\[functionName](...args): any

Calls a remote function asynchronously.

```javascript
const result = await remote.sum(2, 3)
```

`...args` - Can include strings, numbers, arrays, objects, or async functions.

`return` - Returns a Promise that resolves with the result of the remote function call. Nested function-containing objects/arrays are only supported if `allowNestedFunctions` is enabled.


### remote.noWait\[functionName](...args): void
`void remote.noWait.funcNameSync()` - Performs a remote call without waiting for a response (fire-and-forget mode).
Use this for logging, events, or when the result doesn't matter:
```js
remote.noWait.sendPing()
```

#### Reserved function names

The following function names are reserved for internal use and should not be defined in your APIs:
`iorpcUnbind`, `iorpcThrowError`

### function unbind(): void

Every dynamically returned function variable that leads to a function on the other side has this method. Unbinds and reduces the callback waiting list.

```javascript
const localApi = { 
  func(cb) {
    const h = setInterval(async()=>{
      await cb()
    },1000)
    return async()=>{
      cb.unbind()
      clearInterval(h)
    }
  }
}
```
```javascript
const remoteFunctionWithUnbind = await remoteApi.func(()=>{})

await remoteFunctionWithUnbind()

remoteFunctionWithUnbind.unbind()
```

### Functions in `this` object
If enabled `injectToThis` then `remoteApi` and `iorpcPending` are available in the function object. 
In arrow functions, variables in `this` are not available.
```javascript
const localApi = { // these are not arrow functions, so here the variables in `this` are
  func(cb) {
    this.remoteApi
    this.iorpcPending()

    cb(function () {
      this.remoteApi
      this.iorpcPending()
      return function () {
        this.remoteApi
        this.iorpcPending()
      }
    })
  }
}

await remoteApi.func(function () {
  this.remoteApi
  this.iorpcPending()
  return function () {
    this.remoteApi
    this.iorpcPending()
  }
})

const arrowFinction = () => {
  // if `this` is not needed, you can use arrow functions
}
```

### Broadcasting remote errors RemoteError:

Use `try...catch` to catch a remote error. This works for both synchronous throws and rejected Promises returned from local functions — if a local function returns a rejected Promise, the error is automatically forwarded to the caller on the remote side.

```javascript
const localApi = {
  functionWithError() {
    const a = b + 1 // <- /wsHost.js:37:15
  },
  async functionWithRejectedPromise() {
    throw new Error('something went wrong') // rejected promise — also forwarded
  },
}
/* ... */
try {
  await remoteApi.functionWithError() // <- /wsClient.js:35:7
} catch (e) {
  console.log(e)
}
/*
ReferenceError: b is not defined
    at Object.functionWithError (/wsHost.js:37:15)
    ...
    at async Timeout._onTimeout (/wsClient.js:35:7)
*/
```
If your script terminated, you can see it if you switch your debugger to stdout.

You can choose the side of the error display via `try...catch`, to prevent it from being transmitted.

```javascript
try {
  const a = b + 1 
} catch (e) {
  console.log(e)
}
```

## Transport constraints

`ioRPC` is transport-agnostic: it hands your `send` function a plain JSON-compatible **object** (`{ apiFunc, cbId, args, argsTransform }`, plus `kind` when `taggedPackets` is enabled) and expects your `on` to deliver the same object back on the other side. A few practical limits to keep in mind:

- **Serialization/framing is your responsibility.** `send` receives an object — you decide how to encode it (e.g. `JSON.stringify`) and how to frame it on the wire. Mirror that in `on` (e.g. `JSON.parse`).
- **One packet = one transport message.** Keep a 1:1 mapping where possible. If your transport has a maximum message size (for example a WebRTC `RTCDataChannel` is commonly limited to ~256 KB per message), wrap `send`/`on` in a chunking/reassembly framer. Large WebRTC payloads (SDP + a burst of ICE candidates) can exceed such limits.
- **Binary arguments.** `ioRPC` core does not encode binary blobs itself, but the bundled [`binChannel`](#binary-arguments-binchannel) adapter lets you pass `Buffer` / `TypedArray` / `ArrayBuffer` values directly as call arguments over a message-boundary transport (WebRTC `RTCDataChannel`, WebSocket, …) without base64 bloat, with zero-copy and automatic chunking for payloads above the channel limit — for binaries and for large plain JSON packets alike. Raw media streams (continuous video) should still live on their own dedicated channel.
- **Dead transports.** `ioRPC` does not observe transport state. When the underlying socket/channel closes, call [`rejectAll(err)`](#function-pair-send-on-local-options--remote-local-pending) so pending promises reject instead of hanging forever, and optionally set `callTimeout` to bound individual calls.

# Binary arguments (`binChannel`)

`binChannel` is a thin binary adapter shipped alongside `ioRPC`. It lets you pass
**binary values** (`Buffer`, `Uint8Array` / any `TypedArray`, `ArrayBuffer`) as ordinary
call arguments — at any depth inside objects/arrays — over a transport that preserves
**message boundaries and order** (a reliable + ordered WebRTC `RTCDataChannel`, a
WebSocket, etc.).

What it does for you:

- **No base64 bloat.** Binary parts travel as raw bytes, not JSON strings.
- **Zero-copy.** On send, binary parts are sliced as views (`subarray`) — no intermediate
  blob. On receive, you get a view (or an array of view-chunks), not a fresh copy.
- **Automatic chunking.** A binary larger than `chunkSize` (default `200000`, below the
  256 KB `RTCDataChannel` limit) is split across messages and reassembled transparently.
- **Large plain packets too.** The JSON skeleton itself is chunked when it does not fit into
  one message, so big non-binary results (e.g. a ~1 MB `exchangeInfo` object, hundreds of KB
  of JSON) go through a DataChannel just like binaries. No transport message ever exceeds
  `chunkSize + 11` bytes.
- **Drop-in for `pair`.** It returns `{ send, on, reset }`, the exact shape `pair` expects.

## How it works

`binChannel` wraps a low-level **transport adapter** — an object you provide that just
moves bytes:

```js
// transport contract:
{
  sendBin(u8 /* Uint8Array | Buffer */): void, // send one binary message
  onBin(handler /* (msg) => void */): void,    // subscribe to incoming binary messages
  maxMessageSize?: number                       // optional; auto-caps chunkSize
}
```

`binChannel(transport, options)` then:

1. On `send(packet)`: walks the packet, **extracts** every binary into a side list and
   leaves a tiny `{ __bin: idx }` placeholder in a JSON *skeleton*. It sends the skeleton
   as one message (or as several chunk messages if it is larger than the chunk limit),
   then each binary as one or more chunk messages.
2. On the receiving `on(handler)`: reassembles the skeleton with its binaries (order is
   guaranteed by the transport) and calls `handler(packet)` with the original object —
   binary placeholders replaced by the received bytes.

`ioRPC` has already replaced your callback functions with numeric ids before `send` runs,
so `binChannel` only ever sees numbers and binaries — it never touches your callbacks.

## Wire format

Every message starts with a 1-byte type; all integers are big-endian.

| type | meaning          | layout                                                                 |
| ---- | ---------------- | ---------------------------------------------------------------------- |
| `0`  | whole skeleton   | `[0][msgId:u32][binsCount:u16]` + UTF-8 JSON                           |
| `1`  | binary chunk     | `[1][msgId:u32][binIdx:u16][seq:u16][total:u16]` + raw bytes           |
| `2`  | skeleton chunk   | `[2][msgId:u32][binsCount:u16][seq:u16][total:u16]` + part of the JSON |

- Type `0` is used whenever `7 + skeletonBytes <= chunk + 11`; it is byte-identical to
  earlier versions, so small packets stay compatible with older receivers.
- Type `2` (since 9.3.0) is used only for skeletons that do not fit. A receiver older than
  9.3.0 silently ignores such packets (the call then ends by the caller's `callTimeout`),
  so both peers must be upgraded before sending large plain packets.
- All type `2` chunks of a packet precede its type `1` chunks, and the whole packet is
  emitted as one contiguous block.
- `binsCount`, skeleton chunk count and per-binary chunk count are `u16`: exceeding
  `65535` makes `send` throw a `RangeError` before anything is queued.

## Example: send a file over a WebRTC DataChannel

```js
import { pair, binChannel } from 'iorpc';

// --- transport adapter (Node, node-datachannel) ---
const transport = {
  sendBin: buf => dc.sendMessageBinary(buf),
  onBin:   h   => dc.onMessage(m => { if (Buffer.isBuffer(m)) h(m); }),
  maxMessageSize: dc.maxMessageSize()           // e.g. 262144
};

// --- browser adapter would be: ---
// dc.binaryType = 'arraybuffer';
// const transport = {
//   sendBin: u8 => dc.send(u8),
//   onBin:   h  => dc.addEventListener('message', e => h(e.data)), // e.data is ArrayBuffer
//   maxMessageSize: dc.maxMessageSize
// };

const ch = binChannel(transport, {
  chunkSize: 200000,    // chunk size / threshold (< maxMessageSize)
  assembleBins: false,  // false: zero-copy view / { __binChunks } array; true: one Buffer
  pendingTTL: 30000,    // ms to drop an unfinished packet (lost chunk / disconnect)
  onError: e => console.warn('binChannel:', e.message)
});

// Receiver side — register an API that accepts a binary argument:
pair({
  send: ch.send,
  on:   ch.on,
  local: {
    publishStatic(room, mtime, tarGz) {
      // tarGz is a Buffer (or { __binChunks } when chunked, see below)
      const bytes = tarGz.__binChunks ? Buffer.concat(tarGz.__binChunks) : tarGz;
      fs.writeFileSync(`/srv/${room}.tar.gz`, bytes);
      return { saved: true, size: bytes.length };
    }
  }
});

// Caller side:
const { remote, rejectAll } = pair({ send: ch.send, on: ch.on });
const tarGz = fs.readFileSync('public.tar.gz');         // ~211 KB Buffer
const res = await remote.publishStatic('demo', Date.now(), tarGz);
console.log(res); // { saved: true, size: 216064 }

// On transport close: reject pending calls and clear half-received packets.
dc.onClosed(() => { rejectAll(new Error('dc closed')); ch.reset(); });
```

Binaries can sit **anywhere** in the arguments, mixed with callbacks and scalars:

```js
await remote.upload(
  {
    meta:  { thumbnail: thumbBuffer, name: 'clip' },
    parts: [{ id: 0, data: chunk0 }, { id: 1, data: chunk1 }]
  },
  progress => updateBar(progress)      // a normal ioRPC callback, untouched
);
```

## Zero-copy: `assembleBins`

By default (`assembleBins: false`) `binChannel` never builds one big buffer for a large
binary:

- a binary **≤ `chunkSize`** arrives as a single view (a `Buffer` in Node, a `Uint8Array`
  in the browser);
- a binary **> `chunkSize`** arrives as `{ __binChunks: [view, view, …], length }` — you
  can stream the chunks straight to disk without merging:

```js
function save(bin, file) {
  if (bin.__binChunks) for (const c of bin.__binChunks) file.write(c); // streamed, no merge
  else file.write(bin);
}
```

Set `assembleBins: true` if you prefer convenience over memory: every binary is delivered
as one contiguous buffer (one extra copy).

## Options

| option         | default  | meaning                                                                 |
| -------------- | -------- | ----------------------------------------------------------------------- |
| `chunkSize`    | `200000` | Chunk size / threshold for binaries and large skeletons. Auto-capped to `maxMessageSize - 11` if given. |
| `assembleBins` | `false`  | `false`: zero-copy view / `{ __binChunks }`. `true`: one merged buffer. |
| `pendingTTL`   | `30000`  | ms before an unfinished packet (lost binary or skeleton chunk / disconnect) is dropped + `onError`. `0` disables. |
| `onError`      | no-op    | `(err) => void` — decode, malformed-chunk or TTL errors.                |

## Reliability notes

- Requires a transport that **keeps message boundaries and order** (one `sendBin` = one
  `onBin`, same order). Reliable + ordered `RTCDataChannel` and WebSocket qualify.
- Concurrent / interleaved calls are safe: each logical packet is tracked by its own
  `msgId`, so mixing a small command into a large transfer never corrupts either.
- **Ordered output queue.** All messages of a packet are pushed to an internal queue and
  drained into `sendBin` as one contiguous, in-order block. Even if your `sendBin`
  synchronously calls `send` again (reentrancy), the new packet is appended to the tail
  rather than wedged between another packet's chunks — output order is always preserved.
- **Send failures propagate.** If `sendBin` throws (e.g. channel closed mid-flight, or a
  message exceeds the transport limit), the exception is re-thrown from `send` so the
  caller learns about it. The failed message stays at the head of the queue (no gap, no
  loss); a later `send` resumes draining from that point. On a real disconnect call
  `ch.reset()` — it clears both half-received inbound packets and the undelivered outbound
  queue.
- On disconnect call `ch.reset()` (clears half-received packets, including partially received
  skeletons) together with `ioRPC`'s
  `rejectAll(err)` (rejects pending promises). With `pendingTTL > 0`, stalled packets are
  also dropped automatically.

## Copyright

Distributed under the MIT License. See `LICENSE` for more information.

IoRPC comes with ABSOLUTELY NO WARRANTY.

Parashchuk Oleksandr<span><a href="https://www.linkedin.com/in/oleksandr-parashchuk-1a5951165/"><img src="https://linkedin.com/favicon.ico" alt="linkedin.com" width="16"/></a></span> © 2025
