import { sshBridge } from "@/modules/ssh";
import { invoke } from "@tauri-apps/api/core";
import type { DirEntry } from "./useFileTree";

export type FsSearchHit = {
  path: string;
  rel: string;
  name: string;
  is_dir: boolean;
};

/**
 * Filesystem operations the explorer needs. The local implementation talks
 * to the OS via Tauri commands; the remote implementation wraps SFTP.
 *
 * Path strings are always absolute and use POSIX separators — both adapters
 * receive them unchanged and treat them as native paths in their respective
 * filesystems.
 */
export type FsAdapter = {
  readonly id: string;
  readDir(path: string): Promise<DirEntry[]>;
  createFile(path: string): Promise<void>;
  createDir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  delete(path: string): Promise<void>;
  search(root: string, query: string, limit: number): Promise<FsSearchHit[]>;
};

export const localFsAdapter: FsAdapter = {
  id: "local",
  readDir: (path) => invoke<DirEntry[]>("fs_read_dir", { path }),
  createFile: (path) => invoke<void>("fs_create_file", { path }),
  createDir: (path) => invoke<void>("fs_create_dir", { path }),
  rename: (from, to) => invoke<void>("fs_rename", { from, to }),
  delete: (path) => invoke<void>("fs_delete", { path }),
  search: (root, query, limit) =>
    invoke<FsSearchHit[]>("fs_search", { root, query, limit }),
};

export function makeRemoteFsAdapter(sessionId: number): FsAdapter {
  return {
    id: `ssh:${sessionId}`,
    readDir: (path) => sshBridge.readDir(sessionId, path),
    createFile: (path) => sshBridge.createFile(sessionId, path),
    createDir: (path) => sshBridge.createDir(sessionId, path),
    rename: (from, to) => sshBridge.rename(sessionId, from, to),
    delete: (path) => sshBridge.delete(sessionId, path),
    search: (root, query, limit) => sshBridge.search(sessionId, root, query, limit),
  };
}
