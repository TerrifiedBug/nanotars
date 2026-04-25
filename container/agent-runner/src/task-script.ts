import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SCRIPT_TIMEOUT_MS = 30_000;
const SCRIPT_MAX_BUFFER = 1024 * 1024;

export interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}

function log(msg: string): void {
  console.error(`[task-script] ${msg}`);
}

export async function runScript(script: string, taskId: string): Promise<ScriptResult | null> {
  const scriptPath = path.join('/tmp', `task-script-${taskId}.sh`);
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return new Promise((resolve) => {
    execFile(
      'bash',
      [scriptPath],
      { timeout: SCRIPT_TIMEOUT_MS, maxBuffer: SCRIPT_MAX_BUFFER, env: process.env },
      (error, stdout, stderr) => {
        try {
          fs.unlinkSync(scriptPath);
        } catch {
          /* best-effort cleanup */
        }

        if (stderr) {
          log(`[${taskId}] stderr: ${stderr.slice(0, 500)}`);
        }

        if (error) {
          log(`[${taskId}] error: ${error.message}`);
          return resolve(null);
        }

        const lines = stdout.trim().split('\n');
        const lastLine = lines[lines.length - 1];
        if (!lastLine) {
          log(`[${taskId}] no output`);
          return resolve(null);
        }

        try {
          const result = JSON.parse(lastLine);
          if (typeof result.wakeAgent !== 'boolean') {
            log(`[${taskId}] output missing wakeAgent boolean: ${lastLine.slice(0, 200)}`);
            return resolve(null);
          }
          resolve(result as ScriptResult);
        } catch {
          log(`[${taskId}] output is not valid JSON: ${lastLine.slice(0, 200)}`);
          resolve(null);
        }
      },
    );
  });
}
