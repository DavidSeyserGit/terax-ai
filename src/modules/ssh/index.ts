export { sshBridge } from "./bridge";
export type {
  RemoteReadResult,
  RemoteSearchHit,
  SftpEntry,
  SftpKind,
  SshConnectResult,
} from "./bridge";
export { TerminalLineSniffer } from "./detector";
export type { Detection } from "./detector";
export { normalizePosix, resolveRemoteCd } from "./path";
export {
  useSshStore,
  useTabSshSession,
  type SshStatus,
  type SshTabSession,
} from "./sshStore";
