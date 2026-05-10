import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Cancel01Icon,
  FileAddIcon,
  Folder01Icon,
  FolderAddIcon,
  Globe02Icon,
  Loading03Icon,
  Logout03Icon,
  Refresh01Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/lib/utils";
import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SshTabSession } from "@/modules/ssh";
import { useSshStore } from "@/modules/ssh";
import { FileTreeNode } from "./FileTreeNode";
import { InlineInput } from "./InlineInput";
import { copyToClipboard, revealInFinder } from "./lib/contextActions";
import { localFsAdapter, makeRemoteFsAdapter, type FsAdapter, type FsSearchHit } from "./lib/fsAdapter";
import { fileIconUrl, folderIconUrl } from "./lib/iconResolver";
import { COMPACT_CONTENT, COMPACT_ITEM } from "./lib/menuItemClass";
import { useFileTree } from "./lib/useFileTree";

type SearchHit = FsSearchHit;

type OpenFileOpts = { sshSessionId?: number; sshLabel?: string };

type Props = {
  rootPath: string | null;
  onOpenFile: (path: string, opts?: OpenFileOpts) => void;
  onPathRenamed?: (from: string, to: string) => void;
  onPathDeleted?: (path: string) => void;
  onRevealInTerminal?: (path: string) => void;
  onAttachToAgent?: (path: string) => void;
  /** Active terminal's SSH session, if any. When connected, the explorer
   *  switches to a remote SFTP backend rooted at the remote $HOME. */
  ssh?: SshTabSession | null;
  /** Called when the user disconnects from the chip; lets the host send
   *  `exit` to the matching PTY so terminal + sidebar stay in sync. */
  onSshDisconnect?: (tabId: number) => void;
};

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

