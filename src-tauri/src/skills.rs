//! Skill 系统：发现、校验、原子写入与启停（受限存储服务）。
//!
//! 契约：
//! - 数据模型与 src/types.ts 逐字段对齐（serde camelCase）；命令清单见 src/api.ts 的 skills 段；
//! - 技能目录结构 `<skills-root>/<name>/SKILL.md`；全局根 = `<workspace_dir>/.aishell/skills`，
//!   项目根 = `<Project.path>/.aishell/skills`（path 为空回退 `<workspace_dir>/<Project.name>`）；
//! - frontmatter 固定字段：`name`（唯一，`^[a-z0-9]+(?:-[a-z0-9]+)*$`，≤64，目录名必须一致）、
//!   `description`（非空，≤1024）、AIShell 自定义 `scope: string[]`（local | all | remote:<主机名称>，
//!   缺失或空数组按 `["all"]`）、`enabled: bool`（缺失按 true；未知字段忽略，兼容标准 Agent Skill）；
//!   重复顶层键直接报错（serde_yaml_ng 的 Value 反序列化会拒绝重复键）；
//! - `skill_save` 只文本级替换/插入 frontmatter 顶层 `scope` 序列，`skill_set_enabled` 只文本级
//!   替换/插入顶层 `enabled` 布尔标量 —— 正文、注释、字段顺序与未知字段字节保持不变；
//! - `skill_pack_upload` 仅生成同一工作区 `.aishell/tmp/skillhub-upload/` 下的受限临时 ZIP；
//!   浏览器发布成功后由 browser.rs 用本模块受限 helper 清理，手动回退时保留原包；
//! - 所有写操作走同目录 `SKILL.md.tmp`：目标已存在时「.tmp → 原文件改 .bak → .tmp 改名正式 →
//!   删 .bak」，任一步失败回滚 .bak，绝不破坏原文件；
//! - 路径安全：拒绝空名、`..`、路径分隔符、符号链接技能目录/SKILL.md；技能根自身是符号链接时
//!   取其 canonical 目标为受信根；已存在目标 canonicalize、待创建目标 canonicalize 最近已存在
//!   父目录后用 Path::starts_with 复核（Windows 大小写不敏感，与 aishell-guard.ts 同语义）。
//!
//! 命令由 lib.rs 的 generate_handler 登记；本模块仅暴露受限命令与供 browser.rs 复用的安全 helper。

use std::collections::HashSet;
use std::fs::File;
use std::io::{self, Cursor, Read};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::State;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::store::Store;

// ---------------------------------------------------------------- 数据模型

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SkillOrigin {
    Global,
    Project,
}

impl SkillOrigin {
    pub fn as_str(self) -> &'static str {
        match self {
            SkillOrigin::Global => "global",
            SkillOrigin::Project => "project",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSummary {
    /// 固定为 `global:<name>` 或 `project:<projectId>:<name>`。
    pub id: String,
    pub name: String,
    pub description: String,
    /// 缺失/空数组已规范化为 ["all"]；元素去重保留首见顺序。
    pub scope: Vec<String>,
    pub enabled: bool,
    pub origin: SkillOrigin,
    /// SKILL.md 的规范化绝对路径。
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDocument {
    pub summary: SkillSummary,
    /// 完整 SKILL.md 原文。
    pub content: String,
}

// ---------------------------------------------------------------- 常量与内置模板

const SKILL_FILE: &str = "SKILL.md";
pub const SKILL_MANAGEMENT_NAME: &str = "skill-management";

/// 内置 skill-management 模板（include_str! 嵌入，不修改 Tauri bundle resources）。
pub const BUILTIN_SKILL_MANAGEMENT: &str = include_str!("builtin_skills/skill-management/SKILL.md");

// ---------------------------------------------------------------- 根目录推导

/// 全局技能根：`<workspace_dir>/.aishell/skills`；缺 workspace 返回中文可执行错误。
pub fn global_skills_root(store: &Store) -> Result<PathBuf, String> {
    let ws = store
        .settings()
        .workspace_dir
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "请先在设置中配置工作区目录".to_string())?;
    Ok(PathBuf::from(ws).join(".aishell").join("skills"))
}

/// 项目技能根：`<Project.path>/.aishell/skills`；path 为空回退 `<workspace_dir>/<Project.name>`
/// （与 Store::ensure_project_dirs 的既有规则一致）。
pub fn project_skills_root(store: &Store, project_id: &str) -> Result<PathBuf, String> {
    let project = store
        .project(project_id)
        .ok_or_else(|| format!("项目不存在：{project_id}"))?;
    let dir = match project.path.as_deref().filter(|s| !s.trim().is_empty()) {
        Some(p) => PathBuf::from(p),
        None => {
            let ws = store
                .settings()
                .workspace_dir
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| "请先在设置中配置工作区目录".to_string())?;
            PathBuf::from(ws).join(&project.name)
        }
    };
    Ok(dir.join(".aishell").join("skills"))
}

fn skills_root(store: &Store, project_id: &str, origin: SkillOrigin) -> Result<PathBuf, String> {
    match origin {
        SkillOrigin::Global => global_skills_root(store),
        SkillOrigin::Project => project_skills_root(store, project_id),
    }
}

// ---------------------------------------------------------------- 路径安全

/// Windows canonicalize 返回 `\\?\` 前缀的 verbatim 路径（如 `\\?\C:\...`、`\\?\UNC\srv\share`）；
/// 统一转回常规形式（`C:\...` / `\\srv\share`），否则会污染 summary.path / pi 参数 / 环境变量，
/// 并导致 guard 的 path.resolve 归一后前缀失配（fail-closed 误拒技能读取）。
#[cfg(windows)]
fn normalize_win_path(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        p
    }
}

#[cfg(not(windows))]
fn normalize_win_path(p: PathBuf) -> PathBuf {
    p
}

/// Windows 大小写不敏感前缀比较（与 aishell-guard.ts 的 inside 同语义）；其它平台直接 starts_with。
#[cfg(windows)]
fn path_starts_with(base: &Path, target: &Path) -> bool {
    let b: Vec<String> = base
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_lowercase())
        .collect();
    let t: Vec<String> = target
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_lowercase())
        .collect();
    t.len() >= b.len() && b.iter().zip(&t).all(|(x, y)| x == y)
}

#[cfg(not(windows))]
fn path_starts_with(base: &Path, target: &Path) -> bool {
    target.starts_with(base)
}

/// 受信根：根存在时 canonicalize（符号链接根取其目标作为受信根）；不存在时原样返回（列表空、写入前创建）。
fn trusted_root(root: &Path) -> Result<PathBuf, String> {
    if !root.exists() {
        return Ok(root.to_path_buf());
    }
    let meta = std::fs::metadata(root)
        .map_err(|e| format!("技能根读取失败（{}）: {e}", root.display()))?;
    if !meta.is_dir() {
        return Err(format!("技能根不是目录（{}）", root.display()));
    }
    std::fs::canonicalize(root)
        .map(normalize_win_path)
        .map_err(|e| format!("技能根解析失败（{}）: {e}", root.display()))
}

/// 校验技能名称（frontmatter name / 目录名共用）：小写字母数字与连字符、最长 64。
fn validate_skill_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("技能名称不能为空".to_string());
    }
    if name.len() > 64 {
        return Err(format!("技能名称过长（最多 64 字符）：{name}"));
    }
    let re = regex::Regex::new(r"^[a-z0-9]+(?:-[a-z0-9]+)*$").expect("技能名称正则编译失败");
    if !re.is_match(name) {
        return Err(format!(
            "技能名称只能包含小写字母、数字与连字符（形如 my-skill）：{name}"
        ));
    }
    Ok(())
}

/// 解析 `root/<child>` 为受信根内路径：已存在目标 canonicalize、待创建目标 canonicalize
/// 最近已存在父目录，再用 Path::starts_with 复核；child 先过名称校验（拒绝分隔符/`..`）。
/// 返回 (受信根, 规范化目标路径)。
fn resolve_in_root(root: &Path, child: &str) -> Result<(PathBuf, PathBuf), String> {
    validate_skill_name(child)?;
    let trusted = trusted_root(root)?;
    let target = trusted.join(child);
    if target.exists() {
        let meta = std::fs::symlink_metadata(&target)
            .map_err(|e| format!("技能路径读取失败（{}）：{e}", target.display()))?;
        if is_link_or_reparse(&meta) {
            return Err(format!("技能目录不能是符号链接或重解析点：{}", target.display()));
        }
    }
    let canonical = if target.exists() {
        normalize_win_path(
            std::fs::canonicalize(&target)
                .map_err(|e| format!("技能路径解析失败（{}）: {e}", target.display()))?,
        )
    } else {
        let mut anc = target.clone();
        let mut missing: Vec<PathBuf> = Vec::new();
        loop {
            if anc.exists() {
                break;
            }
            let name = anc
                .file_name()
                .map(PathBuf::from)
                .ok_or_else(|| format!("技能路径越界（{}）", target.display()))?;
            missing.push(name);
            anc = anc
                .parent()
                .ok_or_else(|| format!("技能路径越界（{}）", target.display()))?
                .to_path_buf();
        }
        let base = normalize_win_path(
            std::fs::canonicalize(&anc)
                .map_err(|e| format!("技能路径解析失败（{}）: {e}", anc.display()))?,
        );
        missing.iter().rev().fold(base, |acc, n| acc.join(n))
    };
    if !path_starts_with(&trusted, &canonical) {
        return Err(format!("技能路径越界：{} 不在技能根内", target.display()));
    }
    Ok((trusted, canonical))
}

// ---------------------------------------------------------------- frontmatter 解析

/// frontmatter 拆分结果：fm 不含首尾 `---` 分隔线（含末尾换行），closing 为结束分隔线整行。
struct FmSplit<'a> {
    /// 换行风格（\r\n 或 \n）
    nl: &'a str,
    /// 文档开头（BOM + `---` 分隔线行，含换行）
    prefix: &'a str,
    /// frontmatter 文本（不含分隔线，含末尾换行）
    fm: &'a str,
    /// 结束分隔线行（含换行；文档以 `---` 结尾无换行时无）
    closing: &'a str,
    /// 正文
    body: &'a str,
}

