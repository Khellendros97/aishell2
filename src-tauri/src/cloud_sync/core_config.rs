//! 核心配置云同步：白名单 DTO、本机路径保护、引用校验与三方合并。
//!
//! 本模块刻意不序列化 `AppState`：项目 `path`、凭据/服务器 `key_path` 和所有
//! session/keyring 数据均为本机数据。与云端交换的字段以 `store.rs` 为准。
//! 拉取云端新项目时不上云/不下发路径，而是在本机 workspace 下按项目名重建目录。

use std::collections::{BTreeMap, BTreeSet, HashSet};

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::store::{
    alloc_project_dir_in_workspace, project_path_key, AiMode, ApprovalMode, AppState, AuthType,
    Credential, Effort, Project, ProjectView, QuickCommand, Server, Theme,
};
use crate::tunnel::TunnelKind;

/// 核心配置同步协议 v1。字段白名单是协议的一部分，不要改为直接序列化 AppState。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreConfigPayloadV1 {
    pub project_folders: Vec<String>,
    pub projects: Vec<CoreProjectV1>,
    pub credentials: Vec<CoreCredentialV1>,
    pub servers: Vec<CoreServerV1>,
    pub command_folders: Vec<String>,
    /// SSH 隧道配置；不含 `enabled`（运行态属本机，不同步）。
    #[serde(default)]
    pub ssh_tunnels: Vec<CoreTunnelV1>,
    /// SFTP 收藏夹，按服务器分组；旧载荷无此字段时按空（default 保老 baseline 可解）。
    #[serde(default)]
    pub sftp_favorites: Vec<CoreSftpFavoritesV1>,
    /// 浏览器收藏夹（url 即业务键）；旧载荷无此字段时按空。
    #[serde(default)]
    pub browser_favorites: Vec<CoreBrowserFavoriteV1>,
    /// 系统设置白名单；旧载荷无此字段时按 None（不触碰本机设置）。
    #[serde(default)]
    pub settings: Option<CoreSettingsV1>,
}

/// 不含 `Project.path`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreProjectV1 {
    pub id: String,
    pub name: String,
    pub server_ids: Vec<String>,
    pub quick_commands: Vec<CoreQuickCommandV1>,
    pub folder: String,
    pub ai_mode: AiMode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreQuickCommandV1 {
    pub id: String,
    pub title: String,
    pub command: String,
    pub folder: String,
    pub global: bool,
}

/// 不含 `Credential.key_path`；密码不在 store 的结构体中，也不会进入 DTO。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreCredentialV1 {
    pub id: String,
    pub name: String,
    pub auth_type: AuthType,
    pub username: String,
}

/// 不含 `Server.key_path`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreServerV1 {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub auth_type: AuthType,
    pub username: String,
    pub credential_id: Option<String>,
    pub locked: bool,
    pub is_bastion: bool,
    pub bastion_id: Option<String>,
    /// 用户自定义标签；旧载荷无此字段时按空（default 保老 envelope 可解）。
    #[serde(default)]
    pub tags: Vec<String>,
}

/// 不含 `TunnelConfig.enabled`：启用状态是本机运行态，不同步。
/// 恢复端按 id 保留本地 enabled，本地无此隧道时按 false（不自动拉起）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreTunnelV1 {
    pub id: String,
    pub server_id: String,
    pub name: String,
    pub kind: TunnelKind,
    pub bind_addr: String,
    pub local_port: u16,
    pub target_host: String,
    pub target_port: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreSftpFavoriteV1 {
    pub path: String,
    #[serde(default)]
    pub title: String,
}

/// 单台服务器的 SFTP 收藏组；serverId 即组键。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreSftpFavoritesV1 {
    pub server_id: String,
    pub favorites: Vec<CoreSftpFavoriteV1>,
}

/// 浏览器收藏；url 即业务键（前端按 url 去重）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreBrowserFavoriteV1 {
    pub url: String,
    #[serde(default)]
    pub title: String,
}

/// 系统设置白名单（子配置拍平成标量，合并时逐字段取舍）。
/// 不含：`workspace_dir`（本机路径）、`cloud`（账号态，每台设备自己登录）、
/// MCP 服务端口（本机回环监听绑定）；API key（LLM/Brave）全在 keyring，本就不在结构中。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreSettingsV1 {
    pub llm_model_id: String,
    pub llm_base_url: String,
    pub llm_effort: Effort,
    pub search_enabled: bool,
    pub theme: Theme,
    pub auto_switch_ai_workdir: bool,
    pub project_view: ProjectView,
    pub approval_mode: ApprovalMode,
    pub auto_backup_remote_files: bool,
    pub knowledge_auto_inject: bool,
    pub knowledge_inject_count: u32,
    pub compact_server_list: bool,
    pub tunnel_auto_start: bool,
}

pub type CoreProject = CoreProjectV1;
pub type CoreQuickCommand = CoreQuickCommandV1;
pub type CoreCredential = CoreCredentialV1;
pub type CoreServer = CoreServerV1;
pub type CoreSettings = CoreSettingsV1;

impl CoreConfigPayloadV1 {
    pub fn from_app_state(state: &AppState) -> Self {
        from_app_state(state)
    }

    pub fn apply_remote(&self, state: &mut AppState) -> Result<(), String> {
        apply_remote(state, self)
    }

    pub fn merge_three_way(base: &Self, local: &Self, remote: &Self) -> (Self, Vec<CoreConflict>) {
        merge_three_way(base, local, remote)
    }

    pub fn try_merge_three_way(
        base: &Self,
        local: &Self,
        remote: &Self,
    ) -> Result<(Self, Vec<CoreConflict>), String> {
        try_merge_three_way(base, local, remote)
    }
}

