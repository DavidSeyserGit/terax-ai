use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use russh::client::{self, AuthResult, Handle, Handler};
use russh::keys::agent::client::AgentClient;
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;

/// All connections share a default russh config; individual sessions don't
/// override it today. Wrapped in `Arc` so cloning is cheap on every connect.
fn default_client_config() -> Arc<client::Config> {
    Arc::new(client::Config::default())
}

/// Trust-on-first-use is acceptable for this MVP — terminals already establish
/// their own SSH session via the system `ssh` binary, and the user has already
/// reviewed that host fingerprint there. A future iteration should consult
/// ~/.ssh/known_hosts.
pub struct SkipHostKey;

impl Handler for SkipHostKey {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

pub struct SshSession {
    pub handle: Handle<SkipHostKey>,
    pub user: String,
    pub host: String,
    #[allow(dead_code)] // surfaced to the UI; kept for future reconnect logic
    pub port: u16,
    pub home: String,
}

impl SshSession {
    /// Opens a fresh sftp subsystem channel. Each operation gets its own —
    /// keeping a long-lived SftpSession around proved fragile because dropped
    /// channels poison the wrapper's internal state.
    async fn open_sftp(&self) -> Result<SftpSession, String> {
        let channel = self
            .handle
            .channel_open_session()
            .await
            .map_err(|e| format!("channel_open_session: {e}"))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| format!("request_subsystem(sftp): {e}"))?;
        SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| format!("sftp init: {e}"))
    }
}

#[derive(Default)]
pub struct SshState {
    sessions: Mutex<HashMap<u64, Arc<SshSession>>>,
    next_id: Mutex<u64>,
}

impl SshState {
    async fn next_id(&self) -> u64 {
        let mut g = self.next_id.lock().await;
        *g += 1;
        *g
    }

    pub async fn get(&self, id: u64) -> Result<Arc<SshSession>, String> {
        let map = self.sessions.lock().await;
        map.get(&id)
            .cloned()
            .ok_or_else(|| format!("ssh session {id} not found"))
    }

    pub async fn insert(&self, session: SshSession) -> u64 {
        let id = self.next_id().await;
        let mut map = self.sessions.lock().await;
        map.insert(id, Arc::new(session));
        id
    }

    pub async fn remove(&self, id: u64) -> Option<Arc<SshSession>> {
        let mut map = self.sessions.lock().await;
        map.remove(&id)
    }
}

/// Resolves a connect target, defaulting the user to the current local user
/// (matches the system `ssh` CLI's behavior).
pub fn parse_target(target: &str, default_user: &str) -> (String, String, u16) {
    let (user, host_port) = match target.split_once('@') {
        Some((u, h)) => (u.to_string(), h.to_string()),
        None => (default_user.to_string(), target.to_string()),
    };
    let (host, port) = match host_port.rsplit_once(':') {
        Some((h, p)) => (h.to_string(), p.parse().unwrap_or(22)),
        None => (host_port, 22u16),
    };
    (user, host, port)
}

