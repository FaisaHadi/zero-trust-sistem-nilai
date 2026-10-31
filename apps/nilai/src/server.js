import { createHash, timingSafeEqual } from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import { errorResponse, successResponse } from '../../../shared/responses.js';
import { createAuditRecorder } from '../../../shared/audit-writer.js';
import { accessTimeZone, defaultAccessWindow, defaultPorts } from '../../../shared/config.js';
import { openDatabase } from '../../../shared/db.js';

function requiredEnvironment(name, minLength = 1) {
  const value = process.env[name];
  if (!value || value.length < minLength || (value.startsWith('<') && value.endsWith('>'))) {
    throw new Error(`${name} harus diisi dengan nilai nyata di environment.`);
  }
  return value;
}

function gatewayOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('GATEWAY_URL harus berupa origin HTTP(S) yang valid.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username || url.password || url.pathname !== '/' || url.search || url.hash
  ) {
    throw new Error('GATEWAY_URL harus berupa origin HTTP(S) tanpa kredensial, path, atau query.');
  }
  if (url.protocol === 'http:' && !['127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('GATEWAY_URL HTTP hanya diizinkan untuk alamat loopback; host lain wajib HTTPS.');
  }
  return url.origin;
}

function secretsMatch(provided, expected) {
  const providedHash = createHash('sha256').update(provided).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(providedHash, expectedHash);
}

function bearerToken(header) {
  const match = /^Bearer ([^\s]+)$/i.exec(header ?? '');
  return match?.[1] ?? null;
}

const jakartaClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: accessTimeZone,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function clockMinutes(value) {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

const accessStart = clockMinutes(defaultAccessWindow.start);
const accessEnd = clockMinutes(defaultAccessWindow.end);

function withinAccessHours() {
  const parts = jakartaClock.formatToParts(new Date());
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  const current = hour * 60 + minute;
  return current >= accessStart && current < accessEnd;
}

function normalizeGradeValue(value) {
  const text = typeof value === 'string'
    ? value.trim()
    : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
  return text.length > 0 && text.length <= 64 ? text : null;
}

const jwtSecret = requiredEnvironment('JWT_SECRET', 32);
const gatewaySecret = requiredEnvironment('GATEWAY_SECRET', 32);
const serviceClientId = requiredEnvironment('SERVICE_NILAI_CLIENT_ID');
const serviceClientSecret = requiredEnvironment('SERVICE_NILAI_CLIENT_SECRET', 32);
const gatewayUrl = gatewayOrigin(process.env.GATEWAY_URL ?? `http://127.0.0.1:${defaultPorts.gateway}`);
const port = Number(process.env.PORT ?? defaultPorts.nilai);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT harus berupa angka antara 1 dan 65535.');
}
const host = process.env.HOST || '127.0.0.1';

