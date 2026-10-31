import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { databasePath } from './config.js';

export function openDatabase({ create = false } = {}) {
  if (create) {
    mkdirSync(dirname(databasePath), { recursive: true });
  } else if (!existsSync(databasePath)) {
    throw new Error(`Database belum ada di ${databasePath}. Jalankan npm run seed terlebih dahulu.`);
  }

  const database = new DatabaseSync(databasePath, { timeout: 5000 });
  try {
    database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
