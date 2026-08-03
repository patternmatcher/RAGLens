const SECRET_PATTERNS = [
  {
    label: 'openai-api-key',
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g
  },
  {
    label: 'generic-api-key',
    pattern: /\b(api[_-]?key|token|secret|password)\s*[:=]\s*["']?([A-Za-z0-9_./+=-]{16,})["']?/gi
  },
  {
    label: 'aws-access-key',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g
  },
  {
    label: 'private-key-block',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
  }
];

export function redactSecrets(text, knownSecrets = []) {
  let redacted = String(text || '');
  const findings = [];

  for (const { label, pattern } of SECRET_PATTERNS) {
    let count = 0;
    redacted = redacted.replace(pattern, () => {
      count += 1;
      return `[REDACTED:${label}]`;
    });

    if (count) {
      findings.push({ label, count });
    }
  }

  for (const secret of normalizedSecrets(knownSecrets)) {
    const occurrences = redacted.split(secret).length - 1;
    if (!occurrences) continue;
    redacted = redacted.split(secret).join('[REDACTED:known-secret]');
    findings.push({ label: 'known-secret', count: occurrences });
  }

  return {
    text: redacted,
    findings
  };
}

function normalizedSecrets(values) {
  return [...new Set((Array.isArray(values) ? values : [values])
    .map((value) => String(value || ''))
    .filter((value) => value.length >= 8))]
    .sort((left, right) => right.length - left.length);
}
