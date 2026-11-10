/*
 * Shared test setup: a temporary folder with the fake Wyze cloud's state file and
 * the token cache, and the environment that makes the Python helpers load the fake
 * wyze-sdk in test/mock instead of the real one.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PYTHON = process.env.PYTHON || 'python3';
export const HELPERS = path.join(ROOT, 'py_helpers');

export function fakeWyze(initial = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyze-test-'));
  const stateFile = path.join(dir, 'state.json');
  const tokenFile = path.join(dir, 'tokens', 'tokens.json');
  fs.writeFileSync(stateFile, JSON.stringify({ password: 'pw', mode: 'IDLE', battery: 90, charging: true, events: [], ...initial }));
  process.env.MOCK_STATE = stateFile;
  process.env.PYTHONPATH = path.join(ROOT, 'test', 'mock') + (process.env.PYTHONPATH ? path.delimiter + process.env.PYTHONPATH : '');
  const read = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const write = (d) => {   // atomically, like the fake itself (a helper may be running)
    fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify(d));
    fs.renameSync(`${stateFile}.tmp`, stateFile);
  };
  return {
    dir, stateFile, tokenFile, read,
    set: (o) => write({ ...read(), ...o }),
    events: () => read().events ?? [],
    clearEvents: () => write({ ...read(), events: [] }),
    secrets: (password = 'pw') => ({ WYZE_EMAIL: 'me@example.com', WYZE_PASSWORD: password, WYZE_KEY_ID: 'kid',
      WYZE_API_KEY: 'SECRET-API-KEY-123', WYZE_TOTP_KEY: '', WYZE_TOKEN_FILE: tokenFile }),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
