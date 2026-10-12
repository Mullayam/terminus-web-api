/**
 * Security boundary for agent-proposed commands.
 *
 * The LLM only ever *suggests* a command. This module decides what risk tier it
 * falls into and whether it may run. Classification is deny-biased: anything not
 * positively recognised as read-only is treated as at least `medium`.
 */

export type RiskLevel = "safe" | "medium" | "dangerous" | "blocked";

export interface RiskAssessment {
  risk: RiskLevel;
  requiresApproval: boolean;
  /** Human-readable justification, surfaced to the user in the approval prompt */
  reason: string;
  /** Which rule produced the verdict, for auditing */
  rule: string;
}

export interface PolicyOptions {
  /** Auto-approve `medium` commands (default false) */
  autoApproveMedium?: boolean;
  /** Refuse `dangerous` commands outright instead of prompting (default false) */
  denyDangerous?: boolean;
}

/** Read-only binaries that cannot mutate state on their own. */
const READ_ONLY_BINARIES = new Set([
  "ls", "cat", "head", "tail", "less", "more", "stat", "file", "wc", "du", "df",
  "pwd", "whoami", "id", "hostname", "uname", "uptime", "date", "env", "printenv",
  "ps", "top", "free", "vmstat", "iostat", "lsof", "netstat", "ss", "ip", "dig",
  "nslookup", "ping", "traceroute", "grep", "egrep", "fgrep", "rg", "find", "which",
  "whereis", "readlink", "realpath", "basename", "dirname", "echo", "sort", "uniq",
  "cut", "awk", "sed", "diff", "md5sum", "sha256sum", "tree", "journalctl", "dmesg",
  "git", "docker", "kubectl", "systemctl", "curl", "wget",
]);

/**
 * Subcommands that make an otherwise read-only binary mutating.
 * Anything not listed for these binaries is treated as non-read-only.
 */
const READ_ONLY_SUBCOMMANDS: Record<string, Set<string>> = {
  git: new Set(["status", "log", "diff", "show", "branch", "remote", "config", "blame", "describe"]),
  docker: new Set(["ps", "images", "logs", "inspect", "stats", "version", "info", "top", "port", "diff"]),
  kubectl: new Set(["get", "describe", "logs", "top", "explain", "version", "api-resources", "config"]),
  systemctl: new Set(["status", "list-units", "list-unit-files", "is-active", "is-enabled", "show", "cat"]),
};

/** Patterns that are destructive, irreversible, or grant/exfiltrate access. */
const DANGEROUS_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\brm\s+(-[a-z]*[rf][a-z]*\s+)*\/(\s|$)/i, reason: "Recursive delete targeting filesystem root" },
  { re: /\brm\s+-[a-z]*[rf]/i, reason: "Recursive or forced file deletion" },
  { re: /\b(mkfs|fdisk|parted|wipefs)\b/i, reason: "Disk formatting or partitioning" },
  { re: /\bdd\b[^|]*\bof=/i, reason: "Raw disk write via dd" },
  { re: /:\(\)\s*\{.*\}\s*;\s*:/, reason: "Fork bomb" },
  { re: /\b(shutdown|reboot|halt|poweroff|init\s+0|init\s+6)\b/i, reason: "Host shutdown or reboot" },
  { re: /\bchmod\s+(-[a-z]+\s+)*777\b/i, reason: "World-writable permissions" },
  { re: /\bchown\s+-R\b/i, reason: "Recursive ownership change" },
  { re: /\b(useradd|userdel|usermod|passwd|visudo)\b/i, reason: "User or credential modification" },
  { re: /\b(iptables|ufw|firewall-cmd)\b/i, reason: "Firewall modification" },
  { re: /\bcrontab\b/i, reason: "Scheduled task modification" },
  { re: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|k|)sh\b/i, reason: "Piping remote content into a shell" },
  { re: /\b(cat|less|more|head|tail)\s+[^|;&]*(id_rsa|id_ed25519|\.pem|\.key|shadow|\.env|credentials)/i, reason: "Reading secrets or private keys" },
  { re: /\bhistory\s+-c\b|\btruncate\b[^|]*log/i, reason: "Log or history tampering" },
  { re: />\s*\/dev\/(sd|nvme|hd)/i, reason: "Writing directly to a block device" },
];

/** Shell constructs that let a command do more than its leading binary implies. */
const COMPOSITION_PATTERN = /[;&|]|\$\(|`|>>?|<\(/;

/** Strip quoted spans so metacharacters inside string literals don't trip detection. */
function stripQuoted(command: string): string {
  return command.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
}

function leadingBinary(segment: string): { bin: string; sub?: string } {
  const parts = segment.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  // Skip env assignments and privilege escalation wrappers.
  while (i < parts.length && /^[A-Z_][A-Z0-9_]*=/.test(parts[i])) i++;
  let bin = (parts[i] ?? "").replace(/^.*\//, "");
  if (bin === "sudo" || bin === "doas" || bin === "su") {
    i++;
    bin = (parts[i] ?? "").replace(/^.*\//, "");
  }
  const sub = parts[i + 1]?.startsWith("-") ? parts[i + 2] : parts[i + 1];
  return { bin, sub };
}

function isReadOnlySegment(segment: string): boolean {
  const { bin, sub } = leadingBinary(segment);
  if (!bin || !READ_ONLY_BINARIES.has(bin)) return false;

  const allowedSubs = READ_ONLY_SUBCOMMANDS[bin];
  if (allowedSubs) return !!sub && allowedSubs.has(sub);

  // curl/wget are read-only only when they are not writing to disk or executing.
  if (bin === "curl" || bin === "wget") {
    return !/\s(-o|-O|--output|--remote-name)\b/i.test(segment);
  }
  // sed/awk in-place edits mutate files.
  if (bin === "sed" && /\s-i\b/.test(segment)) return false;
  return true;
}

export function assessCommand(command: string, policy: PolicyOptions = {}): RiskAssessment {
  const trimmed = command.trim();

  if (!trimmed) {
    return { risk: "blocked", requiresApproval: false, reason: "Empty command", rule: "empty" };
  }
  if (trimmed.length > 4000) {
    return {
      risk: "blocked",
      requiresApproval: false,
      reason: "Command exceeds the 4000 character limit",
      rule: "length",
    };
  }

  const scannable = stripQuoted(trimmed);

  for (const { re, reason } of DANGEROUS_PATTERNS) {
    if (re.test(scannable)) {
      if (policy.denyDangerous) {
        return { risk: "blocked", requiresApproval: false, reason, rule: re.source };
      }
      return { risk: "dangerous", requiresApproval: true, reason, rule: re.source };
    }
  }

  // Every segment of a compound command must be read-only for the whole to be safe.
  const segments = scannable.split(/&&|\|\||[;|]/).filter((s) => s.trim());
  const allReadOnly = segments.length > 0 && segments.every(isReadOnlySegment);

  if (allReadOnly && !/>>?/.test(scannable) && !/\$\(|`/.test(scannable)) {
    return {
      risk: "safe",
      requiresApproval: false,
      reason: "Read-only inspection command",
      rule: "read-only-allowlist",
    };
  }

  const composed = COMPOSITION_PATTERN.test(scannable);
  return {
    risk: "medium",
    requiresApproval: !policy.autoApproveMedium,
    reason: composed
      ? "Command uses shell composition, redirection, or substitution and may modify state"
      : "Command is not on the read-only allowlist and may modify state",
    rule: composed ? "composition" : "not-allowlisted",
  };
}
