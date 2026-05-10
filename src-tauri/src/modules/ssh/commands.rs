use serde::Serialize;
use tauri::State;

use super::session::{
    self, RemoteReadResult, RemoteSearchHit, SftpEntry, SshState,
};

#[derive(Serialize)]
pub struct SshConnectResult {
    pub session_id: u64,
    pub user: String,
    pub host: String,
    pub port: u16,
    pub home: String,
}

#[tauri::command]
pub async fn ssh_connect(
    target: String,
    password: Option<String>,
    state: State<'_, SshState>,
) -> Result<SshConnectResult, String> {
    let (sess, port) = session::connect(&target, password.as_deref()).await?;
    let user = sess.user.clone();
    let host = sess.host.clone();
    let home = sess.home.clone();
    let session_id = state.insert(sess).await;
    Ok(SshConnectResult {
        session_id,
        user,
        host,
        port,
        home,
    })
}

#[tauri::command]
pub async fn ssh_disconnect(
    session_id: u64,
    state: State<'_, SshState>,
) -> Result<(), String> {
    if let Some(sess) = state.remove(session_id).await {
        // Best-effort disconnect — the underlying handle drops cleanly even
        // if the network is gone, but ignoring errors keeps callers simple.
        let _ = sess
            .handle
            .disconnect(russh::Disconnect::ByApplication, "", "")
            .await;
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_read_dir(
    session_id: u64,
    path: String,
    state: State<'_, SshState>,
) -> Result<Vec<SftpEntry>, String> {
    let sess = state.get(session_id).await?;
    session::read_dir(&sess, &path).await
}

#[tauri::command]
pub async fn ssh_read_file(
    session_id: u64,
    path: String,
    state: State<'_, SshState>,
) -> Result<RemoteReadResult, String> {
    let sess = state.get(session_id).await?;
    session::read_file(&sess, &path).await
}

#[tauri::command]
pub async fn ssh_write_file(
    session_id: u64,
    path: String,
    content: String,
    state: State<'_, SshState>,
) -> Result<(), String> {
    let sess = state.get(session_id).await?;
    session::write_file(&sess, &path, &content).await
}

#[tauri::command]
pub async fn ssh_create_file(
    session_id: u64,
    path: String,
    state: State<'_, SshState>,
) -> Result<(), String> {
    let sess = state.get(session_id).await?;
    session::create_file(&sess, &path).await
}

#[tauri::command]
pub async fn ssh_create_dir(
    session_id: u64,
    path: String,
    state: State<'_, SshState>,
) -> Result<(), String> {
    let sess = state.get(session_id).await?;
    session::create_dir(&sess, &path).await
}

#[tauri::command]
pub async fn ssh_rename(
    session_id: u64,
    from: String,
    to: String,
    state: State<'_, SshState>,
) -> Result<(), String> {
    let sess = state.get(session_id).await?;
    session::rename(&sess, &from, &to).await
}

#[tauri::command]
pub async fn ssh_delete(
    session_id: u64,
    path: String,
    state: State<'_, SshState>,
) -> Result<(), String> {
    let sess = state.get(session_id).await?;
    session::delete(&sess, &path).await
}

#[tauri::command]
pub async fn ssh_search(
    session_id: u64,
    root: String,
    query: String,
    limit: Option<usize>,
    state: State<'_, SshState>,
) -> Result<Vec<RemoteSearchHit>, String> {
    let sess = state.get(session_id).await?;
    session::search(&sess, &root, &query, limit.unwrap_or(200)).await
}
