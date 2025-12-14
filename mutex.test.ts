import { test, expect, describe, beforeEach } from "bun:test";
import { Mutex } from "./index.js"; // Adjust import path as needed

// helpers
const NOOP = () => { };

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
      const lock = await mutex.acquireLock()
      expect(lock.isUnlocked).toBe(false);

      lock.cancel(new Error('Cancelled operation'));
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

  describe("Global mutex", () => {
    test("Mutex.global should be a singleton Mutex instance", () => {
      expect(Mutex.global).toBeInstanceOf(Mutex);
      expect(Mutex.global).toBe(Mutex.global); // Same reference
      expect(Mutex.global.isDestroyed).toBe(false);
    });

    test("Mutex.run should execute operation with global mutex lock", async () => {
      const results: number[] = [];

      // Run multiple operations concurrently
      const p1 = Mutex.run(async () => {
        await sleep(30);
        results.push(1);
        return "first";
      });

      const p2 = Mutex.run(async () => {
        await sleep(10);
        results.push(2);
        return "second";
      });

      const [r1, r2] = await Promise.all([p1, p2]);

      // Should maintain order despite different sleep times
      expect(results).toEqual([1, 2]);
      expect(r1).toBe("first");
      expect(r2).toBe("second");
    });

    test("Mutex.run should handle synchronous operations", async () => {
      const result = await Mutex.run(() => 42);
      expect(result).toBe(42);
    });

    test("Mutex.run should propagate errors", async () => {
      await expect(
        Mutex.run(async () => {
          throw new Error("Test global error");
        })
      ).rejects.toThrow("Test global error");
    });

    test("Mutex.runSafe should return success tuple on success", async () => {
      const [result, error] = await Mutex.runSafe(async () => {
        await sleep(10);
        return "success value";
      });

      expect(result).toBe("success value");
      expect(error).toBeUndefined();
    });

    test("Mutex.runSafe should return error tuple on failure", async () => {
      const [result, error] = await Mutex.runSafe(async () => {
        throw new Error("Expected failure");
      });

      expect(result).toBeUndefined();
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toBe("Expected failure");
    });

    test("Mutex.runSafe should convert non-Error throws to Error", async () => {
      const [result, error] = await Mutex.runSafe(async () => {
        throw "string error";
      });

      expect(result).toBeUndefined();
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toBe("string error");
    });

    test("Mutex.runSafe should maintain order with concurrent calls", async () => {
      const results: string[] = [];

      const p1 = Mutex.runSafe(async () => {
        await sleep(20);
        results.push("a");
        return "a";
      });

      const p2 = Mutex.runSafe(async () => {
        results.push("b");
        throw new Error("b failed");
      });

      const p3 = Mutex.runSafe(async () => {
        results.push("c");
        return "c";
      });

      const [[r1], [r2, e2], [r3]] = await Promise.all([p1, p2, p3]);

      expect(results).toEqual(["a", "b", "c"]);
      expect(r1).toBe("a");
      expect(r2).toBeUndefined();
      expect(e2?.message).toBe("b failed");
      expect(r3).toBe("c");
    });

    test("Mutex.wrap should wrap operations with global mutex", async () => {
      const results: string[] = [];

      const appendResult = Mutex.wrap(async (value: string) => {
        await sleep(Math.random() * 20);
        results.push(value);
        return value;
      });

      const p1 = appendResult("first");
      const p2 = appendResult("second");
      const p3 = appendResult("third");

      await Promise.all([p1, p2, p3]);

      expect(results).toEqual(["first", "second", "third"]);
    });

    test("Mutex.wrap should handle errors correctly", async () => {
      const failingOp = Mutex.wrap(async (shouldFail: boolean) => {
        if (shouldFail) throw new Error("Wrapped error");
        return "success";
      });

      await expect(failingOp(true)).rejects.toThrow("Wrapped error");
      const result = await failingOp(false);
      expect(result).toBe("success");
    });
  });

  describe("Instance run and runSafe methods", () => {
    test("run should execute operation with timeout", async () => {
      const result = await mutex.run(async () => {
        await sleep(10);
        return "completed";
      }, { timeout: 5000 });

      expect(result).toBe("completed");
      expect(mutex.lockCount).toBe(0);
    });

    test("run should timeout if lock cannot be acquired", async () => {
      const lock = await mutex.acquireLock();

      await expect(
        mutex.run(async () => "never", { timeout: 50 })
      ).rejects.toThrow(Mutex.ErrorLockTimeout);

      lock.releaseLock();
    });

    test("run should release lock even on operation error", async () => {
      await expect(
        mutex.run(async () => {
          throw new Error("Operation failed");
        })
      ).rejects.toThrow("Operation failed");

      expect(mutex.lockCount).toBe(0);
    });

    test("run should maintain sequential execution", async () => {
      const order: number[] = [];

      const p1 = mutex.run(async () => {
        await sleep(30);
        order.push(1);
      });

      const p2 = mutex.run(async () => {
        await sleep(10);
        order.push(2);
      });

      const p3 = mutex.run(async () => {
        order.push(3);
      });

      await Promise.all([p1, p2, p3]);

      expect(order).toEqual([1, 2, 3]);
    });

    test("runSafe should return success tuple", async () => {
      const [result, error] = await mutex.runSafe(async () => {
        return { data: "test" };
      });

      expect(result).toEqual({ data: "test" });
      expect(error).toBeUndefined();
    });

    test("runSafe should return error tuple on failure", async () => {
      const [result, error] = await mutex.runSafe(async () => {
        throw new Error("Safe error");
      });

      expect(result).toBeUndefined();
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toBe("Safe error");
    });

    test("runSafe should handle synchronous operations", async () => {
      const [result, error] = await mutex.runSafe(() => 123);

      expect(result).toBe(123);
      expect(error).toBeUndefined();
    });

    test("runSafe should handle synchronous throws", async () => {
      const [result, error] = await mutex.runSafe(() => {
        throw new Error("Sync error");
      });

      expect(result).toBeUndefined();
      expect(error?.message).toBe("Sync error");
    });

    test("runSafe should timeout if lock cannot be acquired", async () => {
      const lock = await mutex.acquireLock();

      const [result, error] = await mutex.runSafe(
        async () => "never",
        { timeout: 50 }
      );

      expect(result).toBeUndefined();
      expect(error).toBeInstanceOf(Mutex.ErrorLockTimeout);

      lock.releaseLock();
    });

    test("runSafe should release lock and continue queue on error", async () => {
      const results: string[] = [];

      const p1 = mutex.runSafe(async () => {
        results.push("first");
        throw new Error("first error");
      });

      const p2 = mutex.runSafe(async () => {
        results.push("second");
        return "ok";
      });

      const [[, e1], [r2]] = await Promise.all([p1, p2]);

      expect(results).toEqual(["first", "second"]);
      expect(e1?.message).toBe("first error");
      expect(r2).toBe("ok");
      expect(mutex.lockCount).toBe(0);
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
        }).catch(() => { }),
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


    test("example usage", async () => {

      const mutex = Mutex.shared()

      const buffer = new WritableStream()

      async function fetchToSharedBuffer(url: string) {
        const data = await fetch(url, { method: 'GET' })
        const lock = await mutex.acquireLock({ timeout: 60_000 }) // acquire lock
        data.body?.pipeTo(buffer)
        lock.releaseLock() // release lock
      }

    })
  });
});