/// Authenticates against the server using whatever credentials are reachable
/// without prompting the user:
///   1. ssh-agent (via `$SSH_AUTH_SOCK`) — covers encrypted keys the user has
///      already unlocked with `ssh-add`, the common case on macOS/Linux.
///   2. Unencrypted private keys at the standard `~/.ssh/id_*` paths.
///
/// Returns a hint-rich error if everything fails; passwords and passphrase
/// prompts are out of scope for this iteration.
pub async fn authenticate(
    handle: &mut Handle<SkipHostKey>,
    user: &str,
    password: Option<&str>,
    identity_file: Option<&str>,
) -> Result<(), String> {
    let mut errors: Vec<String> = Vec::new();
    let mut tried_anything = false;

    // When the caller already has a password (user typed it into the prompt),
    // try it FIRST. Burning a wrong password attempt against the server is
    // user-visible, so we don't want to chew through key/agent attempts and
    // exhaust the auth budget before we get there.
    if let Some(pw) = password {
        tried_anything = true;
        match handle.authenticate_password(user, pw).await {
            Ok(AuthResult::Success) => return Ok(()),
            Ok(_) => errors.push("password rejected".into()),
            Err(e) => errors.push(format!("password attempt: {e}")),
        }
    }

    // ── 1. caller-supplied identity file (e.g. `ssh -i …` from the dialog) ──
    if let Some(p) = identity_file {
        let path = expand_tilde(p);
        tried_anything = true;
        match try_disk_key(handle, user, &path).await {
            Ok(true) => return Ok(()),
            Ok(false) => errors.push(format!("{} rejected", path.display())),
            Err(KeyError::Encrypted) => errors.push(format!(
                "{} is encrypted (run `ssh-add {}` to unlock it)",
                path.display(),
                path.display()
            )),
            Err(KeyError::Other(e)) => errors.push(format!("{}: {e}", path.display())),
        }
    }

    // ── 2. ssh-agent ────────────────────────────────────────────────────
    match try_agent(handle, user).await {
        Ok(true) => return Ok(()),
        Ok(false) => {} // agent reachable but no identity worked
        Err(e) => errors.push(format!("agent: {e}")),
    }

    // ── 3. unencrypted disk keys ────────────────────────────────────────
    if let Some(home) = dirs::home_dir() {
        let ssh_dir = home.join(".ssh");
        let candidates = [
            "id_ed25519",
            "id_ed25519_sk",
            "id_ecdsa",
            "id_ecdsa_sk",
            "id_rsa",
            "id_dsa",
        ];
        for name in candidates {
            let path = ssh_dir.join(name);
            if !path.exists() {
                continue;
            }
            tried_anything = true;
            match try_disk_key(handle, user, &path).await {
                Ok(true) => return Ok(()),
                Ok(false) => errors.push(format!("{} rejected", path.display())),
                Err(KeyError::Encrypted) => errors.push(format!(
                    "{} is encrypted (run `ssh-add {}` to unlock it)",
                    path.display(),
                    path.display()
                )),
                Err(KeyError::Other(e)) => errors.push(format!("{}: {e}", path.display())),
            }
        }
    }

    if !tried_anything && errors.iter().all(|e| e.starts_with("agent: ")) {
        return Err(
            "no usable SSH credentials. Enter a password, run `ssh-add` to \
             unlock your key, or place an unencrypted key under `~/.ssh/`."
                .into(),
        );
    }
    Err(format!("authentication failed: {}", errors.join("; ")))
}

fn expand_tilde(p: &str) -> PathBuf {
    if let Some(rest) = p.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    if p == "~" {
        if let Some(home) = dirs::home_dir() {
            return home;
        }
    }
    PathBuf::from(p)
}

async fn try_agent(handle: &mut Handle<SkipHostKey>, user: &str) -> Result<bool, String> {
    let mut agent = AgentClient::connect_env().await.map_err(|e| e.to_string())?;
    let identities = agent
        .request_identities()
        .await
        .map_err(|e| e.to_string())?;
    if identities.is_empty() {
        return Ok(false);
    }
    let hash = handle
        .best_supported_rsa_hash()
        .await
        .map_err(|e| e.to_string())?
        .flatten();
    for identity in identities {
        let pubkey = identity.public_key().into_owned();
        let result = handle
            .authenticate_publickey_with(user, pubkey, hash, &mut agent)
            .await
            .map_err(|e| e.to_string())?;
        if matches!(result, AuthResult::Success) {
            return Ok(true);
        }
    }
    Ok(false)
}

enum KeyError {
    /// Key file is OpenSSH/PEM-encrypted; we don't have the passphrase.
    Encrypted,
    Other(String),
}

