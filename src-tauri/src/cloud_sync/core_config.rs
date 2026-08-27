//! 核心配置云同步：白名单 DTO、本机路径保护、引用校验与三方合并。
//!
//! 本模块刻意不序列化 `AppState`：项目 `path`、凭据/服务器 `key_path` 和所有
//! session/keyring 数据均为本机数据。与云端交换的字段以 `store.rs` 为准。

use std::collections::{BTreeMap, BTreeSet};

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::store::{AiMode, AppState, AuthType, Credential, Project, QuickCommand, Server};

/// 核心配置同步协议 v1。字段白名单是协议的一部分，不要改为直接序列化 AppState。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreConfigPayloadV1 {
    pub project_folders: Vec<String>,
    pub projects: Vec<CoreProjectV1>,
    pub credentials: Vec<CoreCredentialV1>,
    pub servers: Vec<CoreServerV1>,
    pub command_folders: Vec<String>,
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

pub type CoreProject = CoreProjectV1;
pub type CoreQuickCommand = CoreQuickCommandV1;
pub type CoreCredential = CoreCredentialV1;
pub type CoreServer = CoreServerV1;

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
    }
}

/// 应用完整远端核心配置。所有引用先校验，失败时不修改 state。
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

    let projects: Vec<Project> = payload
        .projects
        .iter()
        .map(|p| Project {
            id: p.id.clone(),
            name: p.name.clone(),
            path: project_paths.get(p.id.as_str()).cloned().unwrap_or(None),
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
        .collect();
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

    (
        CoreConfigPayloadV1 {
            project_folders: decode_or_local(project_folders, &local.project_folders),
            projects: decode_list(projects),
            credentials: decode_list(credentials),
            servers: decode_list(servers),
            command_folders: decode_or_local(command_folders, &local.command_folders),
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
            if l == b {
                None
            } else {
                record_conflicts(kind, id, Some(b), Some(l), None, conflicts);
                Some(l.clone())
            }
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
}