/// 从 AppState 生成白名单载荷；路径字段在这里被永久丢弃。
pub fn from_app_state(state: &AppState) -> CoreConfigPayloadV1 {
    CoreConfigPayloadV1 {
        project_folders: state.project_folders.clone(),
        projects: state
            .projects
            .iter()
            .map(|p| CoreProjectV1 {
                id: p.id.clone(),
                name: p.name.clone(),
                server_ids: p.server_ids.clone(),
                quick_commands: p
                    .quick_commands
                    .iter()
                    .map(|q| CoreQuickCommandV1 {
                        id: q.id.clone(),
                        title: q.title.clone(),
                        command: q.command.clone(),
                        folder: q.folder.clone(),
                        global: q.global,
                    })
                    .collect(),
                folder: p.folder.clone(),
                ai_mode: p.ai_mode,
            })
            .collect(),
        credentials: state
            .credentials
            .iter()
            .map(|c| CoreCredentialV1 {
                id: c.id.clone(),
                name: c.name.clone(),
                auth_type: c.auth_type,
                username: c.username.clone(),
            })
            .collect(),
        servers: state
            .servers
            .iter()
            .map(|s| CoreServerV1 {
                id: s.id.clone(),
                name: s.name.clone(),
                host: s.host.clone(),
                port: s.port,
                auth_type: s.auth_type,
                username: s.username.clone(),
                credential_id: s.credential_id.clone(),
                locked: s.locked,
                is_bastion: s.is_bastion,
                bastion_id: s.bastion_id.clone(),
                tags: s.tags.clone(),
            })
            .collect(),
        command_folders: state.command_folders.clone(),
        // BTreeMap 按 serverId 排序：HashMap 迭代序不定，直接收集会导致 core_hash 抖动（无谓上传）。
        ssh_tunnels: state
            .ssh_tunnels
            .iter()
            .map(|t| CoreTunnelV1 {
                id: t.id.clone(),
                server_id: t.server_id.clone(),
                name: t.name.clone(),
                kind: t.kind,
                bind_addr: t.bind_addr.clone(),
                local_port: t.local_port,
                target_host: t.target_host.clone(),
                target_port: t.target_port,
            })
            .collect(),
        sftp_favorites: {
            let mut by_server: BTreeMap<&str, Vec<CoreSftpFavoriteV1>> = BTreeMap::new();
            for (server_id, favorites) in &state.sftp_favorites {
                by_server
                    .entry(server_id.as_str())
                    .or_default()
                    .extend(favorites.iter().map(|f| CoreSftpFavoriteV1 {
                        path: f.path.clone(),
                        title: f.title.clone(),
                    }));
            }
            by_server
                .into_iter()
                .map(|(server_id, favorites)| CoreSftpFavoritesV1 {
                    server_id: server_id.to_string(),
                    favorites,
                })
                .collect()
        },
        browser_favorites: state
            .browser_favorites
            .iter()
            .map(|f| CoreBrowserFavoriteV1 {
                url: f.url.clone(),
                title: f.title.clone(),
            })
            .collect(),
        settings: Some(CoreSettingsV1 {
            llm_model_id: state.settings.llm.model_id.clone(),
            llm_base_url: state.settings.llm.base_url.clone(),
            llm_effort: state.settings.llm.effort,
            search_enabled: state.settings.search.enabled,
            theme: state.settings.theme,
            auto_switch_ai_workdir: state.settings.auto_switch_ai_workdir,
            project_view: state.settings.project_view,
            approval_mode: state.settings.approval_mode,
            auto_backup_remote_files: state.settings.auto_backup_remote_files,
            knowledge_auto_inject: state.settings.knowledge.auto_inject,
            knowledge_inject_count: state.settings.knowledge.inject_count,
            compact_server_list: state.settings.compact_server_list,
            tunnel_auto_start: state.settings.tunnel_auto_start,
        }),
    }
}

