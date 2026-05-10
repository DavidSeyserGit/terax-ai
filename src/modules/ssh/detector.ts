/**
 * Per-tab line buffer that sniffs PTY *input* (what the user types) for ssh-
 * shaped lines. We feed raw keystrokes; the buffer assembles a line until the
 * user presses Enter, then we parse for `ssh user@host` invocations.
 *
 * Limitations:
 *  - Arrow-key edits, history recall (Up/Down), and Ctrl-R aren't tracked, so
 *    something like recalling an `ssh ...` line from history won't fire here.
 *    OSC 7 detection on the remote (a follow-up) would catch those.
 *  - Shell aliases that map to `ssh` are invisible to us.
 */

export type SshDetection = {
  kind: "ssh";
  /** Raw target as typed (e.g. "user@host" or "host" or "host:2222"). */
  target: string;
};

export type ExitDetection = { kind: "exit" };

export type CdDetection = {
  kind: "cd";
  /** Raw arg as typed; null when the user typed bare `cd` (= home). */
  target: string | null;
};

export type Detection = SshDetection | ExitDetection | CdDetection;

export class TerminalLineSniffer {
  private buf: string = "";

  /**
   * Feed a chunk of user input. Returns a detection if the user just pressed
   * Enter and the assembled line matches `ssh ...` / `exit` / `logout`.
   */
  feed(chunk: string): Detection | null {
    let detected: Detection | null = null;
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];
      const code = chunk.charCodeAt(i);
      if (ch === "\r" || ch === "\n") {
        const line = this.buf;
        this.buf = "";
        const d = parseLine(line);
        if (d) detected = d;
      } else if (code === 0x7f || code === 0x08) {
        // Backspace / DEL.
        this.buf = this.buf.slice(0, -1);
      } else if (code === 0x03 || code === 0x15) {
        // Ctrl-C / Ctrl-U — clear current line.
        this.buf = "";
      } else if (code === 0x1b) {
        // ANSI escape sequence — skip until we reach the terminator. Cheap
        // approximation: consume through the next final byte (0x40-0x7e).
        i++;
        if (chunk[i] === "[" || chunk[i] === "O") i++;
        while (i < chunk.length) {
          const c = chunk.charCodeAt(i);
          if (c >= 0x40 && c <= 0x7e) break;
          i++;
        }
      } else if (code >= 0x20) {
        this.buf += ch;
        // Cap to a reasonable length so a runaway paste doesn't grow forever.
        if (this.buf.length > 4096) this.buf = this.buf.slice(-2048);
      }
    }
    return detected;
  }

  reset() {
    this.buf = "";
  }
}

const SSH_OPTS_WITH_ARG = new Set([
  "-l",
  "-p",
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

function parseLine(line: string): Detection | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (/^\s*(exit|logout)\s*$/.test(trimmed)) {
    return { kind: "exit" };
  }
  // Strip leading env-prefixes like `FOO=bar ssh ...`.
  const tokens = trimmed.split(/\s+/);
  let i = 0;
  while (i < tokens.length && /^[A-Z_][A-Z0-9_]*=/i.test(tokens[i])) i++;
  if (tokens[i] === "cd") {
    // `cd` (bare) → home; `cd -` → previous (skip, we don't track history);
    // anything else is the target. Quotes stripped because users often
    // wrap a path with spaces.
    const rest = tokens.slice(i + 1).join(" ");
    if (!rest) return { kind: "cd", target: null };
    if (rest.trim() === "-") return null;
    const stripped = rest.replace(/^['"]|['"]$/g, "");
    return { kind: "cd", target: stripped };
  }
  if (tokens[i] !== "ssh") return null;
  i++;
  let portOverride: number | null = null;
  let userOverride: string | null = null;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === "--") {
      i++;
      break;
    }
    if (!t.startsWith("-")) break;
    // -p2222 / -p 2222 / -l user / -lroot.
    if (t.length > 2 && SSH_OPTS_WITH_ARG.has(t.slice(0, 2))) {
      const flag = t.slice(0, 2);
      const val = t.slice(2);
      if (flag === "-p") portOverride = Number(val) || portOverride;
      if (flag === "-l") userOverride = val || userOverride;
      i++;
      continue;
    }
    if (SSH_OPTS_WITH_ARG.has(t)) {
      if (t === "-p") portOverride = Number(tokens[i + 1]) || portOverride;
      if (t === "-l") userOverride = tokens[i + 1] || userOverride;
      i += 2;
      continue;
    }
    // Single-char no-arg flag (e.g. -v, -A, -X) or bundled (-vvv).
    i++;
  }
  const dest = tokens[i];
  if (!dest) return null;
  // Skip schemes we can't connect to via plain SSH (e.g. ssh://).
  let target = dest.startsWith("ssh://") ? dest.slice("ssh://".length) : dest;
  if (userOverride && !target.includes("@")) {
    target = `${userOverride}@${target}`;
  }
  if (portOverride && !/:\d+$/.test(target)) {
    target = `${target}:${portOverride}`;
  }
  // Reject obvious garbage (paths, urls).
  if (target.startsWith("-") || target.includes("/")) return null;
  return { kind: "ssh", target };
}
