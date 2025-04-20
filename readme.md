# ioRPC

`ioRPC`is a lightweight module for remote asynchronous function calls between different scripts using various transports. It enables seamless invocation of remote APIs and handling of responses with minimal configuration. You can use it to call JavaScript functions running on another machine, in Node.js, or directly in the browser.

It’s especially useful for smooth communication between different execution contexts (like a browser window and a Web Worker). A standout feature is its ability to serialize **functions as arguments or return values**, making it easy to implement things like real-time progress updates via callbacks.

---

## ✅ Why `ioRPC` is Great

### 🔗 Transparent Remote Function Calls
Call remote functions just like local ones:
```js
await remote.add(1, 2);
```

### 🔄 Function Serialization
You can pass functions as arguments and even receive functions as return values:

```js
let fn = await remote.getCallback();
await fn("hello");
```

### 🔌 Pluggable Transport
Use any transport — WebSocket, MessagePort, iframe, or even `window.postMessage`.

### ⚙️ Simple API
Create a local/remote pair with a very minimal setup.

### 🧩 Works Everywhere
Use in browser apps, Node.js, workers, iframes — anywhere messages can be sent.

---

## 🧠 Real-World Example: UI + Web Worker
### 🟦 Without `ioRPC`:
You'd have to manually:

- serialize messages to `postMessage`

- listen to `message` events and dispatch handlers

- track unique `id`s for each request

- manually wire up promise/response logic

Too much boilerplate.

---

### ⚡️ With `ioRPC`:
#### UI (main window)

```js
import { pair } from "https://unpkg.com/iorpc/index.esm.js";

const worker = new Worker("worker.js");

const { local, remote } = pair({
  send: msg => worker.postMessage(msg),
  on: handler => worker.onmessage = e => handler(e.data)
});

async function run() {
  await remote.processData([1, 2, 3], progress => {
    console.log("Progress:", progress);
  });
}
```
---
#### Worker (worker.js)
```js
importScripts("https://unpkg.com/iorpc/index.js");

const { local, remote } = iorpc.pair({
  send: msg => postMessage(msg),
  on: handler => onmessage = e => handler(e.data)
});

local.processData = async function(data, onProgress) {
  for (let i = 0; i < data.length; i++) {
    await new Promise(r => setTimeout(r, 500));
    await onProgress((i + 1) / data.length);
  }
};
```
---
🚀 Highlights
No manual message/event plumbing

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
  import { pair } from "https://unpkg.com/iorpc/index.esm.js";
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

const wss = new WebSocketServer({ port: 8080 });
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
import { pair } from 'iorpc';

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

    // The ability to pass function references within objects or arrays is implemented. Make sure to unbind them when they are no longer in use.
    const {fn1, fn2} = await remote.functionWithReturnOfTwoFn()
    console.log(await fn1()) // fn1
    console.log(await fn2()) // fn2
    fn1.unbind()
    fn2.unbind()
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
- `allowNestedFunctions: boolean = true` – If true, allows functions to be nested in objects or arrays and passed remotely.
- `exposeErrors: boolean = true` – If true, forwards full remote error details (like stack traces). If false, replaces them with a generic message.
- `injectToThis: boolean = true` – If true, replaces this inside called functions with `this.remoteApi`.

`Return` - An object with the following properties:
- `remote: Object` – A proxy object. Accessing `remote.someFunction()` will trigger a remote call to `someFunction` on the other side.
- `local: Object` – The original local API passed (can be extended dynamically).
- `pending: Function` – Returns the current number of active, bound remote calls (i.e., the wait queue size).
  Useful to monitor memory usage or detect forgotten `unbind()` calls.


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

Use `try...catch` to catch a remote error.

```javascript
const localApi = {
  functionWithError() {
    const a = b + 1 // <- /wsHost.js:37:15
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

## Copyright

Distributed under the MIT License. See `LICENSE` for more information.

IoRPC comes with ABSOLUTELY NO WARRANTY.

Parashchuk Oleksandr<span><a href="https://www.linkedin.com/in/oleksandr-parashchuk-1a5951165/"><img src="https://linkedin.com/favicon.ico" alt="linkedin.com" width="16"/></a></span> © 2025

