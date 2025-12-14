/**
 * Special error which is thrown when a mutex is destroyed.
 */
export class ErrorMutexDestroyed extends Error {
  public override readonly name = 'E_MUTEX_DESTROYED'
}

/**
 * Special error which is thrown when an `AsyncLock` is cancelled.
 */
export class ErrorLockCancelled extends Error {
  public override readonly name = 'E_LOCK_CANCELLED'
}

/**
 * Special error which is thrown when acquiring a lock times out.
 */
export class ErrorLockTimeout extends Error {
  public override readonly name = 'E_LOCK_TIMEOUT'
}

/**
 * A simple promise based locking mechanism which can be awaited
 * and released.
 */
export class AsyncLock {
  private lock? = Promise.withResolvers<void>()

  constructor(private cleanup?: () => void) {}

  public get isUnlocked(): boolean {
    return !this.lock
  }

  /**
   * Cancels the current lock, but does not destroy the mutex.
   */
  public cancel(reason?: any) {
    if (!this.lock) return
    this.unlocked().catch(() => {}) // NOTE: prevent errors from bubbling here
    this.cleanup?.()
    this.lock?.reject(reason)
    this.lock = undefined
  }

  /**
   * Release the current lock so that the next operation can continue.
   */
  public releaseLock() {
    if (!this.lock) return
    this.cleanup?.()
    this.lock?.resolve()
    this.lock = undefined
  }

  /**
   * Returns a promise which will resolve when this lock is released.
   *
   * @note will throw if lock is cancelled.
   */
  public unlocked(): Promise<void> {
    return this.lock?.promise || Promise.resolve()
  }

  [Symbol.dispose]() {
    this.releaseLock()
  }
}

/**
 * Generator used to create a series of `AsyncLock` instances,
 * which will resolve sequentially.
 */
async function* createLocksmith(
  cleanup?: () => void
): AsyncGenerator<AsyncLock, void, void> {
  do {
    try {
      const lock = new AsyncLock(cleanup)
      yield lock
      await lock.unlocked()
    } catch (e) {
      console.warn('[lock] rejection:', e)
      if (e instanceof ErrorMutexDestroyed) {
        break
      }
      if (e instanceof ErrorLockCancelled) {
        continue
      }
      if (e instanceof ErrorLockTimeout) {
        continue
      }
    }
  } while (true)
}

/**
 * Helper which creates a new promise that throws `ErrorLockTimeout` if
 * we fail to resolve the lock before completion.
 */
function withTimeout(timeout?: number): Promise<never> | undefined {
  if (!timeout) return undefined
  return new Promise((_, reject) => {
    setTimeout(() => reject(new ErrorLockTimeout()), timeout)
  })
}

/**
 * # Mutex
 *
 * A mutual exclusion lock which can be acquired via a promise and
 * released manually or automatically via the `using` keyword.
 */
export class Mutex {
  static readonly ErrorMutexDestroyed = ErrorMutexDestroyed
  static readonly ErrorLockCancelled = ErrorLockCancelled
  static readonly ErrorLockTimeout = ErrorLockTimeout

  /**
   * Global mutex singleton.
   */
  static readonly global = new Mutex()

  /**
   * Runs operation after acquiring the global mutex lock.
   *
   * @note global timeout is 2 minutes.
   */
  static async run<T>(operation: () => Promise<T> | T): Promise<T> {
    return await Mutex.global.run(operation, { timeout: 120_000 })
  }

  /**
   * Runs operation after acquiring global mutex lock and catches any errors,
   * returns a result tuple.
   * 
   * @note global timeout is 2 minutes.
   */
  static async runSafe<T>(operation: () => Promise<T> | T): Promise<[T, undefined] | [undefined, Error]> {
    return await Mutex.global.runSafe(operation, { timeout: 120_000 })
  }

  /**
   * Wraps an operation with the global mutex.
   * 
   * @note global timeout is 2 minutes.
   */
  static wrap<TInput, TOutput>(
    operation: (...args: TInput[]) => TOutput
  ): (...args: TInput[]) => Promise<Awaited<TOutput>> {
    return Mutex.global.wrap(operation)
  }

  /**
   * Static helper which creates a new mutex instance.
   */
  static shared(): Mutex {
    return new Mutex()
  }

