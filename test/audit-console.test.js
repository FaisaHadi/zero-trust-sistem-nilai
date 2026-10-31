import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createAuditRecorder } from '../shared/audit-writer.js';
import { printAudit } from '../shared/audit-console.js';
import { createAuthRouter } from '../apps/gateway/src/auth.js';
import { readFileSync } from 'node:fs';
import bcrypt from 'bcryptjs';

test('audit output follows commit, rollback and insertion failures', () => {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE audit_logs (id INTEGER PRIMARY KEY, recorded_at TEXT DEFAULT CURRENT_TIMESTAMP, subject TEXT, method TEXT, endpoint TEXT, device_id TEXT, decision TEXT CHECK(decision IN ('allow','deny')), reason TEXT)");
  const insert = db.prepare('INSERT INTO audit_logs (subject, method, endpoint, device_id, decision, reason) VALUES (?, ?, ?, ?, ?, ?)');
  const lines = [];
  const original = console.log;
  console.log = line => lines.push(line);
  try {
    const write = createAuditRecorder(db, insert, 'GATEWAY');
    write(['user\n\u001b[31m', 'GET', '/nilai', null, 'allow', 'policy_allowed'], false);
    assert.equal(lines.length, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM audit_logs').get().n, 1);
    assert.equal(lines[0].split('\n').length, 1);
    assert.ok(!lines[0].includes('\u001b'));
    assert.ok(!lines[0].includes('password-fixture'));
    const entry = JSON.parse(lines[0].slice('[AUDIT] '.length));
    assert.equal(entry.waktu, db.prepare('SELECT recorded_at FROM audit_logs').get().recorded_at + ' UTC');
    db.exec('BEGIN');
    const afterCommit = write(['x', 'POST', '/auth/login', null, 'allow', 'login_success'], true);
    assert.equal(lines.length, 1);
    db.exec('COMMIT'); afterCommit();
    assert.equal(lines.length, 2);
    db.exec('BEGIN');
    write(['x', 'POST', '/auth/logout', null, 'allow', 'logout_success'], true);
    db.exec('ROLLBACK');
    assert.equal(lines.length, 2);
    assert.throws(() => write(['x', 'GET', '/nilai', null, 'invalid', 'bad'], false));
    assert.equal(lines.length, 2);
    console.log = () => { throw new Error('output failed'); };
    db.exec('BEGIN');
    const afterFailure = write(['x', 'POST', '/auth/login', null, 'allow', 'login_success'], true);
    db.exec('COMMIT');
    assert.doesNotThrow(afterFailure);
    assert.equal(db.prepare('SELECT count(*) AS n FROM audit_logs').get().n, 3);
  } finally { console.log = original; db.close(); }
});

test('actual login and logout handlers emit only committed audit rows', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  const password = 'temporary-password-fixture';
  db.prepare('INSERT INTO users(id,username,password_hash,role) VALUES (?,?,?,?)').run('user', 'demo', bcrypt.hashSync(password, 4), 'dosen');
  db.prepare('INSERT INTO devices(id,user_id) VALUES (?,?)').run('device', 'user');
  let failCommit = false;
  const database = {
    prepare: sql => db.prepare(sql),
    exec: sql => {
      if (sql === 'COMMIT' && failCommit) { failCommit = false; throw new Error('commit fixture'); }
      return db.exec(sql);
    },
  };
  const router = createAuthRouter({ database, jwtSecret: 'x'.repeat(40), serviceClientId: 'fixture', serviceClientSecret: 'y'.repeat(40) });
  const handler = name => router.stack.find(layer => layer.route?.path === name).route.stack[0].handle;
  const response = () => ({ statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; }, end() { return this; } });
  const login = () => handler('/login')({ body: { username: 'demo', password }, get: () => 'device' }, response());
  const lines = [];
  const oldLog = console.log;
  const oldError = console.error;
  console.log = line => lines.push(line);
  console.error = () => {};
  try {
    failCommit = true;
    assert.throws(login, /commit fixture/);
    assert.equal(lines.length, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM audit_logs').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM refresh_tokens').get().n, 0);
    const res = login();
    assert.equal(res.statusCode, 200);
    assert.equal(lines.length, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM audit_logs').get().n, 1);
    assert.ok(!lines[0].includes(password));
    assert.ok(!lines[0].includes(res.body.accessToken));
    assert.ok(!lines[0].includes(res.body.refreshToken));
    console.log = () => { throw new Error('display fixture'); };
    const logoutRes = response();
    handler('/logout')({ body: { refreshToken: res.body.refreshToken } }, logoutRes);
    assert.equal(logoutRes.statusCode, 204);
    assert.equal(db.prepare('SELECT count(*) AS n FROM audit_logs').get().n, 2);
    assert.equal(db.prepare('SELECT count(*) AS n FROM refresh_tokens WHERE revoked_at IS NOT NULL').get().n, 1);
  } finally { console.log = oldLog; console.error = oldError; db.close(); }
});

test('terminal output uses an allowlist and escapes control characters', () => {
  const lines = [];
  const original = console.log;
  console.log = value => lines.push(value);
  try {
    printAudit('NILAI', { recorded_at: '2026-01-01 00:00:00', subject: 'user\n\u001b[31m', method: 'GET', endpoint: '/nilai', device_id: null, decision: 'deny', reason: 'x'.repeat(400), password: 'password-fixture', token: 'token-fixture', body: 'data-fixture' });
    assert.equal(lines.length, 1);
    assert.equal(lines[0].split('\n').length, 1);
    assert.ok(!lines[0].includes('\u001b'));
    for (const secret of ['password-fixture', 'token-fixture', 'data-fixture']) assert.ok(!lines[0].includes(secret));
    const data = JSON.parse(lines[0].slice('[AUDIT] '.length));
    assert.equal(data.alasan.length, 256);
    assert.equal(data.waktu, '2026-01-01 00:00:00 UTC');
  } finally { console.log = original; }
});