/// 应用完整远端核心配置。所有引用先校验，失败时不修改 state。
/// 项目路径是本机数据：本机已有项目保留原路径；云端新项目（或本机路径缺失的）
/// 在 workspace 下按项目名创建目录，workspace 未配置时保持空路径（由启动迁移补建）。
pub fn apply_remote(state: &mut AppState, payload: &CoreConfigPayloadV1) -> Result<(), String> {
    let project_paths: BTreeMap<&str, Option<String>> = state
        .projects
        .iter()
        .map(|p| (p.id.as_str(), p.path.clone()))
        .collect();
    let credential_paths: BTreeMap<&str, String> = state
        .credentials
        .iter()
        .map(|c| (c.id.as_str(), c.key_path.clone()))
        .collect();
    let server_paths: BTreeMap<&str, String> = state
        .servers
        .iter()
        .map(|s| (s.id.as_str(), s.key_path.clone()))
        .collect();

    let workspace = state
        .settings
        .workspace_dir
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let mut taken: HashSet<String> = project_paths
        .values()
        .flatten()
        .map(|p| project_path_key(p))
        .collect();

    let mut projects: Vec<Project> = Vec::with_capacity(payload.projects.len());
    for p in &payload.projects {
        let path = match project_paths.get(p.id.as_str()).cloned().flatten() {
            Some(path) if !path.trim().is_empty() => Some(path),
            _ => match &workspace {
                Some(ws) => {
                    let dir = alloc_project_dir_in_workspace(ws, &p.name, &taken)?;
                    taken.insert(project_path_key(&dir));
                    Some(dir)
                }
                None => None,
            },
        };
        projects.push(Project {
            id: p.id.clone(),
            name: p.name.clone(),
            path,
            server_ids: p.server_ids.clone(),
            quick_commands: p
                .quick_commands
                .iter()
                .map(|q| QuickCommand {
                    id: q.id.clone(),
                    title: q.title.clone(),
                    command: q.command.clone(),
                    folder: q.folder.clone(),
                    global: q.global,
                })
                .collect(),
            folder: p.folder.clone(),
            ai_mode: p.ai_mode,
        });
    }
    let credentials: Vec<Credential> = payload
        .credentials
        .iter()
        .map(|c| Credential {
            id: c.id.clone(),
            name: c.name.clone(),
            auth_type: c.auth_type,
            username: c.username.clone(),
            key_path: credential_paths
                .get(c.id.as_str())
                .cloned()
                .unwrap_or_default(),
        })
        .collect();
    let servers: Vec<Server> = payload
        .servers
        .iter()
        .map(|s| Server {
            id: s.id.clone(),
            name: s.name.clone(),
            host: s.host.clone(),
            port: s.port,
            auth_type: s.auth_type,
            username: s.username.clone(),
            key_path: server_paths.get(s.id.as_str()).cloned().unwrap_or_default(),
            credential_id: s.credential_id.clone(),
            locked: s.locked,
            is_bastion: s.is_bastion,
            bastion_id: s.bastion_id.clone(),
            tags: s.tags.clone(),
        })
        .collect();

    validate_references(&projects, &credentials, &servers)?;
    state.project_folders = payload.project_folders.clone();
    state.projects = projects;
    state.credentials = credentials;
    state.servers = servers;
    state.command_folders = payload.command_folders.clone();

    // 隧道/SFTP 收藏按 serverId 挂靠：引用 payload 之外的服务器（本地删服未级联清理隧道的
    // 残留、或对端发来的悬空数据）时宽松丢弃，不让单条悬空引用卡死整个 core_config 应用。
    let server_ids: BTreeSet<&str> = payload.servers.iter().map(|s| s.id.as_str()).collect();
    let tunnel_enabled: BTreeMap<&str, bool> = state
        .ssh_tunnels
        .iter()
        .map(|t| (t.id.as_str(), t.enabled))
        .collect();
    state.ssh_tunnels = payload
        .ssh_tunnels
        .iter()
        .filter(|t| server_ids.contains(t.server_id.as_str()))
        .map(|t| crate::tunnel::TunnelConfig {
            id: t.id.clone(),
            server_id: t.server_id.clone(),
            name: t.name.clone(),
            kind: t.kind,
            bind_addr: t.bind_addr.clone(),
            local_port: t.local_port,
            target_host: t.target_host.clone(),
            target_port: t.target_port,
            // enabled 是本机运行态：已有隧道保留本地值，新机首次见到按 false（不自动拉起）。
            enabled: tunnel_enabled.get(t.id.as_str()).copied().unwrap_or(false),
        })
        .collect();
    state.sftp_favorites = payload
        .sftp_favorites
        .iter()
        .filter(|group| server_ids.contains(group.server_id.as_str()))
        .map(|group| {
            (
                group.server_id.clone(),
                group
                    .favorites
                    .iter()
                    .map(|f| crate::store::SftpFavorite {
                        path: f.path.clone(),
                        title: f.title.clone(),
                    })
                    .collect::<Vec<_>>(),
            )
        })
        .collect();
    state.browser_favorites = payload
        .browser_favorites
        .iter()
        .map(|f| crate::store::BrowserFavorite {
            url: f.url.clone(),
            title: f.title.clone(),
        })
        .collect();

    // 系统设置白名单应用；workspace_dir（本机路径）、cloud（账号态）、MCP 端口（本机
    // 监听绑定）与 keyring 中的各类 key 保持本机不变。settings 缺失（老载荷）时不触碰。
    if let Some(s) = &payload.settings {
        let target = &mut state.settings;
        target.llm.model_id = s.llm_model_id.clone();
        target.llm.base_url = s.llm_base_url.clone();
        target.llm.effort = s.llm_effort;
        target.search.enabled = s.search_enabled;
        target.theme = s.theme;
        target.auto_switch_ai_workdir = s.auto_switch_ai_workdir;
        target.project_view = s.project_view;
        target.approval_mode = s.approval_mode;
        target.auto_backup_remote_files = s.auto_backup_remote_files;
        target.knowledge.auto_inject = s.knowledge_auto_inject;
        target.knowledge.inject_count = s.knowledge_inject_count;
        target.compact_server_list = s.compact_server_list;
        target.tunnel_auto_start = s.tunnel_auto_start;
    }
    Ok(())
}

/// 字段级冲突；合并结果默认保留 local 值。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreConflict {
    pub entity_type: String,
    pub entity_id: String,
    pub field: String,
    pub base: Option<Value>,
    pub local: Option<Value>,
    pub remote: Option<Value>,
}

/// 以稳定 ID 对实体、以字段对实体内容做三方合并。
/// 只有 local 和 remote 都相对 base 修改且修改不同才冲突；冲突保留 local。
pub fn merge_three_way(
    base: &CoreConfigPayloadV1,
    local: &CoreConfigPayloadV1,
    remote: &CoreConfigPayloadV1,
) -> (CoreConfigPayloadV1, Vec<CoreConflict>) {
    let mut conflicts = Vec::new();
    let projects = merge_list(
        "project",
        &base.projects,
        &local.projects,
        &remote.projects,
        &mut conflicts,
    );
    let credentials = merge_list(
        "credential",
        &base.credentials,
        &local.credentials,
        &remote.credentials,
        &mut conflicts,
    );
    let servers = merge_list(
        "server",
        &base.servers,
        &local.servers,
        &remote.servers,
        &mut conflicts,
    );
    let project_folders = merge_root(
        "projectFolders",
        &base.project_folders,
        &local.project_folders,
        &remote.project_folders,
        &mut conflicts,
    );
    let command_folders = merge_root(
        "commandFolders",
        &base.command_folders,
        &local.command_folders,
        &remote.command_folders,
        &mut conflicts,
    );
    let ssh_tunnels = merge_list(
        "tunnel",
        &base.ssh_tunnels,
        &local.ssh_tunnels,
        &remote.ssh_tunnels,
        &mut conflicts,
    );
    let sftp_favorites = merge_list(
        "sftpFavorites",
        &base.sftp_favorites,
        &local.sftp_favorites,
        &remote.sftp_favorites,
        &mut conflicts,
    );
    let browser_favorites = merge_list(
        "browserFavorite",
        &base.browser_favorites,
        &local.browser_favorites,
        &remote.browser_favorites,
        &mut conflicts,
    );
    // settings 是单对象：复用 merge_entity/merge_object 做逐字段三方取舍（LWW），
    // 序列化后的合成对象带临时 "id" 键，from_value 反序列化时自然丢弃。
    let base_settings = base.settings.as_ref().and_then(|s| serde_json::to_value(s).ok());
    let local_settings = local.settings.as_ref().and_then(|s| serde_json::to_value(s).ok());
    let remote_settings = remote
        .settings
        .as_ref()
        .and_then(|s| serde_json::to_value(s).ok());
    let settings = merge_entity(
        "settings",
        "settings",
        base_settings.as_ref(),
        local_settings.as_ref(),
        remote_settings.as_ref(),
        &mut conflicts,
    );

    (
        CoreConfigPayloadV1 {
            project_folders: decode_or_local(project_folders, &local.project_folders),
            projects: decode_list(projects),
            credentials: decode_list(credentials),
            servers: decode_list(servers),
            command_folders: decode_or_local(command_folders, &local.command_folders),
            ssh_tunnels: decode_list(ssh_tunnels),
            sftp_favorites: decode_list(sftp_favorites),
            browser_favorites: decode_list(browser_favorites),
            settings: settings
                .and_then(|value| serde_json::from_value::<CoreSettingsV1>(value).ok())
                .or_else(|| local.settings.clone()),
        },
        conflicts,
    )
}

