/**
 * Local type shim for @enjoys/store.
 *
 * The package is `"type": "module"` but its shipped .d.ts re-exports without
 * file extensions, which NodeNext cannot resolve. Declaring the surface we use
 * here avoids weakening moduleResolution for the whole project.
 */
declare module "@enjoys/store" {
  export interface IList<T = unknown> {
    push(...values: T[]): Promise<number>;
    range(start: number, stop: number): Promise<T[]>;
  }

  export interface ICache<T = unknown> {
    get(key: string): Promise<T | null>;
    set(key: string, value: T, ttlMs?: number): Promise<void>;
    del(key: string): Promise<void>;
    has?(key: string): Promise<boolean>;
    peek?(key: string): Promise<T | null>;
    clear?(): Promise<void>;
    size?(): Promise<number>;
  }

  export interface IKVStore<T = unknown> {
    get(key: string): Promise<T | null>;
    set(key: string, value: T): Promise<void>;
    del(key: string): Promise<void>;
  }

  export type StoreMode = "embedded" | "worker-thread" | "server";

  export interface StoreConfig {
    mode: StoreMode;
    dbPath?: string;
    rocksdbOptions?: Record<string, any>;
  }

  export class Store {
    close(): Promise<void>;
    kv<T = unknown>(namespace?: string): IKVStore<T>;
    cache<T = unknown>(namespace?: string): ICache<T>;
  }

  export function createStore(config?: Partial<StoreConfig>): Store;
}
