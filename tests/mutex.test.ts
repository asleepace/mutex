import { test, expect, describe, beforeEach } from "bun:test";
import { Mutex } from "../index"; // Adjust import path as needed

// helpers
const NOOP = () => {};

function sleep(time: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(() => resolve(), time);
  });
}

function sleepRand(time: number = 100) {
  return sleep(Math.random() * time);
}

// test suite
describe("Mutex", () => {
  let mutex: Mutex;

  beforeEach(() => {
    mutex = new Mutex();
  });

  describe("Basic functionality", () => {
    test("should be able to create a new mutex lock", async () => {
      const lock = await mutex.acquireLock();
      expect(mutex.lockCount).toBe(1);
      lock.releaseLock();
      expect(lock.isUnlocked).toBe(true);
      expect(mutex.lockCount).toBe(0);
    });

    test("should be able to acquire and release lock with using statement", async () => {
      await (async () => {
        using lock = await mutex.acquireLock();
        expect(lock).toBeDefined();
        expect(mutex.lockCount).toBe(1);
        expect(lock.isUnlocked).toBe(false);
        // Lock should auto-release when scope exits
      })();
      
      expect(mutex.lockCount).toBe(0);
    });

    test("should be able to acquire mutex lock multiple times sequentially", async () => {
      let buffer = "";
      
      async function writeToString(char: string) {
        const lock = await mutex.acquireLock();
        await sleep(Math.random() * 50);
        buffer += char;
        lock.releaseLock();
      }
      
      writeToString("a")
      writeToString("b")
      writeToString("c")
      writeToString("d")

      await mutex.finished()

      expect(buffer).toEqual("abcd");
      expect(mutex.lockCount).toEqual(0);
    });

    test("should track lock count correctly with concurrent acquisitions", async () => {
      const lock1Promise = mutex.acquireLock();
      const lock2Promise = mutex.acquireLock();
      const lock3Promise = mutex.acquireLock();
      
      // All should be pending
      expect(mutex.lockCount).toBe(3);
      
      const lock1 = await lock1Promise;
      expect(mutex.lockCount).toBe(3); // 2 still pending
      
      lock1.releaseLock();
      const lock2 = await lock2Promise;
      expect(mutex.lockCount).toBe(2); // 1 still pending
      
      lock2.releaseLock();
      const lock3 = await lock3Promise;
      expect(mutex.lockCount).toBe(1); // None pending
      
      lock3.releaseLock();
      expect(mutex.lockCount).toBe(0);
    });
  });

  describe("Helper methods", () => {
    test("should be able to use with mutex.wrap(fn)", async () => {
      let buffer = "";
      
      const writeToBuffer = mutex.wrap(async (char: string) => {
        await sleepRand(50);
        buffer += char;
      });
      
      writeToBuffer("a");
      writeToBuffer("b");
      writeToBuffer("c");
      writeToBuffer("d");
      
      await mutex.finished();
      expect(buffer).toBe("abcd");
      expect(mutex.lockCount).toBe(0);
    });

    test("should be able to continue if a single operation fails", async () => {
      let buffer = "";
      
      const writeToBuffer = mutex.wrap(async (char: string) => {
        await sleepRand(50);
        if (char === "c") throw new Error("Invalid char C");
        buffer += char;
      });
      
      writeToBuffer("a");
      writeToBuffer("b");
      writeToBuffer("c").catch(NOOP);
      writeToBuffer("d");
      
      await mutex.finished();
      expect(buffer).toBe("abd");
      expect(mutex.lockCount).toBe(0);
    });

    test("withLock should acquire and release automatically", async () => {
      let executed = false;
      
      const result = await mutex.withLock(async () => {
        executed = true;
        expect(mutex.lockCount).toBe(1);
        await sleep(10);
        return "success";
      });
      
      expect(executed).toBe(true);
      expect(result).toBe("success");
      expect(mutex.lockCount).toBe(0);
    });

    test("withLock should release lock even on error", async () => {
      await expect(
        mutex.withLock(async () => {
          expect(mutex.lockCount).toBe(1);
          throw new Error("Test error");
        })
      ).rejects.toThrow("Test error");
      
      expect(mutex.lockCount).toBe(0);
    });

    test("finished() should wait for all pending operations", async () => {
      const results: number[] = [];
      
      // Start multiple operations
      mutex.withLock(async () => {
        await sleep(50);
        results.push(1);
      });
      
      mutex.withLock(async () => {
        await sleep(30);
        results.push(2);
      });
      
      mutex.withLock(async () => {
        await sleep(10);
        results.push(3);
      });
      
      expect(mutex.lockCount).toBe(3);
      
      // Wait for all to finish
      await mutex.finished();
      
      expect(results).toEqual([1, 2, 3]);
      expect(mutex.lockCount).toBe(0);
    });
  });

  describe("Timeout functionality", () => {
    test("should timeout when specified", async () => {
      // Acquire lock and hold it
      const firstLock = await mutex.acquireLock();
      expect(mutex.lockCount).toBe(1);
      
      // Second acquire should timeout
      const start = Date.now();
      await expect(
        mutex.acquireLock({ timeout: 50 })
      ).rejects.toThrow(Mutex.ErrorLockTimeout);
      
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(45);
      expect(elapsed).toBeLessThan(100);
      
      firstLock.releaseLock();
      expect(mutex.lockCount).toBe(0);
    });

    test("should not timeout when lock is available immediately", async () => {
      const lock = await mutex.acquireLock({ timeout: 100 });
      expect(lock).toBeDefined();
      expect(lock.isUnlocked).toBe(false);
      lock.releaseLock();
      expect(lock.isUnlocked).toBe(true);
    });

    test("should work without timeout when not specified", async () => {
      const lock1 = await mutex.acquireLock();
      
      const promise = mutex.acquireLock();
      setTimeout(() => lock1.releaseLock(), 10);
      
      const lock2 = await promise;
      expect(lock2).toBeDefined();
      lock2.releaseLock();
    });
  });

  describe("Destroy functionality", () => {
    test("should be able to destroy mutex and cancel pending locks", async () => {
      const buffer: number[] = [];
      
      const writeToBuffer = mutex.wrap(async (item: number) => {
        await sleep(1000);
        buffer.push(item);
      });
      
      // Start multiple operations
      writeToBuffer(1).catch(NOOP);
      writeToBuffer(2).catch(NOOP);
      writeToBuffer(3).catch(NOOP);
      writeToBuffer(4).catch(NOOP);
      
      expect(mutex.lockCount).toBe(4);
      
      // Destroy should cancel all pending
      mutex.destroy();
      
      expect(buffer.length).toBe(0);
      expect(mutex.lockCount).toBe(0);
      expect(mutex.isDestroyed).toBe(true);
    });

    test("should throw when acquiring lock after destroy", async () => {
      mutex.destroy();
      
      await expect(mutex.acquireLock()).rejects.toThrow(Mutex.ErrorMutexDestroyed);
      expect(mutex.isDestroyed).toBe(true);
    });

    test("should cancel pending locks when destroyed", async () => {
      const firstLock = await mutex.acquireLock();
      expect(mutex.lockCount).toBe(1);
      
      const secondLockPromise = mutex.acquireLock();
      expect(mutex.lockCount).toBe(2);
      
      mutex.destroy();
      
      await expect(secondLockPromise).rejects.toThrow(Mutex.ErrorMutexDestroyed);
      expect(mutex.lockCount).toBe(0);
      
      // First lock should still work for release
      firstLock.releaseLock();
    });

    test("should work with using statement for auto-destroy", async () => {
      let lockCount: number;
      
      await (async () => {
        using localMutex = new Mutex();
        const lock = await localMutex.acquireLock();
        lockCount = localMutex.lockCount;
        lock.releaseLock();
        // Mutex should auto-destroy when scope exits
      })();
      
      expect(lockCount!).toBe(1);
    });

    test("should handle destroy on already destroyed mutex", () => {
      mutex.destroy();
      expect(mutex.isDestroyed).toBe(true);
      
      mutex.destroy(); // Should not throw
      mutex.destroy(); // Should not throw
      
      expect(mutex.isDestroyed).toBe(true);
    });
  });

  describe("AsyncLock behavior", () => {
    test("should handle multiple releases gracefully", async () => {
      const lock = await mutex.acquireLock();
      expect(lock.isUnlocked).toBe(false);
      
      lock.releaseLock();
      expect(lock.isUnlocked).toBe(true);
      
      lock.releaseLock(); // Should not throw
      lock.releaseLock(); // Should not throw
      
      expect(lock.isUnlocked).toBe(true);
    });

    test("should handle lock cancellation", async () => {
      const lock = await mutex.acquireLock();
      expect(lock.isUnlocked).toBe(false);
      
      lock.cancel(new Error("Test cancellation"));
      expect(lock.isUnlocked).toBe(true);
    });

    test("unlocked() should resolve when lock is released", async () => {
      const lock = await mutex.acquireLock();
      
      let resolved = false;
      const unlockPromise = lock.unlocked().then(() => {
        resolved = true;
      });
      
      expect(resolved).toBe(false);
      
      lock.releaseLock();
      await unlockPromise;
      
      expect(resolved).toBe(true);
    });
  });

  describe("Error classes", () => {
    test("should expose error classes on Mutex", () => {
      expect(Mutex.ErrorMutexDestroyed).toBeDefined();
      expect(Mutex.ErrorLockCancelled).toBeDefined();
      expect(Mutex.ErrorLockTimeout).toBeDefined();
    });

    test("should create proper error instances", () => {
      const destroyedError = new Mutex.ErrorMutexDestroyed();
      const cancelledError = new Mutex.ErrorLockCancelled();
      const timeoutError = new Mutex.ErrorLockTimeout();
      
      expect(destroyedError.name).toBe("E_MUTEX_DESTROYED");
      expect(cancelledError.name).toBe("E_LOCK_CANCELLED");
      expect(timeoutError.name).toBe("E_LOCK_TIMEOUT");
      
      expect(destroyedError instanceof Error).toBe(true);
      expect(cancelledError instanceof Error).toBe(true);
      expect(timeoutError instanceof Error).toBe(true);
    });
  });

  describe("Static methods", () => {
    test("shared should create new mutex instance", () => {
      const sharedMutex = Mutex.shared();
      expect(sharedMutex).toBeInstanceOf(Mutex);
      expect(sharedMutex.isDestroyed).toBe(false);
      expect(sharedMutex.lockCount).toBe(0);
    });
  });

  describe("Edge cases and concurrency", () => {
    test("should handle concurrent acquire attempts", async () => {
      const results: number[] = [];
      
      const tasks = Array.from({ length: 5 }, (_, i) =>
        mutex.withLock(async () => {
          results.push(i);
          await sleep(10);
        })
      );
      
      await Promise.all(tasks);
      
      expect(results).toHaveLength(5);
      expect(results.sort()).toEqual([0, 1, 2, 3, 4]);
      expect(mutex.lockCount).toBe(0);
    });

    test("should maintain proper lock count during failures", async () => {
      const results: string[] = [];
      
      const tasks = [
        mutex.withLock(async () => {
          results.push("a");
          await sleep(10);
        }),
        mutex.withLock(async () => {
          results.push("b");
          throw new Error("Test error");
        }).catch(() => {}),
        mutex.withLock(async () => {
          results.push("c");
          await sleep(10);
        })
      ];
      
      await Promise.all(tasks);
      
      expect(results).toEqual(["a", "b", "c"]);
      expect(mutex.lockCount).toBe(0);
    });

    test("should handle high concurrency", async () => {
      const taskCount = 50;
      let counter = 0;
      
      const tasks = Array.from({ length: taskCount }, () =>
        mutex.withLock(async () => {
          const current = counter;
          await sleep(1);
          counter = current + 1;
        })
      );
      
      await Promise.all(tasks);
      
      expect(counter).toBe(taskCount);
      expect(mutex.lockCount).toBe(0);
    }, 10000);

    test("finished() should work with empty queue", async () => {
      // Should resolve immediately when no locks are pending
      const start = Date.now();
      await mutex.finished();
      const elapsed = Date.now() - start;
      
      expect(elapsed).toBeLessThan(10); // Should be nearly immediate
      expect(mutex.lockCount).toBe(0);
    });
  });
});