use std::{env, fs};
use zed_extension_api::{
    self as zed, ContextServerId, LanguageServerId, Project, Result, Worktree, serde_json,
    settings::LspSettings,
};

const PACKAGE_NAME: &str = "@knip/language-server";
const MCP_PACKAGE_NAME: &str = "@knip/mcp";
const SERVER_PATH: &str = "node_modules/@knip/language-server/src/cli.js";
const MCP_SERVER_PATH: &str = "node_modules/@knip/mcp/src/cli.js";
const WRAPPER_PATH: &str = "wrapper.mjs";

// Embed the custom LSP wrapper into the WASM binary at compile time
const WRAPPER_CONTENT: &str = include_str!("wrapper.mjs");

struct KnipExtension {
    did_find_server: bool,
    did_find_mcp: bool,
}

impl KnipExtension {
    fn server_exists(&self) -> bool {
        fs::metadata(SERVER_PATH).is_ok_and(|stat| stat.is_file())
    }

    fn mcp_exists(&self) -> bool {
        fs::metadata(MCP_SERVER_PATH).is_ok_and(|stat| stat.is_file())
    }

    // Strip leading slash from WASI paths on Windows (e.g. "/C:/..." -> "C:/...")
    fn normalize_windows_path(path: String) -> String {
        if zed::current_platform().0 == zed::Os::Windows && path.starts_with('/') {
            path.trim_start_matches('/').to_string()
        } else {
            path
        }
    }

    // Resolve a relative path inside Zed's extension work directory to a host path for Node.js
    fn abs_path(rel_path: &str) -> String {
        let path = env::current_dir()
            .unwrap()
            .join(rel_path)
            .to_string_lossy()
            .to_string();
        Self::normalize_windows_path(path)
    }

    // Install or update @knip/language-server and write the embedded wrapper script
    fn server_script_path(&mut self, language_server_id: &LanguageServerId) -> Result<String> {
        let server_exists = self.server_exists();
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
                    Err(error) if !self.server_exists() => return Err(error),
                    _ => {}
                }
            }
            self.did_find_server = true;
        }

        fs::write(WRAPPER_PATH, WRAPPER_CONTENT)
            .map_err(|e| format!("Failed to write wrapper.mjs: {e}"))?;

        Ok(Self::abs_path(WRAPPER_PATH))
    }

    // Install or update @knip/mcp for Zed's AI agent context server
    fn mcp_script_path(&mut self) -> Result<String> {
        let mcp_exists = self.mcp_exists();
        if !self.did_find_mcp || !mcp_exists {
            let version = zed::npm_package_latest_version(MCP_PACKAGE_NAME)?;

            if !mcp_exists
                || zed::npm_package_installed_version(MCP_PACKAGE_NAME)?.as_ref() != Some(&version)
            {
                match zed::npm_install_package(MCP_PACKAGE_NAME, &version) {
                    Err(error) if !self.mcp_exists() => return Err(error),
                    _ => {}
                }
            }
            self.did_find_mcp = true;
        }

        Ok(Self::abs_path(MCP_SERVER_PATH))
    }
}

impl zed::Extension for KnipExtension {
    fn new() -> Self {
        Self {
            did_find_server: false,
            did_find_mcp: false,
        }
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
            env: Default::default(),
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

    fn context_server_command(
        &mut self,
        _context_server_id: &ContextServerId,
        _project: &Project,
    ) -> Result<zed::Command> {
        let mcp_path = self.mcp_script_path()?;

        Ok(zed::Command {
            command: zed::node_binary_path()?,
            args: vec![mcp_path],
            env: Default::default(),
        })
    }
}

zed::register_extension!(KnipExtension);
