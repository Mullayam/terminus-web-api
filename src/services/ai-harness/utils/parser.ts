export function buildEndMatcher(endMark: string): RegExp {
  return new RegExp(`${endMark}:(-?\\d+)`);
}

export function parseExitCode(buffer: string, endMark: string): number | null {
  const match = buffer.match(buildEndMatcher(endMark));
  return match ? Number(match[1]) : null;
}

export function sliceAfterStart(buffer: string, startMark: string): { found: boolean; rest: string } {
  const idx = buffer.indexOf(`${startMark}\n`);
  if (idx === -1) return { found: false, rest: buffer };
  return { found: true, rest: buffer.slice(idx + startMark.length + 1) };
}

export function sliceBeforeEnd(buffer: string, endMark: string): string {
  const idx = buffer.indexOf(endMark);
  return idx === -1 ? buffer : buffer.slice(0, idx);
}
