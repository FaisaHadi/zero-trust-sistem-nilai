import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { errorResponse } from '../../../shared/responses.js';
import { createAuditRecorder } from '../../../shared/audit-writer.js';
import { accessTimeZone, defaultAccessWindow } from '../../../shared/config.js';

const USER_ROLES = new Set(['admin', 'dosen', 'mahasiswa']);
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

function matchRoute(method, path) {
  if (method === 'GET' && path === '/nilai') {
    return { name: '/nilai', action: 'read_grades', target: 'nilai' };
  }

  let match = method === 'PUT' && /^\/nilai\/([^/]+)$/.exec(path);
  if (match) {
    return { name: '/nilai/:id', action: 'update_grade', target: 'nilai', id: match[1] };
  }

  match = method === 'POST' && /^\/kelas\/([^/]+)\/finalisasi$/.exec(path);
  if (match) {
    return { name: '/kelas/:id/finalisasi', action: 'finalize_class', target: 'nilai', id: match[1] };
  }

  if (method === 'POST' && path === '/transkrip/sinkron') {
    return { name: '/transkrip/sinkron', action: 'sync_transcript', target: 'transkrip' };
  }

  match = method === 'GET' && /^\/transkrip\/([^/]+)$/.exec(path);
  if (match) {
    return { name: '/transkrip/:nim', action: 'read_transcript', target: 'transkrip', nim: match[1] };
  }

  return null;
}

function bearerToken(header) {
  const match = /^Bearer ([^\s]+)$/i.exec(header ?? '');
  return match?.[1] ?? null;
}

export function createPolicyEngine({ database, jwtSecret, serviceClientId }) {
  const findUser = database.prepare(`
    SELECT id, role, nim FROM users WHERE id = ? AND active = 1
  `);
  const findDevice = database.prepare(`
    SELECT id FROM devices WHERE id = ? AND user_id = ? AND active = 1
  `);
  const findGradeClass = database.prepare(`
    SELECT c.lecturer_id, c.is_finalized
    FROM grades AS g JOIN classes AS c ON c.id = g.class_id
    WHERE g.id = ?
  `);
  const findClass = database.prepare(`
    SELECT lecturer_id FROM classes WHERE id = ?
  `);
  const findStudentNim = database.prepare(`
    SELECT nim FROM users WHERE nim = ? AND role = 'mahasiswa'
  `);
  const insertAudit = database.prepare(`
    INSERT INTO audit_logs (subject, method, endpoint, device_id, decision, reason)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const recordAudit = createAuditRecorder(database, insertAudit, 'GATEWAY');

  function audit(req, route, subject, deviceId, decision, reason) {
    const method = ['GET', 'PUT', 'POST'].includes(req.method) ? req.method : 'OTHER';
    const endpoint = route?.name ?? (req.path.startsWith('/auth/') ? '/auth/*' : '<unmatched>');
    recordAudit([subject, method, endpoint, deviceId, decision, reason]);
  }

  function deny(req, res, route, status, error, reason, subject = null, deviceId = null) {
    audit(req, route, subject, deviceId, 'deny', reason);
    return res.status(status).json(errorResponse(error, reason === 'device_not_registered' && !req.get('X-Device-ID') ? 'missing_device' : reason));
  }

  return function policyEngine(req, res, next) {
    const route = matchRoute(req.method, req.path);
    if (!route && req.path.startsWith('/auth/')) {
      return deny(req, res, null, 404, 'not_found', 'route_not_allowed');
    }

    const token = bearerToken(req.get('Authorization'));
    if (!token) {
      return deny(req, res, route, 401, 'unauthorized', 'missing_bearer_token');
    }

    let claims;
    try {
      claims = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
    } catch {
      return deny(req, res, route, 401, 'unauthorized', 'invalid_or_expired_token');
    }

    if (!claims || typeof claims !== 'object' || typeof claims.sub !== 'string') {
      return deny(req, res, route, 401, 'unauthorized', 'invalid_token_claims');
    }

    if (route?.action === 'sync_transcript') {
      if (claims.role !== 'service' || claims.token_use !== 'service' || claims.sub !== serviceClientId) {
        return deny(req, res, route, 403, 'forbidden', 'service_token_required');
      }

      const requestId = randomUUID();
      audit(req, route, serviceClientId, null, 'allow', `policy_allowed request_id=${requestId}`);
      req.gatewayPolicy = {
        target: route.target,
        token,
        deviceId: null,
        requestId,
        auditOutcome: (decision, reason) =>
          audit(req, route, serviceClientId, null, decision, `${reason} request_id=${requestId}`),
      };
      return next();
    }

    if (claims.token_use !== 'access' || !USER_ROLES.has(claims.role)) {
      return deny(req, res, route, 401, 'unauthorized', 'user_token_required');
    }

    const user = findUser.get(claims.sub);
    if (!user || user.role !== claims.role) {
      return deny(req, res, route, 401, 'unauthorized', 'inactive_user_or_role_mismatch');
    }

    const requestedDeviceId = req.get('X-Device-ID');
    const device = requestedDeviceId && findDevice.get(requestedDeviceId, user.id);
    if (!device) {
      return deny(req, res, route, 403, 'forbidden', 'device_not_registered', user.id);
    }

    const denied = (status, error, reason) =>
      deny(req, res, route, status, error, reason, user.id, device.id);

    if (!route) return denied(404, 'not_found', 'route_not_allowed');

    if (route.action === 'read_grades') {
      if (user.role !== 'mahasiswa' && user.role !== 'dosen') {
        return denied(403, 'forbidden', 'role_forbidden');
      }
    } else if (route.action === 'update_grade') {
      if (user.role !== 'dosen') return denied(403, 'forbidden', 'role_forbidden');
      if (!withinAccessHours()) return denied(403, 'forbidden', 'outside_access_window');

      const gradeClass = findGradeClass.get(route.id);
      if (!gradeClass) return denied(404, 'not_found', 'grade_not_found');
      if (gradeClass.lecturer_id !== user.id) return denied(403, 'forbidden', 'not_class_lecturer');
      if (gradeClass.is_finalized !== 0) return denied(403, 'forbidden', 'grade_finalized');
    } else if (route.action === 'finalize_class') {
      if (user.role !== 'dosen') return denied(403, 'forbidden', 'role_forbidden');
      if (!withinAccessHours()) return denied(403, 'forbidden', 'outside_access_window');

      const classRow = findClass.get(route.id);
      if (!classRow) return denied(404, 'not_found', 'class_not_found');
      if (classRow.lecturer_id !== user.id) return denied(403, 'forbidden', 'not_class_lecturer');
    } else if (route.action === 'read_transcript') {
      if (user.role === 'mahasiswa') {
        if (user.nim !== route.nim) return denied(403, 'forbidden', 'transcript_owner_mismatch');
      } else if (user.role === 'admin') {
        if (!findStudentNim.get(route.nim)) return denied(404, 'not_found', 'nim_not_found');
      } else {
        return denied(403, 'forbidden', 'role_forbidden');
      }
    } else {
      return denied(403, 'forbidden', 'route_not_allowed');
    }

    const requestId = randomUUID();
    audit(req, route, user.id, device.id, 'allow', `policy_allowed request_id=${requestId}`);
    req.gatewayPolicy = {
      target: route.target,
      token,
      deviceId: device.id,
      requestId,
      auditOutcome: (decision, reason) =>
        audit(req, route, user.id, device.id, decision, `${reason} request_id=${requestId}`),
    };
    return next();
  };
}
