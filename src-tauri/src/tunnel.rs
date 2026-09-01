//! SSH 本地端口转发（ssh -L 等价）隧道管理。
//!
//! 配置存 aishell.json（AppState.ssh_tunnels，enabled = 上次启用状态，重启自动重建）；
//! 运行态（监听任务）仅存内存，随程序退出自然销毁，不落盘。
//! 转发路径：本地 TcpListener 接受连接 → 复用 SshManager 已认证连接（每 serverId 一条，
//! 与终端/SFTP 共享）打开 direct-tcpip 通道到目标主机:端口 → copy_bidirectional 双向桥接；
//! 单条转发连接失败只断该连接（监听循环继续），启动阶段先预连服务器把认证/网络错误
//! 尽早反馈给调用方。
//!
//! 接口点：lib.rs 注册命令 + setup 时 manage(TunnelManager) 并 spawn recover
//! （启动时自动重建 enabled 隧道）；前端 api.ts tunnel_* 封装、标签页 TunnelTab.tsx 管理展示。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

use crate::ssh::SshManager;
use crate::store::Store;

/// 隧道配置（持久化；serde camelCase 与 src/types.ts TunnelConfig 对齐）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelConfig {
    pub id: String,
    pub server_id: String,
    pub name: String,
    /// 本地监听地址；默认 127.0.0.1（仅本机可连，安全）。
    pub bind_addr: String,
    /// 本地监听端口（1-65535；0 会重复利用端口，禁止）。
    pub local_port: u16,
    /// 目标主机（远端服务器视角）；空表示服务器自身，归一为 127.0.0.1。
    pub target_host: String,
    /// 目标端口（1-65535）。
    pub target_port: u16,
    /// 上次启用状态：重启时自动重建 enabled 的隧道。
    pub enabled: bool,
}

/// 前端展示用：配置 + 运行态（camelCase；error 预留启动失败原因，当前仅经命令 Err 返回）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelState {
    #[serde(flatten)]
    pub config: TunnelConfig,
    pub running: bool,
    pub error: Option<String>,
}

/// 校验并归一化配置：空绑定地址/目标主机归一为 127.0.0.1，端口与名称非法即失败。
pub fn normalize_config(mut cfg: TunnelConfig) -> Result<TunnelConfig, String> {
    if cfg.id.trim().is_empty() {
        return Err("隧道缺少唯一标识".to_string());
    }
    let name = cfg.name.trim();
    if name.is_empty() {
        return Err("隧道名称不能为空".to_string());
    }
    if cfg.local_port == 0 {
        return Err("本地端口必须为 1-65535".to_string());
    }
    if cfg.target_port == 0 {
        return Err("目标端口必须为 1-65535".to_string());
    }
    cfg.name = name.to_string();
    let bind_addr = cfg.bind_addr.trim();
    cfg.bind_addr = if bind_addr.is_empty() { "127.0.0.1" } else { bind_addr }.to_string();
    let target_host = cfg.target_host.trim();
    cfg.target_host = if target_host.is_empty() { "127.0.0.1" } else { target_host }.to_string();
    Ok(cfg)
}

/// 运行中的隧道句柄：stop 通知监听循环退出（各 1s 轮询 accept 的超时保证能退出），
/// task 为监听任务（含所有转发连接的子任务引用）。
struct RunningTunnel {
    stop: watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

/// 隧道运行态表：id → 监听句柄。仅内存（配置在 Store）。
pub struct TunnelManager {
    running: Mutex<HashMap<String, RunningTunnel>>,
    /// 转发期错误（id → 最近一次转发连接失败的中文错误，成功时清除）；
    /// 与 running 分开持锁：运行中任务（run_local spawn 的转发子任务）需要写入。
    errors: Arc<Mutex<HashMap<String, String>>>,
    /// 事件推送（tunnels:changed 由转发任务在失败/成功后触发，驱动前端刷新错误行）。
    app: Mutex<Option<AppHandle>>,
}

impl Default for TunnelManager {
    fn default() -> Self {
        Self::new()
    }
}

impl TunnelManager {
    pub fn new() -> Self {
        Self {
            running: Mutex::new(HashMap::new()),
            errors: Arc::new(Mutex::new(HashMap::new())),
            app: Mutex::new(None),
        }
    }