pub fn try_merge_three_way(
    base: &CoreConfigPayloadV1,
    local: &CoreConfigPayloadV1,
    remote: &CoreConfigPayloadV1,
) -> Result<(CoreConfigPayloadV1, Vec<CoreConflict>), String> {
    let (merged, conflicts) = merge_three_way(base, local, remote);
    let (projects, credentials, servers) = payload_parts(&merged);
    validate_references(&projects, &credentials, &servers)?;
    Ok((merged, conflicts))
}

fn payload_parts(payload: &CoreConfigPayloadV1) -> (Vec<Project>, Vec<Credential>, Vec<Server>) {
    (
        payload
            .projects
            .iter()
            .map(|p| Project {
                id: p.id.clone(),
                name: p.name.clone(),
                path: None,
                server_ids: p.server_ids.clone(),
                quick_commands: p
                    .quick_commands
                    .iter()
                    .map(|q| QuickCommand {
                        id: q.id.clone(),
                        title: q.title.clone(),
                        command: q.command.clone(),
                        folder: q.folder.clone(),
                        global: q.global,
                    })
                    .collect(),
                folder: p.folder.clone(),
                ai_mode: p.ai_mode,
            })
            .collect(),
        payload
            .credentials
            .iter()
            .map(|c| Credential {
                id: c.id.clone(),
                name: c.name.clone(),
                auth_type: c.auth_type,
                username: c.username.clone(),
                key_path: String::new(),
            })
            .collect(),
        payload
            .servers
            .iter()
            .map(|s| Server {
                id: s.id.clone(),
                name: s.name.clone(),
                host: s.host.clone(),
                port: s.port,
                auth_type: s.auth_type,
                username: s.username.clone(),
                key_path: String::new(),
                credential_id: s.credential_id.clone(),
                locked: s.locked,
                is_bastion: s.is_bastion,
                bastion_id: s.bastion_id.clone(),
                tags: s.tags.clone(),
            })
            .collect(),
    )
}

fn validate_references(
    projects: &[Project],
    credentials: &[Credential],
    servers: &[Server],
) -> Result<(), String> {
    let credential_ids = ids(credentials.iter().map(|c| c.id.as_str()), "凭据")?;
    let server_ids = ids(servers.iter().map(|s| s.id.as_str()), "服务器")?;
    ids(projects.iter().map(|p| p.id.as_str()), "项目")?;
    for server in servers {
        if let Some(credential_id) = &server.credential_id {
            if !credential_ids.contains(credential_id) {
                return Err(format!(
                    "服务器「{}」引用了不存在的凭据「{}」",
                    server.id, credential_id
                ));
            }
        }
        if server.is_bastion && server.bastion_id.is_some() {
            return Err(format!(
                "服务器「{}」不能同时作为堡垒机与目标主机",
                server.id
            ));
        }
        if let Some(bastion_id) = &server.bastion_id {
            let Some(bastion) = servers.iter().find(|s| s.id == *bastion_id) else {
                return Err(format!(
                    "服务器「{}」引用了不存在的堡垒机「{}」",
                    server.id, bastion_id
                ));
            };
            if !bastion.is_bastion {
                return Err(format!(
                    "服务器「{}」引用的服务器「{}」不是堡垒机",
                    server.id, bastion_id
                ));
            }
        }
    }
    for project in projects {
        for server_id in &project.server_ids {
            if !server_ids.contains(server_id) {
                return Err(format!(
                    "项目「{}」引用了不存在的服务器「{}」",
                    project.id, server_id
                ));
            }
        }
    }
    Ok(())
}

fn ids<'a>(items: impl Iterator<Item = &'a str>, kind: &str) -> Result<BTreeSet<String>, String> {
    let mut result = BTreeSet::new();
    for id in items {
        if id.is_empty() {
            return Err(format!("{kind} ID 不能为空"));
        }
        if !result.insert(id.to_string()) {
            return Err(format!("{kind} ID 重复：{id}"));
        }
    }
    Ok(result)
}

trait HasId {
    fn id(&self) -> &str;
}
impl HasId for CoreProjectV1 {
    fn id(&self) -> &str {
        &self.id
    }
}
impl HasId for CoreCredentialV1 {
    fn id(&self) -> &str {
        &self.id
    }
}
impl HasId for CoreServerV1 {
    fn id(&self) -> &str {
        &self.id
    }
}
impl HasId for CoreQuickCommandV1 {
    fn id(&self) -> &str {
        &self.id
    }
}
impl HasId for CoreTunnelV1 {
    fn id(&self) -> &str {
        &self.id
    }
}
impl HasId for CoreSftpFavoritesV1 {
    fn id(&self) -> &str {
        &self.server_id
    }
}
impl HasId for CoreBrowserFavoriteV1 {
    fn id(&self) -> &str {
        &self.url
    }
}

fn json_map<T: HasId + Serialize>(items: &[T]) -> BTreeMap<String, Value> {
    items
        .iter()
        .filter_map(|item| Some((item.id().to_string(), serde_json::to_value(item).ok()?)))
        .collect()
}

fn merge_list<T: HasId + Serialize>(
    kind: &str,
    base: &[T],
    local: &[T],
    remote: &[T],
    conflicts: &mut Vec<CoreConflict>,
) -> Vec<Value> {
    let base = json_map(base);
    let local = json_map(local);
    let remote = json_map(remote);
    base.keys()
        .chain(local.keys())
        .chain(remote.keys())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .filter_map(|id| {
            merge_entity(
                kind,
                id,
                base.get(id),
                local.get(id),
                remote.get(id),
                conflicts,
            )
        })
        .collect()
}

