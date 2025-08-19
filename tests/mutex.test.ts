
import { test, expect, describe, beforeEach } from "bun:test";
import { Mutex } from "../index"; // Adjust import path as needed


function sleep(time: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(() => resolve(), time)
  })
}

function sleepRand(time: number = 100) {
  return sleep(Math.random() * time)
}


describe('Mutex', () => {
  test("should be able to create a new mutex lock", async () => {
    const mutex = new Mutex()
    const lock = await mutex.acquireLock()
    expect(mutex.lockCount).toBe(1)
    lock.releaseLock()
    expect(lock.isUnlocked).toBe(true)
    expect(mutex.lockCount).toBe(0)
  })

  test("Should be able to acquire mutex lock multiple times", async () => {
    const mutex = Mutex.shared()
    let buffer = ''
    async function writeToString(char: string) {
      const lock = await mutex.acquireLock()
      await sleep(Math.random() * 100)
      buffer += char
      lock.releaseLock()
    }
    await Promise.all([
      writeToString('a'),
      writeToString('b'),
      writeToString('c'),
      writeToString('d')
    ])
    expect(buffer).toEqual('abcd')
    expect(mutex.lockCount).toEqual(0)
  })


  test('should be able to use with mutex.wrap(fn)', async () => {
    const mutex = Mutex.shared()
    let buffer = ""
    const writeToBuffer = mutex.wrap(async (char: string) => {
      await sleepRand()
      buffer += char
    })
    writeToBuffer('a')
    writeToBuffer('b')
    writeToBuffer('c')
    writeToBuffer('d')
    await mutex.finished()
    expect(buffer).toBe('abcd')
    expect(mutex.lockCount).toBe(0)
  })

  test('should be able to continue if a single operation fails', async () => {
    const mutex = Mutex.shared()
    let buffer = ""
    const writeToBuffer = mutex.wrap(async (char: string) => {
      await sleepRand()
      if (char === 'c') throw new Error('Invalid char C')
      buffer += char
    })
    writeToBuffer('a')
    writeToBuffer('b')
    writeToBuffer('c').catch(() => {})
    writeToBuffer('d')
    await mutex.finished()
    expect(buffer).toBe('abd')
    expect(mutex.lockCount).toBe(0)
  })

  test('should be able to destroy mutex and pending locks', async () => {
    const mutex = Mutex.shared()
    const buffer: number[] = []

    const writeToBuffer = mutex.wrap(async (item: number) => {
      await sleep(1000)
      buffer.push(item)
    })

    try {
      writeToBuffer(1).catch(() => {})
      writeToBuffer(2).catch(() => {})
      writeToBuffer(3).catch(() => {})
      writeToBuffer(4).catch(() => {})
      mutex.destroy()

    } finally {
      expect(buffer.length).toBe(0)
      expect(mutex.lockCount).toBe(0)
      expect(mutex.isDestroyed).toBe(true)
    }
  })
})