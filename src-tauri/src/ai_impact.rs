//! 远程命令影响路径的确定性分析（自动备份远程文件的前置）。
//!
//! 与智能审批（smart_approval.rs，LLM 风险判定）职责分离：本模块只回答「这条命令会
//! 修改哪些文件」，用纯静态规则识别 `cd`、`>`/`>>` 重定向、`tee`、`sed -i`、`perl -i`、
//! `truncate`、`rm`、`mv`、`cp`、`install`；静态绝对路径与基于静态 `cd` 的相对路径转为
//! 绝对路径。变量、命令替换、外部脚本、循环、无法展开的 glob、目录递归影响一律
//! `unbounded`——不得猜路径，无法完整确定影响范围时由上层转人工确认/拒绝，绝不宣称完整备份。
//!
//! 关键示例（需求验收）：`cd /var/www/app && : > config.json` 必须得到单个绝对
//! `modify` 路径 `/var/www/app/config.json`；`cd "$APP_DIR"` 必须得到 `unbounded`。

use serde::{Deserialize, Serialize};

/// 文件系统影响范围：none = 无已识别写入；bounded = changes 完整列出；
/// unbounded = 影响范围无法静态确定（不得宣称完整备份）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Effect {
    None,
    Bounded,
    Unbounded,
}

/// 文件变更操作（rename 的 destination 为目标绝对路径）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Operation {
    Create,
    Modify,
    Delete,
    Rename,
}

/// 单文件变更（path 恒为绝对路径）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub operation: Operation,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination: Option<String>,
}

/// 影响计划：effect + changes + 中文说明。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImpactPlan {
    pub effect: Effect,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub changes: Vec<FileChange>,
    pub reason: String,
}

impl ImpactPlan {
    pub fn none(reason: &str) -> Self {
        ImpactPlan { effect: Effect::None, changes: Vec::new(), reason: reason.to_string() }
    }

    pub fn unbounded(reason: &str) -> Self {
        ImpactPlan { effect: Effect::Unbounded, changes: Vec::new(), reason: reason.to_string() }
    }

    pub fn bounded(changes: Vec<FileChange>, reason: &str) -> Self {
        ImpactPlan { effect: Effect::Bounded, changes, reason: reason.to_string() }
    }
}

/// 影响严重度排序（merge 用）：none < bounded < unbounded。
fn severity(e: Effect) -> u8 {
    match e {
        Effect::None => 0,
        Effect::Bounded => 1,
        Effect::Unbounded => 2,
    }
}

impl std::str::FromStr for Effect {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "none" => Ok(Effect::None),
            "bounded" => Ok(Effect::Bounded),
            "unbounded" => Ok(Effect::Unbounded),
            _ => Err(format!("非法 filesystemEffect：{s}（应为 none|bounded|unbounded）")),
        }
    }
}

impl std::str::FromStr for Operation {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "create" => Ok(Operation::Create),
            "modify" => Ok(Operation::Modify),
            "delete" => Ok(Operation::Delete),
            "rename" => Ok(Operation::Rename),
            _ => Err(format!("非法 operation：{s}（应为 create|modify|delete|rename）")),
        }
    }
}

/// 合并确定性分析与 LLM 补充分析：取严重度更高的一档，changes 取并集。
/// 供智能审批「复用同一 toolCallId 计划并用 LLM 补充风险/路径分析」使用：
/// LLM 补充的路径只会加不会删，unbounded 永不降级。
pub fn merge_plans(deterministic: &ImpactPlan, llm: &ImpactPlan) -> ImpactPlan {
    let effect = if severity(deterministic.effect) >= severity(llm.effect) {
        deterministic.effect
    } else {
        llm.effect
    };
    let mut changes = deterministic.changes.clone();
    for c in &llm.changes {
        if !changes.contains(c) {
            changes.push(c.clone());
        }
    }
    let reason = if effect == Effect::Unbounded {
        if deterministic.effect == Effect::Unbounded {
            deterministic.reason.clone()
        } else if llm.effect == Effect::Unbounded {
            llm.reason.clone()
        } else {
            deterministic.reason.clone()
        }
    } else {
        format!("{}；{}", deterministic.reason, llm.reason)
    };
    ImpactPlan { effect, changes, reason }
}

/// 校验（LLM 提供的）计划：effect=bounded 必须有非空 changes、每个路径都是绝对路径、
/// rename 必须带绝对 destination；任何非法形态返回 Err（调用方按 unbounded 处理，绝不降级为 none）。
pub fn validate_impact_plan(plan: &ImpactPlan) -> Result<ImpactPlan, String> {
    match plan.effect {
        Effect::Unbounded => Ok(plan.clone()),
        Effect::None => {
            if plan.changes.is_empty() {
                Ok(plan.clone())
            } else {
                Err("effect=none 却携带了文件变更列表".to_string())
            }
        }
        Effect::Bounded => {
            if plan.changes.is_empty() {
                return Err("effect=bounded 但未列出任何受影响的文件".to_string());
            }
            for c in &plan.changes {
                if !c.path.starts_with('/') {
                    return Err(format!("变更路径不是绝对路径：{}", c.path));
                }
                if c.operation == Operation::Rename {
                    match &c.destination {
                        Some(d) if d.starts_with('/') => {}
                        _ => return Err(format!("rename 缺少绝对目标路径：{}", c.path)),
                    }
                }
            }
            Ok(plan.clone())
        }
    }
}

/// 伪文件系统前缀：写这些路径不需要备份（设备/内核/临时虚拟 fs）。
fn is_pseudo_fs(path: &str) -> bool {
    const PREFIXES: [&str; 4] = ["/dev/", "/proc/", "/sys/", "/run/"];
    PREFIXES.iter().any(|p| path.starts_with(p))
}