fn merge_entity(
    kind: &str,
    id: &str,
    base: Option<&Value>,
    local: Option<&Value>,
    remote: Option<&Value>,
    conflicts: &mut Vec<CoreConflict>,
) -> Option<Value> {
    match (base, local, remote) {
        (None, None, None) | (Some(_), None, None) => None,
        (None, Some(v), None) | (None, None, Some(v)) => Some(v.clone()),
        (None, Some(l), Some(r)) => Some(merge_object(kind, id, None, l, r, conflicts)),
        (Some(b), Some(l), Some(r)) => {
            if l == r {
                Some(l.clone())
            } else if l == b {
                Some(r.clone())
            } else if r == b {
                Some(l.clone())
            } else {
                Some(merge_object(kind, id, Some(b), l, r, conflicts))
            }
        }
        (Some(b), None, Some(r)) => {
            if r == b {
                None
            } else {
                record_conflicts(kind, id, Some(b), None, Some(r), conflicts);
                None
            }
        }
        (Some(b), Some(l), None) => {
            // core_config 是云端全量快照：云端缺失某实体不代表「被删除」，
            // 本地也未删除时不应丢项目（否则从残缺的云端拉取会清空本地配置）。
            if l != b {
                record_conflicts(kind, id, Some(b), Some(l), None, conflicts);
            }
            Some(l.clone())
        }
    }
}

fn merge_object(
    kind: &str,
    id: &str,
    base: Option<&Value>,
    local: &Value,
    remote: &Value,
    conflicts: &mut Vec<CoreConflict>,
) -> Value {
    let (Some(local), Some(remote)) = (local.as_object(), remote.as_object()) else {
        return local.clone();
    };
    let base = base.and_then(Value::as_object);
    let fields: BTreeSet<String> = local
        .keys()
        .chain(remote.keys())
        .chain(base.into_iter().flat_map(Map::keys))
        .filter(|k| *k != "id")
        .cloned()
        .collect();
    let mut result = Map::new();
    result.insert("id".into(), Value::String(id.into()));
    for field in fields {
        let b = base.and_then(|m| m.get(&field));
        let l = local.get(&field);
        let r = remote.get(&field);
        let value = if kind == "project" && field == "quickCommands" {
            merge_json_list("quickCommand", id, b, l, r, conflicts)
        } else {
            merge_field(kind, id, &field, b, l, r, conflicts)
        };
        if let Some(value) = value {
            result.insert(field, value);
        }
    }
    Value::Object(result)
}

fn merge_json_list(
    kind: &str,
    parent_id: &str,
    base: Option<&Value>,
    local: Option<&Value>,
    remote: Option<&Value>,
    conflicts: &mut Vec<CoreConflict>,
) -> Option<Value> {
    let b = json_value_map(base.and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]));
    let l = json_value_map(local.and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]));
    let r = json_value_map(remote.and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]));
    let values = b
        .keys()
        .chain(l.keys())
        .chain(r.keys())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .filter_map(|id| {
            merge_entity(
                kind,
                &format!("{parent_id}/{id}"),
                b.get(id),
                l.get(id),
                r.get(id),
                conflicts,
            )
        })
        .collect::<Vec<_>>();
    Some(Value::Array(values))
}

fn json_value_map(values: &[Value]) -> BTreeMap<String, Value> {
    values
        .iter()
        .filter_map(|value| Some((value.get("id")?.as_str()?.to_string(), value.clone())))
        .collect()
}

fn merge_root<T: Serialize + PartialEq>(
    field: &str,
    base: &T,
    local: &T,
    remote: &T,
    conflicts: &mut Vec<CoreConflict>,
) -> Value {
    let b = serde_json::to_value(base).unwrap_or(Value::Null);
    let l = serde_json::to_value(local).unwrap_or(Value::Null);
    let r = serde_json::to_value(remote).unwrap_or(Value::Null);
    merge_field("core", "", field, Some(&b), Some(&l), Some(&r), conflicts).unwrap_or(Value::Null)
}

fn merge_field(
    kind: &str,
    id: &str,
    field: &str,
    base: Option<&Value>,
    local: Option<&Value>,
    remote: Option<&Value>,
    conflicts: &mut Vec<CoreConflict>,
) -> Option<Value> {
    if local == remote {
        return local.cloned();
    }
    if local == base {
        return remote.cloned();
    }
    if remote == base {
        return local.cloned();
    }
    conflicts.push(CoreConflict {
        entity_type: kind.into(),
        entity_id: id.into(),
        field: field.into(),
        base: base.cloned(),
        local: local.cloned(),
        remote: remote.cloned(),
    });
    local.cloned()
}

fn record_conflicts(
    kind: &str,
    id: &str,
    base: Option<&Value>,
    local: Option<&Value>,
    remote: Option<&Value>,
    conflicts: &mut Vec<CoreConflict>,
) {
    let fields = [base, local, remote]
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .flat_map(Map::keys)
        .filter(|k| *k != "id")
        .cloned()
        .collect::<BTreeSet<_>>();
    for field in fields {
        let b = base.and_then(Value::as_object).and_then(|m| m.get(&field));
        let l = local.and_then(Value::as_object).and_then(|m| m.get(&field));
        let r = remote
            .and_then(Value::as_object)
            .and_then(|m| m.get(&field));
        if l != b && r != b {
            conflicts.push(CoreConflict {
                entity_type: kind.into(),
                entity_id: id.into(),
                field,
                base: b.cloned(),
                local: l.cloned(),
                remote: r.cloned(),
            });
        }
    }
}

fn decode_or_local<T: DeserializeOwned + Serialize>(value: Value, local: &T) -> T {
    serde_json::from_value(value).unwrap_or_else(|_| {
        serde_json::to_value(local)
            .ok()
            .and_then(|v| serde_json::from_value(v).ok())
            .expect("local DTO must serialize")
    })
}
fn decode_list<T: DeserializeOwned>(values: Vec<Value>) -> Vec<T> {
    values
        .into_iter()
        .filter_map(|value| serde_json::from_value(value).ok())
        .collect()
}

