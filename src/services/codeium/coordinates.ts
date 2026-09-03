/**
 * Coordinate conversion between Monaco and Codeium (spec §6).
 *
 * Monaco: 1-based lines, 1-based UTF-16 code-unit columns.
 * Codeium: 0-based rows, UTF-8 byte columns, and byte offsets in ranges.
 *
 * Getting this wrong is silent until someone types a non-ASCII character, so
 * every conversion here is byte-exact rather than assuming one char == one byte.
 */

export interface MonacoPosition {
  lineNumber: number;
  column: number;
}

export interface CodeiumCursor {
  row: number;
  col: number;
}

export interface MonacoRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

/** UTF-8 byte length of a string, without allocating a Buffer copy of the whole text. */
function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Splits a document into lines using its declared line ending. Codeium wants the
 * text as one string, but cursor/range math is per-line, so we keep the split.
 */
export function splitLines(text: string, lineEnding: string): string[] {
  // A "\r\n" document still contains lone "\n" only at the declared boundaries;
  // splitting on the declared ending keeps column math aligned with the client.
  return text.split(lineEnding);
}

/**
 * Monaco cursor → Codeium `cursor_position` (§6.1).
 * `col` is the UTF-8 byte offset of the prefix before the cursor on its line.
 */
export function monacoCursorToCodeium(lines: string[], position: MonacoPosition): CodeiumCursor {
  const lineText = lines[position.lineNumber - 1] ?? "";
  const prefix = lineText.slice(0, position.column - 1); // UTF-16 slice
  return {
    row: position.lineNumber - 1,
    col: utf8ByteLength(prefix), // UTF-8 bytes
  };
}

/**
 * Codeium `range` byte offsets → Monaco range (§6.2).
 *
 * When `endOffset > startOffset`, the suggestion replaces the first
 * `(endOffset - startOffset)` bytes of the cursor's line. Returns `undefined`
 * for a pure insertion (client then inserts at the cursor).
 */
export function codeiumRangeToMonaco(
  lineText: string,
  startOffset: number,
  endOffset: number,
  lineNumber: number,
): MonacoRange | undefined {
  const deleteBytes = endOffset - startOffset;
  if (deleteBytes <= 0) return undefined; // insert at cursor

  // Walk the line converting bytes → UTF-16 columns.
  let bytes = 0;
  let utf16 = 0;
  for (const ch of lineText) {
    if (bytes >= deleteBytes) break;
    bytes += utf8ByteLength(ch);
    utf16 += ch.length; // 2 for astral (surrogate-pair) characters
  }

  return {
    startLineNumber: lineNumber,
    startColumn: 1,
    endLineNumber: lineNumber,
    endColumn: utf16 + 1,
  };
}
