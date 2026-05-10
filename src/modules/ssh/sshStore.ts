import { create } from "zustand";
import { sshBridge } from "./bridge";

export type SshStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "error"
  | "disconnecting";

export type SshTabSession = {
  tabId: number;
  status: SshStatus;
  target: string;
  user?: string;
  host?: string;
  port?: number;
  home?: string;
  cwd?: string;
  sessionId?: number;
  error?: string;
};

type State = {
  sessions: Record<number, SshTabSession>;
  beginConnect: (tabId: number, target: string, password?: string) => Promise<void>;
  disconnect: (tabId: number) => Promise<void>;
  /** Manually clear a tab's SSH state (e.g. when the tab is being torn down). */
  clear: (tabId: number) => void;
  setCwd: (tabId: number, cwd: string) => void;
};

export const useSshStore = create<State>((set, get) => ({
  sessions: {},
  beginConnect: async (tabId, target, password) => {
    const existing = get().sessions[tabId];
    if (existing && existing.status === "connecting") return;
    if (existing?.status === "connected" && existing.target === target) return;
    // If an old session is hanging around for this tab, tear it down first.
    if (existing?.sessionId !== undefined) {
      try {
        await sshBridge.disconnect(existing.sessionId);
      } catch {
        // ignore — best-effort cleanup
      }
    }
    set((s) => ({
      sessions: {
        ...s.sessions,
        [tabId]: { tabId, status: "connecting", target },
      },
    }));
    try {
      const result = await sshBridge.connect(target, password);
      set((s) => {
        // The user may have already started another connect/disconnect by the
        // time the result lands — bail out if so.
        const cur = s.sessions[tabId];
        if (!cur || cur.status !== "connecting" || cur.target !== target) {
          // Stale result; close the orphan session so we don't leak it.
          void sshBridge.disconnect(result.session_id).catch(() => undefined);
          return s;
        }
        return {
          sessions: {
            ...s.sessions,
            [tabId]: {
              tabId,
              status: "connected",
              target,
              user: result.user,
              host: result.host,
              port: result.port,
              home: result.home,
              cwd: result.home,
              sessionId: result.session_id,
            },
          },
        };
      });
    } catch (e) {
      set((s) => {
        const cur = s.sessions[tabId];
        if (!cur || cur.target !== target) return s;
        return {
          sessions: {
            ...s.sessions,
            [tabId]: { ...cur, status: "error", error: String(e) },
          },
        };
      });
    }
  },
  disconnect: async (tabId) => {
    const cur = get().sessions[tabId];
    if (!cur) return;
    if (cur.sessionId !== undefined) {
      set((s) => ({
        sessions: {
          ...s.sessions,
          [tabId]: { ...cur, status: "disconnecting" },
        },
      }));
      try {
        await sshBridge.disconnect(cur.sessionId);
      } catch {
        // ignore
      }
    }
    set((s) => {
      const next = { ...s.sessions };
      delete next[tabId];
      return { sessions: next };
    });
  },
  clear: (tabId) => {
    const cur = get().sessions[tabId];
    if (cur?.sessionId !== undefined) {
      void sshBridge.disconnect(cur.sessionId).catch(() => undefined);
    }
    set((s) => {
      const next = { ...s.sessions };
      delete next[tabId];
      return { sessions: next };
    });
  },
  setCwd: (tabId, cwd) => {
    set((s) => {
      const cur = s.sessions[tabId];
      if (!cur) return s;
      return {
        sessions: { ...s.sessions, [tabId]: { ...cur, cwd } },
      };
    });
  },
}));

export function useTabSshSession(
  tabId: number | null | undefined,
): SshTabSession | null {
  return useSshStore((s) => (tabId == null ? null : (s.sessions[tabId] ?? null)));
}
