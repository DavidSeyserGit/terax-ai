import { resolveRemoteCd, TerminalLineSniffer, useSshStore } from "@/modules/ssh";
import { useTheme } from "@/modules/theme";
import type { SearchAddon } from "@xterm/addon-search";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { useTerminalSession } from "./lib/useTerminalSession";

export type TerminalPaneHandle = {
  write: (data: string) => void;
  focus: () => void;
  getBuffer: (maxLines?: number) => string | null;
  getSelection: () => string | null;
};

type Props = {
  tabId: number;
  visible: boolean;
  initialCwd?: string;
  onSearchReady?: (tabId: number, addon: SearchAddon) => void;
  onExit?: (tabId: number, code: number) => void;
  onCwd?: (tabId: number, cwd: string) => void;
  onDetectedLocalUrl?: (tabId: number, url: string) => void;
};

export const TerminalPane = forwardRef<TerminalPaneHandle, Props>(
  function TerminalPane(
    {
      tabId,
      visible,
      initialCwd,
      onSearchReady,
      onExit,
      onCwd,
      onDetectedLocalUrl,
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const { resolvedTheme } = useTheme();
    const snifferRef = useRef<TerminalLineSniffer | null>(null);
    if (snifferRef.current === null) snifferRef.current = new TerminalLineSniffer();

    const session = useTerminalSession({
      container: containerRef,
      visible,
      initialCwd,
      onSearchReady: (a) => onSearchReady?.(tabId, a),
      onExit: (c) => onExit?.(tabId, c),
      onCwd: (c) => {
        // OSC 7 from the remote shell (when it's set up) is the most reliable
        // cwd signal; mirror it into the SSH session if one is connected.
        const sshSession = useSshStore.getState().sessions[tabId];
        if (sshSession?.status === "connected") {
          useSshStore.getState().setCwd(tabId, c);
        }
        onCwd?.(tabId, c);
      },
      onDetectedLocalUrl: (u) => onDetectedLocalUrl?.(tabId, u),
      onUserInput: (chunk) => {
        const detection = snifferRef.current?.feed(chunk);
        if (!detection) return;
        const store = useSshStore.getState();
        if (detection.kind === "ssh") {
          void store.beginConnect(tabId, detection.target);
        } else if (detection.kind === "exit") {
          // The remote shell is being torn down; release our parallel SFTP
          // session too so the badge clears and the explorer falls back to
          // the local FS.
          void store.disconnect(tabId);
        } else if (detection.kind === "cd") {
          // Best-effort cwd tracking when the remote shell doesn't emit OSC
          // 7. We only act on a connected SSH session — local `cd` already
          // gets picked up via the local OSC 7 handler.
          const sshSession = store.sessions[tabId];
          if (sshSession?.status !== "connected") return;
          const base = sshSession.cwd ?? sshSession.home ?? "/";
          const next = detection.target
            ? resolveRemoteCd(base, detection.target, sshSession.home)
            : (sshSession.home ?? base);
          store.setCwd(tabId, next);
        }
      },
    });

    useEffect(() => {
      // Drop any lingering SSH session when the pane unmounts (tab closed).
      return () => {
        useSshStore.getState().clear(tabId);
      };
    }, [tabId]);

    useEffect(() => {
      // Defer one frame so CSS-variable token resolution sees the new class.
      const id = requestAnimationFrame(() => session.applyTheme());
      return () => cancelAnimationFrame(id);
    }, [resolvedTheme, session]);

    useImperativeHandle(
      ref,
      () => ({
        write: (data: string) => session.write(data),
        focus: () => session.focus(),
        getBuffer: (max?: number) => session.getBuffer(max),
        getSelection: () => session.getSelection(),
      }),
      [session],
    );

    return (
      <div
        ref={containerRef}
        className="h-full w-full"
        style={{
          visibility: visible ? "visible" : "hidden",
          pointerEvents: visible ? "auto" : "none",
        }}
      />
    );
  },
);
