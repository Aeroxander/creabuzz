use std::ffi::OsString;
use std::path::{Path, PathBuf};

pub(crate) const PAPERCLIP_PROGRAM: &str = "paperclipai";
pub(crate) const PAPERCLIP_INSTANCE_ID: &str = "buzz-desktop";
pub(crate) const PAPERCLIP_HOME_DIRNAME: &str = "paperclip";
pub(crate) const PAPERCLIP_CONFIG_BASENAME: &str = "config.json";
pub(crate) const PAPERCLIP_RUNTIME_INFO_BASENAME: &str = "runtime-info.json";
pub(crate) const PAPERCLIP_LOG_BASENAME: &str = "paperclip.log";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PaperclipPaths {
    pub home_dir: PathBuf,
    pub config_path: PathBuf,
    pub runtime_info_path: PathBuf,
    pub log_path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PaperclipLaunchCommand {
    pub program: PathBuf,
    pub args: Vec<OsString>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PaperclipRuntimeInfo {
    pub pid: u32,
    pub host: String,
    pub port: u16,
    pub dashboard_url: String,
}

pub(crate) fn paperclip_paths(app_data_dir: &Path) -> Result<PaperclipPaths, String> {
    if app_data_dir.as_os_str().is_empty() {
        return Err("Buzz app data directory is unavailable".to_string());
    }
    let home_dir = app_data_dir.join(PAPERCLIP_HOME_DIRNAME);
    let instance_root = home_dir.join("instances").join(PAPERCLIP_INSTANCE_ID);
    Ok(PaperclipPaths {
        config_path: instance_root.join(PAPERCLIP_CONFIG_BASENAME),
        runtime_info_path: instance_root.join(PAPERCLIP_RUNTIME_INFO_BASENAME),
        log_path: instance_root.join(PAPERCLIP_LOG_BASENAME),
        home_dir,
    })
}

pub(crate) fn paperclip_onboard_command(
    program: &Path,
    paths: &PaperclipPaths,
) -> PaperclipLaunchCommand {
    PaperclipLaunchCommand {
        program: program.to_path_buf(),
        args: vec![
            OsString::from("onboard"),
            OsString::from("--yes"),
            OsString::from("--config"),
            paths.config_path.as_os_str().to_os_string(),
            OsString::from("--data-dir"),
            paths.home_dir.as_os_str().to_os_string(),
            OsString::from("--bind"),
            OsString::from("loopback"),
            OsString::from("--no-install-service"),
        ],
    }
}

pub(crate) fn is_loopback_host(host: &str) -> bool {
    let normalized = host.trim().to_ascii_lowercase();
    matches!(
        normalized.as_str(),
        "localhost" | "127.0.0.1" | "::1" | "[::1]"
    )
}

pub(crate) fn local_app_url(host: &str, port: u16) -> Option<String> {
    if port == 0 || !is_loopback_host(host) {
        return None;
    }
    let host = host.trim();
    let host = if host.eq_ignore_ascii_case("localhost") {
        "127.0.0.1"
    } else {
        host
    };
    let host = if host == "::1" || host == "[::1]" {
        "[::1]"
    } else {
        host
    };
    Some(format!("http://{host}:{port}"))
}

pub(crate) fn local_health_url(host: &str, port: u16) -> Option<String> {
    local_app_url(host, port).map(|url| format!("{url}/api/health"))
}

pub(crate) fn parse_runtime_info(text: &str) -> Option<PaperclipRuntimeInfo> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    let record = value.as_object()?;
    if record.get("schemaVersion")?.as_u64()? != 1 {
        return None;
    }
    if record.get("instanceId")?.as_str()? != PAPERCLIP_INSTANCE_ID {
        return None;
    }
    let pid = record.get("pid")?.as_u64()?;
    let port = record.get("port")?.as_u64()?;
    let host = record.get("host")?.as_str()?;
    let dashboard_url = record.get("dashboardUrl")?.as_str()?;
    let started_at = record.get("startedAt")?.as_str()?;
    if pid == 0 || pid > u32::MAX as u64 {
        return None;
    }
    if port == 0 || port > u16::MAX as u64 {
        return None;
    }
    if host.trim().is_empty() || dashboard_url.trim().is_empty() || started_at.trim().is_empty() {
        return None;
    }
    Some(PaperclipRuntimeInfo {
        pid: pid as u32,
        host: host.to_string(),
        port: port as u16,
        dashboard_url: dashboard_url.to_string(),
    })
}

pub(crate) fn read_runtime_info(path: &Path) -> Option<PaperclipRuntimeInfo> {
    let text = std::fs::read_to_string(path).ok()?;
    parse_runtime_info(&text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime_info_json(pid: u64, instance: &str) -> String {
        serde_json::json!({
            "schemaVersion": 1,
            "instanceId": instance,
            "pid": pid,
            "host": "127.0.0.1",
            "port": 3100,
            "dashboardUrl": "http://127.0.0.1:3100",
            "startedAt": "2026-01-01T00:00:00Z"
        })
        .to_string()
    }

    #[test]
    fn onboard_command_uses_verified_upstream_flags() {
        let paths = PaperclipPaths {
            home_dir: PathBuf::from("/tmp/buzz/paperclip"),
            config_path: PathBuf::from("/tmp/buzz/paperclip/instances/buzz-desktop/config.json"),
            runtime_info_path: PathBuf::from(
                "/tmp/buzz/paperclip/instances/buzz-desktop/runtime-info.json",
            ),
            log_path: PathBuf::from("/tmp/buzz/paperclip/instances/buzz-desktop/paperclip.log"),
        };
        let command = paperclip_onboard_command(Path::new("/usr/local/bin/paperclipai"), &paths);
        let args = command
            .args
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(
            args,
            vec![
                "onboard",
                "--yes",
                "--config",
                "/tmp/buzz/paperclip/instances/buzz-desktop/config.json",
                "--data-dir",
                "/tmp/buzz/paperclip",
                "--bind",
                "loopback",
                "--no-install-service",
            ]
        );
    }

    #[test]
    fn loopback_hosts_are_accepted_and_others_rejected() {
        for host in ["127.0.0.1", "localhost", "LOCALHOST", "::1", "[::1]"] {
            assert!(is_loopback_host(host), "{host} should be loopback");
        }
        for host in ["", "0.0.0.0", "example.com", "192.168.1.10", "file://x"] {
            assert!(!is_loopback_host(host), "{host} should not be loopback");
        }
        assert_eq!(
            local_app_url("0.0.0.0", 3100),
            None,
            "non-loopback hosts must not be embedded"
        );
        assert_eq!(
            local_app_url("localhost", 3100).as_deref(),
            Some("http://127.0.0.1:3100")
        );
        assert_eq!(
            local_app_url("::1", 3100).as_deref(),
            Some("http://[::1]:3100")
        );
        assert_eq!(
            local_health_url("127.0.0.1", 3100).as_deref(),
            Some("http://127.0.0.1:3100/api/health")
        );
    }

    #[test]
    fn runtime_info_requires_schema_instance_pid_port_and_host() {
        assert!(parse_runtime_info(&runtime_info_json(123, PAPERCLIP_INSTANCE_ID)).is_some());
        assert!(parse_runtime_info(&runtime_info_json(0, PAPERCLIP_INSTANCE_ID)).is_none());
        assert!(parse_runtime_info(&runtime_info_json(123, "default")).is_none());
        assert!(parse_runtime_info("not json").is_none());
        assert!(parse_runtime_info(&runtime_info_json(
            u32::MAX as u64 + 1,
            PAPERCLIP_INSTANCE_ID
        ))
        .is_none());
    }
}