    /// setup 阶段注入 AppHandle（run_local 的转发失败事件靠它广播）。
    pub fn set_app(&self, app: AppHandle) {
        *self.app.lock().unwrap() = Some(app);
    }

    fn app_handle(&self) -> Option<AppHandle> {
        self.app.lock().unwrap().clone()
    }

    fn is_running(&self, id: &str) -> bool {
        self.running.lock().unwrap().contains_key(id)
    }

    /// 启动隧道：先 bind 本地端口（失败立即返回，含端口占用），预连服务器把认证/网络错误
    /// 在启动阶段暴露（此后转发连接懒连，服务器断开会自动重连）。幂等：已运行直接成功。
    pub async fn start(&self, ssh: &Arc<SshManager>, cfg: &TunnelConfig) -> Result<(), String> {
        if self.is_running(&cfg.id) {
            return Ok(());
        }
        let addr = format!("{}:{}", cfg.bind_addr, cfg.local_port);
        let listener = TcpListener::bind(&addr).await.map_err(|e| {
            format!(
                "隧道「{}」绑定 {addr} 失败：{e}。请更换本地端口或绑定地址",
                cfg.name
            )
        })?;
        // 预连：认证失败（如公钥需部署）/ 服务器离线在此暴露，转发期间再把"连接断开"兜回懒连
        ssh.get_or_connect(&cfg.server_id)
            .await
            .map_err(|e| format!("隧道「{}」连接服务器「{}」失败：{e}", cfg.name, cfg.server_id))?;
        let (stop_tx, stop_rx) = watch::channel(false);
        let errors = Arc::clone(&self.errors);
        let app = self.app_handle();
        let task = tokio::spawn(run_local(Arc::clone(ssh), cfg.clone(), listener, stop_rx, errors, app));
        self.running
            .lock()
            .unwrap()
            .insert(cfg.id.clone(), RunningTunnel { stop: stop_tx, task });
        Ok(())
    }

    /// 停止隧道：发 stop 信号并等待监听任务退出（2s 兜底，超时直接放弃句柄；
    /// 已停止幂等返回 false）。
    pub async fn stop(&self, id: &str) -> bool {
        let Some(rt) = self.running.lock().unwrap().remove(id) else {
            return false;
        };
        self.errors.lock().unwrap().remove(id);
        let _ = rt.stop.send(true);
        let _ = tokio::time::timeout(Duration::from_secs(2), rt.task).await;
        true
    }

    /// 合并运行态：配置列表 + running 表 + 最近转发错误。
    pub fn states(&self, configs: &[TunnelConfig]) -> Vec<TunnelState> {
        let running = self.running.lock().unwrap();
        let errors = self.errors.lock().unwrap();
        configs
            .iter()
            .map(|cfg| TunnelState {
                config: cfg.clone(),
                running: running.contains_key(&cfg.id),
                error: errors.get(&cfg.id).cloned(),
            })
            .collect()
    }
}

/// 监听循环：接受连接后各自 spawn 转发（单条转发失败只断该连接，不影响隧道）；
/// 失败写入 errors（前端隧道行可读）并广播 tunnels:changed，成功则清除。
async fn run_local(
    ssh: Arc<SshManager>,
    cfg: TunnelConfig,
    listener: TcpListener,
    mut stop: watch::Receiver<bool>,
    errors: Arc<Mutex<HashMap<String, String>>>,
    app: Option<AppHandle>,
) {
    loop {
        tokio::select! {
            _ = stop.changed() => break,
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, _peer)) => {
                        let ssh = Arc::clone(&ssh);
                        let cfg = cfg.clone();
                        let errors = Arc::clone(&errors);
                        let app = app.clone();
                        tokio::spawn(async move {
                            match forward_one(&ssh, &cfg, stream).await {
                                Ok(()) => {
                                    let cleared = errors.lock().unwrap().remove(&cfg.id).is_some();
                                    if cleared {
                                        if let Some(app) = app.as_ref() { let _ = app.emit("tunnels:changed", ()); }
                                    }
                                }
                                Err(e) => {
                                    eprintln!("[tunnel] {} 转发连接失败: {e}", cfg.name);
                                    errors.lock().unwrap().insert(cfg.id.clone(), e);
                                    if let Some(app) = app.as_ref() { let _ = app.emit("tunnels:changed", ()); }
                                }
                            }
                        });
                    }
                    Err(e) => eprintln!("[tunnel] {} 接受连接失败: {e}", cfg.name),
                }
            }
        }
    }
}

