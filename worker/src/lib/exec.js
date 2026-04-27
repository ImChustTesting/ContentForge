import { spawn } from 'node:child_process';
import { logger } from './logger.js';

const STDOUT_KEEP = 4 * 1024;

export class ShellError extends Error {
  constructor(message, { code, signal, cmd, args, stderr } = {}) {
    super(message);
    this.code = code;
    this.signal = signal;
    this.cmd = cmd;
    this.args = args;
    this.stderr = stderr;
  }
}

export function execShell(cmd, args, opts = {}) {
  const {
    cwd,
    env = process.env,
    timeoutMs = 30 * 60 * 1000,
    onStderr,
    captureStdout = false
  } = opts;

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env });
    let stdoutTail = '';
    let stderrTail = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
      reject(new ShellError(`${cmd} timed out after ${timeoutMs}ms`, {
        cmd, args, code: null, signal: 'SIGKILL', stderr: stderrTail
      }));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      if (captureStdout) {
        stdoutTail += chunk.toString();
        if (stdoutTail.length > STDOUT_KEEP) stdoutTail = stdoutTail.slice(-STDOUT_KEEP);
      }
    });
    child.stderr.on('data', (chunk) => {
      const s = chunk.toString();
      stderrTail += s;
      if (stderrTail.length > STDOUT_KEEP) stderrTail = stderrTail.slice(-STDOUT_KEEP);
      if (onStderr) onStderr(s);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (killed) return;
      reject(new ShellError(`spawn ${cmd} failed: ${err.message}`, {
        cmd, args, code: null, signal: null, stderr: stderrTail
      }));
    });

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (killed) return;
      if (code === 0) {
        resolve({ stdout: stdoutTail, stderr: stderrTail });
      } else {
        logger.warn({ cmd, args, code, signal, stderrTail }, 'shell command failed');
        reject(new ShellError(`${cmd} exited with code ${code}`, {
          cmd, args, code, signal, stderr: stderrTail
        }));
      }
    });
  });
}
