export type DangerLevel = "safe" | "confirm" | "blocked";

export interface DangerVerdict {
  level: DangerLevel;
  reason: string;
}

const BLOCKED_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\brm\s+(-\w*\s+)*-\w*r\w*f|\brm\s+(-\w*\s+)*-\w*f\w*r/i, reason: "Recursive forced deletion (rm -rf)" },
  { re: /\brm\s+(-\w*\s+)*-\w*r\b/i, reason: "Recursive deletion (rm -r)" },
  { re: /\bfind\b.*-delete\b/i, reason: "Bulk deletion via find" },
  { re: /\b(shred|wipefs)\b/i, reason: "Secure erase" },
  { re: /\bmkfs(\.\w+)?\b/i, reason: "Filesystem format" },
  { re: /\bdd\b.*\bof=\/dev\//i, reason: "Raw write to a block device" },
  { re: />\s*\/dev\/(sd|nvme|hd|vd)\w+/i, reason: "Redirect into a block device" },
  { re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: "Fork bomb" },
  { re: /\bdrop\s+(database|table)\b/i, reason: "Destructive SQL (DROP)" },
  { re: /\btruncate\s+table\b/i, reason: "Destructive SQL (TRUNCATE TABLE)" },
  { re: /\bgit\s+reset\s+--hard\b/i, reason: "Discard local git changes" },
  { re: /\bgit\s+clean\s+-\w*f\w*d|\bgit\s+clean\s+-\w*d\w*f/i, reason: "Remove untracked files (git clean -fd)" },
  { re: /\bgit\s+push\b.*(--force\b|\s-f\b)/i, reason: "Force push" },
];

const CONFIRM_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: "Host power-state change" },
  { re: /\binit\s+[06]\b/i, reason: "Runlevel change to halt or reboot" },
  { re: /\bchmod\s+-\w*R\w*\s+/i, reason: "Recursive permission change" },
  { re: /\bchown\s+-\w*R\w*\s+/i, reason: "Recursive ownership change" },
  { re: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i, reason: "Pipe remote script into a shell" },
  { re: /\b(userdel|groupdel|deluser)\b/i, reason: "Account deletion" },
  { re: /\bpasswd\b/i, reason: "Password change" },
  { re: /\biptables\s+-F\b|\bnft\s+flush\b|\bufw\s+(deny|reset|disable)\b/i, reason: "Firewall change" },
  { re: /\bkill(all)?\s+-9\s+-1\b/i, reason: "Kill all processes" },
  { re: /\b(fdisk|parted|sgdisk)\b/i, reason: "Partition table change" },
  { re: />\s*\/etc\//i, reason: "Overwrite a system config file" },
  { re: /\bsystemctl\s+(stop|disable|mask)\b/i, reason: "Stop, disable, or mask a service" },
  { re: /\bdocker\s+(rm|rmi|system\s+prune)\b/i, reason: "Remove Docker resources" },
  { re: /\bdocker(\s+compose|-compose)\s+down\b.*-v\b/i, reason: "Remove Docker volumes" },
  { re: /\bkubectl\s+delete\b/i, reason: "Delete Kubernetes resources" },
  { re: /\bhelm\s+uninstall\b/i, reason: "Uninstall a Helm release" },
  { re: /\bterraform\s+destroy\b/i, reason: "Destroy infrastructure" },
  { re: /\b(apt-get|apt|yum|dnf)\b.*\bautoremove\b/i, reason: "Mass package removal" },
  { re: /\btruncate\s+-s\s*0\b/i, reason: "Truncate a file to zero bytes" },
];

export function classifyCommand(command: string): DangerVerdict {
  const normalized = command.trim();
  for (const entry of BLOCKED_PATTERNS) {
    if (entry.re.test(normalized)) return { level: "blocked", reason: entry.reason };
  }
  for (const entry of CONFIRM_PATTERNS) {
    if (entry.re.test(normalized)) return { level: "confirm", reason: entry.reason };
  }
  return { level: "safe", reason: "" };
}
