/**
 * Runs py_helpers/wyze_worker.py as one long-lived Python process and sends it
 * helper commands, one JSON line each, instead of starting Python (and loading
 * wyze-sdk, several seconds on a Raspberry Pi) for every command.
 *
 * - Python is started directly with an argument list (no shell), so vacuum,
 *   floor and room names are passed as-is.
 * - Wyze credentials are sent in the first line on the worker's input, not in
 *   its environment or command line, so other processes cannot read them.
 * - Requests are sent one at a time, in order. A request that gets no answer
 *   within the timeout (counted from when it is sent, not while it waits) fails
 *   and the worker is restarted; the requests behind it go to the new worker. A
 *   worker that exits is started again for the next request.
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

interface Queued { id : number, cmd : string, args : string[], resolve : (r : PyResult) => void }
interface InFlight { req : Queued, child : ChildProcessWithoutNullStreams, timer : NodeJS.Timeout }

export class PyWorker {
  private child : ChildProcessWithoutNullStreams | undefined;
  // Requests wait here and go to the worker one at a time, so each one's timeout only
  // counts the time the worker spends on it, not time spent behind slower requests.
  private readonly queue : Queued[] = [];
  private inFlight : InFlight | undefined;
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
    return new Promise((resolve) => {
      this.queue.push({ id: this.nextId++, cmd, args, resolve });
      this.pump();
    });
  }

  // Close the worker's input (it exits on its own), and make sure it is gone soon after.
  stop() {
    this.stopped = true;
    for (const q of this.queue.splice(0)) {
      q.resolve({ ok: false, stdout: '', stderr: 'The plugin is shutting down' });
    }
    const child = this.child;
    if (child) {
      child.stdin.end();
      setTimeout(() => child.kill(), 3000).unref();
    }
  }

  // Send the next waiting request, if the worker is free.
  private pump() {
    while (!this.inFlight && this.queue.length > 0 && !this.stopped) {
      const req = this.queue.shift() as Queued;
      const child = this.start();
      if (!child) {
        req.resolve({ ok: false, stdout: '', stderr: 'Could not start the Wyze helper' });
        continue;
      }
      const timer = setTimeout(() => this.timedOut(child), this.opts.timeoutMs);
      this.inFlight = { req, child, timer };
      child.stdin.write(JSON.stringify({ id: req.id, cmd: req.cmd, args: req.args }) + '\n');
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

    createInterface({ input: child.stdout }).on('line', (line) => this.answer(child, line));
    createInterface({ input: child.stderr }).on('line', (line) => {
      this.stderrTail = [...this.stderrTail.slice(-9), line];
      this.opts.log(`Wyze helper: ${line}`);
    });
    child.on('error', (e) => this.ended(child, e.message));
    child.on('exit', (code, signal) => this.ended(child, signal ? `stopped by ${signal}` : `exited with code ${code}`));
    this.opts.log(`Wyze helper started (pid ${child.pid})`);
    return child;
  }

  private answer(child : ChildProcessWithoutNullStreams, line : string) {
    let msg : { id? : number, ok? : boolean, out? : string, err? : string };
    try {
      msg = JSON.parse(line);
    } catch {
      this.opts.log(`Wyze helper sent an unreadable line: ${line.slice(0, 200)}`);
      return;
    }
    const f = this.inFlight;
    if (!f || f.child !== child || msg.id !== f.req.id) {
      return;   // answer to a request that already timed out
    }
    this.finish({ ok: msg.ok === true, stdout: String(msg.out ?? ''), stderr: String(msg.err ?? '') });
  }

  // Answer the request in flight and send the next one.
  private finish(result : PyResult) {
    const f = this.inFlight;
    if (!f) {
      return;
    }
    clearTimeout(f.timer);
    this.inFlight = undefined;
    f.req.resolve(result);
    this.pump();
  }

  // The worker exited or could not be started: fail the request it was working on;
  // waiting requests go to a new worker.
  private ended(child : ChildProcessWithoutNullStreams, how : string) {
    if (this.child !== child) {
      return;   // already handled (error and exit can both fire)
    }
    this.child = undefined;
    const detail = this.stderrTail.length ? `: ${this.stderrTail.join(' | ')}` : '';
    const busy = this.inFlight?.child === child;
    if (!this.stopped || busy) {
      this.opts.log(`Wyze helper ${how}${detail}`);
    }
    if (busy) {
      this.finish({ ok: false, stdout: '', stderr: `The Wyze helper ${how}${detail}` });
    } else {
      this.pump();
    }
  }

  // The request in flight got no answer in time: fail it, kill this worker (the next
  // request starts a new one) and go on with the requests waiting behind it.
  private timedOut(child : ChildProcessWithoutNullStreams) {
    if (this.inFlight?.child !== child) {
      return;
    }
    if (this.child === child) {
      this.child = undefined;
    }
    this.opts.log('Wyze helper did not answer in time and was restarted');
    child.kill();
    this.finish({ ok: false, stdout: '', stderr: `No answer from the Wyze helper within ${this.opts.timeoutMs / 1000} s; restarting it` });
  }
}