export function FileExplorer({
  rootPath,
  onOpenFile,
  onPathRenamed,
  onPathDeleted,
  onRevealInTerminal,
  onAttachToAgent,
  ssh,
  onSshDisconnect,
}: Props) {
  const disconnectSsh = (tabId: number) => {
    if (onSshDisconnect) onSshDisconnect(tabId);
    else void useSshStore.getState().disconnect(tabId);
  };
  // Pick the FS backend to drive the tree. A connected SSH tab swaps in a
  // SFTP-backed adapter and reroots the explorer at the remote $HOME.
  const isRemote = ssh?.status === "connected" && ssh.sessionId !== undefined;
  const fs: FsAdapter = useMemo(
    () =>
      isRemote && ssh?.sessionId !== undefined
        ? makeRemoteFsAdapter(ssh.sessionId)
        : localFsAdapter,
    [isRemote, ssh?.sessionId],
  );
  const effectiveRoot = isRemote
    ? (ssh?.cwd ?? ssh?.home ?? "/")
    : rootPath;
  const tree = useFileTree(effectiveRoot, { onPathRenamed, onPathDeleted, fs });

  // Wrap onOpenFile so callers in this tree always get the right SSH context.
  // useMemo isn't worth the dep churn — closure identity doesn't matter here.
  const openFileWithCtx = (path: string) => {
    if (isRemote && ssh?.sessionId !== undefined) {
      const label = ssh.user && ssh.host ? `${ssh.user}@${ssh.host}` : ssh.target;
      onOpenFile(path, { sshSessionId: ssh.sessionId, sshLabel: label });
    } else {
      onOpenFile(path);
    }
  };
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchHit[]>([]);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  type FlatItem = { path: string; isDir: boolean };
  const flat = useMemo<FlatItem[]>(() => {
    if (!effectiveRoot) return [];
    const out: FlatItem[] = [];
    const walk = (parent: string) => {
      const node = tree.nodes[parent];
      if (!node || node.status !== "loaded") return;
      for (const e of node.entries) {
        const p = tree.joinPath(parent, e.name);
        const isDir = e.kind === "dir";
        out.push({ path: p, isDir });
        if (isDir && tree.expanded.has(p)) walk(p);
      }
    };
    walk(effectiveRoot);
    return out;
  }, [effectiveRoot, tree.nodes, tree.expanded, tree.joinPath]);

  useEffect(() => {
    if (selectedPath && !flat.some((f) => f.path === selectedPath)) {
      setSelectedPath(null);
    }
  }, [flat, selectedPath]);

  useEffect(() => {
    if (!effectiveRoot) return;
    const q = query.trim();
    if (!q) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    let alive = true;
    // Remote search is much slower than local (one round-trip per directory),
    // so we debounce more aggressively when SSH'd.
    const debounce = isRemote ? 300 : 120;
    const handle = setTimeout(async () => {
      try {
        const hits = await fs.search(effectiveRoot, q, 200);
        if (alive) setResults(hits);
      } catch (e) {
        if (alive) {
          console.error("search failed:", e);
          setResults([]);
        }
      } finally {
        if (alive) setSearching(false);
      }
    }, debounce);
    return () => {
      alive = false;
      clearTimeout(handle);
    };
  }, [query, effectiveRoot, fs, isRemote]);

  // Connecting / error states show a status banner instead of the empty-tree
  // placeholder so the user can see what's happening with the SSH connection.
  if (ssh && ssh.status !== "connected") {
    return (
      <div className="flex h-full flex-col">
        <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border/60 px-2">
          <SshChip ssh={ssh} cwd={ssh.cwd} onDisconnect={() => disconnectSsh(ssh.tabId)} />
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          {ssh.status === "connecting" || ssh.status === "disconnecting" ? (
            <>
              <HugeiconsIcon
                icon={Loading03Icon}
                size={20}
                strokeWidth={1.5}
                className="animate-spin text-muted-foreground"
              />
              <div className="text-xs text-muted-foreground">
                {ssh.status === "connecting"
                  ? `Connecting to ${ssh.target}…`
                  : "Disconnecting…"}
              </div>
            </>
          ) : (
            <SshErrorPanel ssh={ssh} />
          )}
        </div>
      </div>
    );
  }

  if (!effectiveRoot) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <HugeiconsIcon
          icon={Folder01Icon}
          size={24}
          strokeWidth={1.5}
          className="text-muted-foreground"
        />
        <div className="text-xs text-muted-foreground">
          No current directory
        </div>
      </div>
    );
  }

  const root = tree.nodes[effectiveRoot];
  const pendingAtRoot =
    tree.pendingCreate?.parentPath === effectiveRoot ? tree.pendingCreate : null;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (tree.renaming || tree.pendingCreate || query.trim()) return;
    const target = e.target as HTMLElement;
    if (
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.isContentEditable
    )
      return;
    if (flat.length === 0) return;

    const currentIdx = selectedPath
      ? flat.findIndex((f) => f.path === selectedPath)
      : -1;

    const move = (next: number) => {
      const clamped = Math.max(0, Math.min(flat.length - 1, next));
      const path = flat[clamped].path;
      setSelectedPath(path);
      requestAnimationFrame(() => {
        const el = listRef.current?.querySelector<HTMLElement>(
          `[data-fs-path="${CSS.escape(path)}"]`,
        );
        el?.scrollIntoView({ block: "nearest" });
      });
    };

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(currentIdx < 0 ? 0 : currentIdx + 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(currentIdx < 0 ? flat.length - 1 : currentIdx - 1);
        break;
      case "ArrowRight": {
        if (currentIdx < 0) return;
        e.preventDefault();
        const item = flat[currentIdx];
        if (item.isDir) {
          if (!tree.expanded.has(item.path)) tree.toggle(item.path);
          else move(currentIdx + 1);
        }
        break;
      }
      case "ArrowLeft": {
        if (currentIdx < 0) return;
        e.preventDefault();
        const item = flat[currentIdx];
        if (item.isDir && tree.expanded.has(item.path)) {
          tree.toggle(item.path);
        } else {
          const parent = item.path.slice(0, item.path.lastIndexOf("/"));
          if (parent && parent !== effectiveRoot) setSelectedPath(parent);
        }
        break;
      }
      case "Enter":
        if (currentIdx < 0) return;
        e.preventDefault();
        {
          const item = flat[currentIdx];
          if (item.isDir) tree.toggle(item.path);
          else openFileWithCtx(item.path);
        }
        break;
    }
  };

  return (
    <div
      className="flex h-full flex-col outline-none"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border/60 px-2">
        {ssh && ssh.status === "connected" ? (
          <SshChip ssh={ssh} cwd={ssh.cwd} onDisconnect={() => disconnectSsh(ssh.tabId)} />
        ) : (
          <span
            className="flex-1 flex truncate text-xs font-medium text-foreground/80"
            title={effectiveRoot}
          >
            <img
              src={folderIconUrl(basename(effectiveRoot), false)}
              alt=""
              height={15}
              width={15}
              className="mx-1.5"
            />
            {basename(effectiveRoot)}
          </span>
        )}

        <Button
          variant="ghost"
          size="icon"
          className="size-6 text-muted-foreground hover:text-foreground"
          onClick={() => setIsSearchOpen(!isSearchOpen)}
          title="Search"
        >
          <HugeiconsIcon icon={Search01Icon} size={13} strokeWidth={2} />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="size-6 text-muted-foreground hover:text-foreground"
          onClick={() => tree.beginCreate(effectiveRoot, "file")}
          title="New file"
        >
          <HugeiconsIcon icon={FileAddIcon} size={13} strokeWidth={2} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 text-muted-foreground hover:text-foreground"
          onClick={() => tree.beginCreate(effectiveRoot, "dir")}
          title="New folder"
        >
          <HugeiconsIcon icon={FolderAddIcon} size={13} strokeWidth={2} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 text-muted-foreground hover:text-foreground"
          onClick={() => tree.refresh(effectiveRoot)}
          title="Refresh"
        >
          <HugeiconsIcon icon={Refresh01Icon} size={12} strokeWidth={2} />
        </Button>
      </div>

      {isSearchOpen && (
        <motion.div
          className="relative shrink-0 px-2 py-1.5"
          initial={{ opacity: 0, transform: "translateY(-15px)" }}
          animate={{ opacity: 1, transform: "translateY(0px)" }}
        >
          <HugeiconsIcon
            icon={Search01Icon}
            size={13}
            strokeWidth={2}
            className="absolute top-1/2 left-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search files…"
            className="h-7 pr-7 pl-6.5 text-xs"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute top-1/2 right-3.5 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="Clear search"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
            </button>
          ) : null}
        </motion.div>
      )}

      {query.trim() ? (
        <ScrollArea className="min-h-0 flex-1">
          <div className="py-1">
            {searching && results.length === 0 ? (
              <div className="px-3 py-2 text-[11px] text-muted-foreground">
                Searching…
              </div>
            ) : results.length === 0 ? (
              <div className="px-3 py-2 text-[11px] text-muted-foreground">
                No matches
              </div>
            ) : (
              results.map((hit) => {
                const url = hit.is_dir ? null : fileIconUrl(hit.name);
                return (
                  <button
                    key={hit.path}
                    type="button"
                    onClick={() => {
                      if (!hit.is_dir) openFileWithCtx(hit.path);
                    }}
                    className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs hover:bg-accent"
                    title={hit.path}
                  >
                    {url ? (
                      <img src={url} alt="" className="size-3.5 shrink-0" />
                    ) : (
                      <HugeiconsIcon
                        icon={Folder01Icon}
                        size={13}
                        strokeWidth={1.75}
                        className="shrink-0 text-muted-foreground"
                      />
                    )}
                    <span className="truncate">{hit.name}</span>
                    <span className="ml-auto truncate text-[10px] text-muted-foreground">
                      {hit.rel}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </ScrollArea>
      ) : (
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <ScrollArea className="min-h-0 flex-1">
              <div className="py-1" ref={listRef}>
                {pendingAtRoot && (
                  <div
                    className="flex w-full items-center gap-1.5 px-1.5 py-0.5 text-xs"
                    style={{ paddingLeft: 6 }}
                  >
                    <span className="size-3 shrink-0" />
                    <span className="size-4 shrink-0" />
                    <InlineInput
                      initial=""
                      placeholder={
                        pendingAtRoot.kind === "dir" ? "New folder" : "New file"
                      }
                      onCommit={tree.commitCreate}
                      onCancel={tree.cancelCreate}
                    />
                  </div>
                )}
                {root?.status === "loading" && (
                  <div className="px-3 py-2 text-[11px] text-muted-foreground">
                    Loading…
                  </div>
                )}
                {root?.status === "error" && (
                  <div className="px-3 py-2 text-[11px] text-destructive">
                    {root.message}
                  </div>
                )}
                {root?.status === "loaded" &&
                  root.entries.map((entry) => (
                    <FileTreeNode
                      key={entry.name}
                      entry={entry}
                      parentPath={effectiveRoot}
                      rootPath={effectiveRoot}
                      depth={0}
                      tree={tree}
                      onOpenFile={openFileWithCtx}
                      onRevealInTerminal={isRemote ? undefined : onRevealInTerminal}
                      onAttachToAgent={isRemote ? undefined : onAttachToAgent}
                      selectedPath={selectedPath}
                      onSelectPath={setSelectedPath}
                      isRemote={isRemote}
                    />
                  ))}
              </div>
            </ScrollArea>
          </ContextMenuTrigger>
          <ContextMenuContent className={COMPACT_CONTENT}>
            {onRevealInTerminal && !isRemote && (
              <ContextMenuItem
                className={COMPACT_ITEM}
                onSelect={() => onRevealInTerminal(effectiveRoot)}
              >
                Open in Terminal
              </ContextMenuItem>
            )}
            {!isRemote && (
              <ContextMenuItem
                className={COMPACT_ITEM}
                onSelect={() => void revealInFinder(effectiveRoot)}
              >
                Reveal in Finder
              </ContextMenuItem>
            )}
            <ContextMenuSeparator />
            <ContextMenuItem
              className={COMPACT_ITEM}
              onSelect={() => tree.beginCreate(effectiveRoot, "file")}
            >
              New File
            </ContextMenuItem>
            <ContextMenuItem
              className={COMPACT_ITEM}
              onSelect={() => tree.beginCreate(effectiveRoot, "dir")}
            >
              New Folder
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              className={COMPACT_ITEM}
              onSelect={() => void copyToClipboard(effectiveRoot)}
            >
              Copy Path
            </ContextMenuItem>
            <ContextMenuItem
              className={COMPACT_ITEM}
              onSelect={() => tree.refresh(effectiveRoot)}
            >
              Refresh
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      )}
    </div>
  );
}

function SshErrorPanel({ ssh }: { ssh: SshTabSession }) {
  const [password, setPassword] = useState("");
  const submit = () => {
    const pw = password;
    setPassword("");
    void useSshStore.getState().beginConnect(ssh.tabId, ssh.target, pw || undefined);
  };
  return (
    <>
      <HugeiconsIcon
        icon={Globe02Icon}
        size={20}
        strokeWidth={1.5}
        className="text-destructive"
      />
      <div className="text-[11px] leading-snug text-destructive break-words max-w-[18rem]">
        {ssh.error ?? "SSH connection failed"}
      </div>
      <div className="text-[10px] leading-snug text-muted-foreground max-w-[18rem]">
        Your terminal SSH session is unaffected. The sidebar uses a separate
        SFTP connection. Enter the password for{" "}
        <span className="font-mono text-foreground/80">{ssh.target}</span> to
        unlock the file tree, or run <span className="font-mono">ssh-add</span>{" "}
        in another terminal.
      </div>
      <form
        className="flex w-full max-w-[18rem] flex-col gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          className="h-7 text-xs"
        />
        <div className="flex gap-2">
          <Button
            type="submit"
            size="sm"
            className="h-6 flex-1 text-[11px]"
            disabled={!password}
          >
            Connect
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 text-[11px]"
            onClick={() =>
              void useSshStore.getState().beginConnect(ssh.tabId, ssh.target)
            }
            title="Retry without password (key/agent only)"
          >
            Retry
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 text-[11px]"
            onClick={() => useSshStore.getState().clear(ssh.tabId)}
          >
            Dismiss
          </Button>
        </div>
      </form>
    </>
  );
}

function SshChip({
  ssh,
  cwd,
  onDisconnect,
}: {
  ssh: SshTabSession;
  cwd?: string | null;
  onDisconnect?: () => void;
}) {
  const label = ssh.user && ssh.host ? `${ssh.user}@${ssh.host}` : ssh.target;
  // Truncate the cwd to its leaf for the chip; full path is in the title.
  const cwdLeaf = cwd && cwd !== ssh.home
    ? cwd.replace(/\/$/, "").split("/").filter(Boolean).pop() ?? cwd
    : null;
  const tone =
    ssh.status === "connected"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
      : ssh.status === "error"
        ? "border-destructive/40 bg-destructive/10 text-destructive"
        : "border-border/60 bg-card/60 text-muted-foreground";
  const dotTone =
    ssh.status === "connected"
      ? "bg-emerald-400 shadow-[0_0_6px_currentColor]"
      : ssh.status === "error"
        ? "bg-destructive"
        : "bg-muted-foreground/60 animate-pulse";

  return (
    <div
      className="flex flex-1 items-center gap-1.5 truncate"
      title={`ssh ${label}${cwd ? `\n${cwd}` : ""}`}
    >
      <div
        className={cn(
          "flex flex-1 min-w-0 items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[11px] font-medium",
          tone,
        )}
      >
        <HugeiconsIcon icon={Globe02Icon} size={11} strokeWidth={2} className="shrink-0" />
        <span className="truncate font-mono">{label}</span>
        {cwdLeaf && (
          <>
            <span className="text-muted-foreground/60 shrink-0">·</span>
            <span className="truncate font-mono text-foreground/70">{cwdLeaf}</span>
          </>
        )}
        <span className={cn("ml-auto size-1.5 shrink-0 rounded-full", dotTone)} />
      </div>
      {ssh.status === "connected" && (
        <Button
          variant="ghost"
          size="icon"
          className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => onDisconnect?.()}
          title="Disconnect SSH (also exits the terminal session)"
        >
          <HugeiconsIcon icon={Logout03Icon} size={11} strokeWidth={2} />
        </Button>
      )}
    </div>
  );
}
