import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { databasePath } from '../shared/config.js';
import { openDatabase } from '../shared/db.js';

const schemaPath = fileURLToPath(new URL('./schema.sql', import.meta.url));
const demoPassword = process.env.SEED_DEMO_PASSWORD ?? 'Demo@2026!';

const database = openDatabase({ create: true });

try {
  database.exec(readFileSync(schemaPath, 'utf8'));

  const users = [
    ['admin-01', 'admin', 'admin', null],
    ['dosen-01', 'dosenki', 'dosen', null],
    ['dosen-02', 'dosenkpt', 'dosen', null],
    ['mhs-01', 'faisal', 'mahasiswa', '2024051'],
    ['mhs-02', 'hadi', 'mahasiswa', '2024052'],
    ['mhs-03', 'saik', 'mahasiswa', '2024053'],
  ];
  const devices = [
    ['DEV-ADM-01', 'admin-01'],
    ['DEV-DOS-01', 'dosen-01'],
    ['DEV-DOS-02', 'dosen-02'],
    ['DEV-MHS-051', 'mhs-01'],
    ['DEV-MHS-052', 'mhs-02'],
    ['DEV-MHS-053', 'mhs-03'],
  ];
  const classes = [
    ['IF-101', 'IF101', 'Keamanan Informasi', '2026-Ganjil', 'dosen-01'],
    ['IF-102', 'IF102', 'Komputasi Paralel', '2026-Ganjil', 'dosen-02'],
  ];
  const enrollments = [
    ['IF-101', 'mhs-01'],
    ['IF-101', 'mhs-02'],
    ['IF-102', 'mhs-01'],
    ['IF-102', 'mhs-03'],
  ];
  const grades = [
    ['grade-001', 'IF-101', 'mhs-01', '85'],
    ['grade-002', 'IF-101', 'mhs-02', '78'],
    ['grade-003', 'IF-102', 'mhs-01', '88'],
    ['grade-004', 'IF-102', 'mhs-03', '91'],
  ];

  database.exec('BEGIN IMMEDIATE');
  try {
    const addUser = database.prepare(`
      INSERT INTO users (id, username, password_hash, role, nim)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING
    `);
    const findUser = database.prepare('SELECT 1 FROM users WHERE id = ?');
    for (const [id, username, role, nim] of users) {
      if (findUser.get(id)) continue;
      addUser.run(id, username, bcrypt.hashSync(demoPassword, 10), role, nim);
    }

    const addDevice = database.prepare(`
      INSERT INTO devices (id, user_id) VALUES (?, ?)
      ON CONFLICT(id) DO NOTHING
    `);
    for (const device of devices) addDevice.run(...device);

    const addClass = database.prepare(`
      INSERT INTO classes (id, course_code, course_name, term, lecturer_id)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING
    `);
    for (const item of classes) addClass.run(...item);

    const addEnrollment = database.prepare(`
      INSERT INTO enrollments (class_id, student_id) VALUES (?, ?)
      ON CONFLICT(class_id, student_id) DO NOTHING
    `);
    for (const item of enrollments) addEnrollment.run(...item);

    const addGrade = database.prepare(`
      INSERT INTO grades (id, class_id, student_id, grade_value)
      VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING
    `);
    for (const item of grades) addGrade.run(...item);

    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }

  const count = (table) => database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total;
  console.log(`Seed siap: ${count('users')} user, ${count('devices')} device, ${count('classes')} kelas, ${count('enrollments')} peserta kelas, ${count('grades')} nilai.`);
  console.log(`Database: ${databasePath}`);
} finally {
  database.close();
}
