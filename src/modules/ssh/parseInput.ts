/**
 * Parses what the user types into the +SSH dialog. Accepts both bare
 * `user@host[:port]` and full ssh-style invocations like
 * `ssh root@host -p 22003 -i ~/.ssh/id_ed25519`. The result feeds three
 * different consumers:
 *
 *  - `rawArgs` — what gets typed into the PTY after `ssh ` (so the user's
 *    flags survive verbatim into the local shell).
 *  - `displayTarget` / `sftpTarget` — `user@host[:port]` for the chip label
 *    and the russh side. russh's `parse_target` understands the `:port`
 *    suffix so we don't need a separate port field on the wire.
 *  - `identityFile` — passed to the backend so the russh auth path tries the
 *    same key the user picked for the PTY.
 *
 * Tokenization is whitespace-only; quoted args with spaces aren't honored
 * (rare in this context, and a paste that needs them would also confuse the
 * PTY's local shell parser unless the user retyped quotes).
 */

const SSH_FLAGS_WITH_VALUE = new Set([
  "-p",
  "-l",
  "-i",
  "-o",
  "-c",
  "-D",
  "-L",
  "-R",
  "-W",
  "-J",
  "-F",
  "-E",
  "-Q",
  "-S",
  "-w",
  "-b",
  "-B",
  "-e",
  "-m",
]);

export type ParsedSshInput = {
  /** What to type after `ssh ` in the PTY (no leading "ssh "). */
  rawArgs: string;
  /** Tab title and chip label (`user@host` or `user@host:port`). */
  displayTarget: string;
  /** Wire format for the russh backend (same as displayTarget). */
  sftpTarget: string;
  /** Absolute or `~/`-rooted private-key path, or null. */
  identityFile: string | null;
};

export function parseSshDialogInput(input: string): ParsedSshInput | null {
  let s = input.trim();
  if (!s) return null;
  if (/^ssh\s+/i.test(s)) s = s.replace(/^ssh\s+/i, "");
  const tokens = s.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  let target: string | null = null;
  let port: number | null = null;
  let identityFile: string | null = null;
  let userOverride: string | null = null;

  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === "--") {
      i++;
      continue;
    }
    if (!t.startsWith("-")) {
      if (target === null) target = t;
      i++;
      continue;
    }
    const flag = t.length === 2 ? t : t.slice(0, 2);
    const inline = t.length > 2 ? t.slice(2) : "";
    if (SSH_FLAGS_WITH_VALUE.has(flag)) {
      const val = inline || tokens[i + 1] || "";
      if (flag === "-p") {
        const n = Number(val);
        if (!Number.isNaN(n) && n > 0) port = n;
      } else if (flag === "-i") {
        identityFile = val || null;
      } else if (flag === "-l") {
        userOverride = val || null;
      }
      i += inline ? 1 : 2;
      continue;
    }
    // Boolean flag (e.g. `-v`, `-A`, bundled `-vvv`).
    i++;
  }

  if (!target) return null;
  if (target.startsWith("ssh://")) target = target.slice("ssh://".length);
  if (userOverride && !target.includes("@")) {
    target = `${userOverride}@${target}`;
  }
  if (target.includes("/")) return null; // looks like a path, not a host

  const displayTarget = port ? `${target}:${port}` : target;
  return {
    rawArgs: s,
    displayTarget,
    sftpTarget: displayTarget,
    identityFile,
  };
}
