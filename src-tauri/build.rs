/// 声明 build 输入：`rerun-if-changed` 指向**不存在的文件**时 cargo 会把它当作永久脏，
/// 每次 cargo build/test 都重跑本脚本 → 整个 crate 重编（本地缺 dev.env 时踩过：
/// 零改动也要 3 分钟）。所以只对存在的文件声明。
/// 副作用：之后**新建** dev.env 不会自动触发重新注入，需 `touch src-tauri/build.rs`
/// 或 `cargo clean -p aishell` 一次（这是刻意取舍——目录兜底不可行：cargo 对目录做
/// 递归扫描，仓库根含 target/ 时永远有更新的文件，指纹反而永久脏）。
fn rerun_if_exists(path: &str) {
    if std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(path).exists() {
        println!("cargo:rerun-if-changed={path}");
    }
}

fn main() {
    // tauri-build 的 rerun-if-changed 不含 icons/：替换图标后若不声明，
    // 旧 resource.lib 会被复用，exe 仍嵌入旧图标（踩过坑）
    println!("cargo:rerun-if-changed=icons");
    // 云平台接入（CR-1.8）：构建期注入服务器地址与 OAuth 应用凭据。
    // 取值顺序：
    //   debug 构建（tauri dev）  → dev.env（开发配置优先，避免用户环境中的生产地址污染本地登录）
    //   release 构建（tauri build）→ 环境变量 → release.env
    //   环境变量 AISHELL_ENV_FILE → 覆盖上述默认文件（`npm run tauri dev --env <文件>`，
    //     scripts/tauri.mjs 写入；值为仓库根相对路径，debug/release 均生效）
    // 两者都缺失 → 云功能隐藏（仅 debug；release 缺失直接 panic，见下方门禁）。
    // client_secret 内嵌二进制是 PKCE 上线前的过渡（服务端暂未实现 PKCE，
    // 见 docs/AIShell云服务-OAuth2接入文档.md §7）；换构建 = 换凭据，客户端无修改入口。
    // 两个 env 文件都声明 rerun-if-changed：改文件后增量构建必须重新注入（坑：不声明则复用旧值）；
    // 但必须判断存在性——指向不存在文件的 rerun-if-changed 会让脚本永久脏（见 rerun_if_exists）
    rerun_if_exists("../dev.env");
    rerun_if_exists("../release.env");
    // --env 切换的文件同理：不声明则改文件后增量构建仍复用旧值
    println!("cargo:rerun-if-env-changed=AISHELL_ENV_FILE");
    let is_release = std::env::var("PROFILE")
        .map(|p| p == "release")
        .unwrap_or(false);
    let env_file: String = match std::env::var("AISHELL_ENV_FILE") {
        Ok(v) if !v.trim().is_empty() => {
            let f = v.trim().trim_start_matches("./").to_string();
            rerun_if_exists(&format!("../{f}"));
            format!("../{f}")
        }
        _ if is_release => "../release.env".to_string(),
        _ => "../dev.env".to_string(),
    };
    for var in [
        "AISHELL_SERVER_URL",
        "AISHELL_CLIENT_ID",
        "AISHELL_CLIENT_SECRET",
    ] {
        println!("cargo:rerun-if-env-changed={var}");
        let from_env = std::env::var(var).ok().filter(|v| !v.trim().is_empty());
        let from_file = read_env_file(&env_file, var);
        let val = if is_release {
            from_env.or(from_file)
        } else {
            from_file.or(from_env)
        };
        // 0.5.2 的坑：CI 只注入了 SERVER_URL，client 凭据缺失被静默跳过，
        // 装机后才报「当前构建未配置云服务」。release 包三变量缺一即硬失败，
        // 把问题拦在构建期；debug 允许缺省（CI 的 cargo test 无 dev.env，
        // 本地未配时仅隐藏云功能）。
        let Some(v) = val else {
            if is_release {
                panic!(
                    "release 构建缺少 {var}：请通过环境变量或 {env_file} 提供 \
                     （CI 需在仓库 Secrets 配置同名值并传入构建任务）"
                );
            }
            continue;
        };
        println!("cargo:rustc-env={var}={v}");
    }
    tauri_build::build()
}

/// 从项目根 env 文件读取 KEY=VALUE（# 注释；进程环境变量缺失时兜底）。
fn read_env_file(file: &str, key: &str) -> Option<String> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(file);
    let text = std::fs::read_to_string(path).ok()?;
    for line in text.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        let (k, v) = t.split_once('=')?;
        if k.trim() == key {
            let v = v.trim();
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}