/// 单条连接的转发：SSH 通道打开 direct-tcpip 到目标，与本地 TCP 双向桥接。
async fn forward_one(
    ssh: &Arc<SshManager>,
    cfg: &TunnelConfig,
    stream: TcpStream,
) -> Result<(), String> {
    let handle = ssh.get_or_connect(&cfg.server_id).await?;
    let channel = tokio::time::timeout(
        Duration::from_secs(10),
        handle.channel_open_direct_tcpip(
            &cfg.target_host,
            cfg.target_port as u32,
            "127.0.0.1",
            0,
        ),
    )
    .await
    .map_err(|_| format!("打开到 {}:{} 的转发通道超时", cfg.target_host, cfg.target_port))?
    .map_err(|e| {
        let hint = if e.to_string().to_lowercase().contains("administrativelyprohibited") {
            "（可能被服务器策略拒绝，如 AllowTcpForwarding no）"
        } else {
            ""
        };
        format!("打开到 {}:{} 的转发通道失败：{e}{hint}", cfg.target_host, cfg.target_port)
    })?;
    let mut channel = channel.into_stream();
    let mut stream = stream;
    tokio::io::copy_bidirectional(&mut channel, &mut stream)
        .await
        .map_err(|e| format!("转发数据中断：{e}"))?;
    Ok(())
}

/// 启动时自动重建：上次 enabled 的隧道逐个尝试（失败仅记录，不阻塞启动）。
pub async fn recover(
    app: AppHandle,
    ssh: Arc<SshManager>,
    store: Arc<Store>,
    manager: Arc<TunnelManager>,
) {
    let configs = store
        .tunnels_all()
        .into_iter()
        .filter(|cfg| cfg.enabled)
        .collect::<Vec<_>>();
    for cfg in configs {
        if let Err(e) = manager.start(&ssh, &cfg).await {
            eprintln!("[tunnel] 恢复「{}」失败：{e}", cfg.name);
        }
    }
    let _ = app.emit("tunnels:changed", ());
}

/* ---------------- 命令（前端 api.ts tunnel_* 一一对应） ---------------- */

fn on_changed(app: &AppHandle) {
    let _ = app.emit("tunnels:changed", ());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(id: &str, name: &str) -> TunnelConfig {
        TunnelConfig {
            id: id.into(),
            server_id: "s1".into(),
            name: name.into(),
            bind_addr: "".into(),
            local_port: 3307,
            target_host: "".into(),
            target_port: 3306,
            enabled: true,
        }
    }

    #[test]
    fn normalize_fills_defaults_and_trims() {
        let c = normalize_config(cfg("t1", " 数据库隧道 ")).unwrap();
        assert_eq!(c.name, "数据库隧道");
        assert_eq!(c.bind_addr, "127.0.0.1", "空绑定地址归一为仅本机");
        assert_eq!(c.target_host, "127.0.0.1", "空目标主机归一为服务器自身");
    }

    #[test]
    fn normalize_rejects_bad_fields() {
        assert!(normalize_config(cfg("", "x")).is_err(), "空 id 拒绝");
        assert!(normalize_config(cfg("t1", "  ")).is_err(), "空名称拒绝");
        let mut c = cfg("t1", "x");
        c.local_port = 0;
        assert!(normalize_config(c).is_err(), "本地端口 0 拒绝");
        let mut c = cfg("t1", "x");
        c.target_port = 0;
        assert!(normalize_config(c).is_err(), "目标端口 0 拒绝");
    }

    #[tokio::test]
    async fn states_merges_running_without_mutation() {
        let manager = TunnelManager::new();
        let configs = vec![cfg("t1", "a"), cfg("t2", "b")];
        let states = manager.states(&configs);
        assert_eq!(states.len(), 2);
        assert!(states.iter().all(|s| !s.running));
        assert!(states.iter().all(|s| s.error.is_none()));
        // 标记运行(直接插入句柄表,模拟 start 后的状态):t1 running,t2 停止
        let (tx, _rx) = watch::channel(false);
        manager
            .running
            .lock()
            .unwrap()
            .insert("t1".into(), RunningTunnel { stop: tx, task: tokio::spawn(async {}) });
        let states = manager.states(&configs);
        assert!(states.iter().find(|s| s.config.id == "t1").unwrap().running);
        assert!(!states.iter().find(|s| s.config.id == "t2").unwrap().running);
    }

    #[tokio::test]
    async fn stop_is_idempotent() {
        let manager = TunnelManager::new();
        // 未启动 → false（幂等无副作用）
        assert!(!manager.stop("nope").await);
    }
}

