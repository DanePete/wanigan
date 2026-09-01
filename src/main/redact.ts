/**
 * One credential redactor, shared by every surface that persists text a person
 * can later read back, export, or send on to somebody else.
 *
 * Wanigan grew four independent versions of this filter, of unequal strength,
 * and that is the failure worth naming rather than the individual rules: every
 * time a new credential shape was learned it was added to whichever file the
 * author happened to be in, which left the other three blind to it. The policy
 * ledger — the most exportable artifact in the app — ended up with the weakest
 * of the four. One function means a shape learned once is covered everywhere.
 *
 * Nothing here preserves a secret's shape or length, and the rules over-redact
 * at their edges on purpose: an unquoted value is swallowed to the next
 * separator. Losing a little surrounding context is the cheaper mistake.
 *
 * It applies to file paths and search patterns as well as to prose. A Grep
 * pattern is frequently the secret somebody was hunting for, and a path can be
 * a URL or a temp file named after a token; there is no credential shape a
 * path is allowed to keep that a sentence is not.
 */
export function redactCredentials(value: string): string {
  return value
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi, '[REDACTED PRIVATE KEY]')
    // Any URL scheme: postgres://, redis://, mongodb+srv:// carry passwords too.
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]*:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/\b(authorization|proxy-authorization)\s*:\s*(?:bearer|basic)?\s*[^\s,;]+/gi, '$1: [REDACTED]')
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]')
    .replace(/\b([A-Za-z_][A-Za-z0-9_]*(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_]*)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s]+)/gi, '$1=[REDACTED]')
    // Colon-form env-style names: "API_KEY: value" in YAML/.env-shaped output.
    .replace(/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/g, '$1$2[REDACTED]')
    .replace(/(--(?:api[-_]?key|token|auth(?:entication)?[-_]?token|password|passwd|secret|credential|access[-_]?key)(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s]+)/gi, '$1[REDACTED]')
    .replace(/\b(api\s*key|access\s*key|auth\s*token|token|secret|password|passwd|credential)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1: [REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16})\b/g, '[REDACTED CREDENTIAL]')
    // Underscore prefixes: sk_live_/pk_test_-style keys and webhook secrets.
    .replace(/\b(?:whsec_[A-Za-z0-9]{8,}|[a-z]{2,6}_(?:live|test)_[A-Za-z0-9]{8,})\b/g, '[REDACTED CREDENTIAL]')
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, '[REDACTED TOKEN]');
}