const database = openDatabase();
const findUser = database.prepare(`
  SELECT id, role, nim FROM users WHERE id = ? AND active = 1
`);
const findDevice = database.prepare(`
  SELECT id FROM devices WHERE id = ? AND user_id = ? AND active = 1
`);
const insertAudit = database.prepare(`
  INSERT INTO audit_logs (subject, method, endpoint, device_id, decision, reason)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const writeAudit = createAuditRecorder(database, insertAudit, 'NILAI');

const gatewayRequestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function canonicalEndpoint(req) {
  if (req.method === 'GET' && req.path === '/nilai') return '/nilai';
  if (req.method === 'PUT' && /^\/nilai\/[^/]+$/.test(req.path)) return '/nilai/:id';
  if (req.method === 'POST' && /^\/kelas\/[^/]+\/finalisasi$/.test(req.path)) {
    return '/kelas/:id/finalisasi';
  }
  return '<unmatched>';
}

function recordAudit(req, decision, reasonCode, subject = null, deviceId = null) {
  const method = ['GET', 'PUT', 'POST'].includes(req.method) ? req.method : 'OTHER';
  const reason = req.gatewayRequestId
    ? `${reasonCode} request_id=${req.gatewayRequestId}`
    : reasonCode;
  try {
    writeAudit([subject, method, canonicalEndpoint(req), deviceId, decision, reason]);
  } catch {
    console.error('Service Nilai gagal mencatat audit.');
  }
}

function denyAuthentication(req, res, status, error, reason, subject = null) {
  recordAudit(req, 'deny', reason, subject);
  return res.status(status).json(errorResponse(error, reason === 'device_not_registered' && !req.get('X-Device-ID') ? 'missing_device' : reason));
}

function denyRequest(req, res, status, error, reason) {
  req.auditReason = reason;
  return res.status(status).json(errorResponse(error, reason));
}

const gradeColumns = `
  SELECT g.id, g.class_id AS classId, c.course_code AS courseCode,
         c.course_name AS courseName, c.term, g.student_id AS studentId,
         student.nim, g.grade_value AS gradeValue,
         c.is_finalized AS isFinalized, g.updated_at AS updatedAt
  FROM grades AS g
  JOIN classes AS c ON c.id = g.class_id
  JOIN users AS student ON student.id = g.student_id AND student.role = 'mahasiswa'
`;
const studentGrades = database.prepare(`
  ${gradeColumns}
  WHERE g.student_id = ? AND student.nim = ?
  ORDER BY c.id, g.id
`);
const lecturerGrades = database.prepare(`
  ${gradeColumns}
  WHERE c.lecturer_id = ?
  ORDER BY c.id, g.id
`);
const findGradeClass = database.prepare(`
  SELECT g.id, g.class_id AS classId, g.student_id AS studentId,
         c.lecturer_id AS lecturerId, c.is_finalized AS isFinalized
  FROM grades AS g
  JOIN classes AS c ON c.id = g.class_id
  WHERE g.id = ?
`);
const updateGrade = database.prepare(`
  UPDATE grades SET grade_value = ?, updated_at = ? WHERE id = ?
`);
const findGrade = database.prepare(`
  ${gradeColumns}
  WHERE g.id = ?
`);
const findClass = database.prepare(`
  SELECT id, lecturer_id AS lecturerId, is_finalized AS isFinalized
  FROM classes WHERE id = ?
`);
const finalizeClass = database.prepare(`
  UPDATE classes SET is_finalized = 1, finalized_at = ?
  WHERE id = ? AND is_finalized = 0
`);

function inImmediateTransaction(operation) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

async function serviceAccessToken() {
  const response = await fetch(new URL('/auth/service', gatewayUrl), {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: serviceClientId, clientSecret: serviceClientSecret }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('Service token request failed.');

  const payload = await response.json();
  if (payload?.tokenType !== 'Bearer' || typeof payload.accessToken !== 'string') {
    throw new Error('Invalid service token response.');
  }
  const claims = jwt.verify(payload.accessToken, jwtSecret, { algorithms: ['HS256'] });
  if (
    !claims || typeof claims !== 'object' || claims.sub !== serviceClientId ||
    claims.role !== 'service' || claims.token_use !== 'service'
  ) {
    throw new Error('Invalid service token claims.');
  }
  return payload.accessToken;
}

async function synchronizeTranscript(classId, token) {
  const response = await fetch(new URL('/transkrip/sinkron', gatewayUrl), {
    method: 'POST',
    redirect: 'error',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ classId }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('Transcript synchronization failed.');
}

const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  const providedSecret = req.get('X-Gateway-Secret') ?? '';
  if (!secretsMatch(providedSecret, gatewaySecret)) {
    return denyAuthentication(req, res, 403, 'gateway_required', 'gateway_secret_invalid');
  }

  const requestId = req.get('X-Request-ID');
  if (!requestId || !gatewayRequestIdPattern.test(requestId)) {
    return denyAuthentication(req, res, 400, 'invalid_gateway_request_id', 'invalid_gateway_request_id');
  }
  req.gatewayRequestId = requestId.toLowerCase();

  const token = bearerToken(req.get('Authorization'));
  if (!token) return denyAuthentication(req, res, 401, 'unauthorized', 'missing_bearer_token');

  let claims;
  try {
    claims = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
  } catch {
    return denyAuthentication(req, res, 401, 'unauthorized', 'invalid_or_expired_token');
  }
  if (
    !claims || typeof claims !== 'object' || typeof claims.sub !== 'string' ||
    !Number.isInteger(claims.exp) ||
    claims.token_use !== 'access' || !['mahasiswa', 'dosen', 'admin'].includes(claims.role)
  ) {
    return denyAuthentication(req, res, 401, 'unauthorized', 'invalid_token_claims');
  }

  const user = findUser.get(claims.sub);
  if (!user || user.role !== claims.role) {
    return denyAuthentication(req, res, 401, 'unauthorized', 'inactive_user_or_role_mismatch');
  }

  const requestedDeviceId = req.get('X-Device-ID');
  const device = requestedDeviceId && findDevice.get(requestedDeviceId, user.id);
  if (!device) {
    return denyAuthentication(req, res, 403, 'device_not_registered', 'device_not_registered', user.id);
  }

  res.once('finish', () => {
    const denied = res.statusCode >= 400;
    recordAudit(
      req,
      denied ? 'deny' : 'allow',
      denied ? (req.auditReason ?? 'internal_error') : (req.auditReason ?? 'service_completed'),
      user.id,
      device.id,
    );
  });
  req.identity = user;
  return next();
});

app.use(express.json({ limit: '16kb', strict: true }));

app.get('/nilai', (req, res) => {
  const user = req.identity;
  if (user.role === 'mahasiswa') {
    // Both parameters come from the active user row, never from client filters.
    req.auditReason = 'grades_read_success';
    const grades = studentGrades.all(user.id, user.nim);
    return res.status(200).json(successResponse(grades.length ? 'Data nilai dalam cakupan akses Anda berhasil ditampilkan.' : 'Tidak ada data nilai yang tersedia dalam cakupan akses Anda.', { grades }));
  }
  if (user.role === 'dosen') {
    req.auditReason = 'grades_read_success';
    const grades = lecturerGrades.all(user.id);
    return res.status(200).json(successResponse(grades.length ? 'Data nilai dalam cakupan akses Anda berhasil ditampilkan.' : 'Tidak ada data nilai yang tersedia dalam cakupan akses Anda.', { grades }));
  }
  return denyRequest(req, res, 403, 'forbidden', 'role_not_allowed');
});

app.put('/nilai/:id', (req, res) => {
  const user = req.identity;
  if (user.role !== 'dosen') return denyRequest(req, res, 403, 'forbidden', 'role_not_allowed');

  const gradeValue = normalizeGradeValue(req.body?.gradeValue);
  if (gradeValue === null) return denyRequest(req, res, 400, 'invalid_grade_value', 'invalid_grade_value');

  const result = inImmediateTransaction(() => {
    if (!withinAccessHours()) return { status: 403, error: 'outside_access_window', reason: 'outside_access_hours' };
    const grade = findGradeClass.get(req.params.id);
    if (!grade) return { status: 404, error: 'grade_not_found', reason: 'grade_not_found' };
    if (grade.lecturerId !== user.id) return { status: 403, error: 'forbidden', reason: 'class_not_taught' };
    if (grade.isFinalized !== 0) return { status: 409, error: 'class_finalized', reason: 'grade_finalized' };

    updateGrade.run(gradeValue, new Date().toISOString(), grade.id);
    return { grade: findGrade.get(grade.id) };
  });

  if (result.error) return denyRequest(req, res, result.status, result.error, result.reason);
  req.auditReason = 'grade_updated';
  return res.status(200).json(successResponse('Nilai berhasil diperbarui.', result.grade));
});

app.post('/kelas/:id/finalisasi', async (req, res) => {
  const user = req.identity;
  if (user.role !== 'dosen') return denyRequest(req, res, 403, 'forbidden', 'role_not_allowed');

  const result = inImmediateTransaction(() => {
    if (!withinAccessHours()) return { status: 403, error: 'outside_access_window', reason: 'outside_access_hours' };
    const classRow = findClass.get(req.params.id);
    if (!classRow) return { status: 404, error: 'class_not_found', reason: 'class_not_found' };
    if (classRow.lecturerId !== user.id) return { status: 403, error: 'forbidden', reason: 'class_not_taught' };
    if (classRow.isFinalized !== 0) return { status: 409, error: 'class_finalized', reason: 'class_finalized' };

    const finalizedAt = new Date().toISOString();
    const update = finalizeClass.run(finalizedAt, classRow.id);
    if (update.changes !== 1) throw new Error('Class finalization failed.');
    return { classId: classRow.id, finalizedAt };
  });

  if (result.error) return denyRequest(req, res, result.status, result.error, result.reason);

  let token;
  try {
    token = await serviceAccessToken();
  } catch {
    req.auditReason = 'service_token_unavailable';
    return res.status(502).json({
      success: false,
      message: 'Kelas telah difinalisasi, tetapi sinkronisasi transkrip belum dimulai karena token layanan tidak tersedia.',
      error: 'transcript_sync_failed',
      classId: result.classId,
      isFinalized: true,
      transcriptSyncStatus: 'not_started',
    });
  }

  try {
    await synchronizeTranscript(result.classId, token);
  } catch {
    req.auditReason = 'transcript_sync_unconfirmed';
    return res.status(502).json({
      success: false,
      message: 'Kelas telah difinalisasi, tetapi hasil sinkronisasi transkrip belum dapat dipastikan.',
      error: 'transcript_sync_failed',
      classId: result.classId,
      isFinalized: true,
      transcriptSyncStatus: 'unknown',
    });
  }

  req.auditReason = 'class_finalized_and_synced';
  return res.status(200).json(successResponse('Kelas berhasil difinalisasi dan transkrip berhasil disinkronkan.', {
    classId: result.classId,
    finalizedAt: result.finalizedAt,
    isFinalized: true,
    transcriptSynced: true,
    transcriptSyncStatus: 'confirmed',
  }));
});

app.use((req, res) => denyRequest(req, res, 404, 'not_found', 'route_not_found'));
app.use((error, req, res, _next) => {
  if (res.headersSent) return res.end();
  const status = Number(error?.status ?? error?.statusCode);
  if (status >= 400 && status < 500) {
    req.auditReason = 'invalid_request_body';
    return res.status(status).json(errorResponse('invalid_request', 'invalid_request_body'));
  }
  req.auditReason = 'internal_error';
  return res.status(500).json(errorResponse('internal_error'));
});

const server = app.listen(port, host);
server.once('listening', () => {
  console.log(`Service Nilai aktif di http://${host}:${port}`);
});
server.once('error', (error) => {
  console.error(`Service Nilai gagal mendengarkan (${error.code ?? 'LISTEN_ERROR'}).`);
  process.exitCode = 1;
  database.close();
});
server.on('close', () => database.close());