#[tauri::command]
pub async fn tunnel_list(
    manager: State<'_, Arc<TunnelManager>>,
    store: State<'_, Arc<Store>>,
    server_id: Option<String>,
) -> Result<Vec<TunnelState>, String> {
    let configs = store.tunnels_all();
    let configs = match server_id {
        Some(sid) => configs.into_iter().filter(|cfg| cfg.server_id == sid).collect::<Vec<_>>(),
        None => configs,
    };
    Ok(manager.states(&configs))
}

#[tauri::command]
pub async fn tunnel_save(
    app: AppHandle,
    manager: State<'_, Arc<TunnelManager>>,
    store: State<'_, Arc<Store>>,
    ssh: State<'_, Arc<SshManager>>,
    mut cfg: TunnelConfig,
) -> Result<TunnelState, String> {
    cfg = normalize_config(cfg)?;
    if store.server(&cfg.server_id).is_none() {
        return Err(format!("服务器不存在：{}", cfg.server_id));
    }
    // 配置变更（端口/目标等）或从启用改停用 → 先停掉在跑的旧隧道
    let old = store.tunnels_all().into_iter().find(|t| t.id == cfg.id);
    if old.as_ref() != Some(&cfg) {
        manager.stop(&cfg.id).await;
    }
    store.save_tunnel(cfg.clone())?;
    if cfg.enabled {
        if let Err(e) = manager.start(&ssh, &cfg).await {
            // 配置已落盘（enabled 保留），启动失败经 Err 透传给前端展示；下次重试可恢复
            on_changed(&app);
            return Err(e);
        }
    }
    on_changed(&app);
    Ok(manager
        .states(&[cfg])
        .into_iter()
        .next()
        .expect("states 至少返回 1 项"))
}

#[tauri::command]
pub async fn tunnel_start(
    app: AppHandle,
    manager: State<'_, Arc<TunnelManager>>,
    store: State<'_, Arc<Store>>,
    ssh: State<'_, Arc<SshManager>>,
    id: String,
) -> Result<TunnelState, String> {
    let cfg = store
        .tunnels_all()
        .into_iter()
        .find(|cfg| cfg.id == id)
        .ok_or_else(|| format!("隧道不存在：{id}"))?;
    manager.start(&ssh, &cfg).await?;
    on_changed(&app);
    Ok(manager.states(&[cfg]).into_iter().next().expect("states 至少返回 1 项"))
}

#[tauri::command]
pub async fn tunnel_stop(
    app: AppHandle,
    manager: State<'_, Arc<TunnelManager>>,
    id: String,
) -> Result<(), String> {
    manager.stop(&id).await;
    on_changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn tunnel_delete(
    app: AppHandle,
    manager: State<'_, Arc<TunnelManager>>,
    store: State<'_, Arc<Store>>,
    id: String,
) -> Result<(), String> {
    manager.stop(&id).await;
    store.delete_tunnel(&id)?;
    on_changed(&app);
    Ok(())
}
