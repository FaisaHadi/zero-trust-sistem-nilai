import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import express from 'express';
import jwt from 'jsonwebtoken';
import { errorResponse, successResponse } from '../../../shared/responses.js';
import { createAuditRecorder } from '../../../shared/audit-writer.js';

const ACCESS_TTL_SECONDS = 10 * 60;
const SERVICE_TTL_SECONDS = 5 * 60;
const REFRESH_TTL_SECONDS = 24 * 60 * 60;
const REFRESH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const AUTH_ENDPOINTS = new Set(['/auth/login', '/auth/refresh', '/auth/logout', '/auth/service']);

function isString(value, maxLength) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function hashRefreshToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function isActiveRefreshToken(row, now) {
  return row && row.revoked_at === null && Date.parse(row.expires_at) > now;
}

function secretsMatch(provided, expected) {
  const providedHash = createHash('sha256').update(provided).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(providedHash, expectedHash);
}

export function createAuthRouter({ database, jwtSecret, serviceClientId, serviceClientSecret }) {
  const router = express.Router();
  const findUser = database.prepare(`
    SELECT id, password_hash, role FROM users WHERE username = ? AND active = 1
  `);
  const findDevice = database.prepare(`
    SELECT id FROM devices WHERE id = ? AND user_id = ? AND active = 1
  `);
  const insertRefreshToken = database.prepare(`
    INSERT INTO refresh_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)
  `);
  const findRefreshToken = database.prepare(`
    SELECT rt.user_id, rt.expires_at, rt.revoked_at, u.role, u.active
    FROM refresh_tokens AS rt
    JOIN users AS u ON u.id = rt.user_id
    WHERE rt.token_hash = ?
  `);
  const revokeRefreshToken = database.prepare(`
    UPDATE refresh_tokens SET revoked_at = ?
    WHERE token_hash = ? AND revoked_at IS NULL
  `);
  const insertAudit = database.prepare(`
    INSERT INTO audit_logs (subject, method, endpoint, device_id, decision, reason)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const recordAudit = createAuditRecorder(database, insertAudit, 'GATEWAY');

  function audit(endpoint, subject, deviceId, decision, reason, method = 'POST', defer = false) {
    // Callers pass only database IDs or the configured service client ID.
    const safeMethod = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(method) ? method : 'OTHER';
    return recordAudit([subject, safeMethod, endpoint, deviceId, decision, reason], defer);
  }

  function reject(res, endpoint, status, error, reason, subject = null, messageReason = reason) {
    audit(endpoint, subject, null, 'deny', reason);
    return res.status(status).json(errorResponse(error, messageReason));
  }

  function accessToken(userId, role) {
    return jwt.sign(
      { role, token_use: 'access' },
      jwtSecret,
      { algorithm: 'HS256', subject: userId, expiresIn: ACCESS_TTL_SECONDS },
    );
  }

  router.use(express.json({ limit: '16kb', strict: true }));

  router.post('/login', (req, res) => {
    const { username, password } = req.body ?? {};
    const deviceId = req.get('X-Device-ID');
    if (!isString(username, 128) || !isString(password, 4096) || !isString(deviceId, 128)) {
      return reject(res, '/auth/login', 400, 'invalid_request', 'missing_or_invalid_input', null,
        !deviceId ? 'missing_device' : 'missing_or_invalid_input');
    }

    const user = findUser.get(username);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return reject(res, '/auth/login', 401, 'invalid_credentials', 'invalid_credentials', user?.id);
    }

    const device = findDevice.get(deviceId, user.id);
    if (!device) {
      return reject(res, '/auth/login', 401, 'invalid_credentials', 'unregistered_device', user.id);
    }

    const token = accessToken(user.id, user.role);
    const refreshToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + REFRESH_TTL_SECONDS * 1000).toISOString();

    database.exec('BEGIN IMMEDIATE');
    try {
      insertRefreshToken.run(hashRefreshToken(refreshToken), user.id, expiresAt);
      const emit = audit('/auth/login', user.id, device.id, 'allow', 'login_success', 'POST', true);
      database.exec('COMMIT');
      emit();
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }

    return res.status(200).json(successResponse('Autentikasi berhasil. Token akses dan token penyegaran telah diterbitkan.', {
      tokenType: 'Bearer',
      accessToken: token,
      expiresIn: ACCESS_TTL_SECONDS,
      refreshToken,
      refreshExpiresIn: REFRESH_TTL_SECONDS,
    }));
  });

  router.post('/refresh', (req, res) => {
    const { refreshToken } = req.body ?? {};
    if (typeof refreshToken !== 'string' || !REFRESH_TOKEN_PATTERN.test(refreshToken)) {
      return reject(res, '/auth/refresh', 400, 'invalid_request', 'missing_or_invalid_token');
    }

    const row = findRefreshToken.get(hashRefreshToken(refreshToken));
    if (!isActiveRefreshToken(row, Date.now()) || row.active !== 1) {
      return reject(res, '/auth/refresh', 401, 'invalid_refresh_token', 'invalid_refresh_token', row?.user_id);
    }

    const token = accessToken(row.user_id, row.role);
    audit('/auth/refresh', row.user_id, null, 'allow', 'refresh_success');
    return res.status(200).json(successResponse('Token akses berhasil diperbarui.', { tokenType: 'Bearer', accessToken: token, expiresIn: ACCESS_TTL_SECONDS }));
  });

  router.post('/logout', (req, res) => {
    const { refreshToken } = req.body ?? {};
    if (typeof refreshToken !== 'string' || !REFRESH_TOKEN_PATTERN.test(refreshToken)) {
      return reject(res, '/auth/logout', 400, 'invalid_request', 'missing_or_invalid_token');
    }

    const tokenHash = hashRefreshToken(refreshToken);
    const row = findRefreshToken.get(tokenHash);
    if (!isActiveRefreshToken(row, Date.now())) {
      return reject(res, '/auth/logout', 401, 'invalid_refresh_token', 'invalid_refresh_token', row?.user_id);
    }

    database.exec('BEGIN IMMEDIATE');
    try {
      const result = revokeRefreshToken.run(new Date().toISOString(), tokenHash);
      if (result.changes === 0) {
        const emit = audit('/auth/logout', row.user_id, null, 'deny', 'invalid_refresh_token', 'POST', true);
        database.exec('COMMIT');
        emit();
        return res.status(401).json(errorResponse('invalid_refresh_token'));
      }
      const emit = audit('/auth/logout', row.user_id, null, 'allow', 'logout_success', 'POST', true);
      database.exec('COMMIT');
      emit();
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }

    return res.status(204).end();
  });

  router.post('/service', (req, res) => {
    const { clientId, clientSecret } = req.body ?? {};
    if (!isString(clientId, 128) || !isString(clientSecret, 4096)) {
      return reject(res, '/auth/service', 400, 'invalid_request', 'missing_or_invalid_input');
    }

    const idMatches = secretsMatch(clientId, serviceClientId);
    const secretMatches = secretsMatch(clientSecret, serviceClientSecret);
    if (!idMatches || !secretMatches) {
      return reject(res, '/auth/service', 401, 'invalid_credentials', 'invalid_service_credentials');
    }

    const token = jwt.sign(
      { role: 'service', token_use: 'service' },
      jwtSecret,
      { algorithm: 'HS256', subject: serviceClientId, expiresIn: SERVICE_TTL_SECONDS },
    );
    audit('/auth/service', serviceClientId, null, 'allow', 'service_login_success');
    return res.status(200).json(successResponse('Token akses layanan berhasil diterbitkan.', { tokenType: 'Bearer', accessToken: token, expiresIn: SERVICE_TTL_SECONDS }));
  });

  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);

    const path = req.originalUrl.split('?', 1)[0];
    const endpoint = AUTH_ENDPOINTS.has(path) ? path : '/auth/*';
    const status = Number(error?.status ?? error?.statusCode);
    if (status >= 400 && status < 500) {
      try {
        audit(endpoint, null, null, 'deny', 'invalid_request_body', req.method);
      } catch {
        return res.status(500).json(errorResponse('internal_error'));
      }
      return res.status(status).json(errorResponse('invalid_request', 'invalid_request_body'));
    }

    return res.status(500).json(errorResponse('internal_error'));
  });

  return router;
}
