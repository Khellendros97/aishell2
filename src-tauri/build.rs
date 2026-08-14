fn main() {
    // tauri-build 的 rerun-if-changed 不含 icons/：替换图标后若不声明，
    // 旧 resource.lib 会被复用，exe 仍嵌入旧图标（踩过坑）
    println!("cargo:rerun-if-changed=icons");
    // 云平台接入（CR-1.8）：构建期注入服务器地址与 OAuth 应用凭据。
    // 取值顺序：环境变量 → 项目根按构建档位选择 env 文件（gitignore 本地文件，
    // 供 VS Code 集成终端等读不到 setx 新变量的场景）：
    //   debug 构建（tauri dev）  → dev.env
    //   release 构建（tauri build）→ release.env
    // 两者都缺失 → 云功能隐藏。
    // client_secret 内嵌二进制是 PKCE 上线前的过渡（服务端暂未实现 PKCE，
    // 见 docs/AIShell云服务-OAuth2接入文档.md §7）；换构建 = 换凭据，客户端无修改入口。
    // 两个 env 文件都声明 rerun-if-changed：改文件后增量构建必须重新注入（坑：不声明则复用旧值）
    println!("cargo:rerun-if-changed=../dev.env");
    println!("cargo:rerun-if-changed=../release.env");
    let env_file = if std::env::var("PROFILE").map(|p| p == "release").unwrap_or(false) {
        "../release.env"
    } else {
        "../dev.env"
    };
    for var in [
        "AISHELL_SERVER_URL",
        "AISHELL_CLIENT_ID",
        "AISHELL_CLIENT_SECRET",
    ] {
        println!("cargo:rerun-if-env-changed={var}");
        let val = std::env::var(var)
            .ok()
            .filter(|v| !v.trim().is_empty())
            .or_else(|| read_env_file(env_file, var))
            .filter(|v| !v.trim().is_empty());
        if let Some(v) = val {
            println!("cargo:rustc-env={var}={v}");
        }
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
