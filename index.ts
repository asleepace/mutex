/**
 *  Special error which is thrown when a mutex is detroyed.
 */
export class ErrorMutexDestroyed extends Error {
  public override readonly name = "E_MUTEX_DESTROYED";
}

/**
 *  Special error which is thrown when an `AsyncLock` is cancelled.
 */
export class ErrorLockCancelled extends Error {
  public override readonly name = "E_LOCK_CANCELLED";
}

/**
 *  Special error which is thrown when acquiring a lock times out.
 */
export class ErrorLockTimeout extends Error {
  public override readonly name = "E_LOCK_TIMEOUT";
}

/**
 *  A simple promise based locking mechanism which can be awaited
 *  and released.
 */
class AsyncLock {
  private lock? = Promise.withResolvers<void>();

  constructor(private cleanup?: () => void) {}

  public get isUnlocked(): boolean {
    return !this.lock;
  }

  public cancel(reason?: any) {
    if (!this.lock) return;
    this.lock?.reject(reason);
    this.lock = undefined;
  }

  public releaseLock() {
    if (!this.lock) return;
    this.cleanup?.();
    this.lock?.resolve();
    this.lock = undefined;
  }

  public unlocked(): Promise<void> {
    return this.lock?.promise || Promise.resolve();
  }

  [Symbol.dispose]() {
    this.releaseLock();
  }
}

/**
 *  Generator used to create a series of `LockPromise` instances,
 *  which will resolve sequentially.
 */
async function* createLocksmith(
  cleanup?: () => void
): AsyncGenerator<AsyncLock, void, void> {
  do {
    try {
      const lock = new AsyncLock(cleanup);
      yield lock;
      await lock.unlocked();
    } catch (e) {
      console.warn("[lock] rejection:", e);
      if (e instanceof ErrorMutexDestroyed) {
        break;
      }
    }
  } while (true);
}

/**
 *  Helper which creates a new promise which throw `ErrorLockTimeout` if
 *  we fail to resolve the lock before completion.
 */
function withTimeout(timeout?: number): Promise<never> | undefined {
  if (!timeout) return undefined;
  return new Promise((_, reject) => {
    setTimeout(() => reject(new ErrorLockTimeout()), timeout);
  });
}

/**
 *  # Mutex
 *
 *  A mutual exclusion lock which can be acquired via a promise and
 *  released manually or automatically via the `using` keyword.
 */
export class Mutex {
  static readonly ErrorMutexDestroyed = ErrorMutexDestroyed;
  static readonly ErrorLockCancelled = ErrorLockCancelled;
  static readonly ErrorLockTimeout = ErrorLockTimeout;

  /**
   *  @static helper which create a new mutex instance.
   */
  static shared(): Mutex {
    return new Mutex();
  }

  /**
   *  @private generator which create new locks.
   */
  private locksmith?: AsyncGenerator<AsyncLock, void, void>;

  /**
   *  @private reference to the currently held lock.
   */
  private current?: AsyncLock | undefined;

  /**
   *  Total number of pending lock acquisitions.
   */
  private pending: number = 0;

  constructor() {
    this.current = undefined;
    this.pending = 0;
    this.locksmith = createLocksmith(() => {
      this.pending -= 1;
    });
  }

  /**
   *  Get the total number of pending locks.
   */
  get lockCount(): number {
    return this.pending;
  }

  /**
   *  Returns `true` if the current mutex has been destroyed and can no
   *  longer acquire any new locks.
   */
  get isDestroyed(): boolean {
    return !this.locksmith;
  }

  /**
   *  Helper method which will await any previously scheduled locks to finish,
   *  once the lock is acuired it will be immediately released.
   */
  async finished(): Promise<void> {
    const mutex = await this.acquireLock();
    mutex.releaseLock();
  }

  /**
   *  Await any previous locks to release and then acquire a new lock which
   *  will prevent any other invokations from finishing until `.releaseLock()`
   *  is called or the dispose symbol has been called.
   */
  async acquireLock(options: { timeout?: number } = {}): Promise<AsyncLock> {
    if (!this.locksmith) throw new ErrorMutexDestroyed();
    this.pending += 1;
    const timeoutPromise = withTimeout(options.timeout);
    const getLockPromise = this.locksmith.next();
    let lock: IteratorYieldResult<AsyncLock> | undefined
    try {
      const lock = await Promise.race(
        [getLockPromise, timeoutPromise].filter((item) => item !== undefined)
      );
      if (!this.locksmith || !lock || !lock.value || lock.done) {
        throw new ErrorMutexDestroyed();
      }
      this.current = lock.value;
      return lock.value;
    } catch (e) {
      this.pending -= 1
      throw e
    }
  }

  /**
   *  Destroys the current mutex and cancels any and all pending operations, once
   *  destroyed this mutex cannot be used again.
   */
  destroy(): void {
    if (!this.locksmith) return;
    this.current?.cancel(new ErrorMutexDestroyed());
    this.current = undefined;
    this.pending = 0
    this.locksmith.return(undefined).catch((e) => {
      // ingore cleanup issues
    });
    this.locksmith = undefined;
  }

  /**
   *  Helper method which returns a mutex wrapped operation which will first await and
   *  acquire a new lock before executing, and then automatically release the
   *  lock once finished.
   */
  wrap<TInput, TOutput>(
    operation: (...args: TInput[]) => TOutput
  ): (...args: TInput[]) => Promise<Awaited<TOutput>> {
    return async (...args: TInput[]): Promise<Awaited<TOutput>> => {
      const lock = await this.acquireLock();
      try {
        return await operation(...args);
      } finally {
        lock.releaseLock();
      }
    };
  }

  /**
   *  Helper method which will execute the current operation once it has acquired the
   *  mutex lock, return the value and release the lock automatically.
   */
  async withLock<T>(operation: () => T | Promise<T>): Promise<Awaited<T>> {
    const lock = await this.acquireLock();
    try {
      return await operation();
    } finally {
      lock.releaseLock();
    }
  }

  [Symbol.dispose]() {
    this.destroy();
  }
}
