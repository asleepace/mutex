# @asleepace/mutex

A lightweight, TypeScript-first async mutex implementation with timeout support and automatic cleanup.

## Installation

```bash
npm install @asleepace/mutex
# or
bun add @asleepace/mutex
```

## Quick Start

The simplest way to use the mutex is with the static `run` method:

```typescript
import { Mutex } from '@asleepace/mutex'

// Run a critical section with the global mutex
const result = await Mutex.run(async () => {
  const data = await fetchSensitiveData()
  await processData(data)
  return data
})
```

For error handling without try/catch, use `runSafe`:

```typescript
const [result, error] = await Mutex.runSafe(async () => {
  return await riskyOperation()
})

if (error) {
  console.error('Operation failed:', error)
} else {
  console.log('Success:', result)
}
```

## Global Mutex

The `Mutex` class provides a global singleton for quick access:

```typescript
// All these use the same global mutex instance
await Mutex.run(() => criticalOperation())
await Mutex.runSafe(() => riskyOperation())
const wrapped = Mutex.wrap(myFunction)
```

> **Note:** Global mutex operations have a default timeout of 2 minutes.

## Creating Instances

For isolated mutex instances, use `Mutex.shared()` or `new Mutex()`:

```typescript
const mutex = Mutex.shared()

// Using run/runSafe with custom timeout
const result = await mutex.run(
  async () => await processData(),
  { timeout: 30_000 }
)

// Or with error handling
const [data, error] = await mutex.runSafe(
  async () => await fetchData(),
  { timeout: 10_000 }
)
```

## Manual Lock Control

For fine-grained control, acquire locks directly:

```typescript
const mutex = Mutex.shared()
const buffer = new WritableStream()

async function fetchToSharedBuffer(url: string) {
  const lock = await mutex.acquireLock({ timeout: 60_000 })
  try {
    const resp = await fetch(url, { method: 'GET' })
    await resp.body?.pipeTo(buffer)
  } finally {
    lock.releaseLock()
  }
}

fetchToSharedBuffer('/api/people')
fetchToSharedBuffer('/api/places')
fetchToSharedBuffer('/api/things')
```

Or even cleaner with the `using` keyword:

```typescript
async function fetchToSharedBuffer(url: string) {
  using lock = await mutex.acquireLock({ timeout: 60_000 })
  const resp = await fetch(url, { method: 'GET' })
  await resp.body?.pipeTo(buffer)
  // lock automatically released!
}
```

## Examples

### Sequential Processing with wrap

```typescript
const mutex = Mutex.shared()
const chars: string[] = []

const writeSequentially = mutex.wrap(async (char: string) => {
  await sleep(Math.random() * 100)
  chars.push(char)
})

writeSequentially('a')
writeSequentially('b')
writeSequentially('c')

await mutex.finished()
console.log(chars) // ['a', 'b', 'c']
```

### Safe Error Handling

```typescript
// Instead of try/catch, use runSafe for tuple-based error handling
const [user, error] = await Mutex.runSafe(async () => {
  return await db.users.findById(id)
})

if (error) {
  return { status: 500, message: error.message }
}
return { status: 200, data: user }
```

### Timeout Handling

```typescript
try {
  const lock = await mutex.acquireLock({ timeout: 1000 })
  // Got lock within 1 second
} catch (error) {
  if (error instanceof Mutex.ErrorLockTimeout) {
    console.log('Lock acquisition timed out')
  }
}

// Or with runSafe
const [result, error] = await mutex.runSafe(
  () => longRunningTask(),
  { timeout: 5000 }
)
if (error instanceof Mutex.ErrorLockTimeout) {
  console.log('Operation timed out waiting for lock')
}
```

### Resource Cleanup

```typescript
// Automatic cleanup with using statement
using mutex = new Mutex()
// Mutex destroyed when scope exits

// Manual cleanup
const mutex = new Mutex()
mutex.destroy() // Cancels all pending operations
```

### Stream Processing