/// 路径含动态成分（变量、命令替换、通配符、波浪号、花括号）——无法静态确定。
fn is_dynamic(s: &str) -> bool {
    s.contains(['$', '`', '*', '?', '[', '{', '~'])
}

/// 词法规范化绝对路径：折叠重复 `/`、`.` 与 `..`（不触碰磁盘）。输入必须已解析为
/// 绝对形态（相对路径已由调用方拼上 cwd）。
fn normalize_abs(p: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for comp in p.split('/') {
        match comp {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            c => parts.push(c),
        }
    }
    format!("/{}", parts.join("/"))
}

/// 把重定向目标/工具文件参数解析为规范化绝对路径；含动态成分返回 Err（→ unbounded）。
fn resolve_path(target: &str, cwd: &str) -> Result<String, String> {
    if is_dynamic(target) {
        return Err(format!("路径包含变量/命令替换/通配符，无法静态确定：{target}"));
    }
    let joined = if target.starts_with('/') {
        target.to_string()
    } else {
        format!("{}/{}", cwd.trim_end_matches('/'), target)
    };
    let norm = normalize_abs(&joined);
    if !norm.starts_with('/') {
        return Err(format!("路径解析结果不是绝对路径：{target}"));
    }
    Ok(norm)
}

/// 路径最后一段（`dir/` 结尾时取 dir；根目录返回空）。
fn basename(p: &str) -> &str {
    p.trim_end_matches('/')
        .rsplit('/')
        .find(|s| !s.is_empty())
        .unwrap_or("")
}

fn join_remote(dir: &str, name: &str) -> String {
    if dir == "/" {
        format!("/{name}")
    } else {
        format!("{}/{}", dir.trim_end_matches('/'), name)
    }
}

/// 命令段：words 为一段命令的词列表；after_pipe=true 表示该段在管道（`|`）右侧——
/// 子 shell 中 `cd` 不传播到后续段，但段内文件写入仍按当前 cwd 解析。
struct Segment {
    words: Vec<String>,
    after_pipe: bool,
}

/// 切分命令为段（顶层 `;`/`&&`/`||`/换行/后台 `&` 分段，`|` 标管道子 shell）。
/// 引号（单/双）、反斜杠转义、注释 `#` 正确处理；`(`/`)` 作为独立词标记子 shell。
fn tokenize(command: &str) -> Vec<Segment> {
    let chars: Vec<char> = command.chars().collect();
    let n = chars.len();
    let mut segments: Vec<Segment> = Vec::new();
    let mut words: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut i = 0;

    // 收尾当前段：压入当前词与段；$pipe 决定该段的管道子 shell 标记（`;`/`&` 等为 false，`|` 为 true）。
    macro_rules! flush_segment {
        ($pipe:expr) => {{
            if !cur.is_empty() {
                words.push(std::mem::take(&mut cur));
            }
            if !words.is_empty() {
                segments.push(Segment { words: std::mem::take(&mut words), after_pipe: $pipe });
            }
        }};
    }

    while i < n {
        let c = chars[i];
        match c {
            '\'' => {
                i += 1;
                let start = i;
                while i < n && chars[i] != '\'' {
                    i += 1;
                }
                cur.extend(chars[start..i].iter());
                if i < n {
                    i += 1; // 闭合引号
                }
            }
            '"' => {
                i += 1;
                while i < n && chars[i] != '"' {
                    if chars[i] == '\\' && i + 1 < n {
                        cur.push(chars[i + 1]);
                        i += 2;
                    } else {
                        cur.push(chars[i]);
                        i += 1;
                    }
                }
                if i < n {
                    i += 1;
                }
            }
            '\\' if i + 1 < n => {
                cur.push(chars[i + 1]);
                i += 2;
            }
            '\\' => i += 1,
            // 词首的 # 开始注释到行尾（bash 语义）；词中 # 是普通字符
            '#' if cur.is_empty() && words.is_empty() => {
                while i < n && chars[i] != '\n' {
                    i += 1;
                }
            }
            ';' | '\n' => {
                flush_segment!(false);
                i += 1;
            }
            '&' => {
                // `2>&1` / `2>>&1`：& 属于 fd 重定向词（前词为 数字+>）；否则是
                // && 连接符 / 单 & 后台（段边界，cd 传播保持）
                let prev = cur.as_str();
                let fd_redirect = {
                    let t = prev.trim_start_matches(|c: char| c.is_ascii_digit());
                    t == ">" || t == ">>"
                };
                if fd_redirect {
                    cur.push('&');
                    i += 1;
                } else {
                    flush_segment!(false);
                    if i + 1 < n && chars[i + 1] == '&' {
                        i += 2;
                    } else {
                        i += 1;
                    }
                }
            }
            '|' => {
                // `>|`（noclobber 覆盖）中 | 属于重定向词；否则 | 管道 / || 连接符
                let prev = cur.as_str();
                let in_redirect = {
                    let t = prev.trim_start_matches(|c: char| c.is_ascii_digit());
                    t == ">"
                };
                if in_redirect {
                    cur.push('|');
                    i += 1;
                } else if i + 1 < n && chars[i + 1] == '|' {
                    flush_segment!(false);
                    i += 2;
                } else {
                    // 管道：右侧段打上 after_pipe 标记（子 shell，cd 不传播）
                    flush_segment!(true);
                    i += 1;
                }
            }
            '(' | ')' => {
                flush_segment!(false);
                words.push(c.to_string());
                i += 1;
            }
            c if c.is_whitespace() => {
                if !cur.is_empty() {
                    words.push(std::mem::take(&mut cur));
                }
                i += 1;
            }
            _ => {
                cur.push(c);
                i += 1;
            }
        }
    }
    flush_segment!(false);
    segments
}

