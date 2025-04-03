# ioRPC

`ioRPC` —  is a lightweight module for implementing a mechanism for remote asynchronous function calls between different scripts using various transports, for example, WebSockets. This module allows you to call functions on a remote API and send responses with a minimum of configuration. Allows you to call a JavaScript function on another computer. Works both on nodejs and in the browser.

## Concept

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
//shareToScript2(localApi)
```
Calling from another script
```javascript
// script2.js
//const remoteApi = connectToScript1()

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

Release bindings to dynamic functions if there are many of them. If the incoming functions are not functions, release is not necessary.

You can write in both good and bad ways, depending on the situation. Make complex things simpler.

## Preparation

Install the module:

```bash
npm install iorpc
#yarn add iorpc
```
Connect
```javascript
import createIorpc from 'iorpc' 
/* or */
const createIorpc = require('iorpc')
```
```html
<script type="module">
  import createIorpc from "https://unpkg.com/iorpc/index.esm.js";
</script>
```
If export is not specified, it will create a global variable:
```html
<script src="https://unpkg.com/iorpc/index.js"></script>
<script>
  createIorpc
</script>
```
RequireJS, Webpack, Vite packagers, and more.

# iorpc and websocket integration
## Example websocket host (testPcHost.js)
This code snippet demonstrates the initialization of the module `iorpc` for working with WebSocket.


```javascript
//const createIorpc = require('iorpc')
//const {WebSocketServer} = require('ws')
import createIorpc from "iorpc"
import { WebSocketServer } from "ws"

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
      const iorpcClbsSize = await cbOnClient(Date.now())
      console.log(`ClbsSize: remote ${iorpcClbsSize} local ${this.iorpcClbsSize()}`)
      // ClbsSize: remote 1 local 1
    }, 1000)
    return function () {
      cbOnClient.unbind()
      clearInterval(hSubscribeInterval)
      return 'unbinded'
    }
  },
  clbsSize() {
    return this.iorpcClbsSize()
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
        at Object.<anonymous> (/testPcClient.js:50:17)
        ...
        at async Object.functionWithErrorInCb (/testPcHost.js:44:7)
      */
    }
    return () => {
      const a = d + 1
    }
  }
}

const wss = new WebSocket.Server({ port: 8080 })
wss.on('connection', ws => {
  const { routeInput, remoteApi } = createIorpc(data => ws.send(JSON.stringify(data)), localApi)
  ws.on('message', data => routeInput(JSON.parse(data))) // incoming messages are passed to 'routeInput' for processing via iorpc.
  ws.on('close', () => {
    console.log('Client disconnected')
  })
  ws.on('error', error => {
    console.error('WebSocket error:', error)
  })
})

console.log('WebSocket server running on port 8080')
```

## Client (testPcClient.js)

```javascript
//const createIorpc = require('iorpc')
//const WebSocket = require('ws')
import createIorpc from "iorpc"
import WebSocket from "ws"

const ws = new WebSocket('ws://localhost:8080')

const { routeInput, remoteApi, clbsSize } = createIorpc(data => ws.send(JSON.stringify(data)))

ws.on('message', data => routeInput(JSON.parse(data)))

ws.on('open', async () => {
  console.log('Connected to server')

  const ret = await remoteApi.greetings2('Hello')
  console.log(ret) // Hello world

  remoteApi.noWait.greetings('Hi') // if you don't need to wait for a result

  const unsubscribe = await remoteApi.subscribeToUpdates(function (time) {
    // remember, in arrow functions, variables in 'this' are not available
    console.log("server time:" + time)
    return this.iorpcClbsSize()
  })

  setTimeout(async ()=>{
    const res = await unsubscribe() // res = 'unbinded'
    unsubscribe.unbind() // notifies the remote party that we will no longer call unsubscribe()

    // overflow check
    const remoteClbsSize = await remoteApi.clbsSize()
    const localClbsSize = clbsSize()
    console.log(`ClbsSize final: remote ${remoteClbsSize} local ${localClbsSize}`)
    // ClbsSize final: remote 0 local 0
    
    // broadcast remote errors
    try {
      await remoteApi.functionWithError()
    } catch (e) {
      console.log(e) 
      /*
        RemoteError: 
        ReferenceError: b is not defined
        at Object.functionWithError (/testPcHost.js:37:15)
        ...
        at async Timeout._onTimeout (/testPcClient.js:35:7)
      */
    }
    try {
      await remoteApi.functionWithThrow()
    } catch (e) {
      console.log(e) // someError
    }
    if (0) { // to check put 1
      // error without catch in console is also informative, combines 2 call stacks
      await remoteApi.functionWithError()
      /*terminated, process console:

        node:internal/process/promises:394
        triggerUncaughtException(err, true /* fromPromise * /)
  
        RemoteError: 
        ReferenceError: b is not defined
        at Object.functionWithError (/testPcHost.js:37:15)
        ...
        at async Timeout._onTimeout (/testPcClient.js:35:7)
      */
    }
    // callback errors
    const cbWithErr = await remoteApi.functionWithErrorInCb(()=>{
      const a = c + 1
    })
    try {
      await cbWithErr()
    } catch (e) {
      console.log(e)
      /*
        RemoteError:
        ReferenceError: d is not defined
        at Object.<anonymous> (/testPcHost.js:49:17)
        ...
        at async Timeout._onTimeout (/testPcClient.js:53:7)
      */
    }

    // Passing references to functions inside an object or array is not yet implemented. It is better to declare it in the api.
  }, 3000)
})
ws.on('close', () => {
  console.log('Disconnected from server')
})
```

