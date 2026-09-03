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

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

use crate::ssh::SshManager;
use crate::store::Store;

/// 隧道类型：Local = 本地端口固定转发(ssh -L 等价)；Dynamic = SOCKS5 动态代理(ssh -D 等价，
/// 目标由客户端在 SOCKS5 握手时指定，DNS 走远端解析)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum TunnelKind {
    #[default]
    Local,
    Dynamic,
}

/// 隧道配置（持久化；serde camelCase 与 src/types.ts TunnelConfig 对齐）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelConfig {
    pub id: String,
    pub server_id: String,
    pub name: String,
    /// 隧道类型；旧配置无此字段按 Local（原行为）。
    #[serde(default)]
    pub kind: TunnelKind,
    /// 本地监听地址；默认 127.0.0.1（仅本机可连，安全）。
    pub bind_addr: String,
    /// 本地监听端口（1-65535；0 会重复利用端口，禁止）。
    pub local_port: u16,
    /// 目标主机（远端服务器视角）；空表示服务器自身，归一为 127.0.0.1。
    /// Dynamic 模式下无意义（目标由 SOCKS5 客户端指定），保存时归零。
    pub target_host: String,
    /// 目标端口（1-65535）。Dynamic 模式下无意义，保存时归零。
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
/// Dynamic(SOCKS5)模式下目标字段无意义，归零保存防止脏数据。
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
    cfg.name = name.to_string();
    let bind_addr = cfg.bind_addr.trim();
    cfg.bind_addr = if bind_addr.is_empty() { "127.0.0.1" } else { bind_addr }.to_string();
    match cfg.kind {
        TunnelKind::Local => {
            if cfg.target_port == 0 {
                return Err("目标端口必须为 1-65535".to_string());
            }
            let target_host = cfg.target_host.trim();
            cfg.target_host = if target_host.is_empty() { "127.0.0.1" } else { target_host }.to_string();
        }
        TunnelKind::Dynamic => {
            cfg.target_host = String::new();
            cfg.target_port = 0;
        }
    }
    Ok(cfg)
}

/// 端口冲突错误前缀：命令层检测到目标端口已被其它「正在运行」的隧道绑定时返回
/// `{PREFIX}该端口已被「xxx」占用`，前端 TunnelTab 据此弹「是否关闭冲突隧道」确认框
/// （确认后带 close_conflict=true 重试，见 tunnel_start / tunnel_save）。
pub const PORT_CONFLICT_PREFIX: &str = "[隧道端口冲突]";

/// 两个监听地址是否会在同一端口上互斥：地址相同，或任一方绑定 0.0.0.0
/// （通配地址与任何具体地址重叠，操作系统不允许二者同时监听同一端口）。
fn bind_addrs_conflict(a: &str, b: &str) -> bool {
    a == b || a == "0.0.0.0" || b == "0.0.0.0"
}

/// 找出与 cfg 抢同一监听端口的「正在运行」隧道（排除 cfg 自身；配置允许端口重复，
/// 冲突只在启动时按运行态判定）。
fn port_conflicts(
    all: &[TunnelConfig],
    running_ids: &HashSet<String>,
    cfg: &TunnelConfig,
) -> Vec<TunnelConfig> {
    all.iter()
        .filter(|t| t.id != cfg.id && running_ids.contains(&t.id))
        .filter(|t| t.local_port == cfg.local_port && bind_addrs_conflict(&t.bind_addr, &cfg.bind_addr))
        .cloned()
        .collect()
}