  /**
   * Private generator which creates new locks.
   */
  private locksmith?: AsyncGenerator<AsyncLock, void, void>

  /**
   * Private reference to the currently held lock.
   */
  private current?: AsyncLock

  /**
   * Total number of pending lock acquisitions.
   */
  private __pending = 0

  constructor() {
    this.current = undefined
    this.locksmith = createLocksmith(() => {
      this.lockCount -= 1
    })
  }

  private set lockCount(nextValue: number) {
    this.__pending = Math.max(nextValue, 0)
  }

  /**
   * Get the total number of pending locks.
   */
  get lockCount() {
    if (this.isDestroyed) return 0
    return this.__pending
  }

  /**
   * Returns `true` if the current mutex has been destroyed and can no
   * longer acquire any new locks.
   */
  get isDestroyed(): boolean {
    return !this.locksmith
  }

  /**
   * Helper method which will await any previously scheduled locks to finish.
   * Once the lock is acquired it will be immediately released.
   */
  async finished(): Promise<void> {
    const mutex = await this.acquireLock()
    mutex.releaseLock()
  }

  /**
   * Await any previous locks to release and then acquire a new lock which
   * will prevent any other invocations from finishing until `.releaseLock()`
   * is called or the dispose symbol has been called.
   */
  async acquireLock(options: { timeout?: number } = {}): Promise<AsyncLock> {
    if (!this.locksmith) throw new ErrorMutexDestroyed()
    try {
      this.lockCount += 1
      const timeoutPromise = withTimeout(options.timeout)
      const getLockPromise = this.locksmith.next()
      const lock = await Promise.race(
        [getLockPromise, timeoutPromise].filter((item) => item !== undefined)
      )
      if (!this.locksmith || !lock || !lock.value || lock.done) {
        throw new ErrorMutexDestroyed()
      }
      this.current = lock.value
      return lock.value
    } catch (e) {
      this.lockCount -= 1
      throw e
    }
  }

  /**
   * Destroys the current mutex and cancels any and all pending operations.
   * Once destroyed this mutex cannot be used again.
   */
  destroy(): void {
    if (!this.locksmith) return
    try {
      this.lockCount = 0
      this.current?.cancel()
      this.locksmith.return(undefined).catch((e) => {
        console.warn('[mutex] lock abandonned:', e)
      })
    } finally {
      this.locksmith = undefined
      this.current = undefined
      this.lockCount = 0
    }
  }

  /**
   * Helper method which returns a mutex wrapped operation which will first await and
   * acquire a new lock before executing, and then automatically release the
   * lock once finished.
   */
  wrap<TInput, TOutput>(
    operation: (...args: TInput[]) => TOutput
  ): (...args: TInput[]) => Promise<Awaited<TOutput>> {
    return async (...args: TInput[]): Promise<Awaited<TOutput>> => {
      const lock = await this.acquireLock()
      try {
        return await operation(...args)
      } finally {
        lock.releaseLock()
      }
    }
  }

  /**
   * Helper method which will execute the current operation once it has acquired the
   * mutex lock, return the value and release the lock automatically.
   *
   * @deprecated use `.run(operation)` instead.
   */
  async withLock<T>(operation: () => T | Promise<T>): Promise<Awaited<T>> {
    const lock = await this.acquireLock()
    try {
      return await operation()
    } finally {
      lock.releaseLock()
    }
  }

  /**
   * Run operation after acquiring mutex lock.
   */
  async run<T>(operation: () => T | Promise<T>, options: { timeout: number } = { timeout: 120_000 }): Promise<T> {
    const lock = await this.acquireLock(options)
    try {
      return await operation()
    } finally {
      lock.releaseLock()
    }
  }

  /**
   * Run operation after acquiring mutex lock and handle errors.
   */
  async runSafe<T>(operation: () => Promise<T> | T, options: { timeout: number } = { timeout: 120_000 }): Promise<[T, undefined] | [undefined, Error]> {
    try {
      const output = await this.run(operation, options)
      return [output, undefined]
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e))
      return [undefined, error]
    }
  }

  /**
   * Destroy mutex when finished.
   */
  [Symbol.dispose]() {
    this.destroy()
  }
}