/// 拆分 SKILL.md：文档必须以 `---` 行开头并有闭合 `---` 行；兼容 LF/CRLF。
fn split_frontmatter(content: &str) -> Result<FmSplit<'_>, String> {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let nl = if content.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let Some(open_end) = content.find(nl) else {
        return Err("Skill 文档缺少 frontmatter（必须以 --- 行开头）".to_string());
    };
    if content[..open_end].trim() != "---" {
        return Err("Skill 文档缺少 frontmatter（必须以 --- 行开头）".to_string());
    }
    let prefix = &content[..open_end + nl.len()];
    let after_open = &content[open_end + nl.len()..];
    let mut close_rel: Option<usize> = None;
    let mut offset = 0usize;
    for line in after_open.split_inclusive(nl) {
        if line.trim_end_matches(['\r', '\n']).trim() == "---" {
            close_rel = Some(offset);
            break;
        }
        offset += line.len();
    }
    let close_rel =
        close_rel.ok_or_else(|| "Skill frontmatter 未闭合（缺少结尾 --- 行）".to_string())?;
    let fm = &after_open[..close_rel];
    let closing = &after_open[close_rel..];
    let body = &after_open[close_rel + closing.len()..];
    Ok(FmSplit {
        nl,
        prefix,
        fm,
        closing,
        body,
    })
}

fn parse_fm_value(fm: &str) -> Result<serde_yaml_ng::Value, String> {
    serde_yaml_ng::from_str(fm).map_err(|e| format!("Skill frontmatter YAML 解析失败: {e}"))
}

/// scope 取值校验：local | all | remote:<非空主机名称>（主机名称按用户可见的 Server.name 解释）。
fn validate_scope_item(skill: &str, item: &str) -> Result<(), String> {
    if item == "local" || item == "all" {
        return Ok(());
    }
    if let Some(host) = item.strip_prefix("remote:") {
        if !host.trim().is_empty() {
            return Ok(());
        }
    }
    Err(format!(
        "Skill「{skill}」的 scope 取值非法：{item}（只能是 local、all 或 remote:<主机名称>）"
    ))
}

fn validate_scope_list(skill: &str, scope: &[String]) -> Result<(), String> {
    for item in scope {
        validate_scope_item(skill, item)?;
    }
    Ok(())
}

struct ParsedCommon {
    name: String,
    description: String,
    enabled: bool,
}

/// 基础校验（name/description/enabled + serde_yaml_ng 重复键拒绝）。scope 内容不在此校验
/// （skill_save 场景 scope 会被整体替换，旧值无需逐项合法）。
fn validate_fm_common(v: &serde_yaml_ng::Value) -> Result<ParsedCommon, String> {
    let map = v
        .as_mapping()
        .ok_or_else(|| "Skill frontmatter 必须是 YAML 映射".to_string())?;
    let get_str = |k: &str| -> Result<Option<String>, String> {
        match map.get(serde_yaml_ng::Value::String(k.to_string())) {
            None => Ok(None),
            Some(val) => match val.as_str() {
                Some(s) => Ok(Some(s.to_string())),
                None => Err(format!("Skill frontmatter 字段 {k} 必须是字符串")),
            },
        }
    };
    let name = get_str("name")?.ok_or_else(|| "Skill frontmatter 缺少 name 字段".to_string())?;
    validate_skill_name(&name)?;
    let description =
        get_str("description")?.ok_or_else(|| format!("Skill「{name}」缺少 description 字段"))?;
    if description.trim().is_empty() {
        return Err(format!("Skill「{name}」的 description 不能为空"));
    }
    if description.len() > 1024 {
        return Err(format!(
            "Skill「{name}」的 description 过长（最多 1024 字符）"
        ));
    }
    let enabled = match map.get(serde_yaml_ng::Value::String("enabled".to_string())) {
        None => true,
        Some(v) => v
            .as_bool()
            .ok_or_else(|| format!("Skill「{name}」的 enabled 必须是布尔值（true/false）"))?,
    };
    Ok(ParsedCommon {
        name,
        description,
        enabled,
    })
}

/// 完整校验（读取场景）：基础校验 + scope 逐项校验并规范化（缺失/空 → ["all"]，去重保序）。
fn validate_fm(v: &serde_yaml_ng::Value) -> Result<(ParsedCommon, Vec<String>), String> {
    let common = validate_fm_common(v)?;
    let scope = match v.get(serde_yaml_ng::Value::String("scope".to_string())) {
        None => vec!["all".to_string()],
        Some(val) => {
            let seq = val
                .as_sequence()
                .ok_or_else(|| format!("Skill「{}」的 scope 必须是字符串数组", common.name))?;
            let mut seen: HashSet<String> = HashSet::new();
            let mut out: Vec<String> = Vec::new();
            for item in seq {
                let s = item
                    .as_str()
                    .ok_or_else(|| format!("Skill「{}」的 scope 元素必须是字符串", common.name))?;
                validate_scope_item(&common.name, s)?;
                if seen.insert(s.to_string()) {
                    out.push(s.to_string());
                }
            }
            if out.is_empty() {
                vec!["all".to_string()]
            } else {
                out
            }
        }
    };
    Ok((common, scope))
}

// ---------------------------------------------------------------- 文本级字段改写

/// 行是否为顶层键（列 0 起 `key:` 后跟空白、`#` 或行尾）。
fn is_top_level_key(line: &str, key: &str) -> bool {
    let Some(rest) = line.strip_prefix(key) else {
        return false;
    };
    rest.starts_with(':')
        && rest[1..]
            .chars()
            .next()
            .map(|c| c.is_whitespace() || c == '#')
            .unwrap_or(true)
}

/// 序列化 scope 为缩进块（每项单独序列化，保证含空格/特殊字符的主机名被正确引号包裹）。
fn scope_block(scope: &[String], nl: &str) -> Result<String, String> {
    let mut block = String::from("scope:");
    for item in scope {
        let item_yaml =
            serde_yaml_ng::to_string(item).map_err(|e| format!("scope 序列化失败: {e}"))?;
        for line in item_yaml.trim_end().lines() {
            block.push_str(nl);
            block.push_str("  - ");
            block.push_str(line);
        }
    }
    block.push_str(nl);
    Ok(block)
}

/// 文本级替换/插入 frontmatter 顶层 `scope` 序列；缺失时插到结束分隔线之前。其余字节不变。
fn set_scope_text(fm: &str, scope: &[String], nl: &str) -> Result<String, String> {
    let effective: Vec<String> = if scope.is_empty() {
        vec!["all".to_string()]
    } else {
        scope.to_vec()
    };
    let block = scope_block(&effective, nl)?;
    let mut out = String::new();
    let mut replaced = false;
    for line in fm.split_inclusive('\n') {
        let bare = line.trim_end_matches(['\r', '\n']);
        if !replaced && is_top_level_key(bare, "scope") {
            out.push_str(&block);
            replaced = true;
        } else if replaced && (line.starts_with(' ') || line.starts_with('\t')) {
            // 属于被替换 scope 块的缩进行：丢弃（scope 的序列/映射续行）
            continue;
        } else {
            out.push_str(line);
        }
    }
    if !replaced {
        out.push_str(&block);
    }
    Ok(out)
}

/// 文本级替换/插入 frontmatter 顶层 `enabled` 布尔标量；现有值非布尔标量报错。其余字节不变。
fn set_enabled_text(fm: &str, enabled: bool, nl: &str) -> Result<String, String> {
    let mut out = String::new();
    let mut replaced = false;
    for line in fm.split_inclusive('\n') {
        let had_cr = line.ends_with("\r\n") || line.ends_with('\r');
        let bare = line.trim_end_matches(['\r', '\n']);
        if !replaced && is_top_level_key(bare, "enabled") {
            let after = &bare["enabled".len() + 1..];
            let value_part = after.trim_start();
            let token_end = value_part
                .find(|c: char| c.is_whitespace())
                .unwrap_or(value_part.len());
            let token = &value_part[..token_end];
            if token.is_empty() || token.starts_with('#') {
                return Err("Skill frontmatter 的 enabled 缺少布尔值".to_string());
            }
            serde_yaml_ng::from_str::<bool>(token).map_err(|_| {
                format!("Skill frontmatter 的 enabled 必须是布尔值（true/false），当前值：{token}")
            })?;
            // 保留冒号后的空白与行尾注释；行尾 \r 补回保持该行换行风格
            out.push_str("enabled:");
            out.push_str(&after[..after.len() - value_part.len()]);
            out.push_str(if enabled { "true" } else { "false" });
            out.push_str(&value_part[token_end..]);
            if had_cr {
                out.push_str("\r\n");
            } else {
                out.push('\n');
            }
            replaced = true;
        } else {
            out.push_str(line);
        }
    }
    if !replaced {
        // 缺失：插到结束分隔线之前（fm 末尾补行，用文件换行风格）
        let suffix = if fm.is_empty() || fm.ends_with('\n') || fm.ends_with('\r') {
            String::new()
        } else {
            nl.to_string()
        };
        out.push_str(&suffix);
        out.push_str(if enabled {
            "enabled: true"
        } else {
            "enabled: false"
        });
        out.push_str(nl);
    }
    Ok(out)
}

// ---------------------------------------------------------------- 读取

fn skill_id(origin: SkillOrigin, project_id: &str, name: &str) -> String {
    match origin {
        SkillOrigin::Global => format!("global:{name}"),
        SkillOrigin::Project => format!("project:{project_id}:{name}"),
    }
}

/// 解析单份 SKILL.md 为 SkillSummary（目录名必须与 frontmatter name 一致；失败带具体路径）。
fn parse_skill_doc(
    dir: &Path,
    file: &Path,
    content: &str,
    origin: SkillOrigin,
    project_id: &str,
) -> Result<SkillSummary, String> {
    let split = split_frontmatter(content).map_err(|e| format!("{e}（{}）", file.display()))?;
    let v = parse_fm_value(split.fm).map_err(|e| format!("{e}（{}）", file.display()))?;
    let (common, scope) = validate_fm(&v).map_err(|e| format!("{e}（{}）", file.display()))?;
    let dir_name = dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    if dir_name != common.name {
        return Err(format!(
            "技能目录名与 frontmatter name 不一致（目录「{dir_name}」≠「{}」，路径：{}）",
            common.name,
            dir.display()
        ));
    }
    Ok(SkillSummary {
        id: skill_id(origin, project_id, &common.name),
        name: common.name,
        description: common.description,
        scope,
        enabled: common.enabled,
        origin,
        path: file.to_string_lossy().into_owned(),
    })
}