/// 秘密同步只引用稳定 ID，不携带密码、token 或 key 内容。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretOperationPlan {
    pub operations: Vec<SecretOperation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretOperation {
    pub kind: SecretKind,
    pub id: String,
    pub action: SecretAction,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SecretKind {
    Credential,
    CloudToken,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SecretAction {
    PreserveLocal,
    FetchRemote,
    DeleteLocal,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(id: &str, name: &str, servers: &[&str]) -> CoreProjectV1 {
        CoreProjectV1 {
            id: id.into(),
            name: name.into(),
            server_ids: servers.iter().map(|s| (*s).into()).collect(),
            quick_commands: vec![],
            folder: String::new(),
            ai_mode: AiMode::Suggest,
        }
    }
    fn c(id: &str) -> CoreCredentialV1 {
        CoreCredentialV1 {
            id: id.into(),
            name: id.into(),
            auth_type: AuthType::Password,
            username: "u".into(),
        }
    }
    fn s(id: &str, credential: Option<&str>) -> CoreServerV1 {
        CoreServerV1 {
            id: id.into(),
            name: id.into(),
            host: "host".into(),
            port: 22,
            auth_type: AuthType::Password,
            username: "u".into(),
            credential_id: credential.map(str::to_string),
            locked: false,
            is_bastion: false,
            bastion_id: None,
            tags: Vec::new(),
        }
    }
    fn payload() -> CoreConfigPayloadV1 {
        CoreConfigPayloadV1 {
            project_folders: vec![],
            projects: vec![p("p1", "项目", &["s1"])],
            credentials: vec![c("c1")],
            servers: vec![s("s1", Some("c1"))],
            command_folders: vec![],
            ssh_tunnels: vec![],
            sftp_favorites: vec![],
            browser_favorites: vec![],
            settings: None,
        }
    }

    fn settings_fixture() -> CoreSettingsV1 {
        CoreSettingsV1 {
            llm_model_id: "deepseek-v4-flash".into(),
            llm_base_url: "https://api.deepseek.com/v1".into(),
            llm_effort: Effort::Low,
            search_enabled: false,
            theme: Theme::Dark,
            auto_switch_ai_workdir: true,
            project_view: ProjectView::Card,
            approval_mode: ApprovalMode::Smart,
            auto_backup_remote_files: true,
            knowledge_auto_inject: true,
            knowledge_inject_count: 5,
            compact_server_list: false,
            tunnel_auto_start: true,
        }
    }

    #[test]
    fn whitelist_excludes_paths_and_secrets() {
        let mut state = AppState::default();
        state.projects.push(Project {
            id: "p1".into(),
            name: "P".into(),
            path: Some("C:/private/project".into()),
            server_ids: vec![],
            quick_commands: vec![],
            folder: String::new(),
            ai_mode: AiMode::Suggest,
        });
        state.credentials.push(Credential {
            id: "c1".into(),
            name: "C".into(),
            auth_type: AuthType::Password,
            username: "u".into(),
            key_path: "C:/private/credential-key".into(),
        });
        state.servers.push(Server {
            id: "s1".into(),
            name: "S".into(),
            host: "h".into(),
            port: 22,
            auth_type: AuthType::Password,
            username: "u".into(),
            key_path: "C:/private/server-key".into(),
            credential_id: Some("c1".into()),
            locked: false,
            is_bastion: false,
            bastion_id: None,
            tags: Vec::new(),
        });
        let value = serde_json::to_value(from_app_state(&state)).unwrap();
        assert!(!value.to_string().contains("private"));
        assert!(value["projects"][0].get("path").is_none());
        assert!(value["credentials"][0].get("keyPath").is_none());
        assert!(value["servers"][0].get("keyPath").is_none());
    }

    #[test]
    fn apply_preserves_existing_paths_and_clears_new_paths() {
        let mut state = AppState::default();
        state.projects.push(Project {
            id: "p1".into(),
            name: "P".into(),
            path: Some("C:/p".into()),
            server_ids: vec![],
            quick_commands: vec![],
            folder: String::new(),
            ai_mode: AiMode::Suggest,
        });
        state.credentials.push(Credential {
            id: "c1".into(),
            name: "C".into(),
            auth_type: AuthType::Password,
            username: "u".into(),
            key_path: "C:/c".into(),
        });
        state.servers.push(Server {
            id: "s1".into(),
            name: "S".into(),
            host: "h".into(),
            port: 22,
            auth_type: AuthType::Password,
            username: "u".into(),
            key_path: "C:/s".into(),
            credential_id: Some("c1".into()),
            locked: false,
            is_bastion: false,
            bastion_id: None,
            tags: Vec::new(),
        });
        let mut remote = payload();
        remote.projects.push(p("p2", "新项目", &[]));
        remote.credentials.push(c("c2"));
        remote.servers.push(s("s2", Some("c2")));
        apply_remote(&mut state, &remote).unwrap();
        assert_eq!(state.projects[0].path.as_deref(), Some("C:/p"));
        assert_eq!(state.projects[1].path, None);
        assert_eq!(state.credentials[0].key_path, "C:/c");
        assert_eq!(state.credentials[1].key_path, "");
        assert_eq!(state.servers[0].key_path, "C:/s");
        assert_eq!(state.servers[1].key_path, "");
    }

    #[test]
    fn apply_assigns_workspace_dir_for_new_projects() {
        let ws = std::env::temp_dir().join(format!("aishell-core-test-ws-{}", std::process::id()));
        let mut state = AppState {
            settings: crate::store::Settings {
                workspace_dir: Some(ws.to_string_lossy().into_owned()),
                ..crate::store::Settings::default()
            },
            ..AppState::default()
        };
        state.projects.push(Project {
            id: "p1".into(),
            name: "老项目".into(),
            path: Some("C:/keep".into()),
            server_ids: vec!["s1".into()],
            quick_commands: vec![],
            folder: String::new(),
            ai_mode: AiMode::Suggest,
        });
        // 本机已有 p1（路径必须保留）；p2 名字含 Windows 非法字符；p3 与 p2 清洗后同名。
        let remote = CoreConfigPayloadV1 {
            projects: vec![
                p("p1", "老项目", &["s1"]),
                p("p2", "新/项目", &["s1"]),
                p("p3", "新_项目", &["s1"]),
            ],
            ..payload()
        };
        apply_remote(&mut state, &remote).unwrap();
        assert_eq!(state.projects[0].path.as_deref(), Some("C:/keep"));
        let dir2 = ws.join("新_项目");
        let dir3 = ws.join("新_项目-2");
        assert_eq!(
            state.projects[1].path.as_deref(),
            Some(dir2.to_string_lossy().as_ref())
        );
        assert_eq!(
            state.projects[2].path.as_deref(),
            Some(dir3.to_string_lossy().as_ref())
        );
        assert!(dir2.join(".aishell").is_dir());
        assert!(dir3.join(".aishell").is_dir());
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn merge_keeps_local_when_remote_missing_unmodified_project() {
        let base = CoreConfigPayloadV1 {
            projects: vec![p("p1", "A", &["s1"]), p("p2", "B", &["s1"])],
            ..payload()
        };
        let local = base.clone();
        // 云端是全量快照但缺 p2（云端被清空/未同步该实体）。
        let mut remote = CoreConfigPayloadV1 {
            projects: vec![p("p1", "A", &["s1"])],
            ..payload()
        };
        remote.credentials = payload().credentials;
        remote.servers = payload().servers;
        let (merged, conflicts) = merge_three_way(&base, &local, &remote);
        assert!(conflicts.is_empty());
        assert_eq!(merged.projects.len(), 2);
        assert!(merged.projects.iter().any(|x| x.id == "p2"));
    }

    #[test]
    fn merge_different_fields_without_conflict() {
        let base = payload();
        let mut local = base.clone();
        local.projects[0].name = "本机".into();
        let mut remote = base.clone();
        remote.projects[0].folder = "生产".into();
        let (merged, conflicts) = merge_three_way(&base, &local, &remote);
        assert!(conflicts.is_empty());
        assert_eq!(merged.projects[0].name, "本机");
        assert_eq!(merged.projects[0].folder, "生产");
    }

    #[test]
    fn merge_same_field_reports_conflict_and_keeps_local() {
        let base = payload();
        let mut local = base.clone();
        local.projects[0].name = "本机".into();
        let mut remote = base.clone();
        remote.projects[0].name = "远端".into();
        let (merged, conflicts) = merge_three_way(&base, &local, &remote);
        assert_eq!(merged.projects[0].name, "本机");
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].field, "name");
    }

    #[test]
    fn apply_rejects_bad_references_atomically() {
        let mut state = AppState {
            project_folders: vec!["本机".into()],
            ..AppState::default()
        };
        let mut bad = payload();
        bad.servers[0].credential_id = Some("missing".into());
        assert!(apply_remote(&mut state, &bad)
            .unwrap_err()
            .contains("不存在的凭据"));
        assert_eq!(state.project_folders, vec!["本机"]);
        assert!(state.servers.is_empty());
    }

    fn tun(id: &str, server: &str) -> CoreTunnelV1 {
        CoreTunnelV1 {
            id: id.into(),
            server_id: server.into(),
            name: format!("隧道-{id}"),
            kind: TunnelKind::Local,
            bind_addr: "127.0.0.1".into(),
            local_port: 3307,
            target_host: String::new(),
            target_port: 3306,
        }
    }
    fn fav_group(server: &str, path: &str) -> CoreSftpFavoritesV1 {
        CoreSftpFavoritesV1 {
            server_id: server.into(),
            favorites: vec![CoreSftpFavoriteV1 {
                path: path.into(),
                title: String::new(),
            }],
        }
    }
    fn bfav(url: &str) -> CoreBrowserFavoriteV1 {
        CoreBrowserFavoriteV1 {
            url: url.into(),
            title: "示例".into(),
        }
    }

    #[test]
    fn apply_tunnels_keep_local_enabled_and_default_off() {
        let mut state = AppState::default();
        let mut remote = payload();
        remote.ssh_tunnels.push(tun("t1", "s1"));
        // 新机首次见到该隧道 → enabled=false，同步不会自动拉起监听。
        apply_remote(&mut state, &remote).unwrap();
        assert_eq!(state.ssh_tunnels.len(), 1);
        assert!(!state.ssh_tunnels[0].enabled);
        assert_eq!(state.ssh_tunnels[0].server_id, "s1");

        // 本机已有同名隧道且启用 → 应用远端后保留本地 enabled，其余字段跟随远端。
        let mut enabled = state.ssh_tunnels[0].clone();
        enabled.enabled = true;
        enabled.name = "本机改名".into();
        state.ssh_tunnels[0] = enabled;
        apply_remote(&mut state, &remote).unwrap();
        assert!(state.ssh_tunnels[0].enabled);
        assert_eq!(state.ssh_tunnels[0].name, "隧道-t1");
    }

    #[test]
    fn apply_drops_entries_referencing_missing_servers() {
        let mut state = AppState::default();
        let mut remote = payload();
        remote.ssh_tunnels.push(tun("t-ok", "s1"));
        remote.ssh_tunnels.push(tun("t-dangling", "missing"));
        remote.sftp_favorites.push(fav_group("s1", "/var/www"));
        remote.sftp_favorites.push(fav_group("missing", "/tmp"));
        remote.browser_favorites.push(bfav("https://example.com"));
        apply_remote(&mut state, &remote).unwrap();
        assert_eq!(state.ssh_tunnels.len(), 1);
        assert_eq!(state.ssh_tunnels[0].id, "t-ok");
        assert_eq!(state.sftp_favorites.len(), 1);
        assert!(state.sftp_favorites.contains_key("s1"));
        assert_eq!(state.browser_favorites[0].url, "https://example.com");
        assert_eq!(state.browser_favorites[0].title, "示例");
    }

    #[test]
    fn whitelist_tunnels_exclude_enabled_state() {
        let mut state = AppState::default();
        state.servers.push(Server {
            id: "s1".into(),
            name: "S".into(),
            host: "h".into(),
            port: 22,
            auth_type: AuthType::Password,
            username: "u".into(),
            key_path: String::new(),
            credential_id: None,
            locked: false,
            is_bastion: false,
            bastion_id: None,
            tags: Vec::new(),
        });
        state.ssh_tunnels.push(crate::tunnel::TunnelConfig {
            id: "t1".into(),
            server_id: "s1".into(),
            name: "db".into(),
            kind: TunnelKind::Local,
            bind_addr: "127.0.0.1".into(),
            local_port: 3307,
            target_host: String::new(),
            target_port: 3306,
            enabled: true,
        });
        let value = serde_json::to_value(from_app_state(&state)).unwrap();
        assert!(value["sshTunnels"][0].get("enabled").is_none());
        assert_eq!(value["sshTunnels"][0]["serverId"], "s1");
    }

    #[test]
    fn old_payload_without_new_fields_deserializes() {
        // 老 baseline（含 tags 加入前的更早版本风格）缺新字段时仍可解，值按空。
        let json = serde_json::json!({
            "projectFolders": [], "projects": [], "credentials": [],
            "servers": [], "commandFolders": []
        });
        let restored: CoreConfigPayloadV1 = serde_json::from_value(json).unwrap();
        assert!(restored.ssh_tunnels.is_empty());
        assert!(restored.sftp_favorites.is_empty());
        assert!(restored.browser_favorites.is_empty());
        // settings 缺失按 None，应用时不触碰本机设置。
        assert!(restored.settings.is_none());
        let mut state = AppState::default();
        state.settings.theme = Theme::Dark;
        state.settings.compact_server_list = true;
        apply_remote(&mut state, &restored).unwrap();
        assert_eq!(state.settings.theme, Theme::Dark);
        assert!(state.settings.compact_server_list);
    }

    #[test]
    fn merge_tunnels_and_favorites_three_way() {
        let mut base = payload();
        base.ssh_tunnels.push(tun("t1", "s1"));
        base.sftp_favorites.push(fav_group("s1", "/var/www"));
        base.browser_favorites.push(bfav("https://a.example.com"));

        // 单侧新增（另一侧未动）→ 合入，无冲突。
        let mut local = base.clone();
        local.ssh_tunnels.push(tun("t2", "s1"));
        let mut remote = base.clone();
        remote.browser_favorites.push(bfav("https://b.example.com"));
        let (merged, conflicts) = merge_three_way(&base, &local, &remote);
        assert!(conflicts.is_empty());
        assert_eq!(merged.ssh_tunnels.len(), 2);
        assert_eq!(merged.browser_favorites.len(), 2);
        assert_eq!(merged.sftp_favorites.len(), 1);

        // 两侧改同一收藏组的不同内容 → 冲突一次，保留 local。
        let mut base2 = payload();
        base2.sftp_favorites.push(fav_group("s1", "/var/www"));
        let mut local2 = base2.clone();
        local2.sftp_favorites[0]
            .favorites
            .push(CoreSftpFavoriteV1 {
                path: "/local-only".into(),
                title: String::new(),
            });
        let mut remote2 = base2.clone();
        remote2.sftp_favorites[0].favorites[0].title = "远端改名".into();
        let (merged2, conflicts2) = merge_three_way(&base2, &local2, &remote2);
        assert_eq!(conflicts2.len(), 1);
        assert_eq!(conflicts2[0].entity_type, "sftpFavorites");
        assert_eq!(merged2.sftp_favorites[0].favorites.len(), 2);
    }

    #[test]
    fn settings_roundtrip_excludes_local_and_account_state() {
        let mut state = AppState::default();
        state.settings.workspace_dir = Some("C:/ws".into());
        state.settings.theme = Theme::Light;
        state.settings.llm.model_id = "custom-model".into();
        state.settings.llm.effort = Effort::Max;
        state.settings.approval_mode = ApprovalMode::All;
        state.settings.compact_server_list = true;
        state.settings.knowledge.inject_count = 12;
        state.settings.tunnel_auto_start = false;

        let payload = from_app_state(&state);
        let value = serde_json::to_value(&payload).unwrap();
        assert_eq!(value["settings"]["theme"], "light");
        assert_eq!(value["settings"]["llmModelId"], "custom-model");
        assert_eq!(value["settings"]["llmEffort"], "max");
        assert_eq!(value["settings"]["approvalMode"], "all");
        assert!(value["settings"].get("workspaceDir").is_none());
        assert!(value["settings"].get("cloud").is_none());
        assert!(value["settings"].get("mcpPort").is_none());
        let text = value.to_string();
        assert!(!text.contains("braveKey"));
        assert!(!text.contains("apiKey"));

        // 应用到另一台机器：白名单设置跟随云端，workspace_dir（本机路径）保留。
        let mut fresh = AppState::default();
        fresh.settings.workspace_dir = Some("D:/数据/工作区".into());
        fresh.settings.theme = Theme::Dark;
        apply_remote(&mut fresh, &payload).unwrap();
        assert_eq!(fresh.settings.theme, Theme::Light);
        assert_eq!(fresh.settings.llm.model_id, "custom-model");
        assert_eq!(fresh.settings.llm.effort, Effort::Max);
        assert_eq!(fresh.settings.approval_mode, ApprovalMode::All);
        assert!(fresh.settings.compact_server_list);
        assert_eq!(fresh.settings.knowledge.inject_count, 12);
        assert!(!fresh.settings.tunnel_auto_start);
        assert_eq!(
            fresh.settings.workspace_dir.as_deref(),
            Some("D:/数据/工作区")
        );
    }

    #[test]
    fn merge_settings_per_field() {
        let mut base = payload();
        base.settings = Some(settings_fixture());

        // 单侧各改不同字段 → 逐字段合并，无冲突。
        let mut local = base.clone();
        local.settings.as_mut().unwrap().theme = Theme::Light;
        let mut remote = base.clone();
        remote.settings.as_mut().unwrap().approval_mode = ApprovalMode::All;
        let (merged, conflicts) = merge_three_way(&base, &local, &remote);
        assert!(conflicts.is_empty());
        let settings = merged.settings.expect("settings 应参与合并");
        assert_eq!(settings.theme, Theme::Light);
        assert_eq!(settings.approval_mode, ApprovalMode::All);
        assert_eq!(settings.llm_model_id, "deepseek-v4-flash");

        // 两侧同字段改不同值 → 冲突一次，保留 local。
        let mut local2 = base.clone();
        local2.settings.as_mut().unwrap().llm_model_id = "m-local".into();
        let mut remote2 = base.clone();
        remote2.settings.as_mut().unwrap().llm_model_id = "m-remote".into();
        let (merged2, conflicts2) = merge_three_way(&base, &local2, &remote2);
        assert_eq!(conflicts2.len(), 1);
        assert_eq!(conflicts2[0].entity_type, "settings");
        assert_eq!(conflicts2[0].field, "llmModelId");
        assert_eq!(merged2.settings.unwrap().llm_model_id, "m-local");
    }
}
