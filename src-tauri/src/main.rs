// 阻止 release 版在 Windows 上额外弹出控制台窗口，勿删!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    aishell_lib::run();
}