/// 扫描单个技能根：无 SKILL.md 的普通文件夹忽略；有 SKILL.md 但 frontmatter 非法或目录名不一致、
/// 目录/SKILL.md 是符号链接 → 整次请求返回带路径的中文错误（防止 UI 把损坏技能误显示为已删除）。
fn scan_root(
    root: &Path,
    origin: SkillOrigin,
    project_id: &str,
) -> Result<Vec<SkillSummary>, String> {
    if !root.exists() {
        return Ok(Vec::new());
    }
    let trusted = trusted_root(root)?;
    let rd = std::fs::read_dir(&trusted)
        .map_err(|e| format!("技能根读取失败（{}）: {e}", trusted.display()))?;
    let mut out = Vec::new();
    for entry in rd {
        let entry = entry.map_err(|e| format!("技能根读取失败（{}）: {e}", trusted.display()))?;
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let meta = std::fs::symlink_metadata(&dir)
            .map_err(|e| format!("技能目录读取失败（{}）: {e}", dir.display()))?;
        if meta.file_type().is_symlink() {
            return Err(format!("技能目录不能是符号链接：{}", dir.display()));
        }
        let file = dir.join(SKILL_FILE);
        if !file.is_file() {
            continue;
        }
        let smeta = std::fs::symlink_metadata(&file)
            .map_err(|e| format!("SKILL.md 读取失败（{}）: {e}", file.display()))?;
        if smeta.file_type().is_symlink() {
            return Err(format!("SKILL.md 不能是符号链接：{}", file.display()));
        }
        let content = std::fs::read_to_string(&file)
            .map_err(|e| format!("SKILL.md 读取失败（{}）: {e}", file.display()))?;
        out.push(parse_skill_doc(&dir, &file, &content, origin, project_id)?);
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}
const MAX_SKILLHUB_ARCHIVE_BYTES: usize = 50 * 1024 * 1024;
const MAX_SKILLHUB_EXTRACTED_BYTES: u64 = 100 * 1024 * 1024;

/// 上传临时包固定落在技能所属工作区的 `.aishell/tmp/skillhub-upload`，与 Skill 根同源推导。
fn upload_package_dir(
    store: &Store,
    project_id: &str,
    origin: SkillOrigin,
) -> Result<PathBuf, String> {
    let root = skills_root(store, project_id, origin)?;
    let base = root
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| format!("技能根路径无效：{}", root.display()))?;
    Ok(base.join(".aishell").join("tmp").join("skillhub-upload"))
}

#[cfg(windows)]
fn is_link_or_reparse(meta: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    meta.file_type().is_symlink() || meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_link_or_reparse(meta: &std::fs::Metadata) -> bool {
    meta.file_type().is_symlink()
}

/// 归档条目。目录名始终使用 `/` 结尾，保证跨平台 ZIP 表示一致。
enum UploadEntry {
    Dir(String),
    File { name: String, path: PathBuf },
}

impl UploadEntry {
    fn name(&self) -> &str {
        match self {
            Self::Dir(name) | Self::File { name, .. } => name,
        }
    }
}

/// 遍历已规范化的技能目录，只接受非隐藏的普通目录/文件；遇到链接、reparse point 或越界立即失败。
fn collect_upload_entries(
    skill_root: &Path,
    current: &Path,
    entries: &mut Vec<UploadEntry>,
) -> Result<(), String> {
    for item in std::fs::read_dir(current)
        .map_err(|e| format!("读取技能目录失败（{}）：{e}", current.display()))?
    {
        let item = item.map_err(|e| format!("读取技能目录失败（{}）：{e}", current.display()))?;
        let name = item.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let path = item.path();
        let meta = std::fs::symlink_metadata(&path)
            .map_err(|e| format!("读取技能条目失败（{}）：{e}", path.display()))?;
        if is_link_or_reparse(&meta) {
            return Err(format!("技能上传包不允许符号链接或重解析点：{}", path.display()));
        }
        let canonical = normalize_win_path(
            std::fs::canonicalize(&path)
                .map_err(|e| format!("解析技能条目失败（{}）：{e}", path.display()))?,
        );
        if !path_starts_with(skill_root, &canonical) {
            return Err(format!("技能上传包条目越界：{}", path.display()));
        }
        let rel = canonical
            .strip_prefix(skill_root)
            .map_err(|_| format!("技能上传包条目越界：{}", path.display()))?;
        if rel.as_os_str().is_empty()
            || rel.components().any(|part| {
                matches!(
                    part,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                ) || part.as_os_str().to_string_lossy().starts_with('.')
            })
        {
            return Err(format!("技能上传包条目路径不安全：{}", path.display()));
        }
        let zip_name = rel.to_string_lossy().replace('\\', "/");
        if meta.is_dir() {
            entries.push(UploadEntry::Dir(format!("{zip_name}/")));
            collect_upload_entries(skill_root, &canonical, entries)?;
        } else if meta.is_file() {
            entries.push(UploadEntry::File {
                name: zip_name,
                path: canonical,
            });
        } else {
            return Err(format!("技能上传包不允许非普通文件：{}", path.display()));
        }
    }
    Ok(())
}

/// 将本地 Skill 打成 SkillHub 接受的根级 ZIP；失败时只清理本次临时包，绝不修改源 Skill。
pub fn pack_skill_for_upload(
    store: &Store,
    project_id: &str,
    origin: SkillOrigin,
    name: &str,
) -> Result<String, String> {
    let root = skills_root(store, project_id, origin)?;
    let skill_dir = validated_skill_dir(&root, origin, project_id, name)?;
    let package_dir = upload_package_dir(store, project_id, origin)?;
    std::fs::create_dir_all(&package_dir)
        .map_err(|e| format!("创建 SkillHub 上传目录失败（{}）：{e}", package_dir.display()))?;
    let package_dir = normalize_win_path(
        std::fs::canonicalize(&package_dir)
            .map_err(|e| format!("解析 SkillHub 上传目录失败（{}）：{e}", package_dir.display()))?,
    );
    let package = package_dir.join(format!(
        "{name}-{}.zip",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| format!("生成上传包文件名失败：{e}"))?
            .as_nanos()
    ));
    let result = (|| {
        let skill_dir = normalize_win_path(
            std::fs::canonicalize(&skill_dir)
                .map_err(|e| format!("解析技能目录失败（{}）：{e}", skill_dir.display()))?,
        );
        let dir_meta = std::fs::symlink_metadata(&skill_dir)
            .map_err(|e| format!("读取技能目录失败（{}）：{e}", skill_dir.display()))?;
        if !dir_meta.is_dir() || is_link_or_reparse(&dir_meta) {
            return Err(format!("技能目录不能是符号链接或重解析点：{}", skill_dir.display()));
        }

        let skill_file = skill_dir.join(SKILL_FILE);
        let file_meta = std::fs::symlink_metadata(&skill_file)
            .map_err(|e| format!("读取 SKILL.md 失败（{}）：{e}", skill_file.display()))?;
        if !file_meta.is_file() || is_link_or_reparse(&file_meta) {
            return Err(format!("SKILL.md 不能是符号链接或重解析点：{}", skill_file.display()));
        }

        let mut entries = Vec::new();
        collect_upload_entries(&skill_dir, &skill_dir, &mut entries)?;
        entries.sort_by(|a, b| a.name().cmp(b.name()));

        let file = File::create(&package)
            .map_err(|e| format!("创建 SkillHub 上传包失败（{}）：{e}", package.display()))?;
        let mut zip = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        for entry in entries {
            match entry {
                UploadEntry::Dir(name) => zip
                    .add_directory(name, options)
                    .map_err(|e| format!("写入 SkillHub 上传目录失败（{}）：{e}", package.display()))?,
                UploadEntry::File { name, path } => {
                    zip.start_file(name, options).map_err(|e| {
                        format!("写入 SkillHub 上传文件失败（{}）：{e}", path.display())
                    })?;
                    let mut input = File::open(&path)
                        .map_err(|e| format!("读取技能附件失败（{}）：{e}", path.display()))?;
                    io::copy(&mut input, &mut zip)
                        .map_err(|e| format!("压缩技能附件失败（{}）：{e}", path.display()))?;
                }
            }
        }
        let file = zip
            .finish()
            .map_err(|e| format!("完成 SkillHub 上传包失败（{}）：{e}", package.display()))?;
        let size = file
            .metadata()
            .map_err(|e| format!("读取 SkillHub 上传包失败（{}）：{e}", package.display()))?
            .len();
        if size > MAX_SKILLHUB_ARCHIVE_BYTES as u64 {
            return Err("SkillHub 上传包过大（上限 50 MiB）".to_string());
        }
        Ok(normalize_win_path(
            std::fs::canonicalize(&package)
                .map_err(|e| format!("解析 SkillHub 上传包失败（{}）：{e}", package.display()))?,
        )
        .to_string_lossy()
        .into_owned())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&package);
    }
    result
}

/// 限制浏览器自动化只能使用本次技能根对应上传目录中的真实 ZIP。
pub fn validate_upload_package_path(
    store: &Store,
    project_id: &str,
    origin: SkillOrigin,
    path: &Path,
) -> Result<PathBuf, String> {
    let allowed = upload_package_dir(store, project_id, origin)?;
    let allowed = normalize_win_path(
        std::fs::canonicalize(&allowed)
            .map_err(|e| format!("SkillHub 上传目录不可用（{}）：{e}", allowed.display()))?,
    );
    let meta = std::fs::symlink_metadata(path)
        .map_err(|e| format!("读取 SkillHub 上传包失败（{}）：{e}", path.display()))?;
    if !meta.is_file() || is_link_or_reparse(&meta) {
        return Err(format!("SkillHub 上传包必须是普通 ZIP 文件：{}", path.display()));
    }
    if !path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("zip")) {
        return Err(format!("SkillHub 上传包不是 ZIP 文件：{}", path.display()));
    }
    let canonical = normalize_win_path(
        std::fs::canonicalize(path)
            .map_err(|e| format!("解析 SkillHub 上传包失败（{}）：{e}", path.display()))?,
    );
    if !path_starts_with(&allowed, &canonical) {
        return Err(format!("SkillHub 上传包路径越界：{}", path.display()));
    }
    Ok(canonical)
}

