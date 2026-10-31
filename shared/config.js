import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));

// Resolve relative paths from the project root, regardless of process cwd.
export const databasePath = resolve(projectRoot, 'data/academic.sqlite');

export const defaultPorts = Object.freeze({
  gateway: 3000,
  nilai: 3001,
  transkrip: 3002,
});

export const accessTimeZone = 'Asia/Jakarta';
export const defaultAccessWindow = Object.freeze({ start: '07:00', end: '21:00' });