/// 端口冲突的可识别错误（payload = 冲突隧道名，前端截掉前缀后拼「是否将其关闭」）。
fn conflict_error(conflicts: &[TunnelConfig]) -> String {
    let names = conflicts.iter().map(|c| c.name.as_str()).collect::<Vec<_>>().join("」「");
    format!("{PORT_CONFLICT_PREFIX}该端口已被「{names}」占用")
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

    /// 运行中的隧道 id 集合（内置浏览器代理由隧道提供时求值用）。
    pub fn running_ids(&self) -> std::collections::HashSet<String> {
        self.running.lock().unwrap().keys().cloned().collect()
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

    /// 启动失败写入 errors 表并广播 tunnels:changed。供 recover 静默重建用：
    /// enabled 但没跑起来的隧道在 UI 行内显示原因（否则只有 eprintln，用户不可见）。
    pub fn record_start_failure(&self, id: &str, err: String) {
        self.errors.lock().unwrap().insert(id.to_string(), err);
        if let Some(app) = self.app_handle() {
            let _ = app.emit("tunnels:changed", ());
        }
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
                            let result = match cfg.kind {
                                TunnelKind::Local => forward_one(&ssh, &cfg, stream).await,
                                TunnelKind::Dynamic => forward_dynamic(&ssh, &cfg, stream).await,
                            };
                            match result {
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

/* ---------------- SOCKS 动态代理(ssh -D 等价，兼容 SOCKS4/4a) ---------------- */

/// SOCKS 版本（决定协商格式与回复字节布局）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SocksVersion {
    V4,
    V5,
}

/// SOCKS5 回复字节（10 字节；BND.ADDR/BND.PORT 用 0.0.0.0:0 占位，标准允许。
/// code: 0x00 成功 / 0x05 连接拒绝(转发通道失败) / 0x07 命令不支持 / 0x08 地址类型不支持）。
fn socks5_reply_bytes(code: u8) -> [u8; 10] {
    [0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]
}

/// SOCKS4 回复字节（8 字节；status 90(0x5A)=granted / 91(0x5B)=rejected）。
fn socks4_reply_bytes(granted: bool) -> [u8; 8] {
    [0x00, if granted { 0x5A } else { 0x5B }, 0, 0, 0, 0, 0, 0]
}

/// 按版本的成功回复（协商完成、转发通道已建立）。
fn socks_success_reply(version: SocksVersion) -> Vec<u8> {
    match version {
        SocksVersion::V4 => socks4_reply_bytes(true).to_vec(),
        SocksVersion::V5 => socks5_reply_bytes(0x00).to_vec(),
    }
}

/// 按版本的失败回复（协商失败/转发通道打开失败；调用方写回客户端再断开）。
fn socks_failure_reply(version: SocksVersion, code_v5: u8) -> Vec<u8> {
    match version {
        SocksVersion::V4 => socks4_reply_bytes(false).to_vec(),
        SocksVersion::V5 => socks5_reply_bytes(code_v5).to_vec(),
    }
}

/// 读 NUL 结尾字符串（SOCKS4 的 userid / SOCKS4a 的域名），上限防垃圾数据刷屏。
async fn read_nul_string<S: tokio::io::AsyncRead + Unpin>(stream: &mut S) -> Result<Vec<u8>, u8> {
    use tokio::io::AsyncReadExt;
    let mut buf = Vec::new();
    loop {
        let mut b = [0u8; 1];
        stream.read_exact(&mut b).await.map_err(|_| 0x01u8)?;
        if b[0] == 0 {
            break;
        }
        buf.push(b[0]);
        if buf.len() > 255 {
            return Err(0x01);
        }
    }
    Ok(buf)
}

/// SOCKS4/4a 协商（已消费 ver=0x04）：[cmd=CONNECT, port(be), ip(4), userid(NUL)]
/// 后跟可选 domain(NUL)——SOCKS4a：ip=0.0.0.x(x≠0)时后接域名（DNS 走远端解析，同 v5 域名）。
async fn socks4_negotiate<S>(stream: &mut S) -> Result<(String, u16), u8>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    use tokio::io::AsyncReadExt;

    let mut head = [0u8; 3]; // cmd + port_hi + port_lo
    stream.read_exact(&mut head).await.map_err(|_| 0x01u8)?;
    if head[0] != 0x01 {
        return Err(0x07); // 仅支持 CONNECT
    }
    let port = u16::from_be_bytes([head[1], head[2]]);
    let mut ip = [0u8; 4];
    stream.read_exact(&mut ip).await.map_err(|_| 0x01u8)?;
    let _userid = read_nul_string(stream).await?; // SOCKS4 忽略 userid

    // SOCKS4a：ip 形如 0.0.0.x(x≠0)时,域名接在 userid 后
    if ip[..3] == [0, 0, 0] && ip[3] != 0 {
        let domain = read_nul_string(stream).await?;
        let host = String::from_utf8(domain).map_err(|_| 0x04u8)?;
        return Ok((host, port));
    }
    if ip == [0, 0, 0, 0] {
        return Err(0x04); // 0.0.0.0 无域名 = 非法目标
    }
    Ok((ip.map(|b| b.to_string()).join("."), port))
}

/// SOCKS5 协商（已消费 ver=0x05）：method 选择(仅接受无认证 0x00)→ CONNECT 解析。
async fn socks5_negotiate<S>(stream: &mut S) -> Result<(String, u16), u8>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    // [nmethods, methods...]
    let mut nmethods = [0u8; 1];
    stream.read_exact(&mut nmethods).await.map_err(|_| 0x01u8)?;
    let mut methods = vec![0u8; nmethods[0] as usize];
    stream.read_exact(&mut methods).await.map_err(|_| 0x01u8)?;
    if !methods.contains(&0x00) {
        let _ = stream.write_all(&[0x05, 0xFF]).await; // 无可用认证方法
        return Err(0x07);
    }
    stream.write_all(&[0x05, 0x00]).await.map_err(|_| 0x01u8)?;

    // CONNECT 请求：[ver, cmd, rsv, atyp, addr..., port_hi, port_lo]
    let mut req = [0u8; 4];
    stream.read_exact(&mut req).await.map_err(|_| 0x01u8)?;
    if req[0] != 0x05 || req[1] != 0x01 {
        return Err(0x07); // 仅支持 CONNECT
    }
    let host = match req[3] {
        0x01 => {
            let mut a = [0u8; 4];
            stream.read_exact(&mut a).await.map_err(|_| 0x01u8)?;
            a.map(|b| b.to_string()).join(".")
        }
        0x03 => {
            let mut len = [0u8; 1];
            stream.read_exact(&mut len).await.map_err(|_| 0x01u8)?;
            let mut d = vec![0u8; len[0] as usize];
            stream.read_exact(&mut d).await.map_err(|_| 0x01u8)?;
            // 域名字节原样转发给远端 sshd 解析（DNS 走远端是 -D 的价值），此处仅做 UTF-8 校验
            String::from_utf8(d).map_err(|_| 0x04u8)?
        }
        0x04 => {
            let mut a = [0u8; 16];
            stream.read_exact(&mut a).await.map_err(|_| 0x01u8)?;
            std::net::Ipv6Addr::from(a).to_string()
        }
        _ => return Err(0x08),
    };
    let mut port = [0u8; 2];
    stream.read_exact(&mut port).await.map_err(|_| 0x01u8)?;
    Ok((host, u16::from_be_bytes(port)))
}

/// 版本嗅探 + 分流：SOCKS5(ver=0x05) 与 SOCKS4/4a(ver=0x04) 自动识别。
/// 返回 (host, port, version)；错误码附带版本（ver 非法时 version=None，调用方不回字节直接断）。
async fn socks_negotiate<S>(stream: &mut S) -> Result<(String, u16, SocksVersion), (Option<SocksVersion>, u8)>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    use tokio::io::AsyncReadExt;
    let mut ver = [0u8; 1];
    stream
        .read_exact(&mut ver)
        .await
        .map_err(|_| (None, 0x01u8))?;
    match ver[0] {
        0x04 => socks4_negotiate(stream)
            .await
            .map(|(h, p)| (h, p, SocksVersion::V4))
            .map_err(|code| (Some(SocksVersion::V4), code)),
        0x05 => socks5_negotiate(stream)
            .await
            .map(|(h, p)| (h, p, SocksVersion::V5))
            .map_err(|code| (Some(SocksVersion::V5), code)),
        _ => Err((None, 0x07)), // 不是 SOCKS 握手（如 HTTP）
    }
}

