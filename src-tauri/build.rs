fn main() {
    // tauri-build 的 rerun-if-changed 不含 icons/：替换图标后若不声明，
    // 旧 resource.lib 会被复用，exe 仍嵌入旧图标（踩过坑）
    println!("cargo:rerun-if-changed=icons");
    // 云平台接入（CR-1.8）：构建期注入服务器地址与 OAuth 应用凭据。
    // 三者任一缺失 → 云功能整体隐藏，应用行为与未接入一致。
    // client_secret 内嵌二进制是 PKCE 上线前的过渡（服务端暂未实现 PKCE，
    // 见 docs/AIShell云服务-OAuth2接入文档.md §7）；换构建 = 换凭据，客户端无修改入口。
    for var in [
        "AISHELL_SERVER_URL",
        "AISHELL_CLIENT_ID",
        "AISHELL_CLIENT_SECRET",
    ] {
        println!("cargo:rerun-if-env-changed={var}");
        if let Ok(val) = std::env::var(var) {
            if !val.trim().is_empty() {
                println!("cargo:rustc-env={var}={val}");
            }
        }
    }
    tauri_build::build()
}
