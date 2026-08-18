fn main() {
    let manifest = tauri_build::AppManifest::new().commands(&["host_invoke", "desktop_events"]);
    let attributes = tauri_build::Attributes::new().app_manifest(manifest);

    if let Err(error) = tauri_build::try_build(attributes) {
        eprintln!("failed to build Tauri application: {error:#}");
        std::process::exit(1);
    }
}
