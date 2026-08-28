/* eslint-disable @typescript-eslint/no-var-requires */
// Minimal Mongo client for deterministic test-data staging/cleanup the GraphQL
// API can't express (insert a Stat row, hard deletes). `mongodb` is a
// devDependency of this qa package, so a plain require resolves after `npm ci`.
// Connection is env-overridable (no machine-specific paths).
const { MongoClient } = require('mongodb');

const MONGO_URL = process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017';
// Doit correspondre à MONGODB_URI de `fix-back/.env.development`
// (mongodb://localhost:27017/fixtronixproddb) : seeder une AUTRE base que celle
// que l'app lit rend chaque spec UI vert-sur-rien (la DI seedée n'existe pas
// pour le backend). Surchargeable par env pour une base jetable.
const MONGO_DB = process.env.MONGO_DB ?? 'fixtronixproddb';

export async function withDb<T>(fn: (db: any) => Promise<T>): Promise<T> {
  const client = new MongoClient(MONGO_URL);
  await client.connect();
  try {
    return await fn(client.db(MONGO_DB));
  } finally {
    await client.close();
  }
}
