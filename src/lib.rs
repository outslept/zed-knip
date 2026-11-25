use std::env;
use std::fs;
use zed_extension_api::serde_json;
use zed_extension_api::settings::LspSettings;
use zed_extension_api::{self as zed, LanguageServerId, Result, Worktree};

const PACKAGE_NAME: &str = "@knip/language-server";
const SERVER_PATH: &str = "node_modules/@knip/language-server/src/cli.js";
const WRAPPER_PATH: &str = "wrapper.mjs";

// Embed the custom LSP wrapper into the WASM binary at compile time
const WRAPPER_CONTENT: &str = include_str!("wrapper.mjs");

fn file_exists(path: &str) -> bool {
    fs::metadata(path).is_ok_and(|stat| stat.is_file())
}

// Resolve a relative path inside Zed's extension work directory to a host path for Node.js
fn abs_path(rel_path: &str) -> Result<String> {
    let dir = env::current_dir().map_err(|e| format!("failed to get current directory: {e}"))?;
    let path = dir.join(rel_path);
    let path_str = path.to_string_lossy();

    // Strip leading slash from WASI paths on Windows (e.g. "/C:/..." -> "C:/...")
    if zed::current_platform().0 == zed::Os::Windows {
        Ok(path_str.trim_start_matches('/').to_string())
    } else {
        Ok(path_str.into_owned())
    }
}

#[derive(Default)]
struct KnipExtension {
    did_find_server: bool,
}

impl KnipExtension {
    // Install or update @knip/language-server and write the embedded wrapper script
    fn server_script_path(&mut self, language_server_id: &LanguageServerId) -> Result<String> {
        let server_exists = file_exists(SERVER_PATH);
        if !self.did_find_server || !server_exists {
            zed::set_language_server_installation_status(
                language_server_id,
                &zed::LanguageServerInstallationStatus::CheckingForUpdate,
            );

            let version = zed::npm_package_latest_version(PACKAGE_NAME)?;

            if !server_exists
                || zed::npm_package_installed_version(PACKAGE_NAME)?.as_ref() != Some(&version)
            {
                zed::set_language_server_installation_status(
                    language_server_id,
                    &zed::LanguageServerInstallationStatus::Downloading,
                );
                // Fall back to existing installation if npm install fails (e.g. offline)
                match zed::npm_install_package(PACKAGE_NAME, &version) {
                    Err(error) if !file_exists(SERVER_PATH) => return Err(error),
                    _ => {}
                }
            }
            self.did_find_server = true;
        }

        if fs::read_to_string(WRAPPER_PATH).ok().as_deref() != Some(WRAPPER_CONTENT) {
            fs::write(WRAPPER_PATH, WRAPPER_CONTENT)
                .map_err(|e| format!("failed to write {WRAPPER_PATH}: {e}"))?;
        }

        abs_path(WRAPPER_PATH)
    }
}

impl zed::Extension for KnipExtension {
    fn new() -> Self {
        Self::default()
    }

    fn language_server_command(
        &mut self,
        language_server_id: &LanguageServerId,
        _worktree: &Worktree,
    ) -> Result<zed::Command> {
        let wrapper_path = self.server_script_path(language_server_id)?;
        Ok(zed::Command {
            command: zed::node_binary_path()?,
            args: vec![wrapper_path, "--stdio".to_string()],
            env: Vec::new(),
        })
    }

    // Forward lsp.knip.initialization_options (e.g. custom cwd) from Zed settings
    fn language_server_initialization_options(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &Worktree,
    ) -> Result<Option<serde_json::Value>> {
        let settings = LspSettings::for_worktree(language_server_id.as_ref(), worktree)
            .ok()
            .and_then(|s| s.initialization_options);
        Ok(settings)
    }

    // Forward lsp.knip.settings to workspace/configuration requests from the server
    fn language_server_workspace_configuration(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &Worktree,
    ) -> Result<Option<serde_json::Value>> {
        let settings = LspSettings::for_worktree(language_server_id.as_ref(), worktree)
            .ok()
            .and_then(|s| s.settings)
            .unwrap_or_else(|| serde_json::json!({}));
        Ok(Some(settings))
    }
}

zed::register_extension!(KnipExtension);
