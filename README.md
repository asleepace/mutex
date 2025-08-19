# @asleepace/mutex

A lightweight, TypeScript-first async mutex implementation with timeout support and automatic cleanup.

## Installation

```bash
npm install @asleepace/mutex
# or
bun add @asleepace/mutex
```

## Quick Start

Example usage when writing to a shared resource like a writable stream:

```typescript
import { Mutex } from '@asleepace/mutex'

const mutex = Mutex.shared() // create a shared mutex
const buffer = new WritableStream()

async function fetchToSharedBuffer(url: string) {
  const lock = await mutex.acquireLock({ timeout: 60_000 }) // acquire lock
  try {
    const resp = await fetch(url, { method: 'GET' })
    await resp.body?.pipeTo(buffer)
  } finally {
    lock.releaseLock() // release lock
  }
}

fetchToSharedBuffer('/api/people')
fetchToSharedBuffer('/api/places')
fetchToSharedBuffer('/api/things')
```

Or even cleaner with the new `using` keyword:

```typescript
async function fetchToSharedBuffer(url: string) {
  using lock = await mutex.acquireLock({ timeout: 60_000 }) // acquire lock
  const resp = await fetch(url, { method: 'GET' })
  await resp.body?.pipeTo(buffer)
  // lock automatically released...!
}
```

## Examples

### Sequential Processing

```typescript
const sleepRandom = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, Math.random() * 1_000)
  })

const mutex = Mutex.shared()
const chars = [] as string[]

const writeSequentially = mutex.wrap(async (char: string) => {
  await sleepRandom()
  chars.push(char)
})

writeSequentially('a')
writeSequentially('b')
writeSequentially('c')

await mutex.finished()

console.log(chars) // ['a', 'b', 'c']
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
```

### Resource Cleanup

```typescript
// Automatic cleanup
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

#### Properties

- `lockCount: number` - Number of pending lock acquisitions
- `isDestroyed: boolean` - Whether the mutex has been destroyed

#### Methods

**`acquireLock(options?): Promise<AsyncLock>`**

```typescript
const lock = await mutex.acquireLock({ timeout: 5000 })
```

**`withLock<T>(operation: () => T | Promise<T>): Promise<T>`**

```typescript
const result = await mutex.withLock(() => {
  return criticalOperation()
})
```

**`wrap<T>(fn: (...args: any[]) => T): (...args: any[]) => Promise<T>`**

```typescript
const protectedFn = mutex.wrap(originalFunction)
```

**`finished(): Promise<void>`**

```typescript
await mutex.finished() // Wait for all pending operations
```

**`destroy(): void`**

```typescript
mutex.destroy() // Cancel all pending operations
```

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
- ✅ **Automatic cleanup** - Support for `using` statement and `Symbol.dispose`
- ✅ **Timeout support** - Configurable lock acquisition timeouts
- ✅ **Helper methods** - `withLock()` and `wrap()` for common patterns
- ✅ **Queue monitoring** - Track pending operations with `lockCount`
- ✅ **Error handling** - Specific error types for different failure modes
- ✅ **Zero dependencies** - Lightweight and self-contained

## Requirements

- Node.js 18+ or Bun
- TypeScript 5.0+ (for `using` statement support)

## License

MIT
