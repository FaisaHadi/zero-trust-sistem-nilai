import express from 'express';
import { defaultPorts } from '../../../shared/config.js';
import { openDatabase } from '../../../shared/db.js';
import { createAuthRouter } from './auth.js';
import { createPolicyEngine } from './policy.js';
import { createGatewayProxy } from './proxy.js';
import { errorResponse } from '../../../shared/responses.js';

function requiredEnvironment(name, minLength = 1) {
  const value = process.env[name];
  if (!value || value.length < minLength || (value.startsWith('<') && value.endsWith('>'))) {
    throw new Error(`${name} harus diisi dengan nilai nyata di environment.`);
  }
  return value;
}

const jwtSecret = requiredEnvironment('JWT_SECRET', 32);
const serviceClientId = requiredEnvironment('SERVICE_NILAI_CLIENT_ID');
const serviceClientSecret = requiredEnvironment('SERVICE_NILAI_CLIENT_SECRET', 32);
const gatewaySecret = requiredEnvironment('GATEWAY_SECRET', 32);
const port = Number(process.env.PORT ?? defaultPorts.gateway);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT harus berupa angka antara 1 dan 65535.');
}
const host = process.env.HOST || '127.0.0.1';

const database = openDatabase();
const app = express();
app.disable('x-powered-by');
app.use('/auth', createAuthRouter({ database, jwtSecret, serviceClientId, serviceClientSecret }));
app.use(
  createPolicyEngine({ database, jwtSecret, serviceClientId }),
  createGatewayProxy({ gatewaySecret }),
);
app.use((error, _req, res, next) => {
  if (res.headersSent) return next(error);
  return res.status(500).json(errorResponse('internal_error'));
});

const server = app.listen(port, host);
server.once('listening', () => {
  console.log(`API Gateway aktif di http://${host}:${port}`);
});
server.once('error', (error) => {
  console.error(`API Gateway gagal mendengarkan (${error.code ?? 'LISTEN_ERROR'}).`);
  process.exitCode = 1;
  database.close();
});
server.on('close', () => database.close());
