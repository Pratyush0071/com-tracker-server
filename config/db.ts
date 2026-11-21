import mongoose from 'mongoose';
import type { ClientSession } from 'mongoose';
import type { MongoMemoryReplSet as MongoMemoryReplSetType } from 'mongodb-memory-server';
import { env } from './env.ts';

let memoryReplSet: MongoMemoryReplSetType | null = null;
let transactionsSupported = true;

export async function connectDatabase(): Promise<void> {
  if (mongoose.connection.readyState === 1) {
    return;
  }

  let uri = env.mongoUri.trim();

  if (!uri) {
    const mmsModule = await import('mongodb-memory-server');
    const MongoMemoryReplSet =
      mmsModule.MongoMemoryReplSet ||
      (mmsModule as unknown as { default: typeof mmsModule }).default?.MongoMemoryReplSet;
    memoryReplSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
    uri = memoryReplSet.getUri();
    transactionsSupported = true;
    console.log('[DB] Connected to local MongoMemoryReplSet (ACID transactions enabled)');
  } else {
    console.log('[DB] Connecting to configured MONGODB_URI...');
  }

  await mongoose.connect(uri, {
    autoIndex: true,
  });

  if (env.mongoUri.trim()) {
    try {
      const admin = mongoose.connection.db?.admin();
      const status = await admin?.command({ isMaster: 1 });
      transactionsSupported = Boolean(status?.setName || status?.msg === 'isdbgrid');
    } catch {
      transactionsSupported = false;
    }
  }
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
  if (memoryReplSet) {
    await memoryReplSet.stop();
    memoryReplSet = null;
  }
}

export async function runInTransaction<T>(
  work: (session: ClientSession | null) => Promise<T>
): Promise<T> {
  if (!transactionsSupported) {
    return work(null);
  }

  const session = await mongoose.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : '';
    if (
      message.includes('Transaction numbers are only allowed on a replica set member') ||
      message.includes('does not support retryable writes')
    ) {
      transactionsSupported = false;
      return work(null);
    }
    throw err;
  } finally {
    await session.endSession();
  }
}