## API Inventory
### function createIorpc(sendFn: Function, localApi?: Object, waitQueueSize?: Number): Object
Create new iorpc instance. There is no client or server here, both parties can distribute the API simultaneously.
```javascript
const sendFn = data => ws.send(JSON.stringify(data))
const {      
  remoteApi /* An proxy-object with remoteApi callers */,
  routeInput /* Function to handle incoming messages */,
  clbsSize /* Returns the size of the waiting list to check if it is overflowing */
} = createIorpc(sendFn, localApi = {}, waitQueueSize = 10000)
```
`sendFn: Function` – Function to send data to the iorpc instance on the other side. Required.

`localApi?: Object` – An object containing methods callable from the remote side; this is optional if you don't need the remote side to call methods back on this side.

`waitQueueSize?: number = 10000` – Maximum number of functions waiting in queue (default 10000). If you exceed this, the oldest unbound bindings will be removed. Similar to `freemem()` C++, you should free bindings to permanent callbacks with `unbind()` when they are no longer needed. If you use named calls with remoteApi, these temporary callbacks are removed automatically. If you need the number of concurrent waits to be higher, you should increase `waitQueueSize`.

`Return` - An object with remoteApi (remote API functions) and routeInput (input message handler)



### function routeInput(message:Object): void

Input message handler.

```javascript
ws.on('message', data => routeInput(JSON.parse(data)))
```

`message: Object` - An object that is received from another party, that was sent from `sendFn`



### async function remoteApi\[funcname:string](...any): any

`remoteApi` - An proxy-object with remoteApi callers.

```javascript
const ret = await remoteApi.funcname(...args)
```

`...args?: string, number, array, object, async function` - Input parameters passed to the other side. Cannot contain objects or arrays with functions inside.

`Return: string, number, array, object, async function` - The result of a remote function. Cannot contain objects or arrays with functions inside.


#### noWait modifier
`void remoteApi.noWait.funcNameSync()` - Synchronous mode, disables waiting for a response from the server.

#### Reserved function names

Function names `iorpcUnbind` and `iorpcThrowError` are part of the internal implementation, you should not use them.


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
`remoteApi` and `iorpcClbsSize` are available in the function object. In arrow functions, variables in `this` are not available.
```javascript
const localApi = { // these are not arrow functions, so here the variables in `this` are
  func(cb) {
    this.remoteApi
    this.iorpcClbsSize()

    cb(function () {
      this.remoteApi
      this.iorpcClbsSize()
      return function () {
        this.remoteApi
        this.iorpcClbsSize()
      }
    })
  }
}

await remoteApi.func(function () {
  this.remoteApi
  this.iorpcClbsSize()
  return function () {
    this.remoteApi
    this.iorpcClbsSize()
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
    const a = b + 1 // <- /testPc2Host.js:37:15
  },
}
/* ... */
try {
  await remoteApi.functionWithError() // <- /testPc1Client.js:35:7
} catch (e) {
  console.log(e)
}
/*
ReferenceError: b is not defined
    at Object.functionWithError (/testPcHost.js:37:15)
    ...
    at async Timeout._onTimeout (/testPcClient.js:35:7)
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

Copyright (c) 2025 Parashchuk Oleksandr <span><a href="https://www.linkedin.com/in/oleksandr-parashchuk-1a5951165/"><img src="https://linkedin.com/favicon.ico" alt="linkedin.com" width="16"/></a></span>. All rights reserved.

