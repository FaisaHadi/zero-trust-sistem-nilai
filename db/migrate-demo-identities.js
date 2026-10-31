import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, backup } from 'node:sqlite';
import { databasePath as configuredDatabasePath } from '../shared/config.js';

const USER_MAPPINGS = Object.freeze([
  { id: 'admin-01', role: 'admin', oldUsername: 'admin01', username: 'admin', oldNim: null, nim: null, oldDevice: 'DEV-ADM-01', device: 'DEV-ADM-01' },
  { id: 'dosen-01', role: 'dosen', oldUsername: 'dosen01', username: 'dosenki', oldNim: null, nim: null, oldDevice: 'DEV-DOS-01', device: 'DEV-DOS-01' },
  { id: 'dosen-02', role: 'dosen', oldUsername: 'dosen02', username: 'dosenkpt', oldNim: null, nim: null, oldDevice: 'DEV-DOS-02', device: 'DEV-DOS-02' },
  { id: 'mhs-01', role: 'mahasiswa', oldUsername: 'mhs01', username: 'faisal', oldNim: '2026001', nim: '2024051', oldDevice: 'DEV-MHS-01', device: 'DEV-MHS-051' },
  { id: 'mhs-02', role: 'mahasiswa', oldUsername: 'mhs02', username: 'hadi', oldNim: '2026002', nim: '2024052', oldDevice: 'DEV-MHS-02', device: 'DEV-MHS-052' },
  { id: 'mhs-03', role: 'mahasiswa', oldUsername: 'mhs03', username: 'saik', oldNim: '2026003', nim: '2024053', oldDevice: 'DEV-MHS-03', device: 'DEV-MHS-053' },
]);

const CLASS_MAPPINGS = Object.freeze([
  { id: 'IF-101', oldName: 'Keamanan Informasi', name: 'Keamanan Informasi', lecturerId: 'dosen-01' },
  { id: 'IF-102', oldName: 'Sistem Terdistribusi', name: 'Komputasi Paralel', lecturerId: 'dosen-02' },
]);

const TABLES = Object.freeze([
  ['users', 'id'], ['devices', 'id'], ['classes', 'id'], ['enrollments', 'class_id, student_id'],
  ['grades', 'id'], ['transcript_entries', 'class_id, student_id'], ['refresh_tokens', 'token_hash'], ['audit_logs', 'id'],
]);

function assertExistingDatabase(path) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`Target database tidak ditemukan atau bukan berkas: ${path}`);
  }
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function collectCounts(database) {
  return Object.fromEntries(TABLES.map(([table]) => [table, database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total]));
}

function databaseDigest(database) {
  const snapshot = Object.fromEntries(TABLES.map(([table, order]) => [table, database.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all()]));
  return hash(snapshot);
}

function preservedDigest(database) {
  const protectedData = {
    userSecurityState: database.prepare('SELECT id, password_hash, role, active FROM users ORDER BY id').all(),
    classState: database.prepare('SELECT id, course_code, term, lecturer_id, is_finalized, finalized_at FROM classes ORDER BY id').all(),
    enrollments: database.prepare('SELECT class_id, student_id FROM enrollments ORDER BY class_id, student_id').all(),
    grades: database.prepare('SELECT id, class_id, student_id, grade_value, updated_at FROM grades ORDER BY id').all(),
    transcripts: database.prepare('SELECT class_id, student_id, grade_value, synced_at FROM transcript_entries ORDER BY class_id, student_id').all(),
    refreshTokens: database.prepare('SELECT token_hash, user_id, expires_at, revoked_at FROM refresh_tokens ORDER BY token_hash').all(),
    auditLogs: database.prepare('SELECT id, recorded_at, subject, method, endpoint, device_id, decision, reason FROM audit_logs ORDER BY id').all(),
  };
  return hash(protectedData);
}

function assertHealthy(database) {
  if (database.prepare('PRAGMA foreign_keys').get().foreign_keys !== 1) {
    throw new Error('Foreign key SQLite tidak aktif pada koneksi migrasi.');
  }
  const integrity = database.prepare('PRAGMA integrity_check').get().integrity_check;
  if (integrity !== 'ok') throw new Error(`Pemeriksaan integritas SQLite gagal: ${integrity}`);
  const foreignKeyViolations = database.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeyViolations.length > 0) throw new Error('Pemeriksaan foreign key SQLite menemukan pelanggaran.');
}

function sameOrExpected(value, oldValue, targetValue) {
  return value === oldValue || value === targetValue;
}

