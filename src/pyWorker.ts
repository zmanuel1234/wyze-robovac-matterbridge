/**
 * Runs py_helpers/wyze_worker.py as one long-lived Python process and sends it
 * helper commands, one JSON line each, instead of starting Python (and loading
 * wyze-sdk, several seconds on a Raspberry Pi) for every command.
 *
 * - Python is started directly with an argument list (no shell), so vacuum,
 *   floor and room names are passed as-is.
 * - Wyze credentials are sent in the first line on the worker's input, not in
 *   its environment or command line, so other processes cannot read them.
 * - The worker answers requests one at a time, in order. A request that gets no
 *   answer within the timeout fails and the worker is restarted; a worker that
 *   exits is started again on the next request.
 *
 * @license Apache-2.0
 */

import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface } from 'readline';

export interface PyResult { ok : boolean, stdout : string, stderr : string }

export interface PyWorkerOptions {
  python : string;                          // interpreter, e.g. /opt/matterbridge/wyze-venv/bin/python
  script : string;                          // full path of wyze_worker.py
  secrets : () => Record<string, string>;   // WYZE_* values sent in the first line
  timeoutMs : number;
  log : (message : string) => void;         // diagnostics (worker start/stop, stray output)
}

interface Pending { resolve : (r : PyResult) => void, timer : NodeJS.Timeout }

export class PyWorker {
  private child : ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private stderrTail : string[] = [];
  private stopped = false;

  constructor(private readonly opts : PyWorkerOptions) {}

  // Run one helper command, e.g. request('getVacuumStatus', ['Home Vacuum']).
  // Never rejects: problems come back as { ok: false, stderr: reason }.
  request(cmd : string, args : string[]) : Promise<PyResult> {
    if (this.stopped) {
      return Promise.resolve({ ok: false, stdout: '', stderr: 'The plugin is shutting down' });
    }
    const child = this.start();
    if (!child) {
      return Promise.resolve({ ok: false, stdout: '', stderr: 'Could not start the Wyze helper' });
    }
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, stdout: '', stderr: `No answer from the Wyze helper within ${this.opts.timeoutMs / 1000} s; restarting it` });
        this.restart(child);
      }, this.opts.timeoutMs);
      this.pending.set(id, { resolve, timer });
      child.stdin.write(JSON.stringify({ id, cmd, args }) + '\n');
    });
  }

  // Close the worker's input (it exits on its own), and make sure it is gone soon after.
  stop() {
    this.stopped = true;
    const child = this.child;
    if (child) {
      child.stdin.end();
      setTimeout(() => child.kill(), 3000).unref();
    }
  }

  private start() : ChildProcessWithoutNullStreams | undefined {
    if (this.child) {
      return this.child;
    }
    let child : ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.opts.python, [this.opts.script], {
        stdio: 'pipe',
        env: { ...process.env, PYTHONWARNINGS: 'ignore', PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1' },
      });
    } catch (e) {
      this.opts.log(`Could not start ${this.opts.python}: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
    this.child = child;
    this.stderrTail = [];
    child.stdin.on('error', () => { /* worker gone; the exit handler reports it */ });
    child.stdin.write(JSON.stringify({ env: this.opts.secrets() }) + '\n');

    createInterface({ input: child.stdout }).on('line', (line) => this.answer(line));
    createInterface({ input: child.stderr }).on('line', (line) => {
      this.stderrTail = [...this.stderrTail.slice(-9), line];
      this.opts.log(`Wyze helper: ${line}`);
    });
    child.on('error', (e) => this.ended(child, e.message));
    child.on('exit', (code, signal) => this.ended(child, signal ? `stopped by ${signal}` : `exited with code ${code}`));
    this.opts.log(`Wyze helper started (pid ${child.pid})`);
    return child;
  }

  private answer(line : string) {
    let msg : { id? : number, ok? : boolean, out? : string, err? : string };
    try {
      msg = JSON.parse(line);
    } catch {
      this.opts.log(`Wyze helper sent an unreadable line: ${line.slice(0, 200)}`);
      return;
    }
    const p = msg.id === undefined ? undefined : this.pending.get(msg.id);
    if (!p) {
      return;   // answer to a request that already timed out
    }
    this.pending.delete(msg.id as number);
    clearTimeout(p.timer);
    p.resolve({ ok: msg.ok === true, stdout: String(msg.out ?? ''), stderr: String(msg.err ?? '') });
  }

  // The worker exited or could not be started: fail what was waiting for it.
  private ended(child : ChildProcessWithoutNullStreams, how : string) {
    if (this.child !== child) {
      return;   // already handled (error and exit can both fire)
    }
    this.child = undefined;
    const detail = this.stderrTail.length ? `: ${this.stderrTail.join(' | ')}` : '';
    if (!this.stopped || this.pending.size > 0) {
      this.opts.log(`Wyze helper ${how}${detail}`);
    }
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, stdout: '', stderr: `The Wyze helper ${how}${detail}` });
      this.pending.delete(id);
    }
  }

  // A request timed out: stop using this worker at once (the next request starts a new
  // one), fail whatever else was queued on it, and kill it.
  private restart(child : ChildProcessWithoutNullStreams) {
    this.ended(child, 'did not answer in time and was restarted');
    child.kill();
  }
}
