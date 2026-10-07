// Loads .env (Node 22+ has this built in) and returns the active Tradetron cookie.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.ALGOLENS_DATA || path.join(ROOT, 'data');
export const COOKIE_FILE = path.join(DATA_DIR, 'tradetron-cookie.txt');

export function loadEnv() {
  try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* no .env file: rely on real environment variables */ }
}

// A cookie pasted on the admin page (saved in data/) takes priority over the one in .env
export function readCookie() {
  try { const c = fs.readFileSync(COOKIE_FILE, 'utf8').trim(); if (c) return c; } catch {}
  return process.env.TRADETRON_COOKIE || '';
}
