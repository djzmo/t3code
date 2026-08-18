#![forbid(unsafe_code)]

fn main() {
    let result = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![])
        .run(tauri::generate_context!());

    if let Err(error) = result {
        eprintln!("failed to run Agent Nanoni: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    #[test]
    fn capability_is_scoped_to_main_webview() {
        let capability: Value =
            serde_json::from_str(include_str!("../capabilities/main.json")).expect("valid JSON");

        assert_eq!(capability["identifier"], "main");
        assert_eq!(capability["webviews"], serde_json::json!(["main"]));
        assert!(
            capability["permissions"]
                .as_array()
                .is_some_and(|permissions| permissions
                    .iter()
                    .any(|permission| permission == "allow-host-invoke"))
        );
    }

    #[test]
    fn capability_does_not_grant_remote_webview_access() {
        let capability: Value =
            serde_json::from_str(include_str!("../capabilities/main.json")).expect("valid JSON");

        assert!(
            capability["webviews"]
                .as_array()
                .is_some_and(|webviews| webviews.iter().all(|webview| webview == "main"))
        );
        assert!(!capability["windows"].is_array());
    }
}
