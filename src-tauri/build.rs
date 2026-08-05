fn main() {
    // tauri-build 的 rerun-if-changed 不含 icons/：替换图标后若不声明，
    // 旧 resource.lib 会被复用，exe 仍嵌入旧图标（踩过坑）
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
