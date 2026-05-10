import { invoke } from "@tauri-apps/api/core";

export type SshConnectResult = {
  session_id: number;
  user: string;
  host: string;
  port: number;
  home: string;
};

export type SftpKind = "file" | "dir" | "symlink";

export type SftpEntry = {
  name: string;
  kind: SftpKind;
  size: number;
  mtime: number;
};

export type RemoteReadResult =
  | { kind: "text"; content: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

export type RemoteSearchHit = {
  path: string;
  rel: string;
  name: string;
  is_dir: boolean;
};

export const sshBridge = {
  connect: (target: string, password?: string) =>
    invoke<SshConnectResult>("ssh_connect", { target, password }),
  disconnect: (sessionId: number) =>
    invoke<void>("ssh_disconnect", { sessionId }),
  readDir: (sessionId: number, path: string) =>
    invoke<SftpEntry[]>("ssh_read_dir", { sessionId, path }),
  readFile: (sessionId: number, path: string) =>
    invoke<RemoteReadResult>("ssh_read_file", { sessionId, path }),
  writeFile: (sessionId: number, path: string, content: string) =>
    invoke<void>("ssh_write_file", { sessionId, path, content }),
  createFile: (sessionId: number, path: string) =>
    invoke<void>("ssh_create_file", { sessionId, path }),
  createDir: (sessionId: number, path: string) =>
    invoke<void>("ssh_create_dir", { sessionId, path }),
  rename: (sessionId: number, from: string, to: string) =>
    invoke<void>("ssh_rename", { sessionId, from, to }),
  delete: (sessionId: number, path: string) =>
    invoke<void>("ssh_delete", { sessionId, path }),
  search: (sessionId: number, root: string, query: string, limit?: number) =>
    invoke<RemoteSearchHit[]>("ssh_search", {
      sessionId,
      root,
      query,
      limit,
    }),
};
