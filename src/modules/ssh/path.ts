/**
 * POSIX path helpers for tracking a remote shell's current directory. Always
 * forward-slash; we never run on a Windows remote (SFTP servers expose POSIX
 * paths even when hosted on Windows OpenSSH, so this is safe).
 */

export function normalizePosix(path: string): string {
  const absolute = path.startsWith("/");
  const parts = path.split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(p);
  }
  const joined = out.join("/");
  return absolute ? `/${joined}` : joined || ".";
}

/**
 * Resolves a `cd` target against a base directory the way bash/zsh would,
 * *except* we don't honor CDPATH (rare and ambiguous).
 */
export function resolveRemoteCd(
  base: string,
  target: string,
  home?: string,
): string {
  if (target.startsWith("/")) {
    return normalizePosix(target);
  }
  if (target === "~") {
    return home ? normalizePosix(home) : base;
  }
  if (target.startsWith("~/")) {
    return home ? normalizePosix(`${home}/${target.slice(2)}`) : base;
  }
  // Other `~user` forms (e.g. ~root) require a remote lookup we don't do.
  if (target.startsWith("~")) return base;
  return normalizePosix(`${base}/${target}`);
}
