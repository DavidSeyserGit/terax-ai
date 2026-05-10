import {
  consumePendingSshPassword,
  TerminalLineSniffer,
  useSshStore,
} from "@/modules/ssh";
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
  /** When set, the pane runs `ssh <args>` (verbatim, no quoting) after the
   *  shell starts and consumes the queued one-shot password from
   *  pendingPasswords.ts. The dialog is responsible for shell-safe args. */
  pendingSshArgs?: string;
  onSearchReady?: (tabId: number, addon: SearchAddon) => void;
  onExit?: (tabId: number, code: number) => void;
  onCwd?: (tabId: number, cwd: string) => void;
  onDetectedLocalUrl?: (tabId: number, url: string) => void;
  onSshAutologinDone?: (tabId: number) => void;
};

export const TerminalPane = forwardRef<TerminalPaneHandle, Props>(
  function TerminalPane(
    {
      tabId,
      visible,
      initialCwd,
      pendingSshArgs,
      onSearchReady,
      onExit,
      onCwd,
      onDetectedLocalUrl,
      onSshAutologinDone,
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const { resolvedTheme } = useTheme();
    const snifferRef = useRef<TerminalLineSniffer | null>(null);
    if (snifferRef.current === null) snifferRef.current = new TerminalLineSniffer();

    // Snapshot the args on first render — props can churn but the autologin
    // only runs once. We pull the password lazily from pendingPasswords so it
    // never lands in component state.
    const autoSshLoginRef = useRef<{ args: string } | null>(
      pendingSshArgs ? { args: pendingSshArgs } : null,
    );
    const onSshAutologinDoneRef = useRef(onSshAutologinDone);
    onSshAutologinDoneRef.current = onSshAutologinDone;

    const session = useTerminalSession({
      container: containerRef,
      visible,
      initialCwd,
      autoSshLogin: autoSshLoginRef.current
        ? {
            args: autoSshLoginRef.current.args,
            consumePassword: () => consumePendingSshPassword(tabId),
            onLoginCompleted: () => onSshAutologinDoneRef.current?.(tabId),
          }
        : undefined,
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
        }
        // We used to also resolve `cd <target>` from the typed input, but
        // tab-completion / aliases / Up-arrow recall happen server-side and
        // never appear in the input stream — so we'd drift out of sync. The
        // OSC 7 emitter installed after autologin is now authoritative.
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
