export function nowIso() {
  return new Date().toISOString();
}

export function msSince(startedAt) {
  return Math.max(0, Math.round(performance.now() - startedAt));
}
