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

export function redactSecrets(text) {
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

  return {
    text: redacted,
    findings
  };
}