function validateAndPlan(database) {
  assertHealthy(database);
  const findUser = database.prepare('SELECT id, username, role, nim, active FROM users WHERE id = ?');
  const devicesForUser = database.prepare('SELECT id, user_id, active FROM devices WHERE user_id = ? ORDER BY id');
  const findUsernameOwner = database.prepare('SELECT id FROM users WHERE username = ?');
  const findNimOwner = database.prepare('SELECT id FROM users WHERE nim = ?');
  const findDeviceOwner = database.prepare('SELECT user_id FROM devices WHERE id = ?');
  const findClass = database.prepare('SELECT id, course_code, course_name, term, lecturer_id, is_finalized, finalized_at FROM classes WHERE id = ?');

  const changes = { users: [], studentDevices: [], classes: [] };
  const already = { users: 0, studentDevices: 0, classes: 0 };

  for (const mapping of USER_MAPPINGS) {
    const row = findUser.get(mapping.id);
    if (!row) throw new Error(`Akun seed tidak ditemukan: ${mapping.id}`);
    if (row.role !== mapping.role) throw new Error(`Role akun tidak sesuai untuk ${mapping.id}.`);
    if (!sameOrExpected(row.username, mapping.oldUsername, mapping.username)) {
      throw new Error(`Username sumber tidak dikenali untuk ${mapping.id}.`);
    }
    if (!sameOrExpected(row.nim, mapping.oldNim, mapping.nim)) {
      throw new Error(`NIM sumber tidak dikenali untuk ${mapping.id}.`);
    }

    const usernameOwner = findUsernameOwner.get(mapping.username);
    if (usernameOwner && usernameOwner.id !== mapping.id) {
      throw new Error(`Username target sudah digunakan akun lain: ${mapping.username}`);
    }
    if (mapping.nim !== null) {
      const nimOwner = findNimOwner.get(mapping.nim);
      if (nimOwner && nimOwner.id !== mapping.id) throw new Error(`NIM target sudah digunakan akun lain: ${mapping.nim}`);
    }

    if (row.username !== mapping.username || row.nim !== mapping.nim) changes.users.push(mapping);
    else already.users += 1;

    const devices = devicesForUser.all(mapping.id);
    if (devices.length !== 1 || devices[0].user_id !== mapping.id) {
      throw new Error(`Perangkat terdaftar untuk ${mapping.id} ambigu; migrasi dibatalkan.`);
    }
    const device = devices[0];
    if (!sameOrExpected(device.id, mapping.oldDevice, mapping.device)) {
      throw new Error(`Device ID sumber tidak dikenali untuk ${mapping.id}.`);
    }
    const targetDeviceOwner = findDeviceOwner.get(mapping.device);
    if (targetDeviceOwner && targetDeviceOwner.user_id !== mapping.id) {
      throw new Error(`Device ID target sudah digunakan akun lain: ${mapping.device}`);
    }

    if (device.id !== mapping.device) {
      if (mapping.role !== 'mahasiswa') throw new Error(`Device dosen/admin tidak sesuai untuk ${mapping.id}.`);
      changes.studentDevices.push(mapping);
    } else if (mapping.role === 'mahasiswa') already.studentDevices += 1;
  }

  for (const mapping of CLASS_MAPPINGS) {
    const row = findClass.get(mapping.id);
    if (!row) throw new Error(`Kelas seed tidak ditemukan: ${mapping.id}`);
    if (row.lecturer_id !== mapping.lecturerId) throw new Error(`Pengampu kelas tidak sesuai untuk ${mapping.id}.`);
    if (!sameOrExpected(row.course_name, mapping.oldName, mapping.name)) {
      throw new Error(`Nama kelas sumber tidak dikenali untuk ${mapping.id}.`);
    }
    if (row.course_name !== mapping.name) changes.classes.push(mapping);
    else already.classes += 1;
  }

  return {
    ready: true,
    counts: collectCounts(database),
    preserved: preservedDigest(database),
    summary: {
      toChange: Object.fromEntries(Object.entries(changes).map(([key, value]) => [key, value.length])),
      already,
    },
    mapping: {
      users: USER_MAPPINGS.map(({ id, role, username, nim, device }) => ({ id, role, username, nim, device })),
      classes: CLASS_MAPPINGS.map(({ id, name, lecturerId }) => ({ id, courseName: name, lecturerId })),
    },
    changes,
  };
}

