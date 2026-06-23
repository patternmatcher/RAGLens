export function sourceLabelForChunk(chunk) {
  return `D${labelId(chunk)}:C${Number(chunk.index || 0) + 1}`;
}

export function labelMapForRetrieved(retrieved) {
  return new Map(
    retrieved
      .filter((item) => item?.chunk)
      .map((item) => [sourceLabelForChunk(item.chunk), item.chunk.id])
  );
}

function labelId(chunk = {}) {
  const parts = [compactId(chunk.documentId), compactId(chunk.id)].filter(Boolean);
  return parts.join('') || 'DOC';
}

function compactId(value) {
  const suffix = String(value || '').split('_').at(-1) || '';
  return suffix.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 12);
}