/// Dynamic 隧道的单连接转发：SOCKS 协商(自动 v4/v5)读出目标 → SSH 通道 direct-tcpip
/// → 按版本回成功字节 → 双向桥接。协商/通道失败按版本回对应错误码再断开。
async fn forward_dynamic(
    ssh: &Arc<SshManager>,
    cfg: &TunnelConfig,
    stream: TcpStream,
) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    let mut stream = stream;
    let (host, port, version) = match socks_negotiate(&mut stream).await {
        Ok(target) => target,
        Err((version, code)) => {
            // 版本已知(v4/v5 内部失败)才回错误字节;ver 非法(非 SOCKS)不回,直接断
            if let Some(v) = version {
                let _ = stream.write_all(&socks_failure_reply(v, code)).await;
            }
            return Err(format!("SOCKS 协商失败（错误码 {code:#04x}）"));
        }
    };
    let handle = ssh.get_or_connect(&cfg.server_id).await?;
    let channel = match tokio::time::timeout(
        Duration::from_secs(10),
        handle.channel_open_direct_tcpip(&host, port as u32, "127.0.0.1", 0),
    )
    .await
    {
        Ok(Ok(channel)) => channel,
        Ok(Err(e)) => {
            let _ = stream.write_all(&socks_failure_reply(version, 0x05)).await;
            return Err(format!("打开到 {host}:{port} 的转发通道失败：{e}"));
        }
        Err(_) => {
            let _ = stream.write_all(&socks_failure_reply(version, 0x05)).await;
            return Err(format!("打开到 {host}:{port} 的转发通道超时"));
        }
    };
    stream
        .write_all(&socks_success_reply(version))
        .await
        .map_err(|e| format!("SOCKS 成功回复发送失败: {e}"))?;
    let mut channel = channel.into_stream();
    tokio::io::copy_bidirectional(&mut channel, &mut stream)
        .await
        .map_err(|e| format!("转发数据中断：{e}"))?;
    Ok(())
}