async fn try_disk_key(
    handle: &mut Handle<SkipHostKey>,
    user: &str,
    path: &Path,
) -> Result<bool, KeyError> {
    let key = match load_secret_key(path, None) {
        Ok(k) => k,
        Err(e) => {
            // russh wraps the underlying ssh_key error; surface "encrypted"
            // distinctly so the UI can recommend ssh-add instead of dumping
            // a generic parse error on the user.
            let msg = e.to_string().to_lowercase();
            if msg.contains("encrypted") || msg.contains("passphrase") {
                return Err(KeyError::Encrypted);
            }
            return Err(KeyError::Other(e.to_string()));
        }
    };
    let hash = handle
        .best_supported_rsa_hash()
        .await
        .map_err(|e| KeyError::Other(e.to_string()))?
        .flatten();
    let result = handle
        .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
        .await
        .map_err(|e| KeyError::Other(e.to_string()))?;
    Ok(matches!(result, AuthResult::Success))
}

pub async fn connect(
    target: &str,
    password: Option<&str>,
    identity_file: Option<&str>,
) -> Result<(SshSession, u16), String> {
    let default_user = std::env::var("USER").unwrap_or_else(|_| "root".to_string());
    let (user, host, port) = parse_target(target, &default_user);

    let config = default_client_config();
    let mut handle = client::connect(config, (host.as_str(), port), SkipHostKey)
        .await
        .map_err(|e| format!("connect {host}:{port}: {e}"))?;

    authenticate(&mut handle, &user, password, identity_file).await?;

    // Resolve $HOME so the explorer can default the root path. We open one
    // extra exec channel rather than rely on canonicalize(".") because the
    // SFTP starting directory is implementation-defined (some servers anchor
    // to / instead of $HOME).
    let home = resolve_home(&handle).await.unwrap_or_else(|_| "/".to_string());

    let session = SshSession {
        handle,
        user,
        host,
        port,
        home,
    };
    Ok((session, port))
}

async fn resolve_home(handle: &Handle<SkipHostKey>) -> Result<String, String> {
    use russh::ChannelMsg;
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| e.to_string())?;
    channel
        .exec(true, "printf '%s' \"$HOME\"")
        .await
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::Data { data } => out.extend_from_slice(&data),
            ChannelMsg::Eof | ChannelMsg::Close => break,
            _ => {}
        }
    }
    let s = String::from_utf8(out).map_err(|e| e.to_string())?;
    let trimmed = s.trim();
    if trimmed.is_empty() {
        Err("empty $HOME".into())
    } else {
        Ok(trimmed.to_string())
    }
}

// ── Filesystem operations ────────────────────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SftpKind {
    File,
    Dir,
    Symlink,
}

#[derive(serde::Serialize)]
pub struct SftpEntry {
    pub name: String,
    pub kind: SftpKind,
    pub size: u64,
    pub mtime: u64,
}

