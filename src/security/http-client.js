const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

export async function fetchNoRedirect(fetchImpl, url, options = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('Fetch is unavailable in this runtime.');
  }
  return fetchImpl(url, {
    ...options,
    redirect: 'error'
  });
}

export async function readJsonResponse(response, options = {}) {
  const text = await readTextResponse(response, options);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${options.label || 'Remote service'} returned invalid JSON.`);
  }
}

export async function readTextResponse(response, options = {}) {
  const bytes = await readResponseBytes(response, options);
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

export async function readResponseBytes(response, options = {}) {
  const label = options.label || 'Remote service';
  const maxBytes = positiveLimit(options.maxBytes, DEFAULT_MAX_BYTES);
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel?.();
    throw new Error(`${label} response exceeded the ${maxBytes}-byte limit.`);
  }
  if (!response.body?.getReader) {
    throw new Error(`${label} response body is not stream-readable.`);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error(`${label} response exceeded the ${maxBytes}-byte limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function positiveLimit(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}
