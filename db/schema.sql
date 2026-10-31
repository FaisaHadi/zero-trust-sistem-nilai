CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'dosen', 'mahasiswa')),
  nim TEXT UNIQUE,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  CHECK (
    (role = 'mahasiswa' AND nim IS NOT NULL) OR
    (role <> 'mahasiswa' AND nim IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);

CREATE TABLE IF NOT EXISTS classes (
  id TEXT PRIMARY KEY,
  course_code TEXT NOT NULL,
  course_name TEXT NOT NULL,
  term TEXT NOT NULL,
  lecturer_id TEXT NOT NULL REFERENCES users(id),
  is_finalized INTEGER NOT NULL DEFAULT 0 CHECK (is_finalized IN (0, 1)),
  finalized_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_classes_lecturer ON classes(lecturer_id);

CREATE TABLE IF NOT EXISTS enrollments (
  class_id TEXT NOT NULL REFERENCES classes(id),
  student_id TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY (class_id, student_id)
);

CREATE TABLE IF NOT EXISTS grades (
  id TEXT PRIMARY KEY,
  class_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  grade_value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (class_id, student_id),
  FOREIGN KEY (class_id, student_id) REFERENCES enrollments(class_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_grades_student ON grades(student_id);

CREATE TABLE IF NOT EXISTS transcript_entries (
  class_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  grade_value TEXT NOT NULL,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (class_id, student_id),
  FOREIGN KEY (class_id, student_id) REFERENCES grades(class_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_transcript_student ON transcript_entries(student_id);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  subject TEXT,
  method TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  device_id TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
  reason TEXT NOT NULL
);
