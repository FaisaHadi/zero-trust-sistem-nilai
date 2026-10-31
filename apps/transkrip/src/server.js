import { createHash, timingSafeEqual } from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import { errorResponse, successResponse } from '../../../shared/responses.js';
import { createAuditRecorder } from '../../../shared/audit-writer.js';
import { defaultPorts } from '../../../shared/config.js';
import { openDatabase } from '../../../shared/db.js';

function requiredEnvironment(name, minLength = 1) {
  const value = process.env[name];
  if (!value || value.length < minLength || (value.startsWith('<') && value.endsWith('>'))) {
    throw new Error(`${name} harus diisi dengan nilai nyata di environment.`);
  }
  return value;
}

function secretsMatch(provided, expected) {
  if (typeof provided !== 'string') return false;
  const providedHash = createHash('sha256').update(provided).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(providedHash, expectedHash);
}

function bearerToken(value) {
  return /^Bearer ([^\s]+)$/i.exec(value ?? '')?.[1] ?? null;
}

const jwtSecret = requiredEnvironment('JWT_SECRET', 32);
const gatewaySecret = requiredEnvironment('GATEWAY_SECRET', 32);
const serviceClientId = requiredEnvironment('SERVICE_NILAI_CLIENT_ID');
const port = Number(process.env.PORT ?? defaultPorts.transkrip);
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
const findStudent = database.prepare(`
  SELECT id, nim FROM users WHERE nim = ? AND role = 'mahasiswa'
`);
const readTranscript = database.prepare(`
  SELECT t.class_id AS classId, c.course_code AS courseCode,
         c.course_name AS courseName, c.term, t.grade_value AS gradeValue,
         t.synced_at AS syncedAt
  FROM transcript_entries AS t
  JOIN classes AS c ON c.id = t.class_id
  WHERE t.student_id = ? AND c.is_finalized = 1
  ORDER BY c.term, c.course_code, c.id
`);
const findClass = database.prepare(`
  SELECT id, is_finalized FROM classes WHERE id = ?
`);
const syncGrades = database.prepare(`
  INSERT INTO transcript_entries (class_id, student_id, grade_value)
  SELECT g.class_id, g.student_id, g.grade_value
  FROM grades AS g
  WHERE g.class_id = ?
  ON CONFLICT(class_id, student_id) DO NOTHING
`);
const countTranscript = database.prepare(`
  SELECT COUNT(*) AS total FROM transcript_entries WHERE class_id = ?
`);
const recordAuthDenial = database.prepare(`
  INSERT INTO audit_logs (subject, method, endpoint, device_id, decision, reason)
  VALUES (?, ?, ?, NULL, 'deny', ?)
`);
const recordServiceOutcome = database.prepare(`
  INSERT INTO audit_logs (subject, method, endpoint, device_id, decision, reason)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const writeAuthDenial = createAuditRecorder(database, recordAuthDenial, 'TRANSKRIP');
const writeServiceOutcome = createAuditRecorder(database, recordServiceOutcome, 'TRANSKRIP');

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function auditMethod(method) {
  return ['GET', 'POST'].includes(method) ? method : 'OTHER';
}

function auditEndpoint(method, path) {
  if (method === 'POST' && path === '/transkrip/sinkron') return '/transkrip/sinkron';
  if (method === 'GET' && /^\/transkrip\/[^/]+$/.test(path)) return '/transkrip/:nim';
  return 'unknown';
}

function auditReason(req, reason) {
  return req.trustedRequestId ? `${reason} request_id=${req.trustedRequestId}` : reason;
}

function respond(res, status, error, reason) {
  res.locals.auditReason = reason;
  return res.status(status).json(errorResponse(error, reason));
}

function denyAuthentication(req, res, status, reason, user = null) {
  writeAuthDenial([
    user?.id ?? null, auditMethod(req.method), auditEndpoint(req.method, req.path),
    auditReason(req, reason),
  ]);
  const error = status === 400 ? 'invalid_request' : status === 403 ? 'forbidden' : 'unauthorized';
  return res.status(status).json(errorResponse(error, reason === 'device_unregistered' && !req.get('X-Device-ID') ? 'missing_device' : reason));
}

const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  if (!secretsMatch(req.get('X-Gateway-Secret'), gatewaySecret)) {
    return denyAuthentication(req, res, 403, 'gateway_secret_invalid');
  }

  // Only a request authenticated with the gateway secret may supply an audit correlation ID.
  const requestId = req.get('X-Request-ID');
  if (!uuidV4.test(requestId ?? '')) {
    return denyAuthentication(req, res, 400, 'invalid_gateway_request_id');
  }
  req.trustedRequestId = requestId.toLowerCase();

  const token = bearerToken(req.get('Authorization'));
  if (!token) return denyAuthentication(req, res, 401, 'bearer_missing');

  let claims;
  try {
    claims = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
  } catch {
    return denyAuthentication(req, res, 401, 'token_invalid');
  }
  if (
    !claims || typeof claims !== 'object' ||
    typeof claims.sub !== 'string' || !Number.isInteger(claims.exp)
  ) {
    return denyAuthentication(req, res, 401, 'token_claims_invalid');
  }

  if (claims.role === 'service' && claims.token_use === 'service') {
    if (claims.sub !== serviceClientId) {
      return denyAuthentication(req, res, 403, 'service_identity_invalid');
    }
    req.identity = { kind: 'service' };
    return next();
  }

  if (claims.token_use !== 'access' || !['admin', 'dosen', 'mahasiswa'].includes(claims.role)) {
    return denyAuthentication(req, res, 401, 'token_use_invalid');
  }

  const user = findUser.get(claims.sub);
  if (!user || user.role !== claims.role) {
    return denyAuthentication(req, res, 401, 'user_or_role_invalid');
  }
  const deviceId = req.get('X-Device-ID');
  const device = deviceId && findDevice.get(deviceId, user.id);
  if (!device) {
    return denyAuthentication(req, res, 403, 'device_unregistered', user);
  }

  req.identity = { kind: 'user', user, deviceId: device.id };
  return next();
});

app.use((req, res, next) => {
  const subject = req.identity.kind === 'service' ? serviceClientId : req.identity.user.id;
  const deviceId = req.identity.kind === 'user' ? req.identity.deviceId : null;
  const method = auditMethod(req.method);
  const endpoint = auditEndpoint(req.method, req.path);
  res.once('finish', () => {
    try {
      writeServiceOutcome([
        subject, method, endpoint, deviceId,
        res.statusCode >= 400 ? 'deny' : 'allow',
        auditReason(req, res.locals.auditReason ?? 'service_response_completed'),
      ]);
    } catch {
      console.error('Service Transkrip gagal mencatat hasil respons.');
    }
  });
  return next();
});

app.get('/transkrip/:nim', (req, res) => {
  if (req.identity.kind !== 'user') {
    return respond(res, 403, 'forbidden', 'user_token_required');
  }

  const { user } = req.identity;
  const requestedNim = req.params.nim;
  let student;
  if (user.role === 'mahasiswa') {
    if (requestedNim !== user.nim) {
      return respond(res, 403, 'forbidden', 'transcript_not_owned');
    }
    student = user;
  } else if (user.role === 'admin') {
    student = findStudent.get(requestedNim);
    if (!student) return respond(res, 404, 'not_found', 'student_not_found');
  } else {
    return respond(res, 403, 'forbidden', 'role_forbidden');
  }

  res.locals.auditReason = 'transcript_read_success';
  const entries = readTranscript.all(student.id);
  return res.status(200).json(successResponse(entries.length ? 'Data transkrip berhasil ditampilkan.' : 'Tidak ada data transkrip yang tersedia.', { nim: student.nim, entries }));
});

app.post('/transkrip/sinkron', express.json({ limit: '16kb', strict: true }), (req, res) => {
  if (req.identity.kind !== 'service') {
    return respond(res, 403, 'forbidden', 'service_token_required');
  }

  const body = req.body;
  if (
    !body || typeof body !== 'object' || Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    typeof body.classId !== 'string' || !body.classId || body.classId.length > 128
  ) {
    return respond(res, 400, 'invalid_request', 'invalid_sync_request');
  }

  database.exec('BEGIN IMMEDIATE');
  try {
    const classRow = findClass.get(body.classId);
    if (!classRow) {
      database.exec('ROLLBACK');
      return respond(res, 404, 'not_found', 'class_not_found');
    }
    if (classRow.is_finalized !== 1) {
      database.exec('ROLLBACK');
      return respond(res, 409, 'class_not_finalized', 'class_not_finalized');
    }

    const inserted = Number(syncGrades.run(body.classId).changes);
    const total = Number(countTranscript.get(body.classId).total);
    database.exec('COMMIT');
    res.locals.auditReason = 'transcript_sync_success';
    return res.status(200).json(successResponse('Sinkronisasi transkrip berhasil diproses.', { classId: body.classId, inserted, total }));
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
});

app.use((_req, res) => respond(res, 404, 'not_found', 'route_not_found'));
app.use((error, _req, res, next) => {
  if (res.headersSent) return next(error);
  const status = Number(error?.status ?? error?.statusCode);
  if (status >= 400 && status < 500) {
    return respond(res, status, 'invalid_request', 'request_parse_error');
  }
  return respond(res, 500, 'internal_error', 'internal_error');
});

const server = app.listen(port, host);
server.once('listening', () => {
  console.log(`Service Transkrip aktif di http://${host}:${port}`);
});
server.once('error', (error) => {
  console.error(`Service Transkrip gagal mendengarkan (${error.code ?? 'LISTEN_ERROR'}).`);
  process.exitCode = 1;
  database.close();
});
server.on('close', () => database.close());
