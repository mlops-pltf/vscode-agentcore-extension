const vscode = require('vscode');
const cp = require('child_process');
const path = require('path');
const readline = require('readline');

// Restart the Python bridge after these delays if it crashes; give up when it
// crashes more than RESTART_DELAYS_MS.length times within CRASH_WINDOW_MS
const RESTART_DELAYS_MS = [1000, 3000, 10000];
const CRASH_WINDOW_MS = 60000;

// Runs python/bridge.py and keeps it running. Messages go in as JSON lines on
// stdin (with the current settings attached); events come back on stdout.
class PythonBridge {
  /**
   * @param {object} options
   * @param {string} options.extensionDir   folder containing python/bridge.py
   * @param {() => Promise<string>} options.findPython   resolves the Python to use
   * @param {() => object} options.getSettings   settings attached to every message
   * @param {object} options.log   the Output channel
   * @param {(message: object) => void} options.onMessage   events for the panel
   * @param {(state: string) => void} options.onState   'ready' | 'restarting' | 'down'
   * @param {object} [options.env]   extra environment variables for Python (e.g. the chat history folder)
   */
  constructor({ extensionDir, findPython, getSettings, log, onMessage, onState, env }) {
    this._env = env || {};
    this._extensionDir = extensionDir;
    this._findPython = findPython;
    this._getSettings = getSettings;
    this._log = log;
    this._onMessage = onMessage;
    this._onState = onState;
    this._process = undefined;
    // Messages sent before Python is running (e.g. during first-time venv setup)
    this._pending = [];
    // Times of recent unexpected exits, for restart backoff
    this._crashTimes = [];
    this._disposed = false;
  }

  get process() {
    return this._process;
  }

  async start() {
    if (this._disposed || this._process) return;
    let pythonPath;
    try {
      pythonPath = await this._findPython();
    } catch (e) {
      this._log.error(`Python environment setup failed: ${e.message}`);
      return;
    }
    // Something else may have started or stopped the bridge while we waited
    if (this._disposed || this._process) return;

    const scriptPath = path.join(this._extensionDir, 'python', 'bridge.py');
    this._log.info(`Starting Python bridge: ${pythonPath} ${scriptPath}`);
    const proc = cp.spawn(pythonPath, [scriptPath], { env: { ...process.env, ...this._env } });
    this._process = proc;

    readline.createInterface({ input: proc.stdout }).on('line', (line) => this._onLine(line));
    proc.stderr.on('data', (data) => {
      for (const line of String(data).split(/\r?\n/)) {
        if (line.trim()) this._log.warn(`[python] ${line}`);
      }
    });
    // Writing to a process that just died raises EPIPE; log it instead of crashing
    proc.stdin.on('error', (e) => this._log.warn(`Python stdin: ${e.message}`));
    proc.on('error', (e) => {
      this._log.error(`Python bridge could not start: ${e.message}`);
      this._onExit(proc, null, null);
    });
    proc.on('exit', (code, signal) => this._onExit(proc, code, signal));

    this._onState('ready');
    for (const payload of this._pending.splice(0)) {
      this.send(payload);
    }
  }

  stop() {
    const proc = this._process;
    this._process = undefined;
    if (proc) {
      proc.stoppedOnPurpose = true;
      proc.kill();
    }
  }

  async restart() {
    this._crashTimes = [];
    this.stop();
    await this.start();
  }

  send(payload) {
    if (this._process && this._process.stdin.writable) {
      this._process.stdin.write(JSON.stringify({ ...payload, settings: this._getSettings() }) + '\n');
    } else {
      this._pending.push(payload);
    }
  }

  dispose() {
    this._disposed = true;
    this.stop();
  }

  _onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this._log.error(`Invalid JSON from Python: ${line}`);
      return;
    }
    // Raw response lines are for the Output channel only (debugRawResponses)
    if (message.type === 'raw') {
      this._log.info(`[raw ${String(message.requestId).slice(0, 8)}] ${message.line}`);
      return;
    }
    // Python's own log lines (events.log), also for the Output channel only
    if (message.type === 'log') {
      const write = { warn: 'warn', error: 'error' }[message.level] || 'info';
      this._log[write](String(message.message));
      return;
    }
    if (message.type === 'error') {
      this._log.warn(`Error: ${message.message}`);
    }
    this._onMessage(message);
  }

  _onExit(proc, code, signal) {
    // 'error' and 'exit' can both fire for one process
    if (proc.exitHandled) return;
    proc.exitHandled = true;
    if (this._process === proc) this._process = undefined;

    if (proc.stoppedOnPurpose || this._disposed) {
      this._log.info('Python bridge stopped');
      return;
    }

    this._log.error(`Python bridge exited unexpectedly (code ${code}, signal ${signal})`);
    const now = Date.now();
    this._crashTimes = this._crashTimes.filter((t) => now - t < CRASH_WINDOW_MS).concat(now);
    const attempt = this._crashTimes.length;

    if (attempt > RESTART_DELAYS_MS.length) {
      this._onState('down');
      vscode.window
        .showErrorMessage('AgentCore Chat: the Python backend keeps crashing.', 'Show Logs', 'Restart')
        .then((choice) => {
          if (choice === 'Show Logs') this._log.show();
          if (choice === 'Restart') this.restart();
        });
      return;
    }

    const delay = RESTART_DELAYS_MS[attempt - 1];
    this._log.info(`Restarting Python bridge in ${delay / 1000}s (attempt ${attempt} of ${RESTART_DELAYS_MS.length})`);
    this._onState('restarting');
    setTimeout(() => this.start(), delay);
  }
}

module.exports = { PythonBridge };
