export function sourceLabelForChunk(chunk) {
  const page = pageLabel(chunk);
  return `D${labelId(chunk)}${page}:C${Number(chunk.index || 0) + 1}`;
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

function pageLabel(chunk) {
  if (chunk?.pageNumbersExact !== true || !Number.isInteger(Number(chunk.pageStart ?? chunk.page))) {
    return '';
  }
  const start = Number(chunk.pageStart ?? chunk.page);
  const end = Number(chunk.pageEnd ?? start);
  return end > start ? `:P${start}-${end}` : `:P${start}`;
}
