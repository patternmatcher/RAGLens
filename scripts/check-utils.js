import net from 'node:net';

export async function findOpenPort(host = '127.0.0.1') {
  const server = net.createServer();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });

  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export async function waitForHealth(url, options = {}) {
  const deadline = Date.now() + (options.timeoutMs || 10_000);
  const childState = options.childState || (() => ({}));

  while (Date.now() < deadline) {
    const child = childState();
    if (child.exited) {
      throw new Error(`RAGLens server exited before becoming healthy.${child.output ? `\n${child.output}` : ''}`);
    }

    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  throw new Error('RAGLens server did not become healthy.');
}

export function trackChild(child) {
  const state = {
    exited: false,
    output: ''
  };

  child.stdout?.on('data', (chunk) => {
    state.output += chunk.toString();
  });
  child.stderr?.on('data', (chunk) => {
    state.output += chunk.toString();
  });
  child.on('exit', (code, signal) => {
    state.exited = true;
    state.output += `\nExited with code ${code ?? 'null'} signal ${signal ?? 'null'}.`;
  });

  return () => state;
}

export async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 3_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill();
  });
}
