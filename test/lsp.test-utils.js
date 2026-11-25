import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const wrapperPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'wrapper.mjs');
const HEADER_SEPARATOR = '\r\n\r\n';

export async function createProject(files) {
  const dir = await mkdtemp(path.join(tmpdir(), 'zed-knip-project-'));
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(dir, name);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }
  return dir;
}

function createClient(child, settings) {
  let buffer = Buffer.alloc(0);
  let nextId = 1;
  let stderr = '';
  let exitResolve;
  const pending = new Map();
  const queues = new Map();
  const waiters = new Map();
  const diagnostics = new Map();
  const refreshWaiters = [];
  const state = { inlayRefreshes: 0 };
  const exited = new Promise(resolve => {
    exitResolve = resolve;
  });

  const send = message => {
    const body = JSON.stringify(message);
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  };

  const fail = error => {
    for (const waiter of [...pending.values()]) waiter.reject(error);
    pending.clear();
    for (const list of [...waiters.values()]) for (const waiter of [...list]) waiter.reject(error);
    waiters.clear();
  };

  const handleNotification = (method, params) => {
    if (method === 'textDocument/publishDiagnostics') {
      diagnostics.set(params.uri, params.diagnostics);
      return;
    }
    const list = waiters.get(method);
    if (list?.length) {
      const waiter = list.shift();
      if (list.length === 0) waiters.delete(method);
      waiter.resolve(params);
      return;
    }
    const queue = queues.get(method) ?? [];
    queue.push(params);
    queues.set(method, queue);
  };

  const handleServerRequest = ({ id, method, params }) => {
    if (method === 'workspace/inlayHint/refresh') {
      state.inlayRefreshes++;
      const waiter = refreshWaiters.shift();
      if (waiter) waiter();
    }
    const result = method === 'workspace/configuration' ? (params?.items ?? []).map(() => settings) : null;
    send({ jsonrpc: '2.0', id, result });
  };

  const handleMessage = message => {
    if (message.method && message.id !== undefined) {
      handleServerRequest(message);
      return;
    }
    if (message.method) {
      handleNotification(message.method, message.params);
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  };

  child.stderr.on('data', chunk => {
    stderr += chunk;
  });
  child.on('exit', code => {
    fail(new Error(`language server exited (${code}): ${stderr}`));
    exitResolve();
  });
  child.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf(HEADER_SEPARATOR);
      if (headerEnd === -1) return;
      const header = buffer.subarray(0, headerEnd).toString();
      const match = /Content-Length: (\d+)/i.exec(header);
      const start = headerEnd + HEADER_SEPARATOR.length;
      const end = start + (match ? Number(match[1]) : 0);
      if (buffer.length < end) return;
      const payload = buffer.subarray(start, end).toString();
      buffer = buffer.subarray(end);
      if (!payload) continue;
      handleMessage(JSON.parse(payload));
    }
  });

  const request = (method, params, timeout = 30000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const signal = AbortSignal.timeout(timeout);
      const onAbort = () => {
        pending.delete(id);
        reject(new Error(`timed out waiting for ${method}: ${stderr}`));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      pending.set(id, {
        resolve: value => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        reject: error => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      });
      send({ jsonrpc: '2.0', id, method, params });
    });

  const waitForNotification = (method, timeout = 30000) => {
    const queue = queues.get(method);
    if (queue?.length) return Promise.resolve(queue.shift());
    return new Promise((resolve, reject) => {
      const signal = AbortSignal.timeout(timeout);
      const waiter = {
        resolve: value => {
          cleanup();
          resolve(value);
        },
        reject: error => {
          cleanup();
          reject(error);
        },
      };
      const cleanup = () => {
        signal.removeEventListener('abort', onAbort);
        const list = waiters.get(method);
        if (!list) return;
        const index = list.indexOf(waiter);
        if (index !== -1) list.splice(index, 1);
        if (list.length === 0) waiters.delete(method);
      };
      const onAbort = () => waiter.reject(new Error(`timed out waiting for ${method}: ${stderr}`));
      signal.addEventListener('abort', onAbort, { once: true });
      const list = waiters.get(method) ?? [];
      list.push(waiter);
      waiters.set(method, list);
    });
  };

  const waitForInlayRefresh = (timeout = 30000) => {
    return new Promise((resolve, reject) => {
      const signal = AbortSignal.timeout(timeout);
      const waiter = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        signal.removeEventListener('abort', onAbort);
        const index = refreshWaiters.indexOf(waiter);
        if (index !== -1) refreshWaiters.splice(index, 1);
      };
      const onAbort = () => {
        cleanup();
        reject(new Error(`timed out waiting for inlay hint refresh: ${stderr}`));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      refreshWaiters.push(waiter);
    });
  };

  return {
    request,
    notify: (method, params) => send({ jsonrpc: '2.0', method, params }),
    waitForNotification,
    waitForInlayRefresh,
    diagnostics,
    state,
    async close() {
      child.kill();
      await exited;
    },
  };
}

export async function startServer({ files, settings = {}, initializationOptions = {}, waitForGraph = true }) {
  const projectDir = await createProject(files);
  const child = spawn(process.execPath, [wrapperPath, '--stdio'], {
    cwd: projectDir,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const client = createClient(child, settings);
  await client.request('initialize', {
    processId: process.pid,
    rootUri: pathToFileURL(projectDir).href,
    capabilities: {
      workspace: { configuration: true, didChangeWatchedFiles: { dynamicRegistration: true } },
      textDocument: { hover: { contentFormat: ['markdown'] }, inlayHint: {} },
    },
    workspaceFolders: [{ uri: pathToFileURL(projectDir).href, name: 'fixture' }],
    initializationOptions,
  });
  client.notify('initialized', {});
  const server = {
    projectDir,
    client,
    async close() {
      await client.close();
      await rm(projectDir, { recursive: true, force: true });
    },
  };
  try {
    if (waitForGraph) await client.waitForNotification('knip.moduleGraphBuilt');
  } catch (error) {
    await server.close();
    throw error;
  }
  return server;
}
