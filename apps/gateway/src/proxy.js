import { createProxyMiddleware } from 'http-proxy-middleware';
import { defaultPorts } from '../../../shared/config.js';
import { errorResponse } from '../../../shared/responses.js';

function serviceTarget(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} harus berupa URL service yang valid.`);
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username || url.password || url.pathname !== '/' || url.search || url.hash
  ) {
    throw new Error(`${name} harus berupa origin HTTP(S) tanpa kredensial, path, atau query.`);
  }
  return url.origin;
}

export function createGatewayProxy({ gatewaySecret }) {
  const nilaiTarget = serviceTarget(
    process.env.NILAI_SERVICE_URL ?? `http://127.0.0.1:${defaultPorts.nilai}`,
    'NILAI_SERVICE_URL',
  );
  const transkripTarget = serviceTarget(
    process.env.TRANSKRIP_SERVICE_URL ?? `http://127.0.0.1:${defaultPorts.transkrip}`,
    'TRANSKRIP_SERVICE_URL',
  );

  function makeProxy(target) {
    return createProxyMiddleware({
      target,
      changeOrigin: true,
      on: {
        proxyRes(proxyRes, req) {
          req.gatewayUpstreamStatus = proxyRes.statusCode;
        },
        proxyReq(proxyReq, req) {
          proxyReq.setHeader('X-Gateway-Secret', gatewaySecret);
          proxyReq.setHeader('Authorization', `Bearer ${req.gatewayPolicy.token}`);
          proxyReq.setHeader('X-Request-ID', req.gatewayPolicy.requestId);
          if (req.gatewayPolicy.deviceId) {
            proxyReq.setHeader('X-Device-ID', req.gatewayPolicy.deviceId);
          } else {
            proxyReq.removeHeader('X-Device-ID');
          }
        },
        error(_error, req, res) {
          req.gatewayProxyError = true;
          if (res.writableEnded) return;
          if (res.headersSent) return res.end();
          return res.status(502).json({ ...errorResponse('bad_gateway'), message: 'Komunikasi dengan layanan tujuan terganggu. Hasil permintaan belum dapat dipastikan.' });
        },
      },
    });
  }

  const nilaiProxy = makeProxy(nilaiTarget);
  const transkripProxy = makeProxy(transkripTarget);

  function observeOutcome(req, res, auditOutcome) {
    let recorded = false;
    const record = (decision, reason) => {
      if (recorded) return;
      recorded = true;
      try {
        auditOutcome(decision, reason);
      } catch {
        // The response is already being sent; never expose audit or request details.
        console.error('Gateway gagal mencatat hasil upstream.');
      }
    };

    res.once('finish', () => {
      if (req.gatewayProxyError) return record('deny', 'proxy_error');
      const status = req.gatewayUpstreamStatus;
      if (!Number.isInteger(status)) return record('deny', 'upstream_status_unknown');
      return record(status >= 400 ? 'deny' : 'allow', `upstream_http_${status}`);
    });
    res.once('close', () => {
      if (!res.writableFinished) {
        record('deny', req.gatewayProxyError ? 'proxy_error' : 'response_incomplete');
      }
    });
  }

  return function gatewayProxy(req, res, next) {
    const policy = req.gatewayPolicy;
    if (!policy || typeof policy.auditOutcome !== 'function' || typeof policy.requestId !== 'string') {
      return next(new Error('Policy decision missing before proxy.'));
    }

    if (req.method === 'GET' && req.path === '/nilai') {
      // The Nilai service derives row scope from the verified token and DB.
      // Forward no client query or X-* scope hints for this collection route.
      req.url = '/nilai';
      for (const name of Object.keys(req.headers)) {
        if (name.startsWith('x-')) delete req.headers[name];
      }
    }

    // Replace client-provided headers with the values authorized by this gateway.
    delete req.headers['x-gateway-secret'];
    delete req.headers['x-request-id'];
    req.headers.authorization = `Bearer ${policy.token}`;
    req.headers['x-request-id'] = policy.requestId;
    if (policy.deviceId) {
      req.headers['x-device-id'] = policy.deviceId;
    } else {
      delete req.headers['x-device-id'];
    }

    observeOutcome(req, res, policy.auditOutcome);
    if (policy.target === 'nilai') return nilaiProxy(req, res, next);
    if (policy.target === 'transkrip') return transkripProxy(req, res, next);
    return next(new Error('Unknown proxy target.'));
  };
}