/// 重定向词分类：Some((is_write, word 内目标))；is_write=false 为输入重定向（忽略）。
/// 支持 `>f`、`>>f`、`>|f`、`2>f`、`2>>f`、`&>f`、`&>>f`、`> f`（目标在下一词，返回空串）。
fn split_redirect(w: &str) -> Option<(bool, &str)> {
    let w = w.strip_prefix('&').unwrap_or(w);
    let bytes = w.as_bytes();
    let mut idx = 0;
    while idx < bytes.len() && bytes[idx].is_ascii_digit() {
        idx += 1;
    }
    let rest = &w[idx..];
    if rest.starts_with("<<") {
        return Some((false, "")); // heredoc / herestring：输入
    }
    if rest.starts_with('<') {
        return Some((false, "")); // 输入重定向
    }
    if let Some(r) = rest.strip_prefix(">>") {
        return Some((true, r));
    }
    if let Some(r) = rest.strip_prefix(">|") {
        return Some((true, r));
    }
    if let Some(r) = rest.strip_prefix('>') {
        return Some((true, r));
    }
    None
}

/// 已知可分析工具名（含绝对路径形态 `/bin/rm` 等取 basename 判定）。
const KNOWN_TOOLS: [&str; 9] = ["tee", "sed", "perl", "truncate", "rm", "mv", "cp", "install", "cd"];

fn is_known_tool(first: &str) -> bool {
    let base = basename(first);
    KNOWN_TOOLS.contains(&base)
}

/// 追加一条文件变更（去伪 fs、解析绝对路径）。
fn push_change(changes: &mut Vec<FileChange>, op: Operation, target: &str, cwd: &str) -> Result<(), String> {
    let path = resolve_path(target, cwd)?;
    if !is_pseudo_fs(&path) {
        changes.push(FileChange { operation: op, path, destination: None });
    }
    Ok(())
}

/// 重定向目标是否指向文件描述符（`2>&1` 等）——不涉及文件。
fn is_fd_target(target: &str) -> bool {
    target == "&1" || target == "&2" || target == "&-"
}

/// 分析单个语句（非 cd）的文件影响；无法静态确定返回 Err（→ unbounded）。
fn analyze_statement(words: &[String], cwd: &str) -> Result<Vec<FileChange>, String> {
    let mut changes: Vec<FileChange> = Vec::new();
    // 第一遍：提取重定向（> 族），剩余为命令词
    let mut cmd_words: Vec<String> = Vec::new();
    let mut i = 0;
    while i < words.len() {
        let w = &words[i];
        if let Some((is_write, rest)) = split_redirect(w) {
            if is_write {
                // 目标在同一词内（rest）或下一词
                let target = if rest.is_empty() {
                    i += 1;
                    match words.get(i) {
                        Some(t) => t.clone(),
                        None => {
                            // 重定向缺目标：shell 语法错误，命令不会执行，无文件影响
                            i += 1;
                            continue;
                        }
                    }
                } else {
                    rest.to_string()
                };
                if !is_fd_target(&target) {
                    push_change(&mut changes, Operation::Modify, &target, cwd)?;
                }
            }
            i += 1;
            continue;
        }
        cmd_words.push(w.clone());
        i += 1;
    }

    let first = match cmd_words.first() {
        None => return Ok(changes), // 只有重定向，已处理
        Some(f) => f.as_str(),
    };
    // 子 shell / 循环结构（在 tokenize 层已标记 unbounded，此处兜底）
    if first == "(" || first == ")" {
        return Err("子 shell 内命令影响范围无法静态确定".to_string());
    }
    if matches!(first, "for" | "while" | "until" | "case") {
        return Err("循环/分支结构无法静态确定执行范围".to_string());
    }
    // 纯 shell 关键字：跳过（真正命令在后续段）
    if matches!(first, "do" | "done" | "then" | "else" | "elif" | "fi" | "esac" | "{" | "}" | "if") {
        return Ok(changes);
    }
    if is_dynamic(first) {
        return Err(format!("命令名包含变量/命令替换，无法确定影响范围：{first}"));
    }
    // 可执行路径（含 / 或 . 开头）且不是已知工具 → 外部脚本
    if (first.contains('/') || first.starts_with('.')) && !is_known_tool(first) {
        return Err(format!("外部脚本/可执行文件（{first}），无法确定影响范围"));
    }

    match basename(first) {
        "tee" => handle_tee(&cmd_words, cwd, &mut changes)?,
        "sed" => handle_sed(&cmd_words, cwd, &mut changes)?,
        "perl" => handle_perl(&cmd_words, cwd, &mut changes)?,
        "truncate" => handle_truncate(&cmd_words, cwd, &mut changes)?,
        "rm" => handle_rm(&cmd_words, cwd, &mut changes)?,
        "mv" => handle_mv(&cmd_words, cwd, &mut changes)?,
        "cp" => handle_cp(&cmd_words, cwd, &mut changes)?,
        "install" => handle_install(&cmd_words, cwd, &mut changes)?,
        // 解释器：即使不写文件也无法证明，一律无法确定（perl -i 已在上方分支处理）
        "bash" | "sh" | "zsh" | "dash" | "ksh" | "python" | "python3" | "ruby" | "node" | "php" | "expect" => {
            return Err(format!("解释器执行脚本（{first}），无法确定影响范围"));
        }
        _ => {
            // 未知命令：未识别到文件写入（重定向已处理），按无文件影响处理
        }
    }
    Ok(changes)
}

