fn main() {
    // tauri-build compiles icons/icon.ico into Windows resource.lib without
    // emitting rerun-if-changed for icons/, so Cargo can link a stale icon
    // after icons are regenerated on incremental or cached CI builds.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/32x32.png");
    println!("cargo:rerun-if-changed=icons/128x128.png");
    println!("cargo:rerun-if-changed=icons/128x128@2x.png");
    println!("cargo:rerun-if-changed=windows/hooks.nsh");
    tauri_build::build()
}