function openDatabase(path, readOnly = false) {
  assertExistingDatabase(path);
  const database = new DatabaseSync(path, { readOnly, timeout: 5000 });
  try {
    database.exec('PRAGMA foreign_keys = ON;');
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function inspectMigration(targetPath = configuredDatabasePath) {
  const path = resolve(targetPath);
  const database = openDatabase(path, true);
  try {
    return { databasePath: path, ...validateAndPlan(database) };
  } finally {
    database.close();
  }
}

export async function createVerifiedBackup(sourcePath, destinationPath) {
  const source = resolve(sourcePath);
  const destination = resolve(destinationPath);
  assertExistingDatabase(source);
  if (source === destination) throw new Error('Path backup tidak boleh sama dengan database sumber.');
  if (existsSync(destination)) throw new Error(`Backup sudah ada dan tidak akan ditimpa: ${destination}`);

  mkdirSync(dirname(destination), { recursive: true });
  const sourceDatabase = openDatabase(source, true);
  try {
    const sourceCounts = collectCounts(sourceDatabase);
    const sourceDigest = databaseDigest(sourceDatabase);
    await backup(sourceDatabase, destination);

    const backupDatabase = openDatabase(destination, true);
    try {
      assertHealthy(backupDatabase);
      const backupCounts = collectCounts(backupDatabase);
      if (JSON.stringify(backupCounts) !== JSON.stringify(sourceCounts) || databaseDigest(backupDatabase) !== sourceDigest) {
        throw new Error('Backup SQLite tidak cocok dengan sumber pada saat backup dibuat.');
      }
      return { sourcePath: source, backupPath: destination, counts: backupCounts, integrity: 'ok', foreignKeyViolations: 0 };
    } finally {
      backupDatabase.close();
    }
  } finally {
    sourceDatabase.close();
  }
}

export function applyMigration(targetPath = configuredDatabasePath) {
  const path = resolve(targetPath);
  const database = openDatabase(path);
  let transactionStarted = false;
  try {
    database.exec('BEGIN IMMEDIATE');
    transactionStarted = true;
    const before = validateAndPlan(database);

    const updateUser = database.prepare('UPDATE users SET username = ?, nim = ? WHERE id = ?');
    for (const mapping of before.changes.users) updateUser.run(mapping.username, mapping.nim, mapping.id);

    const updateDevice = database.prepare('UPDATE devices SET id = ? WHERE id = ? AND user_id = ?');
    for (const mapping of before.changes.studentDevices) updateDevice.run(mapping.device, mapping.oldDevice, mapping.id);

    const updateClass = database.prepare('UPDATE classes SET course_name = ? WHERE id = ?');
    for (const mapping of before.changes.classes) updateClass.run(mapping.name, mapping.id);

    const after = validateAndPlan(database);
    if (JSON.stringify(before.counts) !== JSON.stringify(after.counts)) {
      throw new Error('Jumlah baris berubah; migrasi dibatalkan.');
    }
    if (before.preserved !== after.preserved) {
      throw new Error('Data bisnis atau keamanan yang harus dipertahankan berubah; migrasi dibatalkan.');
    }
    if (Object.values(after.summary.toChange).some((count) => count !== 0)) {
      throw new Error('Validasi hasil migrasi tidak mencapai identitas target.');
    }

    database.exec('COMMIT');
    transactionStarted = false;
    return {
      databasePath: path,
      applied: true,
      changed: before.summary.toChange,
      summary: after.summary,
      counts: after.counts,
      preserved: after.preserved,
      mapping: after.mapping,
    };
  } catch (error) {
    if (transactionStarted) {
      try { database.exec('ROLLBACK'); } catch { /* Preserve the original migration error. */ }
    }
    throw error;
  } finally {
    database.close();
  }
}

function parseArguments(argumentsList) {
  const options = { databasePath: configuredDatabasePath, apply: false, backupPath: null };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === '--apply') options.apply = true;
    else if (argument === '--check') options.apply = false;
    else if (argument === '--database' || argument === '--backup') {
      const value = argumentsList[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`Nilai diperlukan setelah ${argument}.`);
      if (argument === '--database') options.databasePath = resolve(value);
      else options.backupPath = resolve(value);
      index += 1;
    } else {
      throw new Error(`Argumen tidak dikenal: ${argument}`);
    }
  }
  return options;
}

async function runCli() {
  const options = parseArguments(process.argv.slice(2));
  let backupResult;
  if (options.backupPath) backupResult = await createVerifiedBackup(options.databasePath, options.backupPath);
  const result = options.apply ? applyMigration(options.databasePath) : inspectMigration(options.databasePath);
  console.log(JSON.stringify({ mode: options.apply ? 'apply' : 'check', backup: backupResult ?? null, result }, null, 2));
}

const invokedPath = process.argv[1] && resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    console.error(`Migrasi tidak dijalankan: ${error.message}`);
    process.exitCode = 1;
  });
}