/// tee [OPTION]... [FILE]...：参数（非选项）即写入目标。
fn handle_tee(words: &[String], cwd: &str, changes: &mut Vec<FileChange>) -> Result<(), String> {
    for w in &words[1..] {
        if w == "-" || (w.starts_with('-') && w.len() > 1) {
            continue;
        }
        push_change(changes, Operation::Modify, w, cwd)?;
    }
    Ok(())
}

/// sed -i [OPTION]... [script] [FILE]...：带 -i 时文件列表为修改目标。
/// 仅第一个非选项参数是脚本（GNU 语义，其后非选项参数均为文件）。
fn handle_sed(words: &[String], cwd: &str, changes: &mut Vec<FileChange>) -> Result<(), String> {
    let mut in_place = false;
    let mut script_pending = false; // 下一个参数是脚本（-e 表达式）
    let mut script_seen = false;
    let mut files: Vec<String> = Vec::new();
    let mut i = 1;
    while i < words.len() {
        let w = &words[i];
        if script_pending {
            script_pending = false;
            script_seen = true;
            i += 1;
            continue;
        }
        if w == "-i" || (w.starts_with("-i") && w.len() > 2) {
            in_place = true; // -i 或 -i.bak（备份后缀，同样就地写）
            i += 1;
            continue;
        }
        if w == "-e" || w == "--expression" {
            script_pending = true;
            i += 1;
            continue;
        }
        if w.starts_with("--expression=") {
            script_seen = true;
            i += 1;
            continue;
        }
        if w == "-" {
            i += 1;
            continue; // stdin
        }
        if w.starts_with('-') && w.len() > 1 {
            i += 1;
            continue; // -n -E -r -u --posix 等
        }
        if !script_seen {
            script_seen = true;
            i += 1;
            continue;
        }
        files.push(w.clone());
        i += 1;
    }
    if in_place {
        for f in &files {
            push_change(changes, Operation::Modify, f, cwd)?;
        }
    }
    Ok(())
}

/// perl -i：带 -i/-i.bak 时文件列表为修改目标；无 -i 按外部脚本处理（无法确定）。
fn handle_perl(words: &[String], cwd: &str, changes: &mut Vec<FileChange>) -> Result<(), String> {
    let mut in_place = false;
    let mut script_pending = false;
    let mut script_seen = false;
    let mut files: Vec<String> = Vec::new();
    let mut i = 1;
    while i < words.len() {
        let w = &words[i];
        if script_pending {
            script_pending = false;
            script_seen = true;
            i += 1;
            continue;
        }
        if w == "-i" || (w.starts_with("-i") && w.len() > 2) || w.starts_with("-pi") {
            in_place = true; // -i / -i.bak / -pi / -pie（-p -i 捆绑）
            i += 1;
            continue;
        }
        // -e / -pe / -ne / -pie：表达式在下一参数；-p / -n / -w / -pi 等无表达式参数
        if matches!(w.as_str(), "-e" | "-pe" | "-ne" | "-pie" | "-wp" | "-wn") {
            script_pending = true;
            i += 1;
            continue;
        }
        if w == "-" {
            i += 1;
            continue;
        }
        if w.starts_with('-') && w.len() > 1 {
            i += 1;
            continue;
        }
        if !script_seen {
            script_seen = true;
            i += 1;
            continue;
        }
        files.push(w.clone());
        i += 1;
    }
    if !in_place {
        return Err("perl 未使用 -i 就地编辑，按外部脚本处理".to_string());
    }
    for f in &files {
        push_change(changes, Operation::Modify, f, cwd)?;
    }
    Ok(())
}

/// truncate [OPTION]... FILE...：非选项参数即修改目标。
fn handle_truncate(words: &[String], cwd: &str, changes: &mut Vec<FileChange>) -> Result<(), String> {
    let mut i = 1;
    while i < words.len() {
        let w = &words[i];
        if w == "-s" || w == "--size" || w == "-r" || w == "--reference" {
            i += 2; // 跳过取值
            continue;
        }
        if matches!(w.as_str(), "-c" | "--no-create" | "-o" | "--io-blocks") {
            i += 1;
            continue;
        }
        if (w.starts_with("-s") && w.len() > 2) || (w.starts_with("--size=") ) || (w.starts_with("--reference=")) {
            i += 1;
            continue;
        }
        if w == "-" {
            i += 1;
            continue;
        }
        if w.starts_with('-') && w.len() > 1 {
            i += 1;
            continue;
        }
        push_change(changes, Operation::Modify, w, cwd)?;
        i += 1;
    }
    Ok(())
}

/// rm [OPTION]... FILE...：-r/-R/--recursive（含捆绑如 -rf/-fr）递归删除 → unbounded；
/// 否则逐个 delete。
fn handle_rm(words: &[String], cwd: &str, changes: &mut Vec<FileChange>) -> Result<(), String> {
    let mut recursive = false;
    let mut files: Vec<String> = Vec::new();
    for w in &words[1..] {
        if is_recursive_flag(w) {
            recursive = true;
            continue;
        }
        if w == "-" {
            continue;
        }
        if w.starts_with('-') && w.len() > 1 {
            continue; // -f -i -v -d --
        }
        files.push(w.clone());
    }
    if recursive {
        return Err("递归删除（rm -r），目录内文件无法枚举".to_string());
    }
    for f in &files {
        push_change(changes, Operation::Delete, f, cwd)?;
    }
    Ok(())
}

