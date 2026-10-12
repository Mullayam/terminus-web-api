const SENTINEL_PREFIX = "__AIH";

export interface SentinelMarks {
  token: string;
  startMark: string;
  endMark: string;
}

export function buildSentinelMarks(): SentinelMarks {
  const token = `${SENTINEL_PREFIX}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  return { token, startMark: `${token}_S`, endMark: `${token}_E` };
}

export function buildPtyCommand(command: string, marks: SentinelMarks): string {
  return (
    `printf '%s\\n' '${marks.startMark}'; ` +
    `${command}\n` +
    `printf '%s:%s\\n' '${marks.endMark}' "$?"\n`
  );
}
