# ioRPC

`ioRPC` — це легкий модуль для реалізації механізму 
віддалених викликів асинхронних функцій між різними скриптами за 
допомогою різного транспорту, наприклад, WebSocket'ів. 
Цей модуль дозволяє викликати функції на віддаленому API 
та направляти відповіді з мінімальною кількістю налаштувань. Дозволяє викликати JavaScript функцію на іншому компютері.
Працює як на nodejs так і в браузері.
## Концепція

Створити функції які можливо викликати віддалено, передаючи посилання на функції
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
Викликаєм з іншого сткрипта
```javascript
// script2.js
//const remoteApi = connectToScript1()

const x1 = await remoteApi.func1("Hello"," world")
// x0 = "Hello world"

const x2 = await remoteApi.func2(2, 
  a => a*2 // тут може бути асинхронна функція
)
// typeof x2 === 'function'

const x3 = await x2(2) // remote, c => a + b + c
// a(2) + b(4) + c(2)

const remoteFunctionWithUnbind = await remoteApi.func(()=>{}) // function передасться як cb:Promise
``` 
Кожна динамічна змінна `Function` має метод `void unbind()`
```javascript
// якщо функція приходить в якості аргумента
// async func2(a, cb) { ...
     cb.unbind()
// }
  
// якщо функція приходить в якості результату
// const x2 = await remoteApi.func2(/**/)
   x2.unbind()
```

Звільніть привязки до динамічних функцій, якщо їх буде багато. Якщо приходять не функції, звільнення не потрібно.

Ви можете написати і хорошим так і поганим способом, в залежності від ситуації. Робіть складні речі простішими.

## Підготовка

Встановіть модуль:

```bash
npm install iorpc
#yarn add iorpc
```
Підключіть
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
Якщо ексорт не вичначено, створить глобальну змінну:
```html
<script src="https://unpkg.com/iorpc/index.js"></script>
<script>
  createIorpc
</script>
```
RequireJS, пакувальники Webpack, Vite та інше.

# Інтеграція iorpc та websocket
## Приклад хоста на websocket (testPcHost.js)
Цей фрагмент коду демонструє ініціалізацію бібліотеки `iorpc` для роботи з WebSocket.


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
    // не є стрілочною функцією, тому тут доступний 
    // async this.remoteApi.fn() якщо з іншої сторони оголошено функції
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
  ws.on('message', data => routeInput(JSON.parse(data))) // Усі вхідні повідомлення передаються в 'routeInput' для обробки через iorpc.
  ws.on('close', () => {
    console.log('Клієнт відключився')
  })
  ws.on('error', error => {
    console.error('Помилка WebSocket:', error)
  })
})

console.log('WebSocket сервер запущено на порту 8080')
```

## Клієнт (testPcClient.js)

```javascript
//const createIorpc = require('iorpc')
//const WebSocket = require('ws')
import createIorpc from "iorpc"
import WebSocket from "ws"

const ws = new WebSocket('ws://localhost:8080')

const { routeInput, remoteApi, clbsSize } = createIorpc(data => ws.send(JSON.stringify(data)))

ws.on('message', data => routeInput(JSON.parse(data)))