/// 递归标志：--recursive 或短选项含 r（-r / -rf / -fr / -R 等）。
fn is_recursive_flag(w: &str) -> bool {
    if w == "--recursive" {
        return true;
    }
    w.starts_with('-') && !w.starts_with("--") && w.len() >= 2 && w[1..].contains('r')
}

/// mv [OPTION]... SOURCE DEST / mv -t DIR SOURCE...：rename 变更（源 + 目标）。
fn handle_mv(words: &[String], cwd: &str, changes: &mut Vec<FileChange>) -> Result<(), String> {
    let mut args: Vec<String> = Vec::new();
    let mut i = 1;
    let mut dest_dir: Option<String> = None;
    while i < words.len() {
        let w = &words[i];
        if w == "-t" || w == "--target-directory" {
            dest_dir = words.get(i + 1).cloned().map(|d| d.trim_end_matches('/').to_string());
            i += 2;
            continue;
        }
        if w == "-T" || w == "--no-target-directory" {
            i += 1;
            continue;
        }
        if w == "-" {
            i += 1;
            continue;
        }
        if w.starts_with('-') && w.len() > 1 {
            i += 1;
            continue;
        }
        args.push(w.clone());
        i += 1;
    }
    if args.is_empty() {
        return Ok(());
    }
    let mut push_rename = |src: &str, dest: &str| -> Result<(), String> {
        let src_path = resolve_path(src, cwd)?;
        let dest_path = resolve_path(dest, cwd)?;
        if !is_pseudo_fs(&src_path) || !is_pseudo_fs(&dest_path) {
            changes.push(FileChange { operation: Operation::Rename, path: src_path, destination: Some(dest_path) });
        }
        Ok(())
    };
    if let Some(dir) = &dest_dir {
        for src in &args {
            push_rename(src, &join_remote(dir, basename(src)))?;
        }
        return Ok(());
    }
    if args.len() < 2 {
        return Ok(()); // 缺参数：shell 报错，无操作
    }
    let dest = args.last().unwrap().clone();
    let sources = &args[..args.len() - 1];
    if sources.len() > 1 && !dest.ends_with('/') {
        return Err("多源移动且目标不是目录形态，无法确定落地文件名".to_string());
    }
    for src in sources {
        let dest_path = if dest.ends_with('/') || sources.len() > 1 {
            join_remote(&dest, basename(src))
        } else {
            dest.clone()
        };
        push_rename(src, &dest_path)?;
    }
    Ok(())
}

/// cp [OPTION]... SOURCE DEST / cp -t DIR SOURCE...：-r 递归 → unbounded；目标 modify。
fn handle_cp(words: &[String], cwd: &str, changes: &mut Vec<FileChange>) -> Result<(), String> {
    let mut args: Vec<String> = Vec::new();
    let mut recursive = false;
    let mut i = 1;
    let mut dest_dir: Option<String> = None;
    while i < words.len() {
        let w = &words[i];
        if is_recursive_flag(w) {
            recursive = true;
            i += 1;
            continue;
        }
        if w == "-t" || w == "--target-directory" {
            dest_dir = words.get(i + 1).cloned().map(|d| d.trim_end_matches('/').to_string());
            i += 2;
            continue;
        }
        if w == "-T" || w == "--no-target-directory" {
            i += 1;
            continue;
        }
        if w == "-" {
            i += 1;
            continue;
        }
        if w.starts_with('-') && w.len() > 1 {
            i += 1;
            continue;
        }
        args.push(w.clone());
        i += 1;
    }
    if recursive {
        return Err("递归复制（cp -r），目录内文件无法枚举".to_string());
    }
    if args.is_empty() {
        return Ok(());
    }
    if let Some(dir) = &dest_dir {
        for src in &args {
            push_change(changes, Operation::Modify, &join_remote(dir, basename(src)), cwd)?;
        }
        return Ok(());
    }
    if args.len() < 2 {
        return Ok(());
    }
    let dest = args.last().unwrap().clone();
    let sources = &args[..args.len() - 1];
    if sources.len() > 1 && !dest.ends_with('/') {
        return Err("多源复制且目标不是目录形态，无法确定落地文件名".to_string());
    }
    for src in sources {
        let dest_path = if dest.ends_with('/') || sources.len() > 1 {
            join_remote(&dest, basename(src))
        } else {
            dest.clone()
        };
        push_change(changes, Operation::Modify, &dest_path, cwd)?;
    }
    Ok(())
}

/// install [OPTION]... SOURCE DEST / install -t DIR SOURCE... / install -d DIR...。
fn handle_install(words: &[String], cwd: &str, changes: &mut Vec<FileChange>) -> Result<(), String> {
    let mut args: Vec<String> = Vec::new();
    let mut i = 1;
    let mut dest_dir: Option<String> = None;
    while i < words.len() {
        let w = &words[i];
        if w == "-t" || w == "--target-directory" {
            dest_dir = words.get(i + 1).cloned().map(|d| d.trim_end_matches('/').to_string());
            i += 2;
            continue;
        }
        if w == "-d" || w == "--directory" {
            return Ok(()); // 仅创建目录，无文件内容影响
        }
        // 带取值选项：-m MODE -o OWNER -g GROUP（跳过取值）；其余无取值（-s -p -b -D -C -v）
        if matches!(w.as_str(), "-m" | "-o" | "-g") {
            i += 2;
            continue;
        }
        if matches!(w.as_str(), "-s" | "-p" | "-b" | "-D" | "-C" | "-v") {
            i += 1;
            continue;
        }
        if w == "-" {
            i += 1;
            continue;
        }
        if w.starts_with('-') && w.len() > 1 {
            i += 1;
            continue;
        }
        args.push(w.clone());
        i += 1;
    }
    if args.is_empty() {
        return Ok(());
    }
    if let Some(dir) = &dest_dir {
        for src in &args {
            push_change(changes, Operation::Modify, &join_remote(dir, basename(src)), cwd)?;
        }
        return Ok(());
    }
    if args.len() < 2 {
        return Ok(());
    }
    let dest = args.last().unwrap().clone();
    let sources = &args[..args.len() - 1];
    if sources.len() > 1 {
        return Err("install 多源且无 -t 目标目录，无法确定落地文件名".to_string());
    }
    push_change(changes, Operation::Modify, &dest, cwd)?;
    Ok(())
}

