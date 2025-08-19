export class ErrorMutexDestroyed extends Error {
  public override readonly name = "E_MUTEX_DESTROYED";
}

type PromiseWithResolvers<T> = ReturnType<typeof Promise.withResolvers<T>>;

async function* locksmith(): AsyncGenerator<
  PromiseWithResolvers<void>,
  void,
  void
> {
  do {
    try {
      const lock = Promise.withResolvers<void>();
      yield lock;
      await lock.promise;
    } catch (e) {
      console.warn("[lock] rejection:", e);
      if (e instanceof ErrorMutexDestroyed) {
        break;
      }
    }
  } while (true);
}

/**
 *  # Mutex
 *
 *  A mutual exclusion lock which can be acquired via a promise and
 *  released manually or automatically via the `using` keyword.
 */
export class Mutex {
  private isDestroyed = false;
  private locksmith = locksmith();
  private active: PromiseWithResolvers<void> | undefined;

  destroyLocks() {
    if (this.isDestroyed) return;
    this.isDestroyed = true;
    this.active?.reject(new ErrorMutexDestroyed());
    this.locksmith.return(undefined);
  }

  async acquireLock() {
    if (this.isDestroyed) throw new ErrorMutexDestroyed();
    const { value: lock } = await this.locksmith.next();
    if (this.isDestroyed || !lock) throw new ErrorMutexDestroyed();

    let isReleased = false;

    return {
      releaseLock() {
        if (isReleased) return;
        isReleased = true;
        lock.resolve();
      },
      [Symbol.dispose]() {
        this.releaseLock();
      },
    };
  }

  [Symbol.dispose]() {
    this.destroyLocks();
  }
}
