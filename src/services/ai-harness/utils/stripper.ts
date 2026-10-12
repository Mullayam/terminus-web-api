const ANSI_OSC = /\x1B\][0-9];[^\x07]*\x07/g;
const ANSI_CSI = /\x1B\[[0-9;?]*[ -/]*[@-~]/g;
const CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

export function stripAnsi(input: string): string {
  return input.replace(ANSI_OSC, "").replace(ANSI_CSI, "").replace(CONTROL, "").replace(/\r/g, "");
}

export function stripSentinels(input: string, token: string): string {
  const re = new RegExp(`${token}[_A-Za-z0-9:\\-]*`, "g");
  return input
    .replace(re, "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