/// 仅删除通过同一受限路径校验的成功发布临时包。
pub fn remove_upload_package(
    store: &Store,
    project_id: &str,
    origin: SkillOrigin,
    path: &Path,
) -> Result<(), String> {
    let path = validate_upload_package_path(store, project_id, origin, path)?;
    std::fs::remove_file(&path)
        .map_err(|e| format!("清理 SkillHub 上传包失败（{}）：{e}", path.display()))
}

/// 安全解压 SkillHub ZIP，并复用既有 Skill 写入校验，避免路径穿越或覆盖已有用户技能。
pub fn install_skillhub_zip(
    store: &Store,
    project_id: &str,
    origin: SkillOrigin,
    slug: &str,
    zip_bytes: &[u8],
) -> Result<SkillSummary, String> {
    if zip_bytes.len() > MAX_SKILLHUB_ARCHIVE_BYTES {
        return Err("SkillHub 安装包过大（上限 50 MiB）".to_string());
    }
    validate_skill_name(slug)?;

    let root = skills_root(store, project_id, origin)?;
    std::fs::create_dir_all(&root)
        .map_err(|e| format!("创建 Skill 目录失败（{}）：{e}", root.display()))?;
    let target = root.join(slug);
    if target.exists() {
        return Err(format!("Skill 已存在，未覆盖原文件：{}", target.display()));
    }

    let staging = root.join(format!(
        ".skillhub-{}-{}",
        slug,
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| format!("生成临时目录名失败：{e}"))?
            .as_nanos()
    ));
    std::fs::create_dir(&staging)
        .map_err(|e| format!("创建 Skill 临时目录失败（{}）：{e}", staging.display()))?;

    let result = (|| {
        let mut archive = ZipArchive::new(Cursor::new(zip_bytes))
            .map_err(|e| format!("读取 SkillHub ZIP 失败：{e}"))?;
        let mut extracted = 0_u64;
        for index in 0..archive.len() {
            let mut entry = archive
                .by_index(index)
                .map_err(|e| format!("读取 SkillHub ZIP 条目失败：{e}"))?;
            let raw_name = entry.name().replace('\\', "/");
            let rel = Path::new(&raw_name);
            if raw_name.is_empty()
                || rel.is_absolute()
                || rel.components().any(|c| {
                    matches!(
                        c,
                        std::path::Component::ParentDir
                            | std::path::Component::RootDir
                            | std::path::Component::Prefix(_)
                    )
                })
            {
                return Err(format!("SkillHub ZIP 含不安全路径：{raw_name}"));
            }
            let mut components = rel.components();
            let first = components
                .next()
                .ok_or_else(|| "SkillHub ZIP 含空路径".to_string())?;
            let first = first.as_os_str().to_string_lossy();
            let relative = if first == slug {
                components.as_path().to_path_buf()
            } else {
                rel.to_path_buf()
            };
            if relative.as_os_str().is_empty() {
                continue;
            }
            let output = staging.join(&relative);
            if entry.is_dir() {
                std::fs::create_dir_all(&output)
                    .map_err(|e| format!("解压 SkillHub 目录失败（{}）：{e}", output.display()))?;
                continue;
            }
            let declared_size = entry.size();
            if declared_size > MAX_SKILLHUB_EXTRACTED_BYTES.saturating_sub(extracted) {
                return Err("SkillHub 解压内容过大（上限 100 MiB）".to_string());
            }
            if let Some(parent) = output.parent() {
                std::fs::create_dir_all(parent).map_err(|e| {
                    format!("创建 SkillHub 解压目录失败（{}）：{e}", parent.display())
                })?;
            }
            let mut file = File::create(&output)
                .map_err(|e| format!("创建 SkillHub 文件失败（{}）：{e}", output.display()))?;
            let remaining = MAX_SKILLHUB_EXTRACTED_BYTES - extracted;
            let mut limited = (&mut entry).take(remaining.saturating_add(1));
            let written = io::copy(&mut limited, &mut file)
                .map_err(|e| format!("写入 SkillHub 文件失败（{}）：{e}", output.display()))?;
            if written > remaining {
                return Err("SkillHub 解压内容过大（上限 100 MiB）".to_string());
            }
            extracted += written;
        }

        let skill_dir = if staging.join(SKILL_FILE).is_file() {
            staging.clone()
        } else {
            let mut dirs = std::fs::read_dir(&staging)
                .map_err(|e| format!("读取 SkillHub 解压目录失败：{e}"))?
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| path.is_dir());
            let only = dirs
                .next()
                .ok_or_else(|| "SkillHub ZIP 内缺少 SKILL.md".to_string())?;
            if dirs.next().is_some() || !only.join(SKILL_FILE).is_file() {
                return Err("SkillHub ZIP 根目录必须直接包含 SKILL.md".to_string());
            }
            only
        };
        let content = std::fs::read_to_string(skill_dir.join(SKILL_FILE))
            .map_err(|e| format!("读取 SkillHub SKILL.md 失败：{e}"))?;
        let split =
            split_frontmatter(&content).map_err(|e| format!("SkillHub SKILL.md 解析失败：{e}"))?;
        let value =
            parse_fm_value(split.fm).map_err(|e| format!("SkillHub SKILL.md 解析失败：{e}"))?;
        let (common, _) =
            validate_fm(&value).map_err(|e| format!("SkillHub SKILL.md 校验失败：{e}"))?;
        if common.name != slug {
            return Err(format!(
                "SkillHub 包内名称与下载项不一致：{} != {slug}",
                common.name
            ));
        }
        if skill_dir != staging {
            let entries = std::fs::read_dir(&skill_dir)
                .map_err(|e| format!("整理 SkillHub 文件失败：{e}"))?
                .map(|entry| entry.map(|entry| entry.path()))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("整理 SkillHub 文件失败：{e}"))?;
            for entry in entries {
                let name = entry
                    .file_name()
                    .ok_or_else(|| "SkillHub ZIP 条目名称为空".to_string())?;
                let destination = staging.join(name);
                if destination.exists() {
                    return Err(format!(
                        "SkillHub ZIP 根目录存在重复条目：{}",
                        destination.display()
                    ));
                }
                std::fs::rename(&entry, &destination).map_err(|e| {
                    format!("整理 SkillHub 文件失败（{}）：{e}", destination.display())
                })?;
            }
            std::fs::remove_dir(&skill_dir).map_err(|e| {
                format!("清理 SkillHub 临时目录失败（{}）：{e}", skill_dir.display())
            })?;
        }
        std::fs::rename(&staging, &target)
            .map_err(|e| format!("安装 SkillHub Skill 失败（{}）：{e}", target.display()))?;
        let file = target.join(SKILL_FILE);
        let content = std::fs::read_to_string(&file)
            .map_err(|e| format!("读取已安装 Skill 失败（{}）：{e}", file.display()))?;
        parse_skill_doc(&target, &file, &content, origin, project_id)
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    result
}

fn validated_skill_dir(
    root: &Path,
    origin: SkillOrigin,
    project_id: &str,
    name: &str,
) -> Result<PathBuf, String> {
    let (_trusted, canonical) = resolve_in_root(root, name)?;
    let file = canonical.join(SKILL_FILE);
    if !file.exists() {
        return Err(format!("技能不存在：{name}（{}）", canonical.display()));
    }
    let file_meta = std::fs::symlink_metadata(&file)
        .map_err(|e| format!("SKILL.md 读取失败（{}）: {e}", file.display()))?;
    if !file_meta.is_file() {
        return Err(format!("技能不存在：{name}（{}）", canonical.display()));
    }
    if is_link_or_reparse(&file_meta) {
        return Err(format!("SKILL.md 不能是符号链接或重解析点：{}", file.display()));
    }
    let content = std::fs::read_to_string(&file)
        .map_err(|e| format!("SKILL.md 读取失败（{}）: {e}", file.display()))?;
    let _ = parse_skill_doc(&canonical, &file, &content, origin, project_id)?;
    Ok(canonical)
}

// ---------------------------------------------------------------- 原子写入

/// 原子写入 SKILL.md：写 .tmp → 原文件改 .bak → .tmp 改名正式 → 删 .bak；
/// 任一步失败回滚 .bak，绝不破坏原文件。目标不存在时直接 .tmp → 正式。
fn write_skill_file(path: &Path, content: &str) -> Result<(), String> {
    let tmp = path.with_file_name(format!("{SKILL_FILE}.tmp"));
    std::fs::write(&tmp, content)
        .map_err(|e| format!("写入临时文件失败（{}）: {e}", tmp.display()))?;
    if path.exists() {
        let bak = path.with_file_name(format!("{SKILL_FILE}.bak"));
        std::fs::rename(path, &bak).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("备份原文件失败（{}）: {e}", path.display())
        })?;
        if let Err(e) = std::fs::rename(&tmp, path) {
            let _ = std::fs::rename(&bak, path);
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("替换 SKILL.md 失败（{}）: {e}", path.display()));
        }
        let _ = std::fs::remove_file(&bak);
    } else {
        std::fs::rename(&tmp, path).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("写入 SKILL.md 失败（{}）: {e}", path.display())
        })?;
    }
    Ok(())
}

// ---------------------------------------------------------------- 业务操作（供命令与 ai.rs 复用）

/// 分别扫描全局、项目技能根（根不存在返回空，不创建目录）。
pub fn list_skills(store: &Store, project_id: &str) -> Result<Vec<SkillSummary>, String> {
    let mut out = Vec::new();
    out.extend(scan_root(
        &global_skills_root(store)?,
        SkillOrigin::Global,
        project_id,
    )?);
    out.extend(scan_root(
        &project_skills_root(store, project_id)?,
        SkillOrigin::Project,
        project_id,
    )?);
    Ok(out)
}