pub async fn read_dir(session: &SshSession, path: &str) -> Result<Vec<SftpEntry>, String> {
    let sftp = session.open_sftp().await?;
    let mut entries: Vec<SftpEntry> = sftp
        .read_dir(path)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter_map(|e| {
            let name = e.file_name();
            if name == "." || name == ".." || name.starts_with('.') {
                return None;
            }
            let meta = e.metadata();
            let kind = if meta.is_dir() {
                SftpKind::Dir
            } else if meta.is_symlink() {
                SftpKind::Symlink
            } else {
                SftpKind::File
            };
            Some(SftpEntry {
                name,
                kind,
                size: meta.size.unwrap_or(0),
                mtime: meta.mtime.unwrap_or(0) as u64 * 1000,
            })
        })
        .collect();

    entries.sort_by(|a, b| {
        let rank = |k: &SftpKind| match k {
            SftpKind::Dir => 0,
            SftpKind::Symlink => 1,
            SftpKind::File => 2,
        };
        rank(&a.kind)
            .cmp(&rank(&b.kind))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

const MAX_REMOTE_READ_BYTES: u64 = 10 * 1024 * 1024;
const BINARY_SNIFF_BYTES: usize = 8 * 1024;

#[derive(serde::Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum RemoteReadResult {
    Text { content: String, size: u64 },
    Binary { size: u64 },
    TooLarge { size: u64, limit: u64 },
}

pub async fn read_file(session: &SshSession, path: &str) -> Result<RemoteReadResult, String> {
    let sftp = session.open_sftp().await?;
    let meta = sftp.metadata(path).await.map_err(|e| e.to_string())?;
    let size = meta.size.unwrap_or(0);
    if size > MAX_REMOTE_READ_BYTES {
        return Ok(RemoteReadResult::TooLarge {
            size,
            limit: MAX_REMOTE_READ_BYTES,
        });
    }
    let mut file = sftp
        .open_with_flags(path, OpenFlags::READ)
        .await
        .map_err(|e| e.to_string())?;
    let mut buf = Vec::with_capacity(size as usize);
    file.read_to_end(&mut buf).await.map_err(|e| e.to_string())?;

    let sniff = buf.len().min(BINARY_SNIFF_BYTES);
    if buf[..sniff].contains(&0) {
        return Ok(RemoteReadResult::Binary { size });
    }
    match String::from_utf8(buf) {
        Ok(content) => Ok(RemoteReadResult::Text { content, size }),
        Err(_) => Ok(RemoteReadResult::Binary { size }),
    }
}

pub async fn write_file(session: &SshSession, path: &str, content: &str) -> Result<(), String> {
    // Stage to sibling temp then rename — same pattern the local fs uses, so
    // a crash mid-write doesn't leave a half-saved buffer on the remote.
    let parent_path = parent_dir(path);
    let file_name = leaf_name(path);
    let tmp = format!("{parent_path}/.{file_name}.terax.tmp");

    let sftp = session.open_sftp().await?;
    let mut file = sftp
        .open_with_flags(
            &tmp,
            OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
        )
        .await
        .map_err(|e| e.to_string())?;
    file.write_all(content.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    file.flush().await.map_err(|e| e.to_string())?;
    file.shutdown().await.map_err(|e| e.to_string())?;
    drop(file);

    // Best-effort: remove the existing target before rename. SFTP rename is
    // not guaranteed to overwrite, so we make the behavior explicit.
    let _ = sftp.remove_file(path).await;
    if let Err(e) = sftp.rename(&tmp, path).await {
        // Cleanup staged temp on failure so we don't leak hidden files.
        let _ = sftp.remove_file(&tmp).await;
        return Err(e.to_string());
    }
    Ok(())
}

pub async fn create_file(session: &SshSession, path: &str) -> Result<(), String> {
    let sftp = session.open_sftp().await?;
    if sftp.metadata(path).await.is_ok() {
        return Err(format!("already exists: {path}"));
    }
    let mut file = sftp
        .open_with_flags(
            path,
            OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::TRUNCATE,
        )
        .await
        .map_err(|e| e.to_string())?;
    file.shutdown().await.map_err(|e| e.to_string())?;
    Ok(())
}

pub async fn create_dir(session: &SshSession, path: &str) -> Result<(), String> {
    let sftp = session.open_sftp().await?;
    if sftp.metadata(path).await.is_ok() {
        return Err(format!("already exists: {path}"));
    }
    // Mirror local fs_create_dir which behaves like mkdir -p. SFTP's mkdir
    // refuses missing parents, so we walk and create each segment.
    let mut acc = String::new();
    let absolute = path.starts_with('/');
    for segment in path.split('/').filter(|s| !s.is_empty()) {
        if absolute || !acc.is_empty() {
            acc.push('/');
        }
        acc.push_str(segment);
        if sftp.metadata(&acc).await.is_err() {
            sftp.create_dir(&acc).await.map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub async fn rename(session: &SshSession, from: &str, to: &str) -> Result<(), String> {
    let sftp = session.open_sftp().await?;
    if sftp.metadata(from).await.is_err() {
        return Err(format!("not found: {from}"));
    }
    if sftp.metadata(to).await.is_ok() {
        return Err(format!("already exists: {to}"));
    }
    sftp.rename(from, to).await.map_err(|e| e.to_string())?;
    Ok(())
}

pub async fn delete(session: &SshSession, path: &str) -> Result<(), String> {
    let sftp = session.open_sftp().await?;
    let meta = sftp.metadata(path).await.map_err(|e| e.to_string())?;
    if meta.is_dir() {
        delete_dir_recursive(&sftp, path).await
    } else {
        sftp.remove_file(path).await.map_err(|e| e.to_string())
    }
}

async fn delete_dir_recursive(sftp: &SftpSession, path: &str) -> Result<(), String> {
    // Iterative DFS — sftp doesn't expose a recursive remove, and recursion
    // would borrow `sftp` across an `await` in a way the compiler rejects.
    let mut stack: Vec<(String, bool)> = vec![(path.to_string(), false)];
    while let Some((cur, visited)) = stack.pop() {
        if visited {
            sftp.remove_dir(&cur).await.map_err(|e| e.to_string())?;
            continue;
        }
        stack.push((cur.clone(), true));
        let entries = sftp.read_dir(&cur).await.map_err(|e| e.to_string())?;
        for entry in entries {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let child = format!("{}/{}", cur.trim_end_matches('/'), name);
            let meta = entry.metadata();
            if meta.is_dir() {
                stack.push((child, false));
            } else {
                sftp.remove_file(&child).await.map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

#[derive(serde::Serialize)]
pub struct RemoteSearchHit {
    pub path: String,
    pub rel: String,
    pub name: String,
    pub is_dir: bool,
}

const SEARCH_MAX_DEPTH: usize = 8;
const SEARCH_MAX_VISITED: usize = 5_000;

/// Naive BFS search over SFTP. Remote walks are slow (one round-trip per
/// directory), so we cap depth + visited count to keep latency reasonable.
/// A future iteration could shell out to `find -type f` over an exec channel.
pub async fn search(
    session: &SshSession,
    root: &str,
    query: &str,
    limit: usize,
) -> Result<Vec<RemoteSearchHit>, String> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let cap = limit.min(500);
    let sftp = session.open_sftp().await?;

    let mut out: Vec<RemoteSearchHit> = Vec::new();
    let mut queue: std::collections::VecDeque<(String, usize)> =
        std::collections::VecDeque::from([(root.to_string(), 0)]);
    let mut visited: usize = 0;

    while let Some((dir, depth)) = queue.pop_front() {
        if out.len() >= cap || visited >= SEARCH_MAX_VISITED {
            break;
        }
        visited += 1;
        let entries = match sftp.read_dir(&dir).await {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries {
            let name = entry.file_name();
            if name == "." || name == ".." || name.starts_with('.') {
                continue;
            }
            let abs = format!("{}/{}", dir.trim_end_matches('/'), name);
            let rel = match abs.strip_prefix(root) {
                Some(r) => r.trim_start_matches('/').to_string(),
                None => abs.clone(),
            };
            let is_dir = entry.metadata().is_dir();
            if rel.to_lowercase().contains(&q) {
                out.push(RemoteSearchHit {
                    path: abs.clone(),
                    rel,
                    name: name.clone(),
                    is_dir,
                });
                if out.len() >= cap {
                    break;
                }
            }
            if is_dir && depth + 1 < SEARCH_MAX_DEPTH {
                queue.push_back((abs, depth + 1));
            }
        }
    }

    out.sort_by(|a, b| {
        let an = a.name.to_lowercase().contains(&q);
        let bn = b.name.to_lowercase().contains(&q);
        bn.cmp(&an).then(a.rel.len().cmp(&b.rel.len()))
    });
    Ok(out)
}

fn parent_dir(path: &str) -> String {
    match path.rfind('/') {
        Some(0) => "/".to_string(),
        Some(i) => path[..i].to_string(),
        None => ".".to_string(),
    }
}

fn leaf_name(path: &str) -> String {
    let p = path.trim_end_matches('/');
    match p.rfind('/') {
        Some(i) => p[i + 1..].to_string(),
        None => p.to_string(),
    }
}