/// 解析 cd 目标：返回新 cwd（规范化绝对路径）；无法静态确定返回 Err。
fn resolve_cd(words: &[String], cwd: &str) -> Result<String, String> {
    let mut i = 1;
    if words.get(i).map(String::as_str) == Some("--") {
        i += 1;
    }
    let target = match words.get(i) {
        Some(t) => t,
        None => return Err("cd 无参数（回 home），目录无法静态确定".to_string()),
    };
    if target == "-" || target == "~" || target == "~/" {
        return Err("cd 目标依赖 shell 状态（- / ~），无法静态确定".to_string());
    }
    if is_dynamic(target) {
        return Err(format!("cd 目标包含变量/命令替换/通配符：{target}"));
    }
    let joined = if target.starts_with('/') {
        target.clone()
    } else {
        format!("{}/{}", cwd.trim_end_matches('/'), target)
    };
    Ok(normalize_abs(&joined))
}

/// 确定性分析入口：给定完整命令与初始 cwd（绝对路径），返回影响计划。
/// 纯函数（无网络/磁盘访问），供审批、执行前快照与单测复用。
pub fn analyze_remote_command(command: &str, cwd: &str) -> ImpactPlan {
    let mut cur_cwd = cwd.trim().to_string();
    let mut changes: Vec<FileChange> = Vec::new();
    let mut unbounded_reason: Option<String> = None;
    let segments = tokenize(command);
    for seg in &segments {
        let words = &seg.words;
        if words.is_empty() {
            continue;
        }
        let first = words[0].as_str();
        if first == "cd" {
            if !seg.after_pipe {
                match resolve_cd(words, &cur_cwd) {
                    Ok(new_cwd) => cur_cwd = new_cwd,
                    Err(reason) => {
                        if unbounded_reason.is_none() {
                            unbounded_reason = Some(reason);
                        }
                    }
                }
            } else if resolve_cd(words, &cur_cwd).is_err() && unbounded_reason.is_none() {
                // 管道子 shell 中的 cd：不传播，但目标可疑仍标 unbounded
                unbounded_reason = Some("管道子 shell 中 cd 目标无法静态确定".to_string());
            }
            continue;
        }
        match analyze_statement(words, &cur_cwd) {
            Ok(mut stmt_changes) => changes.append(&mut stmt_changes),
            Err(reason) => {
                if unbounded_reason.is_none() {
                    unbounded_reason = Some(reason);
                }
            }
        }
    }
    if let Some(reason) = unbounded_reason {
        ImpactPlan::unbounded(&format!("{reason}；不保证完整备份"))
    } else if changes.is_empty() {
        ImpactPlan::none("未识别到远程文件写入操作")
    } else {
        ImpactPlan::bounded(changes, "已识别完整写入范围，执行前将逐文件备份")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(command: &str, cwd: &str) -> ImpactPlan {
        analyze_remote_command(command, cwd)
    }

    #[test]
    fn cd_redirect_example_produces_absolute_modify() {
        // 需求验收：cd /var/www/app && : > config.json → 单个绝对 modify /var/www/app/config.json
        let p = plan("cd /var/www/app && : > config.json", "/root");
        assert_eq!(p.effect, Effect::Bounded, "应 bounded: {:?}", p);
        assert_eq!(p.changes.len(), 1, "应恰好一个变更: {:?}", p.changes);
        assert_eq!(p.changes[0].operation, Operation::Modify);
        assert_eq!(p.changes[0].path, "/var/www/app/config.json");
    }

    #[test]
    fn relative_path_resolves_against_cwd() {
        let p = plan("echo hi > logs/app.log", "/srv/portal");
        assert_eq!(p.effect, Effect::Bounded);
        assert_eq!(p.changes[0].path, "/srv/portal/logs/app.log");
    }

    #[test]
    fn dynamic_cd_is_unbounded() {
        // 需求验收：动态 cd "$APP_DIR" → unbounded，不得猜路径
        assert_eq!(plan("cd \"$APP_DIR\" && : > config.json", "/root").effect, Effect::Unbounded);
        assert_eq!(plan("cd $APP_DIR && rm config.json", "/root").effect, Effect::Unbounded);
        assert_eq!(plan("cd ~ && : > f", "/root").effect, Effect::Unbounded);
        assert_eq!(plan("cd && : > f", "/root").effect, Effect::Unbounded);
        assert_eq!(plan("cd - && : > f", "/root").effect, Effect::Unbounded);
    }

    #[test]
    fn redirect_variants() {
        // 追加、fd、&>、>|、2> 目标
        let p = plan("echo x >> /var/log/app.log", "/");
        assert_eq!(p.changes[0].path, "/var/log/app.log");
        let p = plan("echo x 2>/tmp/err.txt", "/");
        assert_eq!(p.changes[0].path, "/tmp/err.txt");
        let p = plan("echo x &> /tmp/both.log", "/");
        assert_eq!(p.changes[0].path, "/tmp/both.log");
        let p = plan("echo x >| /tmp/over.txt", "/");
        assert_eq!(p.changes[0].path, "/tmp/over.txt");
        // fd 重定向 2>&1 不产生文件变更
        let p = plan("echo x > /tmp/a.txt 2>&1", "/");
        assert_eq!(p.changes.len(), 1);
        // 输入重定向 / heredoc 不产生变更
        let p = plan("cat < /etc/hosts", "/");
        assert_eq!(p.changes.len(), 0);
        let p = plan("mysql db <<EOF\nSELECT 1;\nEOF", "/");
        assert_eq!(p.changes.len(), 0);
        // /dev/null 等伪 fs 不产生变更
        let p = plan("echo x > /dev/null", "/");
        assert_eq!(p.effect, Effect::None, "写 /dev/null 不应备份: {:?}", p);
        let p = plan("echo x > /proc/1/status", "/");
        assert_eq!(p.effect, Effect::None);
    }

    #[test]
    fn tools_tee_sed_perl_truncate() {
        let p = plan("echo hi | tee /var/www/app/config.json", "/root");
        assert_eq!(p.effect, Effect::Bounded);
        assert_eq!(p.changes[0].path, "/var/www/app/config.json");
        // tee 无文件参数 → stdout
        let p = plan("echo hi | tee", "/");
        assert_eq!(p.effect, Effect::None);

        let p = plan("sed -i 's/x/y/' /etc/app.conf", "/");
        assert_eq!(p.changes[0].path, "/etc/app.conf");
        let p = plan("sed -i.bak s/x/y/g /etc/app.conf", "/");
        assert_eq!(p.changes[0].path, "/etc/app.conf");
        let p = plan("sed -i -e 's/a/b/' -e 's/c/d/' /etc/a.conf /etc/b.conf", "/");
        assert_eq!(p.changes.len(), 2);
        assert_eq!(p.changes[1].path, "/etc/b.conf");
        // sed 无 -i：读不改
        let p = plan("sed 's/x/y/' /etc/app.conf", "/");
        assert_eq!(p.effect, Effect::None);

        let p = plan("perl -pi -e 's/x/y/' /etc/app.conf", "/");
        assert_eq!(p.changes[0].path, "/etc/app.conf");
        let p = plan("perl -i -pe 's/x/y/' /etc/app.conf", "/");
        assert_eq!(p.changes[0].path, "/etc/app.conf");
        // perl 无 -i：外部脚本 → unbounded
        assert_eq!(plan("perl script.pl /etc/x", "/").effect, Effect::Unbounded);

        let p = plan("truncate -s 0 /var/log/app.log", "/");
        assert_eq!(p.changes[0].path, "/var/log/app.log");
        let p = plan("truncate -s 1024 /tmp/a /tmp/b", "/");
        assert_eq!(p.changes.len(), 2);
    }

    #[test]
    fn tools_rm_mv_cp_install() {
        let p = plan("rm /var/log/old.log", "/");
        assert_eq!(p.changes[0].operation, Operation::Delete);
        assert_eq!(p.changes[0].path, "/var/log/old.log");
        // 递归删除 → unbounded
        assert_eq!(plan("rm -rf /var/log/app", "/").effect, Effect::Unbounded);
        assert_eq!(plan("rm -r /var/www", "/").effect, Effect::Unbounded);

        let p = plan("mv /etc/a.conf /etc/b.conf", "/");
        assert_eq!(p.changes[0].operation, Operation::Rename);
        assert_eq!(p.changes[0].path, "/etc/a.conf");
        assert_eq!(p.changes[0].destination.as_deref(), Some("/etc/b.conf"));
        // 移动到目录（尾斜杠）：落地名 = 目录 + 源文件名
        let p = plan("mv /tmp/out.txt /var/backup/", "/");
        assert_eq!(p.changes[0].destination.as_deref(), Some("/var/backup/out.txt"));
        // mv -t
        let p = plan("mv -t /var/backup /tmp/a.txt", "/");
        assert_eq!(p.changes[0].destination.as_deref(), Some("/var/backup/a.txt"));

        let p = plan("cp /etc/a.conf /etc/b.conf", "/");
        assert_eq!(p.changes[0].operation, Operation::Modify);
        assert_eq!(p.changes[0].path, "/etc/b.conf");
        assert_eq!(plan("cp -r /var/www /backup", "/").effect, Effect::Unbounded);
        let p = plan("cp /etc/a.conf /backup/", "/");
        assert_eq!(p.changes[0].path, "/backup/a.conf");

        let p = plan("install -m 755 /tmp/app /usr/local/bin/app", "/");
        assert_eq!(p.changes[0].path, "/usr/local/bin/app");
        let p = plan("install -t /opt/bin /tmp/tool", "/");
        assert_eq!(p.changes[0].path, "/opt/bin/tool");
        let p = plan("install -d /var/lib/new", "/");
        assert_eq!(p.effect, Effect::None);
    }

    #[test]
    fn dynamic_and_scripts_and_loops_unbounded() {
        assert_eq!(plan("rm $FILE", "/").effect, Effect::Unbounded);
        assert_eq!(plan("rm \"$FILE\"", "/").effect, Effect::Unbounded);
        assert_eq!(plan("rm $(cat list)", "/").effect, Effect::Unbounded);
        assert_eq!(plan("rm /var/log/app/*.log", "/").effect, Effect::Unbounded);
        assert_eq!(plan("rm /var/log/app/[ab].log", "/").effect, Effect::Unbounded);
        assert_eq!(plan("bash deploy.sh", "/").effect, Effect::Unbounded);
        assert_eq!(plan("./deploy.sh", "/").effect, Effect::Unbounded);
        assert_eq!(plan("python3 /srv/scripts/migrate.py", "/").effect, Effect::Unbounded);
        assert_eq!(plan("for f in /var/log/*.log; do : > \"$f\"; done", "/").effect, Effect::Unbounded);
        assert_eq!(plan("while true; do : > /tmp/x; done", "/").effect, Effect::Unbounded);
        assert_eq!(plan("(cd /tmp && echo x > f)", "/").effect, Effect::Unbounded);
    }

    #[test]
    fn unknown_read_only_commands_are_none() {
        // 常规只读/无文件写入命令：none（直接执行，不备份）
        for cmd in [
            "ls -la /var/log",
            "cat /etc/app.conf",
            "grep error /var/log/app.log",
            "df -h",
            "systemctl status nginx",
            "awk -F: '{print $1}' /etc/passwd",
            "git status",
            "echo hello",
        ] {
            assert_eq!(plan(cmd, "/root").effect, Effect::None, "应 none: {cmd}");
        }
    }

    #[test]
    fn quoting_preserved_and_comment_ignored() {
        let p = plan("echo 'hi there' > '/var/www/my file.txt'", "/");
        assert_eq!(p.changes[0].path, "/var/www/my file.txt");
        // 词中 # 是普通字符；行首 # 是注释
        let p = plan("echo x > /tmp/a#b.txt", "/");
        assert_eq!(p.changes[0].path, "/tmp/a#b.txt");
        let p = plan("echo x > /tmp/ok.txt # comment", "/");
        assert_eq!(p.changes.len(), 1);
        assert_eq!(p.changes[0].path, "/tmp/ok.txt");
        let p = plan("# only comment", "/");
        assert_eq!(p.effect, Effect::None);
    }

    #[test]
    fn cd_propagates_across_separators_not_pipes() {
        // cd 经 && 传播；经管道不传播（子 shell）
        let p = plan("cd /a && : > f.txt; echo x > g.txt", "/root");
        assert_eq!(p.changes[0].path, "/a/f.txt");
        assert_eq!(p.changes[1].path, "/a/g.txt");
        let p = plan("cd /a | cat > f.txt", "/root");
        assert_eq!(p.changes[0].path, "/root/f.txt", "管道右侧用原 cwd");
        let p = plan("cd /a; : > f.txt", "/root");
        assert_eq!(p.changes[0].path, "/a/f.txt");
        // cd 后接相对 cd
        let p = plan("cd /var/www && cd app && : > config.json", "/root");
        assert_eq!(p.changes[0].path, "/var/www/app/config.json");
    }

    #[test]
    fn normalize_and_parent_dots() {
        let p = plan("echo x > /var/www/../etc/app.conf", "/");
        assert_eq!(p.changes[0].path, "/var/etc/app.conf");
        let p = plan("echo x > ./a/../b.txt", "/tmp");
        assert_eq!(p.changes[0].path, "/tmp/b.txt");
    }

    #[test]
    fn validate_plan_rules() {
        let ok = ImpactPlan::bounded(
            vec![FileChange { operation: Operation::Modify, path: "/a/b".into(), destination: None }],
            "x",
        );
        assert!(validate_impact_plan(&ok).is_ok());
        // bounded 无 changes → Err
        assert!(validate_impact_plan(&ImpactPlan::bounded(vec![], "x")).is_err());
        // 非绝对路径 → Err
        let rel = ImpactPlan::bounded(
            vec![FileChange { operation: Operation::Modify, path: "a/b".into(), destination: None }],
            "x",
        );
        assert!(validate_impact_plan(&rel).is_err());
        // rename 缺 destination → Err
        let bad_rename = ImpactPlan::bounded(
            vec![FileChange { operation: Operation::Rename, path: "/a".into(), destination: None }],
            "x",
        );
        assert!(validate_impact_plan(&bad_rename).is_err());
        // none 携带 changes → Err
        let bad_none = ImpactPlan { effect: Effect::None, changes: vec![FileChange { operation: Operation::Modify, path: "/a".into(), destination: None }], reason: "x".into() };
        assert!(validate_impact_plan(&bad_none).is_err());
        // none / unbounded 空 changes 合法
        assert!(validate_impact_plan(&ImpactPlan::none("x")).is_ok());
        assert!(validate_impact_plan(&ImpactPlan::unbounded("x")).is_ok());
    }

    #[test]
    fn merge_takes_severity_max_and_unions_changes() {
        let d = ImpactPlan::bounded(
            vec![FileChange { operation: Operation::Modify, path: "/a".into(), destination: None }],
            "d",
        );
        let l = ImpactPlan::bounded(
            vec![
                FileChange { operation: Operation::Modify, path: "/a".into(), destination: None },
                FileChange { operation: Operation::Modify, path: "/b".into(), destination: None },
            ],
            "l",
        );
        let m = merge_plans(&d, &l);
        assert_eq!(m.effect, Effect::Bounded);
        assert_eq!(m.changes.len(), 2, "并集去重: {:?}", m.changes);
        // none + bounded → bounded
        let m2 = merge_plans(&ImpactPlan::none("n"), &d);
        assert_eq!(m2.effect, Effect::Bounded);
        assert_eq!(m2.changes.len(), 1);
        // unbounded 永不降级
        let m3 = merge_plans(&ImpactPlan::unbounded("u"), &d);
        assert_eq!(m3.effect, Effect::Unbounded);
        let m4 = merge_plans(&d, &ImpactPlan::unbounded("u"));
        assert_eq!(m4.effect, Effect::Unbounded);
    }
}