ws.on('open', async () => {
  console.log('Підключено до сервера')

  const ret = await remoteApi.greetings2('Hello')
  console.log(ret) // Hello world

  remoteApi.noWait.greetings('Hi') // якщо не потрібено очікувати результат

  const unsubscribe = await remoteApi.subscribeToUpdates(function (time) {
    // увага! в стрілочних функціях змінні в this не доступні
    console.log("server time:" + time)
    return this.iorpcClbsSize()
  })

  setTimeout(async ()=>{
    const res = await unsubscribe() // res = 'unbinded'
    unsubscribe.unbind() // сповіщає віддалену сторону що ми більше не викликатимемо unsubscribe()

    // перевірка переповнення
    const remoteClbsSize = await remoteApi.clbsSize()
    const localClbsSize = clbsSize()
    console.log(`ClbsSize final: remote ${remoteClbsSize} local ${localClbsSize}`)
    // ClbsSize final: remote 0 local 0
    
    // трансляція віддалених помилок
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
    if (0) { // для перевірки поставити 1
      // помилка без catch в консолі також інформативна, обєдгує 2 каллстека
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
    // помилки у зворотних викликах
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

    // Передавання посилань на функції всередині у обєкті чи у масиві поки не реалізовано. Краще оголосити в api.
  }, 3000)
})
ws.on('close', () => {
  console.log('Відключено від сервера')
})
```

## Опис API
### function createIorpc(sendFn: Function, localApi?: Object, waitQueueSize?: Number): Object
Create new iorpc instance. Тут немає клаєнта чи сервера, обидві сторони можуть одночасно поширити API.
```javascript
const sendFn = data => ws.send(JSON.stringify(data))
const {      
  remoteApi /* An proxy-object with remoteApi callers */,
  routeInput /* Function to handle incoming messages */,
  clbsSize /* Повертає розмір списку очікування, для перевірки чи не переповнюється */
} = createIorpc(sendFn, localApi = {}, waitQueueSize = 10000)
```
`sendFn: Function` – Function to send data to the iorpc instance on the other side. Required.

`localApi?: Object` – An object containing methods callable from the remote side; this is optional if you don't need the remote side to call methods back on this side.

`waitQueueSize?: number = 10000` – Maximum number of functions waiting in queue (default 10000). При перебільшенні будуть видалені найстаріші невідв'язані привязки. По аналогії до `freemem()` з C++, слід звільняти привязки до постійних калбеків за допомогою `unbind()` коли вони більше не будуть використовуватись. Якщо ви використовуєте іменовані виклики з remoteApi, ці тимчасові колбеки видаляються автоматично. Якщо вам потрібно, щоб кількість одночасного очікування була більше, слід збільшити `waitQueueSize`.

`Return` - An object with remoteApi (remote API functions) and routeInput (input message handler)



### function routeInput(message:Object): void

Input message handler.

```javascript
ws.on('message', data => routeInput(JSON.parse(data)))
```

`message: Object` - Обєкт, який отриманий від іншої сторони, який був надісланий з `sendFn`



### async function remoteApi\[funcname:string](...any): any

`remoteApi` - An proxy-object with remoteApi callers.

```javascript
const ret = await remoteApi.funcname(...args)
```

`...args?: string, number, array, object, async function` - 
Вхідні параметри, що передаються на іншу сторону. 
Не може містити обєкти чи масиви з функціями всередині.

`Return: string, number, array, object, async function` - 
Результат віддаленої функції.
Не може містити обєкти чи масиви з функціями всередині.


#### Модифікатор noWait
`void remoteApi.noWait.funcNameSync()` - Синхронний режим, відключає очікування відгуку від серверу.

#### Зарезервовані імена funcname

Імена функцій `iorpcUnbind` і `iorpcThrowError` частина внутрішньої реалізації, ви не повинні їх використовувати.


### function unbind(): void

Кожна повернута динамічно змінна функції, яка веде до функції на іншій стороні має цей метод. 
Відвязує і зменшує список очікування зворотніх викликів.

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

### Об'єкт функції this
remoteApi і iorpcClbsSize доступні в обєкті функцій. В стрілочних функціях змінні в this не доступні
```javascript
const localApi = { // це не є стрілочними функціями, тому тут змінні в this є
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
  // якщо this не потрібен, ви можете використовувати стрілочні функції
}
```

### Трансляція віддалених помилок RemoteError:

Використовуйте `try...catch` для отримання віддаленої помилки.

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
Якщо ви отримаєте помилку в stderr з завершенням скрипта, можете її побачити якщо переключити ваш дебагер на stdout.

Ви можете обрати сторону показу помилчи через `try...catch`, щоб запобігти її передачі.

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

