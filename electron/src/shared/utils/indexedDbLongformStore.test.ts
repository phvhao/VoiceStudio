import { describe, expect, it, vi } from 'vitest';

import { createIndexedDbLongformStore } from './indexedDbLongformStore';

function createReadableDatabase(value: unknown = undefined): IDBDatabase {
  const database = {
    close: vi.fn(),
    objectStoreNames: { contains: () => true },
    transaction: vi.fn(() => {
      const transaction: Record<string, unknown> = {
        error: null,
        objectStore: () => ({
          get: () => {
            const request: Record<string, unknown> = { error: null, result: value };
            queueMicrotask(() => {
              (request.onsuccess as (() => void) | undefined)?.();
              (transaction.oncomplete as (() => void) | undefined)?.();
            });
            return request;
          },
        }),
      };
      return transaction;
    }),
  };
  return database as unknown as IDBDatabase;
}

function createReadableFactory(...databases: IDBDatabase[]): IDBFactory {
  let databaseIndex = 0;
  return {
    open: vi.fn(() => {
      const database = databases[databaseIndex++] ?? createReadableDatabase();
      const request: Record<string, unknown> = { error: null, result: database };
      queueMicrotask(() => (request.onsuccess as (() => void) | undefined)?.());
      return request;
    }),
  } as unknown as IDBFactory;
}

describe('IndexedDB long-form store', () => {
  it('reopens after the factory throws synchronously', async () => {
    const factory = createReadableFactory(createReadableDatabase());
    const getFactory = vi
      .fn<() => IDBFactory>()
      .mockImplementationOnce(() => {
        throw new DOMException('content intentionally omitted', 'UnknownError');
      })
      .mockReturnValue(factory);
    const store = createIndexedDbLongformStore(getFactory);

    await expect(store.read()).rejects.toMatchObject({ name: 'UnknownError' });
    await expect(store.read()).resolves.toBeNull();
    expect(getFactory).toHaveBeenCalledTimes(2);
  });

  it('reopens after the cached connection closes unexpectedly', async () => {
    const firstDatabase = createReadableDatabase();
    const secondDatabase = createReadableDatabase();
    const factory = createReadableFactory(firstDatabase, secondDatabase);
    const store = createIndexedDbLongformStore(() => factory);

    await expect(store.read()).resolves.toBeNull();
    firstDatabase.onclose?.(new Event('close'));
    await expect(store.read()).resolves.toBeNull();

    expect(factory.open).toHaveBeenCalledTimes(2);
  });

  it('invalidates a dead connection after transaction InvalidStateError', async () => {
    const deadDatabase = createReadableDatabase();
    vi.mocked(deadDatabase.transaction).mockImplementation(() => {
      throw new DOMException('content intentionally omitted', 'InvalidStateError');
    });
    const healthyDatabase = createReadableDatabase();
    const factory = createReadableFactory(deadDatabase, healthyDatabase);
    const store = createIndexedDbLongformStore(() => factory);

    await expect(store.read()).rejects.toMatchObject({ name: 'InvalidStateError' });
    await expect(store.read()).resolves.toBeNull();

    expect(deadDatabase.close).toHaveBeenCalledOnce();
    expect(factory.open).toHaveBeenCalledTimes(2);
  });

  it('rejects a present record with an unsupported schema', async () => {
    const malformed = {
      schema: 999,
      revision: 4,
      payload: { script: 'only durable copy' },
    };
    const factory = createReadableFactory(createReadableDatabase(malformed));
    const store = createIndexedDbLongformStore(() => factory);

    await expect(store.read()).rejects.toMatchObject({ name: 'DataError' });
  });

  it('keeps records under keys of their own, written all at once', async () => {
    // One object store in memory; a readwrite transaction applies its
    // operations only when it completes, as IndexedDB commits.
    const records = new Map<string, unknown>([
      ['meta:a', { id: 'a' }],
      ['meta:b', { id: 'b' }],
      ['other', 1],
    ]);
    const transactions: string[][] = [];
    const database = {
      close: vi.fn(),
      objectStoreNames: { contains: () => true },
      transaction: vi.fn(() => {
        const ops: (() => void)[] = [];
        const names: string[] = [];
        transactions.push(names);
        const transaction: Record<string, unknown> = { error: null };
        const request = (result: () => unknown) => {
          const value: Record<string, unknown> = { error: null };
          queueMicrotask(() => {
            value.result = result();
            (value.onsuccess as (() => void) | undefined)?.();
          });
          return value;
        };
        const inRange = (range: { lower: string; upper: string }) =>
          [...records.keys()].filter((key) => key >= range.lower && key <= range.upper).sort();
        transaction.objectStore = () => ({
          get: (key: string) => request(() => records.get(key)),
          getAllKeys: (range: { lower: string; upper: string }) => request(() => inRange(range)),
          getAll: (range: { lower: string; upper: string }) =>
            request(() => inRange(range).map((key) => records.get(key))),
          put: (value: unknown, key: string) => {
            names.push('put ' + key);
            ops.push(() => records.set(key, value));
          },
          delete: (key: string) => {
            names.push('delete ' + key);
            ops.push(() => records.delete(key));
          },
          clear: () => ops.push(() => records.clear()),
        });
        setTimeout(() => {
          ops.forEach((op) => op());
          (transaction.oncomplete as (() => void) | undefined)?.();
        });
        return transaction;
      }),
    } as unknown as IDBDatabase;
    vi.stubGlobal('IDBKeyRange', {
      bound: (lower: string, upper: string) => ({ lower, upper }),
    });
    try {
      const store = createIndexedDbLongformStore(() => createReadableFactory(database));
      expect(await store.entries('meta:')).toEqual([
        ['meta:a', { id: 'a' }],
        ['meta:b', { id: 'b' }],
      ]);
      await store.commit({ put: [['meta:c', { id: 'c' }]], remove: ['meta:a'] });
      expect(transactions.at(-1)).toEqual(['delete meta:a', 'put meta:c']);
      expect(await store.get('meta:c')).toEqual({ id: 'c' });
      expect((await store.entries('meta:')).map(([key]) => key)).toEqual(['meta:b', 'meta:c']);
      await store.clearAll();
      expect(records.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