```typescript
const mutex = new Mutex()
const writer = stream.getWriter()

const writeChunk = mutex.wrap(async (data) => {
  await writer.ready
  return writer.write(data)
})

// Multiple streams can safely write
await Promise.all([
  stream1.pipeTo(new WritableStream({ write: writeChunk })),
  stream2.pipeTo(new WritableStream({ write: writeChunk })),
])
```

## API Reference

### `Mutex`

#### Static Properties

- `Mutex.global: Mutex` - Global singleton mutex instance

#### Static Methods

**`Mutex.run<T>(operation): Promise<T>`**

Execute an operation with the global mutex. Default timeout is 2 minutes.

```typescript
const result = await Mutex.run(async () => {
  return await criticalOperation()
})
```

**`Mutex.runSafe<T>(operation): Promise<[T, undefined] | [undefined, Error]>`**

Execute an operation with the global mutex, returning a result tuple instead of throwing.

```typescript
const [result, error] = await Mutex.runSafe(async () => {
  return await riskyOperation()
})
```

**`Mutex.wrap<T>(fn): (...args) => Promise<T>`**

Wrap a function with the global mutex.

```typescript
const safeWrite = Mutex.wrap(writeToFile)
await safeWrite('data.txt', content)
```

**`Mutex.shared(): Mutex`**

Create a new mutex instance.

```typescript
const mutex = Mutex.shared()
```

#### Instance Properties

- `lockCount: number` - Number of pending lock acquisitions
- `isDestroyed: boolean` - Whether the mutex has been destroyed

#### Instance Methods

**`run<T>(operation, options?): Promise<T>`**

Execute an operation after acquiring the lock.

```typescript
const result = await mutex.run(
  async () => await processData(),
  { timeout: 30_000 }
)
```

**`runSafe<T>(operation, options?): Promise<[T, undefined] | [undefined, Error]>`**

Execute an operation, returning a result tuple instead of throwing.

```typescript
const [result, error] = await mutex.runSafe(
  async () => await fetchData(),
  { timeout: 10_000 }
)
```

**`acquireLock(options?): Promise<AsyncLock>`**

Acquire a lock for manual control.

```typescript
const lock = await mutex.acquireLock({ timeout: 5000 })
try {
  // critical section
} finally {
  lock.releaseLock()
}
```

**`wrap<T>(fn): (...args) => Promise<T>`**

Wrap a function so it automatically acquires the lock.

```typescript
const protectedFn = mutex.wrap(originalFunction)
```

**`finished(): Promise<void>`**

Wait for all pending operations to complete.

```typescript
await mutex.finished()
```

**`destroy(): void`**

Destroy the mutex and cancel all pending operations.

```typescript
mutex.destroy()
```

**`withLock<T>(operation): Promise<T>`** *(deprecated)*

Use `run()` instead.

### `AsyncLock`

#### Properties

- `isUnlocked: boolean` - Whether the lock has been released

#### Methods

- `releaseLock(): void` - Release the lock
- `unlocked(): Promise<void>` - Promise that resolves when lock is released
- `cancel(reason?): void` - Cancel the lock with optional reason

## Error Types

```typescript
// Available as static properties
Mutex.ErrorMutexDestroyed // Mutex was destroyed
Mutex.ErrorLockCancelled // Lock was cancelled
Mutex.ErrorLockTimeout // Lock acquisition timed out
```

## Features

- ✅ **TypeScript-first** - Full type safety and IntelliSense
- ✅ **Global mutex** - Quick access via `Mutex.run()`, `Mutex.runSafe()`, and `Mutex.wrap()`
- ✅ **Result tuples** - `runSafe()` returns `[result, error]` for clean error handling
- ✅ **Automatic cleanup** - Support for `using` statement and `Symbol.dispose`
- ✅ **Timeout support** - Configurable lock acquisition timeouts
- ✅ **Helper methods** - `run()`, `runSafe()`, and `wrap()` for common patterns
- ✅ **Queue monitoring** - Track pending operations with `lockCount`
- ✅ **Error handling** - Specific error types for different failure modes
- ✅ **Zero dependencies** - Lightweight and self-contained

## Requirements

- Node.js 18+ or Bun
- TypeScript 5.0+ (for `using` statement support)

## License

MIT
