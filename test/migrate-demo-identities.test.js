import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { applyMigration, createVerifiedBackup, inspectMigration } from '../db/migrate-demo-identities.js';

const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');

function createOldIdentityFixture(path) {
  const db = new DatabaseSync(path);
  try {
    db.exec(schema);
    const users = [
      ['admin-01', 'admin01', 'admin', null], ['dosen-01', 'dosen01', 'dosen', null],
      ['dosen-02', 'dosen02', 'dosen', null], ['mhs-01', 'mhs01', 'mahasiswa', '2026001'],
      ['mhs-02', 'mhs02', 'mahasiswa', '2026002'], ['mhs-03', 'mhs03', 'mahasiswa', '2026003'],
    ];
    const addUser = db.prepare('INSERT INTO users(id,username,password_hash,role,nim) VALUES(?,?,?,?,?)');
    for (const [id, username, role, nim] of users) addUser.run(id, username, `hash-${id}`, role, nim);
    const addDevice = db.prepare('INSERT INTO devices(id,user_id) VALUES(?,?)');
    for (const pair of [['DEV-ADM-01', 'admin-01'], ['DEV-DOS-01', 'dosen-01'], ['DEV-DOS-02', 'dosen-02'], ['DEV-MHS-01', 'mhs-01'], ['DEV-MHS-02', 'mhs-02'], ['DEV-MHS-03', 'mhs-03']]) addDevice.run(...pair);
    const addClass = db.prepare('INSERT INTO classes(id,course_code,course_name,term,lecturer_id) VALUES(?,?,?,?,?)');
    addClass.run('IF-101', 'IF101', 'Keamanan Informasi', '2026-Ganjil', 'dosen-01');
    addClass.run('IF-102', 'IF102', 'Sistem Terdistribusi', '2026-Ganjil', 'dosen-02');
    const addEnrollment = db.prepare('INSERT INTO enrollments(class_id,student_id) VALUES(?,?)');
    for (const pair of [['IF-101', 'mhs-01'], ['IF-101', 'mhs-02'], ['IF-102', 'mhs-01'], ['IF-102', 'mhs-03']]) addEnrollment.run(...pair);
    const addGrade = db.prepare('INSERT INTO grades(id,class_id,student_id,grade_value) VALUES(?,?,?,?)');
    for (const row of [['grade-001', 'IF-101', 'mhs-01', '85'], ['grade-002', 'IF-101', 'mhs-02', '78'], ['grade-003', 'IF-102', 'mhs-01', '88'], ['grade-004', 'IF-102', 'mhs-03', '91']]) addGrade.run(...row);
    db.prepare('INSERT INTO refresh_tokens(token_hash,user_id,expires_at) VALUES(?,?,?)').run('fixture-token', 'mhs-01', '2030-01-01T00:00:00.000Z');
    db.prepare("INSERT INTO audit_logs(subject,method,endpoint,device_id,decision,reason) VALUES(?,?,?,?,?,?)").run('mhs-01', 'GET', '/nilai', 'DEV-MHS-01', 'allow', 'historical_fixture');
  } finally { db.close(); }
}

test('migration updates only mapped identities, preserves relationships, and is idempotent', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'zero-trust-migration-'));
  const databasePath = join(directory, 'academic.sqlite');
  const backupPath = join(directory, 'backup.sqlite');
  try {
    createOldIdentityFixture(databasePath);
    const before = inspectMigration(databasePath);
    assert.equal(before.ready, true);
    assert.equal(before.summary.toChange.users, 6);
    assert.equal(before.summary.toChange.studentDevices, 3);
    assert.equal(before.summary.toChange.classes, 1);
    assert.equal(before.summary.already.studentDevices, 0);

    const backup = await createVerifiedBackup(databasePath, backupPath);
    assert.equal(backup.integrity, 'ok');
    assert.deepEqual(backup.counts, before.counts);

    const applied = applyMigration(databasePath);
    assert.equal(applied.applied, true);
    assert.deepEqual(applied.summary.toChange, { users: 0, studentDevices: 0, classes: 0 });

    const after = inspectMigration(databasePath);
    assert.equal(after.ready, true);
    assert.deepEqual(after.summary.toChange, { users: 0, studentDevices: 0, classes: 0 });
    assert.deepEqual(after.counts, before.counts);
    assert.deepEqual(after.preserved, before.preserved);

    const repeated = applyMigration(databasePath);
    assert.equal(repeated.applied, true);
    assert.deepEqual(repeated.changed, { users: 0, studentDevices: 0, classes: 0 });
    assert.deepEqual(inspectMigration(databasePath).counts, before.counts);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
