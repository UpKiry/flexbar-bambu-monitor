// Diagnostics are deliberately lossy: unknown free text and URLs may contain credentials.
const HIDDEN = "[已隐藏]";
const SENSITIVE = /token|password|passwd|secret|authorization|cookie|credential|access.?code|verify|verification|captcha|signature|email|phone|mobile|account|user.?id|^uid$|address|nickname|avatar|real.?name|first.?name|last.?name|full.?name|display.?name|user.?name|api.?key|access.?key|private.?key|ssid|contact|location|ip.?address|^ip$|^code$/i;
const PRIVATE = /^(?:name|dev_name|project_name|task_name|subtask_name|gcode_file|file|filename)$/i;

function sanitizeText(value) {
  return String(value)
    .replace(/https?:\/\/[^\s"'<>]+/gi, HIDDEN)
    .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, HIDDEN)
    .replace(/\b(?:\+?\d[ -]?){10,15}\b/g, HIDDEN)
    .replace(/(bearer\s+)[\w.~+/=-]+/gi, `$1${HIDDEN}`)
    .replace(/\b((?:[\w-]*(?:token|password|passwd|secret|authorization|cookie|access[_-]?code|verification[_-]?code|verify[_-]?code|signature|email|phone|account)[\w-]*|code)\s*["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;}]+)/gi, `$1"${HIDDEN}"`);
}

/** Bound traversal as well as output, and never retain references to inbound data. */
function sanitizePayload(value, { maxBytes = 32 * 1024, maxNodes = 2048, maxDepth = 16 } = {}) {
  let budget = Math.max(64, maxBytes);
  let nodes = 0;
  let truncated = false;
  const seen = new WeakSet();
  function visit(item, depth) {
    if (++nodes > maxNodes || depth > maxDepth || budget < 32) {
      truncated = true;
      return "[已截断]";
    }
    budget -= 16;
    if (item === null || typeof item === "boolean" || typeof item === "number") return item;
    if (typeof item === "string") {
      // Slice before regex work; never export an unredacted prefix of a long value.
      if (Buffer.byteLength(item) > budget / 6) {
        truncated = true;
        return "[已截断]";
      }
      const safe = sanitizeText(item);
      budget -= Buffer.byteLength(safe) * 6;
      return safe;
    }
    if (!item || typeof item !== "object") return null;
    if (seen.has(item)) { truncated = true; return "[已截断]"; }
    seen.add(item);
    const output = Array.isArray(item) ? [] : Object.create(null);
    for (const key of Object.keys(item)) {
      if (budget < 64 || nodes >= maxNodes) { truncated = true; break; }
      if (key.length > 120) { truncated = true; continue; }
      const safeKey = sanitizeText(key);
      budget -= Buffer.byteLength(safeKey) * 6 + 16;
      const child = SENSITIVE.test(key) || PRIVATE.test(key) ? HIDDEN : visit(item[key], depth + 1);
      Object.defineProperty(output, safeKey, { value: child, enumerable: true, writable: true, configurable: true });
    }
    return output;
  }
  const payload = visit(value, 0);
  return { payload, truncated };
}

module.exports = { sanitizePayload, sanitizeText };