/// 读取单个技能完整文档（SKILL.md 原文）。
pub fn read_skill(
    store: &Store,
    project_id: &str,
    origin: SkillOrigin,
    name: &str,
) -> Result<SkillDocument, String> {
    let root = skills_root(store, project_id, origin)?;
    let dir = validated_skill_dir(&root, origin, project_id, name)?;
    let file = dir.join(SKILL_FILE);
    let content = std::fs::read_to_string(&file)
        .map_err(|e| format!("SKILL.md 读取失败（{}）: {e}", file.display()))?;
    let summary = parse_skill_doc(&dir, &file, &content, origin, project_id)?;
    Ok(SkillDocument { summary, content })
}

/// 保存技能：scope 为管理 UI 的显式值，后端校验后仅文本级替换/插入 frontmatter 顶层 scope 序列，
/// 其余字节不变。新增（original_name=None）目标必须不存在；编辑改名（frontmatter name 变化）时
/// 先整体 rename 旧目录为新目录（保留 scripts/、references/、assets/ 等附属资源）再原子替换
/// SKILL.md，写失败把目录 rename 回旧名并保留旧文档。
pub fn save_skill(
    store: &Store,
    project_id: &str,
    origin: SkillOrigin,
    original_name: Option<&str>,
    content: &str,
    scope: &[String],
) -> Result<SkillSummary, String> {
    let root = skills_root(store, project_id, origin)?;
    // 新内容 frontmatter 基础校验（name/description/重复键/enabled；scope 由显式参数权威决定）
    let split = split_frontmatter(content)?;
    let v = parse_fm_value(split.fm)?;
    let common = validate_fm_common(&v)?;
    let new_name = common.name.clone();
    validate_scope_list(&new_name, scope)?;
    let effective_scope: Vec<String> = if scope.is_empty() {
        vec!["all".to_string()]
    } else {
        scope.to_vec()
    };
    let final_content = set_scope_text(split.fm, &effective_scope, split.nl)?;
    let final_content = format!(
        "{}{final_content}{}{}",
        split.prefix, split.closing, split.body
    );
    let trusted = trusted_root(&root)?;

    match original_name {
        None => {
            // 新增：目标必须不存在
            if trusted.join(&new_name).exists() {
                return Err(format!("技能已存在：{new_name}"));
            }
            // 根不存在时先创建再取 canonical 受信根（待创建目标 canonicalize 最近已存在父目录并复核）
            if !root.exists() {
                std::fs::create_dir_all(&root)
                    .map_err(|e| format!("创建技能根失败（{}）: {e}", root.display()))?;
            }
            let trusted = trusted_root(&root)?;
            let dir = trusted.join(&new_name);
            if dir.exists() {
                return Err(format!("技能已存在：{new_name}"));
            }
            if !path_starts_with(&trusted, &dir) {
                return Err(format!("技能路径越界：{} 不在技能根内", dir.display()));
            }
            std::fs::create_dir_all(&dir)
                .map_err(|e| format!("创建技能目录失败（{}）: {e}", dir.display()))?;
            let file = dir.join(SKILL_FILE);
            write_skill_file(&file, &final_content)?;
            parse_skill_doc(&dir, &file, &final_content, origin, project_id)
        }
        Some(old) if old != new_name => {
            // 编辑改名：旧目录必须有效、新目录必须不存在；整体 rename 保留附属资源
            validate_skill_name(old)?;
            let old_dir = validated_skill_dir(&root, origin, project_id, old)?;
            let new_dir = trusted.join(&new_name);
            if new_dir.exists() {
                return Err(format!("技能已存在：{new_name}"));
            }
            std::fs::rename(&old_dir, &new_dir).map_err(|e| {
                format!(
                    "重命名技能目录失败（{} → {}）: {e}",
                    old_dir.display(),
                    new_dir.display()
                )
            })?;
            let file = new_dir.join(SKILL_FILE);
            if let Err(e) = write_skill_file(&file, &final_content) {
                // 写失败：目录 rename 回旧名，保留旧文档
                let _ = std::fs::rename(&new_dir, &old_dir);
                return Err(e);
            }
            parse_skill_doc(&new_dir, &file, &final_content, origin, project_id)
        }
        Some(old) => {
            // 未改名：目标必须已存在且有效
            let dir = validated_skill_dir(&root, origin, project_id, old)?;
            let file = dir.join(SKILL_FILE);
            write_skill_file(&file, &final_content)?;
            parse_skill_doc(&dir, &file, &final_content, origin, project_id)
        }
    }
}

/// 删除技能：不存在报错；递归删除前重复做根内校验。
pub fn delete_skill(
    store: &Store,
    project_id: &str,
    origin: SkillOrigin,
    name: &str,
) -> Result<(), String> {
    let root = skills_root(store, project_id, origin)?;
    let dir = validated_skill_dir(&root, origin, project_id, name)?;
    std::fs::remove_dir_all(&dir).map_err(|e| format!("删除技能目录失败（{}）: {e}", dir.display()))
}

/// 启停：只文本级修改或插入 frontmatter 顶层 `enabled` 布尔标量；现有值非布尔标量报错，
/// 正文、注释与其它 frontmatter 字节保持不变。
pub fn set_skill_enabled(
    store: &Store,
    project_id: &str,
    origin: SkillOrigin,
    name: &str,
    enabled: bool,
) -> Result<SkillSummary, String> {
    let root = skills_root(store, project_id, origin)?;
    let dir = validated_skill_dir(&root, origin, project_id, name)?;
    let file = dir.join(SKILL_FILE);
    let content = std::fs::read_to_string(&file)
        .map_err(|e| format!("SKILL.md 读取失败（{}）: {e}", file.display()))?;
    let split = split_frontmatter(&content)?;
    let v = parse_fm_value(split.fm)?;
    let _ = validate_fm_common(&v)?;
    let new_fm = set_enabled_text(split.fm, enabled, split.nl)?;
    let new_content = format!("{}{new_fm}{}{}", split.prefix, split.closing, split.body);
    write_skill_file(&file, &new_content)?;
    parse_skill_doc(&dir, &file, &new_content, origin, project_id)
}

// ---------------------------------------------------------------- 内置播种

/// 内置 skill-management 一次性播种：`<workspace>/.aishell/skills/skill-management/SKILL.md`。
/// 目标已存在则保留用户文件不覆盖；返回 Ok 表示文件已就绪（已存在或成功创建）。
pub fn seed_builtin_skill_files(workspace: &str) -> Result<(), String> {
    let file = PathBuf::from(workspace)
        .join(".aishell")
        .join("skills")
        .join(SKILL_MANAGEMENT_NAME)
        .join(SKILL_FILE);
    if file.is_file() {
        return Ok(());
    }
    let dir = file
        .parent()
        .ok_or_else(|| "内置技能路径非法".to_string())?;
    std::fs::create_dir_all(dir)
        .map_err(|e| format!("创建内置技能目录失败（{}）: {e}", dir.display()))?;
    std::fs::write(&file, BUILTIN_SKILL_MANAGEMENT)
        .map_err(|e| format!("写入内置技能失败（{}）: {e}", file.display()))
}

// ---------------------------------------------------------------- Tauri commands
// 命令名/参数名与 src/api.ts 的 skills 段逐一对应（Tauri snake_case→camelCase 自动映射）。

#[tauri::command]
pub fn skills_list(
    store: State<'_, Arc<Store>>,
    project_id: String,
) -> Result<Vec<SkillSummary>, String> {
    list_skills(&store, &project_id)
}

#[tauri::command]
pub fn skill_read(
    store: State<'_, Arc<Store>>,
    project_id: String,
    origin: SkillOrigin,
    name: String,
) -> Result<SkillDocument, String> {
    read_skill(&store, &project_id, origin, &name)
}

#[tauri::command]
pub fn skill_save(
    store: State<'_, Arc<Store>>,
    project_id: String,
    origin: SkillOrigin,
    original_name: Option<String>,
    content: String,
    scope: Vec<String>,
) -> Result<SkillSummary, String> {
    save_skill(
        &store,
        &project_id,
        origin,
        original_name.as_deref(),
        &content,
        &scope,
    )
}

#[tauri::command]
pub fn skill_delete(
    store: State<'_, Arc<Store>>,
    project_id: String,
    origin: SkillOrigin,
    name: String,
) -> Result<(), String> {
    delete_skill(&store, &project_id, origin, &name)
}

#[tauri::command]
pub fn skill_set_enabled(
    store: State<'_, Arc<Store>>,
    project_id: String,
    origin: SkillOrigin,
    name: String,
    enabled: bool,
) -> Result<SkillSummary, String> {
    set_skill_enabled(&store, &project_id, origin, &name, enabled)
}

