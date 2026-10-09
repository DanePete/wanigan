// JSON with comments, as Gemini CLI reads its settings.json: it passes the text
// through strip-json-comments before JSON.parse (settings.ts, Gemini CLI 0.46),
// so `//` and `/* */` comments outside strings are allowed and nothing else is.

/** The text with its comments taken out, strings untouched. */
export function stripJsonComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      out += ' ';
      i = end === -1 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** A JSON object read the way Gemini reads one, or null. */
export function parseJsonc(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(stripJsonComments(text)) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