/// 启动时自动重建：上次 enabled 的隧道逐个尝试（失败写入 errors 表供 UI 行内展示，
/// 不弹交互、不阻塞启动）。恢复阶段检测到端口冲突直接给出可读原因（无用户在场，
/// 不做「关闭对方」的自动取舍，先启动者胜出）。
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
        let conflicts = port_conflicts(&store.tunnels_all(), &manager.running_ids(), &cfg);
        let result = match conflicts.split_first() {
            Some((first, _)) => Err(format!("本地端口 {} 已被隧道「{}」占用", cfg.local_port, first.name)),
            None => manager.start(&ssh, &cfg).await,
        };
        if let Err(e) = result {
            eprintln!("[tunnel] 恢复「{}」失败：{e}", cfg.name);
            manager.record_start_failure(&cfg.id, e);
        }
    }
    let _ = app.emit("tunnels:changed", ());
}

/* ---------------- 命令（前端 api.ts tunnel_* 一一对应） ---------------- */

fn on_changed(app: &AppHandle) {
    let _ = app.emit("tunnels:changed", ());
}

/// 命令层统一的「先解冲突再启动」：目标端口已被其它运行中隧道占时，close_conflict=false
/// 返回带 [`PORT_CONFLICT_PREFIX`] 的可识别错误（前端弹确认框后带 true 重试）；
/// true 先停掉所有冲突隧道再启动（启动仍可能因非隧道进程占用/认证失败而报错）。
async fn start_resolving_conflicts(
    manager: &TunnelManager,
    ssh: &Arc<SshManager>,
    cfg: &TunnelConfig,
    conflicts: Vec<TunnelConfig>,
    close_conflict: bool,
) -> Result<(), String> {
    if !conflicts.is_empty() {
        if !close_conflict {
            return Err(conflict_error(&conflicts));
        }
        for c in &conflicts {
            manager.stop(&c.id).await;
        }
    }
    manager.start(ssh, cfg).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(id: &str, name: &str) -> TunnelConfig {
        TunnelConfig {
            id: id.into(),
            server_id: "s1".into(),
            name: name.into(),
            kind: TunnelKind::Local,
            bind_addr: "".into(),
            local_port: 3307,
            target_host: "".into(),
            target_port: 3306,
            enabled: true,
        }
    }

    #[test]
    fn normalize_dynamic_zeroes_target_fields() {
        let mut c = cfg("t1", "socks");
        c.kind = TunnelKind::Dynamic;
        c.target_host = "example.com".into();
        c.target_port = 8080;
        let c = normalize_config(c).unwrap();
        assert_eq!(c.target_host, "", "dynamic 模式目标字段归零");
        assert_eq!(c.target_port, 0);
        // dynamic 模式不需要目标端口校验(0 合法)
        let mut c = cfg("t1", "socks");
        c.kind = TunnelKind::Dynamic;
        c.target_port = 0;
        assert!(normalize_config(c).is_ok());
    }

    #[test]
    fn socks5_reply_format() {
        assert_eq!(socks5_reply_bytes(0x00), [5, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
        assert_eq!(socks5_reply_bytes(0x05)[1], 0x05, "第二字节是回复码");
        assert_eq!(socks5_reply_bytes(0x08)[3], 0x01, "ATYP=IPv4 占位");
    }

    #[test]
    fn socks4_reply_format() {
        assert_eq!(socks4_reply_bytes(true), [0, 0x5A, 0, 0, 0, 0, 0, 0]);
        assert_eq!(socks4_reply_bytes(false), [0, 0x5B, 0, 0, 0, 0, 0, 0]);
    }

    /// SOCKS4 协商：IPv4 目标。
    #[tokio::test]
    async fn socks4_negotiate_ipv4_target() {
        let (mut client, mut server) = tokio::io::duplex(64);
        let client_task = tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            // ver=4, cmd=CONNECT, port=0x1F90(8080), ip=127.0.0.1, userid="u"
            client
                .write_all(&[0x04, 0x01, 0x1F, 0x90, 127, 0, 0, 1, b'u', 0])
                .await
                .unwrap();
        });
        let (host, port, _version) = socks_negotiate(&mut server).await.unwrap();
        assert_eq!(host, "127.0.0.1");
        assert_eq!(port, 8080);
        client_task.await.unwrap();
    }

    /// SOCKS4a 协商：ip=0.0.0.1 时后接域名（域名走远端解析）。
    #[tokio::test]
    async fn socks4a_negotiate_domain_target() {
        let (mut client, mut server) = tokio::io::duplex(64);
        let client_task = tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            // ver=4, cmd=CONNECT, port=0x1F90, ip=0.0.0.1(4a 标记), userid 空, domain="example.test"
            let mut req = vec![0x04, 0x01, 0x1F, 0x90, 0, 0, 0, 1, 0];
            req.extend_from_slice(b"example.test");
            req.push(0);
            client.write_all(&req).await.unwrap();
        });
        let (host, port, _version) = socks_negotiate(&mut server).await.unwrap();
        assert_eq!(host, "example.test");
        assert_eq!(port, 8080);
        client_task.await.unwrap();
    }

    /// 非 SOCKS 协议(ver=0x47 'G')应被嗅探拒绝(返回 Unknown 版本)。
    #[tokio::test]
    async fn socks_negotiate_rejects_non_socks() {
        let (mut client, mut server) = tokio::io::duplex(64);
        let client_task = tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            client.write_all(b"GET / HTTP/1.1\r\n\r\n").await.unwrap();
        });
        let err = socks_negotiate(&mut server).await.unwrap_err();
        assert_eq!(err, (None, 0x07));
        client_task.await.unwrap();
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

    #[test]
    fn bind_addrs_conflict_cases() {
        assert!(bind_addrs_conflict("127.0.0.1", "127.0.0.1"));
        assert!(bind_addrs_conflict("0.0.0.0", "127.0.0.1"), "通配地址与具体地址重叠");
        assert!(bind_addrs_conflict("127.0.0.1", "0.0.0.0"));
        assert!(!bind_addrs_conflict("127.0.0.1", "192.168.1.5"), "两个具体地址互不重叠");
    }

    #[test]
    fn port_conflicts_filters_running_and_port() {
        let mut t1 = cfg("t1", "a");
        t1.bind_addr = "127.0.0.1".into();
        let mut t2 = cfg("t2", "b");
        t2.bind_addr = "127.0.0.1".into();
        let mut t3 = cfg("t3", "c");
        t3.bind_addr = "127.0.0.1".into();
        t3.local_port = 3308;
        let mut t4 = cfg("t4", "d");
        t4.bind_addr = "0.0.0.0".into();
        let all = vec![t1.clone(), t2, t3, t4];
        let running: HashSet<String> = ["t2", "t3", "t4"].iter().map(|s| s.to_string()).collect();
        // 查询 t1(127.0.0.1:3307)：命中 t2(同端口运行中)与 t4(0.0.0.0 通配)；t3 端口不同不算
        let ids: Vec<String> = port_conflicts(&all, &running, &t1).into_iter().map(|c| c.id).collect();
        assert_eq!(ids, vec!["t2", "t4"]);
        // 未运行的配置允许端口重复：t2 不在运行表时不冲突
        let only_t4: HashSet<String> = ["t4"].iter().map(|s| s.to_string()).collect();
        let ids: Vec<String> = port_conflicts(&all, &only_t4, &t1).into_iter().map(|c| c.id).collect();
        assert_eq!(ids, vec!["t4"]);
        // 自身即使运行中也不与自己冲突（保存路径先停旧实例，这里双保险）
        let self_running: HashSet<String> = ["t1"].iter().map(|s| s.to_string()).collect();
        assert!(port_conflicts(&all, &self_running, &t1).is_empty());
    }

    #[test]
    fn conflict_error_carries_prefix_and_names() {
        let mut a = cfg("t1", "数据库隧道");
        a.bind_addr = "127.0.0.1".into();
        let mut b = cfg("t2", "socks");
        b.bind_addr = "0.0.0.0".into();
        let err = conflict_error(&[a, b]);
        assert!(err.starts_with(PORT_CONFLICT_PREFIX), "前端按前缀识别冲突错误");
        assert!(err.contains("数据库隧道」「socks"), "多个冲突隧道名以「」「」连接");
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
    close_conflict: Option<bool>,
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
        let conflicts = port_conflicts(&store.tunnels_all(), &manager.running_ids(), &cfg);
        if let Err(e) =
            start_resolving_conflicts(&manager, &ssh, &cfg, conflicts, close_conflict.unwrap_or(false))
                .await
        {
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
    close_conflict: Option<bool>,
) -> Result<TunnelState, String> {
    let all = store.tunnels_all();
    let cfg = all
        .iter()
        .find(|cfg| cfg.id == id)
        .cloned()
        .ok_or_else(|| format!("隧道不存在：{id}"))?;
    let conflicts = port_conflicts(&all, &manager.running_ids(), &cfg);
    start_resolving_conflicts(&manager, &ssh, &cfg, conflicts, close_conflict.unwrap_or(false)).await?;
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