/// 打包本地 Skill 供内置浏览器上传；仅返回受限临时 ZIP 的规范化绝对路径。
#[tauri::command]
pub fn skill_pack_upload(
    store: State<'_, Arc<Store>>,
    project_id: String,
    origin: SkillOrigin,
    name: String,
) -> Result<String, String> {
    pack_skill_for_upload(&store, &project_id, origin, &name)
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{test_store, Project, Settings};

    /// 独立临时基目录（pid + 序号，测试间不冲突；结束不清理由系统临时目录兜底）。
    fn tmp_base(tag: &str) -> PathBuf {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static SEQ: AtomicUsize = AtomicUsize::new(0);
        std::env::temp_dir().join(format!(
            "aishell-skills-{tag}-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::SeqCst)
        ))
    }

    /// 构造带 workspace 的 Store（save_settings 会播种内置技能，需要时测试自行清理）。
    fn store_with_workspace(tag: &str) -> (Store, PathBuf) {
        let base = tmp_base(tag);
        let config = base.join("config");
        let ws = base.join("workspace");
        std::fs::create_dir_all(&config).unwrap();
        let store = test_store(config);
        store
            .save_settings(
                Settings {
                    workspace_dir: Some(ws.to_string_lossy().into_owned()),
                    ..Default::default()
                },
                None,
                None,
            )
            .unwrap();
        (store, ws)
    }

    /// 一个合法的 SKILL.md 内容（extra 可塞未知字段/注释）。
    fn skill_md(name: &str, desc: &str, extra: &str) -> String {
        format!(
            "---\nname: {name}\ndescription: {desc}\n{extra}enabled: true\n---\n\n# {name}\n正文第一行。\n第二行：```bash\necho hi\n```\n"
        )
    }

    fn project(store: &Store, id: &str, name: &str, path: Option<&str>) {
        store
            .upsert_project(Project {
                id: id.to_string(),
                name: name.to_string(),
                path: path.map(str::to_string),
                server_ids: Vec::new(),
                quick_commands: Vec::new(),
                folder: String::new(),
                ai_mode: Default::default(),
            })
            .unwrap();
    }

    #[test]
    fn roots_derive_from_workspace_and_project() {
        let (store, ws) = store_with_workspace("roots");
        assert_eq!(
            global_skills_root(&store).unwrap(),
            ws.join(".aishell").join("skills")
        );
        project(&store, "p1", "my-proj", None);
        assert_eq!(
            project_skills_root(&store, "p1").unwrap(),
            ws.join("my-proj").join(".aishell").join("skills")
        );
        // 显式 path 优先
        let explicit = tmp_base("roots-explicit");
        std::fs::create_dir_all(&explicit).unwrap();
        project(&store, "p2", "ignored", Some(explicit.to_str().unwrap()));
        assert_eq!(
            project_skills_root(&store, "p2").unwrap(),
            explicit.join(".aishell").join("skills")
        );
        // 缺 workspace：全局根报中文可执行错误；项目 path 为空也回退失败
        let store_no_ws = test_store(tmp_base("roots-nows"));
        project(&store_no_ws, "p3", "x", Some("C:\\some\\path"));
        let err = global_skills_root(&store_no_ws).unwrap_err();
        assert!(
            err.contains("请先在设置中配置工作区目录"),
            "错误串不符: {err}"
        );
        project(&store_no_ws, "p4", "y", None);
        let err = project_skills_root(&store_no_ws, "p4").unwrap_err();
        assert!(
            err.contains("请先在设置中配置工作区目录"),
            "错误串不符: {err}"
        );
        let err = project_skills_root(&store_no_ws, "nope").unwrap_err();
        assert!(err.contains("项目不存在"), "错误串不符: {err}");
    }

    #[test]
    fn missing_root_returns_empty_without_creating() {
        let (store, _ws) = store_with_workspace("missing-root");
        // 全局根已被播种（存在 skill-management）：改用项目根验证「根不存在 → 空且不创建」
        project(&store, "p1", "my-proj", None);
        let root = project_skills_root(&store, "p1").unwrap();
        let list = list_skills(&store, "p1").unwrap();
        assert!(!root.exists(), "列表不应创建根");
        // 只有全局 skill-management
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "skill-management");
        assert_eq!(list[0].origin, SkillOrigin::Global);
        // 无 workspace 时全局根报错
        let store_no_ws = test_store(tmp_base("missing-root-nows"));
        let err = global_skills_root(&store_no_ws).unwrap_err();
        assert!(err.contains("请先在设置中配置工作区目录"));
    }

    #[test]
    fn roundtrip_preserves_unknown_fields_and_body() {
        let (store, ws) = store_with_workspace("roundtrip");
        project(&store, "p1", "my-proj", None);
        let content = skill_md("alpha", "阿尔法技能", "# 顶层注释\ncustom_field: 保留值\n");
        let saved = save_skill(
            &store,
            "p1",
            SkillOrigin::Project,
            None,
            &content,
            &["all".into(), "remote:测试机".into()],
        )
        .unwrap();
        assert_eq!(saved.name, "alpha");
        assert_eq!(saved.scope, vec!["all", "remote:测试机"]);
        assert!(saved.enabled);
        assert_eq!(saved.origin, SkillOrigin::Project);
        assert!(saved.id.starts_with("project:p1:"));

        let doc = read_skill(&store, "p1", SkillOrigin::Project, "alpha").unwrap();
        // 正文与未知字段/注释逐字节保持；只有 scope 被替换
        assert!(
            doc.content.contains("# 顶层注释\ncustom_field: 保留值\n"),
            "未知字段丢失: {}",
            doc.content
        );
        assert!(
            doc.content.contains("# alpha\n正文第一行。"),
            "正文变化: {}",
            doc.content
        );
        assert!(
            doc.content.contains("scope:\n  - all\n  - remote:测试机"),
            "scope 未按显式值重写: {}",
            doc.content
        );
        assert!(
            doc.content.contains("第二行：```bash\necho hi\n```"),
            "正文围栏丢失: {}",
            doc.content
        );
        // .tmp/.bak 无残留
        let dir = ws
            .join("my-proj")
            .join(".aishell")
            .join("skills")
            .join("alpha");
        let names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(
            !names
                .iter()
                .any(|n| n.ends_with(".tmp") || n.ends_with(".bak")),
            "临时文件残留: {names:?}"
        );
        assert_eq!(names, vec!["SKILL.md"]);
    }

    #[test]
    fn scope_missing_or_empty_defaults_to_all() {
        let (store, ws) = store_with_workspace("scope-default");
        project(&store, "p1", "my-proj", None);
        // 无 scope 字段
        let no_scope = "---\nname: plain\ndescription: 无 scope\nenabled: true\n---\n正文\n";
        save_skill(&store, "p1", SkillOrigin::Project, None, no_scope, &[]).unwrap();
        let doc = read_skill(&store, "p1", SkillOrigin::Project, "plain").unwrap();
        assert_eq!(doc.summary.scope, vec!["all"]);
        // save 显式空 scope 也写 ["all"]
        assert!(
            doc.content.contains("scope:\n  - all"),
            "空 scope 未写成 all: {}",
            doc.content
        );
        // 显式空数组 scope
        let empty_scope = "---\nname: es\ndescription: 空数组\nscope: []\nenabled: true\n---\n";
        save_skill(
            &store,
            "p1",
            SkillOrigin::Project,
            None,
            empty_scope,
            &["all".into()],
        )
        .unwrap();
        let doc = read_skill(&store, "p1", SkillOrigin::Project, "es").unwrap();
        assert_eq!(doc.summary.scope, vec!["all"]);
        // 去重保序
        let dup = "---\nname: dup\ndescription: 去重\nscope:\n  - local\n  - all\n  - local\nenabled: true\n---\n";
        std::fs::create_dir_all(
            ws.join("my-proj")
                .join(".aishell")
                .join("skills")
                .join("dup"),
        )
        .unwrap();
        std::fs::write(
            ws.join("my-proj")
                .join(".aishell")
                .join("skills")
                .join("dup")
                .join("SKILL.md"),
            dup,
        )
        .unwrap();
        let doc = read_skill(&store, "p1", SkillOrigin::Project, "dup").unwrap();
        assert_eq!(doc.summary.scope, vec!["local", "all"]);
    }

    #[test]
    fn invalid_frontmatter_rejected_with_path() {
        let (store, ws) = store_with_workspace("invalid");
        project(&store, "p1", "my-proj", None);
        let root = ws.join("my-proj").join(".aishell").join("skills");
        // 非法 name
        let bad_name = "---\nname: Bad_Name\n---\n";
        let err = save_skill(&store, "p1", SkillOrigin::Project, None, bad_name, &[]).unwrap_err();
        assert!(err.contains("小写字母"), "错误串不符: {err}");
        // 非法 scope
        let bad_scope = skill_md("s1", "d", "scope:\n  - nope\n");
        let err = save_skill(
            &store,
            "p1",
            SkillOrigin::Project,
            None,
            &bad_scope,
            &["weird".into()],
        )
        .unwrap_err();
        assert!(err.contains("scope 取值非法"), "错误串不符: {err}");
        // 空 description
        let no_desc = "---\nname: s2\ndescription: \"\"\n---\n";
        let err = save_skill(&store, "p1", SkillOrigin::Project, None, no_desc, &[]).unwrap_err();
        assert!(err.contains("description 不能为空"), "错误串不符: {err}");
        // 重复顶层键（serde_yaml_ng 拒绝）
        let dup_key = "---\nname: a\nname: b\ndescription: d\n---\n";
        let err = save_skill(&store, "p1", SkillOrigin::Project, None, dup_key, &[]).unwrap_err();
        assert!(err.contains("frontmatter"), "错误串不符: {err}");
        // 目录名与 name 不一致（损坏技能 → 列表整次报错且带路径）
        std::fs::create_dir_all(root.join("mismatch")).unwrap();
        std::fs::write(
            root.join("mismatch").join("SKILL.md"),
            skill_md("other", "d", ""),
        )
        .unwrap();
        let err = list_skills(&store, "p1").unwrap_err();
        assert!(err.contains("不一致"), "错误串不符: {err}");
        assert!(err.contains("mismatch"), "缺少路径: {err}");
        // 非法 YAML → 带路径错误
        std::fs::create_dir_all(root.join("broken")).unwrap();
        std::fs::write(root.join("broken").join("SKILL.md"), "name: [unclosed\n").unwrap();
        let err = list_skills(&store, "p1").unwrap_err();
        assert!(err.contains("frontmatter"), "错误串不符: {err}");
        assert!(err.contains("broken"), "缺少路径: {err}");
        // 无 SKILL.md 的普通文件夹忽略（先清掉损坏项再验证）
        std::fs::remove_dir_all(root.join("broken")).unwrap();
        std::fs::remove_dir_all(root.join("mismatch")).unwrap();
        std::fs::create_dir_all(root.join("plain-folder")).unwrap();
        let list = list_skills(&store, "p1").unwrap();
        assert!(
            list.iter().all(|s| s.name != "plain-folder"),
            "普通文件夹不应出现"
        );
    }

    #[test]
    fn name_and_traversal_rejected() {
        let (store, ws) = store_with_workspace("traversal");
        project(&store, "p1", "my-proj", None);
        let root = ws.join("my-proj").join(".aishell").join("skills");
        // 路径穿越：名称不能含 .. 或分隔符（validate_skill_name 层拒绝）
        for bad in ["..", "../evil", "a/b", "a\\b", "a..b"] {
            let err = save_skill(
                &store,
                "p1",
                SkillOrigin::Project,
                None,
                &skill_md(bad, "d", ""),
                &[],
            )
            .unwrap_err();
            assert!(err.contains("小写字母"), "名称 {bad} 未被拒: {err}");
        }
        // 解析层防御：resolve_in_root 对分隔符名称拒绝
        let err = resolve_in_root(&root, "a/b").unwrap_err();
        assert!(err.contains("小写字母"), "错误串不符: {err}");
    }

    #[test]
    fn symlink_skill_rejected() {
        let (store, ws) = store_with_workspace("symlink");
        project(&store, "p1", "my-proj", None);
        let root = ws.join("my-proj").join(".aishell").join("skills");
        std::fs::create_dir_all(&root).unwrap();
        // 技能目录是符号链接 → 拒绝（Windows 无权限建链接时跳过）
        let outside = tmp_base("symlink-outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("SKILL.md"), skill_md("linked", "d", "")).unwrap();
        let link = root.join("linked");
        let ok = mk_symlink_dir(&outside, &link);
        if !ok {
            eprintln!("跳过符号链接用例：当前环境无法创建目录符号链接");
            return;
        }
        let err = list_skills(&store, "p1").unwrap_err();
        assert!(err.contains("符号链接"), "错误串不符: {err}");
        assert!(err.contains("linked"), "缺少路径: {err}");
        // 根内 SKILL.md 是符号链接 → 拒绝
        std::fs::remove_dir(&link).unwrap();
        let real = root.join("real");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("SKILL.md"), skill_md("real", "d", "")).unwrap();
        let file_link = real.join("SKILL.md");
        let _ = std::fs::remove_file(&file_link);
        if !mk_symlink_file(&outside.join("SKILL.md"), &file_link) {
            eprintln!("跳过 SKILL.md 符号链接用例");
            return;
        }
        let err = list_skills(&store, "p1").unwrap_err();
        assert!(err.contains("符号链接"), "错误串不符: {err}");
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[cfg(windows)]
    fn mk_symlink_dir(target: &Path, link: &Path) -> bool {
        std::os::windows::fs::symlink_dir(target, link).is_ok()
    }
    #[cfg(not(windows))]
    fn mk_symlink_dir(target: &Path, link: &Path) -> bool {
        std::os::unix::fs::symlink(target, link).is_ok()
    }
    #[cfg(windows)]
    fn mk_symlink_file(target: &Path, link: &Path) -> bool {
        std::os::windows::fs::symlink_file(target, link).is_ok()
    }
    #[cfg(not(windows))]
    fn mk_symlink_file(target: &Path, link: &Path) -> bool {
        std::os::unix::fs::symlink(target, link).is_ok()
    }

    #[test]
    fn create_conflict_and_rename_conflict_rejected() {
        let (store, _ws) = store_with_workspace("conflict");
        project(&store, "p1", "my-proj", None);
        save_skill(
            &store,
            "p1",
            SkillOrigin::Project,
            None,
            &skill_md("alpha", "a", ""),
            &[],
        )
        .unwrap();
        // 新增重名
        let err = save_skill(
            &store,
            "p1",
            SkillOrigin::Project,
            None,
            &skill_md("alpha", "b", ""),
            &[],
        )
        .unwrap_err();
        assert!(err.contains("已存在"), "错误串不符: {err}");
        // 编辑改名冲突：目标已存在
        save_skill(
            &store,
            "p1",
            SkillOrigin::Project,
            None,
            &skill_md("beta", "b", ""),
            &[],
        )
        .unwrap();
        let err = save_skill(
            &store,
            "p1",
            SkillOrigin::Project,
            Some("alpha"),
            &skill_md("beta", "x", ""),
            &[],
        )
        .unwrap_err();
        assert!(err.contains("已存在"), "错误串不符: {err}");
        // 改名成功：附属资源随目录迁移
        let root = project_skills_root(&store, "p1").unwrap();
        std::fs::create_dir_all(root.join("alpha").join("scripts")).unwrap();
        std::fs::write(
            root.join("alpha").join("scripts").join("run.sh"),
            "#!/bin/sh\n",
        )
        .unwrap();
        let saved = save_skill(
            &store,
            "p1",
            SkillOrigin::Project,
            Some("alpha"),
            &skill_md("alpha-renamed", "新", ""),
            &[],
        )
        .unwrap();
        assert_eq!(saved.name, "alpha-renamed");
        assert!(!root.join("alpha").exists(), "旧目录未迁移");
        assert!(
            root.join("alpha-renamed")
                .join("scripts")
                .join("run.sh")
                .is_file(),
            "附属资源未保留"
        );
    }

    #[test]
    fn set_enabled_only_changes_enabled_scalar() {
        let (store, _ws) = store_with_workspace("enabled");
        project(&store, "p1", "my-proj", None);
        let content = "---\n# 技能注释\nname: t1\ndescription: 描述 # 行内注释\nscope:\n  - local\nenabled: true # 原注释\n---\n# 正文标题\n保留字节。\n";
        save_skill(
            &store,
            "p1",
            SkillOrigin::Project,
            None,
            content,
            &["all".into()],
        )
        .unwrap();
        let s = set_skill_enabled(&store, "p1", SkillOrigin::Project, "t1", false).unwrap();
        assert!(!s.enabled);
        let doc = read_skill(&store, "p1", SkillOrigin::Project, "t1").unwrap();
        assert!(
            doc.content.contains("enabled: false # 原注释"),
            "注释丢失: {}",
            doc.content
        );
        assert!(doc.content.contains("# 技能注释\nname: t1"), "注释行丢失");
        assert!(
            doc.content.contains("description: 描述 # 行内注释"),
            "行内注释丢失"
        );
        assert!(doc.content.contains("# 正文标题\n保留字节。"), "正文变化");
        assert!(doc.content.contains("scope:\n  - all"), "scope 被无关改动");
        // 非布尔标量 → 报错且原文件不变
        let dir = project_skills_root(&store, "p1").unwrap().join("t1");
        std::fs::write(
            dir.join("SKILL.md"),
            content.replace("enabled: true", "enabled: maybe"),
        )
        .unwrap();
        let before = std::fs::read(dir.join("SKILL.md")).unwrap();
        let err = set_skill_enabled(&store, "p1", SkillOrigin::Project, "t1", true).unwrap_err();
        assert!(err.contains("必须是布尔值"), "错误串不符: {err}");
        assert_eq!(
            std::fs::read(dir.join("SKILL.md")).unwrap(),
            before,
            "失败时文件被改动"
        );
        // enabled 缺失 → 插入
        std::fs::write(
            dir.join("SKILL.md"),
            "---\nname: t1\ndescription: d\n---\n正文\n",
        )
        .unwrap();
        let s = set_skill_enabled(&store, "p1", SkillOrigin::Project, "t1", false).unwrap();
        assert!(!s.enabled);
        let doc = read_skill(&store, "p1", SkillOrigin::Project, "t1").unwrap();
        assert!(
            doc.content.contains("enabled: false"),
            "缺失未插入: {}",
            doc.content
        );
    }

    #[test]
    fn crlf_frontmatter_preserved() {
        let (store, _ws) = store_with_workspace("crlf");
        project(&store, "p1", "my-proj", None);
        let content = "---\r\nname: crlf-skill\r\ndescription: CRLF 技能\r\nenabled: true\r\n---\r\n\r\n正文行。\r\n";
        save_skill(
            &store,
            "p1",
            SkillOrigin::Project,
            None,
            content,
            &["local".into(), "all".into()],
        )
        .unwrap();
        let doc = read_skill(&store, "p1", SkillOrigin::Project, "crlf-skill").unwrap();
        assert!(doc.content.contains("\r\n"), "CRLF 被破坏");
        assert!(
            doc.content.contains("scope:\r\n  - local\r\n  - all"),
            "scope 块换行风格不符: {:?}",
            doc.content
        );
        let s = set_skill_enabled(&store, "p1", SkillOrigin::Project, "crlf-skill", false).unwrap();
        assert!(!s.enabled);
        let doc = read_skill(&store, "p1", SkillOrigin::Project, "crlf-skill").unwrap();
        assert!(
            doc.content.contains("enabled: false\r\n"),
            "enabled 换行风格不符: {:?}",
            doc.content
        );
        assert!(doc.content.contains("\r\n\r\n正文行。\r\n"), "正文被破坏");
    }

    #[test]
    fn delete_removes_recursively_and_errors_on_missing() {
        let (store, _ws) = store_with_workspace("delete");
        project(&store, "p1", "my-proj", None);
        save_skill(
            &store,
            "p1",
            SkillOrigin::Project,
            None,
            &skill_md("gone", "d", ""),
            &[],
        )
        .unwrap();
        let root = project_skills_root(&store, "p1").unwrap();
        std::fs::create_dir_all(root.join("gone").join("assets")).unwrap();
        delete_skill(&store, "p1", SkillOrigin::Project, "gone").unwrap();
        assert!(!root.join("gone").exists(), "目录未被递归删除");
        let err = delete_skill(&store, "p1", SkillOrigin::Project, "gone").unwrap_err();
        assert!(err.contains("不存在"), "错误串不符: {err}");
        // 非技能目录不可删（无 SKILL.md）
        std::fs::create_dir_all(root.join("not-skill")).unwrap();
        let err = delete_skill(&store, "p1", SkillOrigin::Project, "not-skill").unwrap_err();
        assert!(err.contains("不存在"), "错误串不符: {err}");
    }

    #[test]
    fn write_failure_keeps_original_intact() {
        let (store, _ws) = store_with_workspace("write-fail");
        project(&store, "p1", "my-proj", None);
        let content = skill_md("keep", "d", "");
        save_skill(&store, "p1", SkillOrigin::Project, None, &content, &[]).unwrap();
        let dir = project_skills_root(&store, "p1").unwrap().join("keep");
        let file = dir.join("SKILL.md");
        // 使 .tmp 写入必然失败：在同目录放一个名为 SKILL.md.tmp 的目录（跨平台可注入）
        let tmp = dir.join("SKILL.md.tmp");
        std::fs::create_dir_all(&tmp).unwrap();
        let before = std::fs::read(&file).unwrap();
        let err = set_skill_enabled(&store, "p1", SkillOrigin::Project, "keep", false).unwrap_err();
        assert!(err.contains("写入临时文件失败"), "错误串不符: {err}");
        assert_eq!(std::fs::read(&file).unwrap(), before, "失败时原文件被破坏");
        assert!(!dir.join("SKILL.md.bak").exists(), "失败时不应产生 .bak");
        let _ = std::fs::remove_dir_all(&tmp);
        // 恢复后正常启停且无残留
        set_skill_enabled(&store, "p1", SkillOrigin::Project, "keep", false).unwrap();
        let names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(
            !names
                .iter()
                .any(|n| n.contains(".tmp") || n.contains(".bak")),
            "临时文件残留: {names:?}"
        );
    }

    #[test]
    fn seed_builtin_skill_idempotent_and_preserves_user_file() {
        let ws = tmp_base("seed");
        std::fs::create_dir_all(&ws).unwrap();
        let file = ws
            .join(".aishell")
            .join("skills")
            .join("skill-management")
            .join("SKILL.md");
        seed_builtin_skill_files(ws.to_str().unwrap()).unwrap();
        assert!(file.is_file(), "内置技能未播种");
        let first = std::fs::read_to_string(&file).unwrap();
        assert!(
            first.contains("## 两个技能根目录"),
            "内置文档缺少目录结构说明"
        );
        assert!(first.contains("## scope 语义"), "内置文档缺少 scope 语义");
        // 已存在不覆盖
        std::fs::write(&file, "用户改写的文件").unwrap();
        seed_builtin_skill_files(ws.to_str().unwrap()).unwrap();
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "用户改写的文件",
            "已存在文件被覆盖"
        );
        let _ = std::fs::remove_dir_all(&ws);
    }
    #[test]
    fn skillhub_zip_install_supports_nested_root_and_rejects_overwrite() {
        use std::io::Write;
        use zip::write::SimpleFileOptions;
        use zip::ZipWriter;

        let (store, _ws) = store_with_workspace("skillhub-install");
        project(&store, "p1", "my-proj", None);
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        let options = SimpleFileOptions::default();
        writer.start_file("hub-skill/SKILL.md", options).unwrap();
        writer
            .write_all("---\nname: hub-skill\ndescription: SkillHub\n---\n正文\n".as_bytes())
            .unwrap();
        writer
            .start_file("hub-skill/scripts/run.sh", options)
            .unwrap();
        writer.write_all(b"echo ok\n").unwrap();
        let bytes = writer.finish().unwrap().into_inner();

        let installed =
            install_skillhub_zip(&store, "p1", SkillOrigin::Project, "hub-skill", &bytes).unwrap();
        assert_eq!(installed.name, "hub-skill");
        let root = project_skills_root(&store, "p1").unwrap();
        assert!(root.join("hub-skill/SKILL.md").is_file());
        assert!(root.join("hub-skill/scripts/run.sh").is_file());

        let err = install_skillhub_zip(&store, "p1", SkillOrigin::Project, "hub-skill", &bytes)
            .unwrap_err();
        assert!(err.contains("未覆盖"), "错误串不符: {err}");
    }

    #[test]
    fn pack_skill_for_upload_keeps_root_layout_and_excludes_hidden_entries() {
        let (store, ws) = store_with_workspace("pack-upload");
        project(&store, "p1", "my-proj", None);
        let content = skill_md("uploadable", "可上传", "");
        save_skill(
            &store,
            "p1",
            SkillOrigin::Project,
            None,
            &content,
            &["all".to_string()],
        )
        .unwrap();
        let skill = project_skills_root(&store, "p1").unwrap().join("uploadable");
        std::fs::create_dir_all(skill.join("references")).unwrap();
        std::fs::write(skill.join("references/guide.txt"), "逐字节附件").unwrap();
        std::fs::write(skill.join("blob.bin"), [0, 1, 2, 255]).unwrap();
        std::fs::create_dir_all(skill.join(".clawhub")).unwrap();
        std::fs::write(skill.join(".env"), "secret").unwrap();
        std::fs::write(skill.join(".clawhub/state"), "local state").unwrap();

        let package = PathBuf::from(
            pack_skill_for_upload(&store, "p1", SkillOrigin::Project, "uploadable").unwrap(),
        );
        let mut archive = ZipArchive::new(File::open(&package).unwrap()).unwrap();
        let mut names = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect::<Vec<_>>();
        names.sort();
        assert_eq!(
            names,
            vec![
                "SKILL.md".to_string(),
                "blob.bin".to_string(),
                "references/".to_string(),
                "references/guide.txt".to_string(),
            ]
        );
        let mut guide = String::new();
        archive
            .by_name("references/guide.txt")
            .unwrap()
            .read_to_string(&mut guide)
            .unwrap();
        assert_eq!(guide, "逐字节附件");
        let mut blob = Vec::new();
        archive.by_name("blob.bin").unwrap().read_to_end(&mut blob).unwrap();
        assert_eq!(blob, [0, 1, 2, 255]);
        let expected_dir = normalize_win_path(
            std::fs::canonicalize(ws.join("my-proj/.aishell/tmp/skillhub-upload")).unwrap(),
        );
        assert!(package.starts_with(expected_dir));
    }

    #[test]
    fn upload_packages_are_unique_and_cleanup_is_restricted() {
        let (store, _ws) = store_with_workspace("pack-upload-cleanup");
        project(&store, "p1", "my-proj", None);
        let content = skill_md("uploadable", "可上传", "");
        save_skill(&store, "p1", SkillOrigin::Global, None, &content, &[]).unwrap();
        let first = PathBuf::from(
            pack_skill_for_upload(&store, "p1", SkillOrigin::Global, "uploadable").unwrap(),
        );
        let second = PathBuf::from(
            pack_skill_for_upload(&store, "p1", SkillOrigin::Global, "uploadable").unwrap(),
        );
        assert_ne!(first, second, "并发点击不能覆盖同一上传包");
        assert_eq!(
            validate_upload_package_path(&store, "p1", SkillOrigin::Global, &first).unwrap(),
            first
        );
        remove_upload_package(&store, "p1", SkillOrigin::Global, &first).unwrap();
        assert!(!first.exists());

        let outside = tmp_base("pack-upload-outside").join("outside.zip");
        std::fs::create_dir_all(outside.parent().unwrap()).unwrap();
        std::fs::write(&outside, b"zip").unwrap();
        assert!(
            validate_upload_package_path(&store, "p1", SkillOrigin::Global, &outside).is_err()
        );
        let non_zip = second.with_extension("txt");
        std::fs::write(&non_zip, b"not zip").unwrap();
        assert!(
            validate_upload_package_path(&store, "p1", SkillOrigin::Global, &non_zip).is_err()
        );
    }

    #[test]
    fn pack_skill_for_upload_rejects_invalid_source_without_creating_package() {
        let (store, _ws) = store_with_workspace("pack-upload-invalid");
        project(&store, "p1", "my-proj", None);
        let root = project_skills_root(&store, "p1").unwrap();
        let skill = root.join("broken");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(skill.join(SKILL_FILE), "---\nname: broken\n---\n").unwrap();
        let err = pack_skill_for_upload(&store, "p1", SkillOrigin::Project, "broken").unwrap_err();
        assert!(err.contains("description"), "错误串不符：{err}");
        let uploads = upload_package_dir(&store, "p1", SkillOrigin::Project).unwrap();
        assert!(
            !uploads.exists() || std::fs::read_dir(&uploads).unwrap().next().is_none(),
            "失败时不应残留上传包"
        );
    }

    #[cfg(windows)]
    #[test]
    fn pack_skill_for_upload_rejects_windows_symlink_when_available() {
        use std::os::windows::fs::symlink_file;

        let (store, _ws) = store_with_workspace("pack-upload-link");
        project(&store, "p1", "my-proj", None);
        let content = skill_md("linked", "可上传", "");
        save_skill(&store, "p1", SkillOrigin::Project, None, &content, &[]).unwrap();
        let skill = project_skills_root(&store, "p1").unwrap().join("linked");
        let target = skill.join("target.txt");
        let link = skill.join("link.txt");
        std::fs::write(&target, "target").unwrap();
        if symlink_file(&target, &link).is_err() {
            return; // 未启用开发者模式时 Windows 不授予创建链接权限，无法构造该输入。
        }
        let err = pack_skill_for_upload(&store, "p1", SkillOrigin::Project, "linked").unwrap_err();
        assert!(err.contains("符号链接") || err.contains("重解析点"), "错误串不符：{err}");
    }

    #[test]
    fn pack_skill_for_upload_rejects_archives_over_fifty_mib() {
        use std::io::Write;

        let (store, _ws) = store_with_workspace("pack-upload-large");
        project(&store, "p1", "my-proj", None);
        let content = skill_md("large-upload", "可上传", "");
        save_skill(&store, "p1", SkillOrigin::Project, None, &content, &[]).unwrap();
        let large = project_skills_root(&store, "p1")
            .unwrap()
            .join("large-upload")
            .join("attachment.bin");
        let mut output = File::create(&large).unwrap();
        let mut state = 0x9e37_79b9_u32;
        let mut buffer = [0_u8; 8192];
        for _ in 0..((51 * 1024 * 1024) / buffer.len()) {
            for byte in &mut buffer {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                *byte = state as u8;
            }
            output.write_all(&buffer).unwrap();
        }
        drop(output);

        let err = pack_skill_for_upload(&store, "p1", SkillOrigin::Project, "large-upload")
            .unwrap_err();
        assert!(
            err.contains("SkillHub 上传包过大（上限 50 MiB）"),
            "错误串不符：{err}"
        );
        let uploads = upload_package_dir(&store, "p1", SkillOrigin::Project).unwrap();
        assert!(
            !uploads.exists() || std::fs::read_dir(&uploads).unwrap().next().is_none(),
            "超限失败后残留上传包"
        );
    }
}
