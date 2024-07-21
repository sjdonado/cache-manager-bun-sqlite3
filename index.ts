import { Database } from 'bun:sqlite';
import { decode, encode } from 'cbor-x';
import type { Store, Config } from 'cache-manager';

const configurePragmas = `
PRAGMA main.synchronous = NORMAL;
PRAGMA main.journal_mode = WAL2;
PRAGMA main.auto_vacuum = INCREMENTAL;
`;

const createTableStm = `
CREATE TABLE IF NOT EXISTS {table} (
    key TEXT PRIMARY KEY, 
    val BLOB, 
    created_at INTEGER, 
    expire_at INTEGER
);
CREATE INDEX IF NOT EXISTS index_expire_{table} ON {table}(expire_at);
`;

interface CacheRow {
  key: string;
  val: string & (Uint8Array | Buffer);
  created_at: number;
  expire_at: number;
}

const serializers = {
  json: {
    serialize: JSON.stringify,
    deserialize: JSON.parse,
  },
  cbor: {
    serialize: encode,
    deserialize: decode,
  },
};

type SqliteCacheOptions = Config & {
  name?: string;
  path?: string;
  serializer?: 'json' | 'cbor';
  ttl?: number;
};

export interface SqliteStore extends Store {
  name: string;
  isCacheable: (value: unknown) => boolean;
  get client(): Database;
}

export class NoCacheableError implements Error {
  name = 'NoCacheableError';
  constructor(public message: string) { }
}

export default async function createSqliteStore({
  name = 'cache',
  path = ':memory:',
  serializer = 'cbor',
  ttl = 24 * 60 * 60,
  ...options
}: SqliteCacheOptions = {}): Promise<SqliteStore> {
  // Added default value for destructuring
  const db = new Database(path);
  const serializerAdapter = serializers[serializer];
  const defaultTtl = ttl * 1000;

  try {
    db.exec(configurePragmas);
    const stmt = createTableStm.replace(/{table}/g, name);
    db.exec(stmt);
  } catch (err) {
    throw new Error(`Failed to initialize SQLite store: ${err}`);
  }

  const isCacheable =
    options?.isCacheable || (value => value !== undefined && value !== null);

  const get = async <T>(key: string): Promise<T | undefined> => {
    const statement = db.prepare(`SELECT * FROM ${name} WHERE key = ?`);

    const rows = statement.all(key) as CacheRow[];
    if (rows.length > 0 && rows[0].expire_at > Date.now()) {
      return serializerAdapter.deserialize(rows[0].val) as T;
    }
  };

  const set = async (key: string, value: unknown, options?: { ttl?: number }) => {
    if (!isCacheable(value)) {
      throw new NoCacheableError(`"${value}" is not a cacheable value`);
    }

    const ttlValue = options?.ttl || defaultTtl;
    const expireAt = Date.now() + ttlValue;
    const serializedVal = serializerAdapter.serialize(value);

    const statement = db.prepare(
      `INSERT OR REPLACE INTO ${name}(key, val, created_at, expire_at) VALUES (?, ?, ?, ?)`
    );
    statement.run(key, serializedVal, Date.now(), expireAt);
  };

  const mset = async (pairs: [string, unknown][], options?: { ttl?: number }) => {
    const ttlValue = options?.ttl || defaultTtl;
    const expireAt = Date.now() + ttlValue;

    const stmt = `INSERT OR REPLACE INTO ${name}(key, val, created_at, expire_at) VALUES ${pairs.map(() => '(?, ?, ?, ?)').join(', ')}`;
    const bindings = pairs.flatMap(([key, value]) => {
      if (!isCacheable(value)) {
        throw new NoCacheableError(`"${value}" is not a cacheable value`);
      }
      return [key, serializerAdapter.serialize(value), Date.now(), expireAt];
    });

    const statement = db.prepare(stmt);
    statement.run(...bindings);
  };

  const mget = async <T>(...keys: string[]): Promise<(T | undefined)[]> => {
    const placeholders = keys.map(() => '?').join(', ');
    const statement = db.prepare(`SELECT * FROM ${name} WHERE key IN (${placeholders})`);
    const rows = statement.all(...keys) as CacheRow[];

    return keys.map(key => {
      const row = rows.find(r => r.key === key);
      return row && row.expire_at > Date.now()
        ? (serializerAdapter.deserialize(row.val) as T)
        : undefined;
    });
  };

  const del = async (key: string) => {
    const statement = db.prepare(`DELETE FROM ${name} WHERE key = ?`);
    statement.run(key);
  };

  const mdel = async (...keys: string[]) => {
    const placeholders = keys.map(() => '?').join(', ');
    const statement = db.prepare(`DELETE FROM ${name} WHERE key IN (${placeholders})`);
    statement.run(...keys);
  };

  const keys = async (): Promise<string[]> => {
    const statement = db.prepare(`SELECT key FROM ${name}`);
    const rows = statement.all() as CacheRow[];
    return rows.map(row => row.key);
  };

  const reset = async () => {
    const statement = db.prepare(`DELETE FROM ${name}`);
    statement.run();
  };

  const ttlFn = async (key: string): Promise<number> => {
    const statement = db.prepare(`SELECT expire_at FROM ${name} WHERE key = ?`);
    const rows = statement.all(key) as CacheRow[];
    if (rows.length > 0) {
      return rows[0].expire_at - Date.now();
    }
    return -1;
  };

  const purgeExpired = async () => {
    const statement = db.prepare(`DELETE FROM ${name} WHERE expire_at < ?`);
    statement.run(Date.now());
  };

  setInterval(purgeExpired, 60 * 60 * 1000); // Every hour

  return {
    name,
    get,
    set,
    mset,
    mget,
    del,
    mdel,
    keys,
    reset,
    ttl: ttlFn,
    isCacheable,
    get client() {
      return db;
    },
  } as SqliteStore;
}
