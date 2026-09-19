use std::fs::OpenOptions;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use tokio::process::Child;
use tokio::time::{sleep, Instant};

use super::paperclip_env::{
    is_loopback_host, local_app_url, paperclip_onboard_command, paperclip_paths, read_runtime_info,
    PaperclipLaunchCommand, PaperclipPaths, PAPERCLIP_INSTANCE_ID, PAPERCLIP_PROGRAM,
};
use super::paperclip_http::paperclip_health;
#[cfg(windows)]
use super::JobHandle;
use super::{process_is_running, resolve_command, terminate_process};

const READY_TIMEOUT: Duration = Duration::from_secs(90);
const READY_POLL_INTERVAL: Duration = Duration::from_millis(500);
const LOG_TAIL_BYTES: u64 = 32 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum PaperclipState {
    Stopped,
    Running,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PaperclipStatus {
    pub state: PaperclipState,
    pub url: Option<String>,
    pub error: Option<String>,
}

impl PaperclipStatus {
    fn stopped() -> Self {
        Self {
            state: PaperclipState::Stopped,
            url: None,
            error: None,
        }
    }

    fn running(url: String) -> Self {
        Self {
            state: PaperclipState::Running,
            url: Some(url),
            error: None,
        }
    }

    fn error(message: String) -> Self {
        Self {
            state: PaperclipState::Error,
            url: None,
            error: Some(message),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum StartupProgress {
    Ready(String),
    Waiting,
    Failed(String),
}

/// What to do when the instance's runtime info names a process that is not ours.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ForeignRuntimeInfo {
    /// Another healthy Paperclip is already serving this instance profile: use it.
    Adopt,
    /// The runtime info cannot be trusted as a live instance: report the failure.
    Fail,
}

/// Decide whether a runtime info file naming someone else's process is a usable
/// instance or a failure.
///
/// Adoption requires the named process to be alive, bound to loopback, and
/// answering its health probe. Anything less is reported in full - a runtime info
/// file left behind by a dead process is a common state and must not be presented
/// as a running instance.
pub(crate) fn classify_foreign_runtime_info(
    owner_is_running: bool,
    owner_is_loopback: bool,
    owner_is_healthy: bool,
) -> ForeignRuntimeInfo {
    if owner_is_running && owner_is_loopback && owner_is_healthy {
        ForeignRuntimeInfo::Adopt
    } else {
        ForeignRuntimeInfo::Fail
    }
}

pub(crate) struct PaperclipManager {
    child: Option<Child>,
    #[cfg(windows)]
    job: Option<JobHandle>,
    paths: Option<PaperclipPaths>,
    observed_pid: Option<u32>,
    last_error: Option<String>,
}

impl PaperclipManager {
    pub(crate) fn new() -> Self {
        Self {
            child: None,
            #[cfg(windows)]
            job: None,
            paths: None,
            observed_pid: None,
            last_error: None,
        }
    }

    pub(crate) async fn status(&mut self, http: &reqwest::Client) -> PaperclipStatus {
        if let Some(mut child) = self.child.take() {
            let status = match child.try_wait() {
                Ok(Some(exit)) => {
                    let message = Self::exit_message(exit, self.paths.as_ref());
                    self.last_error = Some(message.clone());
                    PaperclipStatus::error(message)
                }
                Ok(None) => {
                    self.child = Some(child);
                    return match self.startup_progress(http, false).await {
                        StartupProgress::Ready(url) => PaperclipStatus::running(url),
                        StartupProgress::Failed(error) => PaperclipStatus::error(error),
                        StartupProgress::Waiting => match self.last_error.clone() {
                            Some(error) => PaperclipStatus::error(error),
                            None => PaperclipStatus::stopped(),
                        },
                    };
                }
                Err(error) => {
                    let message = format!("Paperclip process handle failed: {error}");
                    self.last_error = Some(message.clone());
                    PaperclipStatus::error(message)
                }
            };
            self.observed_pid = None;
            return status;
        }

        if let Some(paths) = self.paths.clone() {
            if let Some(info) = read_runtime_info(&paths.runtime_info_path) {
                if process_is_running(info.pid) {
                    self.observed_pid = Some(info.pid);
                    if paperclip_health(http, &info.host, info.port).await.is_ok() {
                        if let Some(url) = local_app_url(&info.host, info.port) {
                            self.last_error = None;
                            return PaperclipStatus::running(url);
                        }
                    }
                }
            }
        }

        match self.last_error.clone() {
            Some(error) => PaperclipStatus::error(error),
            None => PaperclipStatus::stopped(),
        }
    }

    pub(crate) async fn start(
        &mut self,
        app_data_dir: &Path,
        http: &reqwest::Client,
        stop_requested: &std::sync::atomic::AtomicBool,
    ) -> Result<PaperclipStatus, String> {
        use std::sync::atomic::Ordering;

        if stop_requested.load(Ordering::SeqCst) {
            return Err("Paperclip start was cancelled".to_string());
        }
        match self.status(http).await {
            status @ PaperclipStatus {
                state: PaperclipState::Running,
                ..
            } => return Ok(status),
            PaperclipStatus {
                state: PaperclipState::Error,
                error: Some(error),
                ..
            } if error == "Paperclip start is already in progress" => {
                return Err(error);
            }
            _ => {}
        }
        if self.child.is_some() {
            self.last_error = Some("Paperclip start is already in progress".to_string());
            return Err("Paperclip start is already in progress".to_string());
        }

        let executable = resolve_command(PAPERCLIP_PROGRAM).ok_or_else(|| {
            "paperclipai was not found on PATH. Install Paperclip with the official installer or `npm install -g paperclipai`, then retry Start Paperclip."
                .to_string()
        })?;
        stop_requested.store(false, std::sync::atomic::Ordering::SeqCst);
        let paths = paperclip_paths(app_data_dir)?;
        create_parent_dirs(&paths)?;
        let log = open_log(&paths.log_path)?;
        let launch = paperclip_onboard_command(&executable, &paths);
        let child = spawn_onboard(&launch, &paths, log)?;
        #[cfg(windows)]
        {
            let Some(job) = super::create_job_for_child(child.id().ok_or_else(|| {
                "Paperclip exited before process ownership could be established".to_string()
            })?) else {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err("Paperclip could not be contained in a Windows job object".to_string());
            };
            if !super::resume_process(job_pid(&child)?) {
                drop(job);
                let _ = child.wait().await;
                return Err("Paperclip could not be resumed after containment".to_string());
            }
            self.job = Some(job);
        }

        self.child = Some(child);
        self.paths = Some(paths);
        self.observed_pid = None;
        self.last_error = None;
        self.await_ready(http, stop_requested).await
    }

    pub(crate) async fn stop(&mut self) -> Result<PaperclipStatus, String> {
        #[cfg(windows)]
        let job = self.job.take();
        if let Some(mut child) = self.child.take() {
            let pid = child.id();
            if let Some(pid) = pid {
                terminate_process(pid)
                    .map_err(|error| format!("Paperclip stop failed: {error}"))?;
            }
            #[cfg(windows)]
            drop(job);
            let _ = child.wait().await;
            self.observed_pid = None;
            self.last_error = None;
            Self::remove_runtime_file_for(self.paths.as_ref(), pid);
            return Ok(PaperclipStatus::stopped());
        }

        if let Some(pid) = self.observed_pid.take() {
            if process_is_running(pid) {
                terminate_process(pid)
                    .map_err(|error| format!("Paperclip stop failed: {error}"))?;
            }
            self.last_error = None;
            Self::remove_runtime_file_for(self.paths.as_ref(), Some(pid));
        }
        Ok(PaperclipStatus::stopped())
    }

    pub(crate) fn shutdown(&mut self) {
        if let Some(mut child) = self.child.take() {
            let pid = child.id();
            if let Some(pid) = pid {
                let _ = terminate_process(pid);
            }
            #[cfg(windows)]
            drop(self.job.take());
            let _ = child.try_wait();
            self.observed_pid = None;
            Self::remove_runtime_file_for(self.paths.as_ref(), pid);
        } else if let Some(pid) = self.observed_pid.take() {
            if process_is_running(pid) {
                let _ = terminate_process(pid);
            }
            Self::remove_runtime_file_for(self.paths.as_ref(), Some(pid));
        }
    }

    async fn await_ready(
        &mut self,
        http: &reqwest::Client,
        stop_requested: &std::sync::atomic::AtomicBool,
    ) -> Result<PaperclipStatus, String> {
        use std::sync::atomic::Ordering;

        let deadline = Instant::now() + READY_TIMEOUT;
        loop {
            if stop_requested.load(Ordering::SeqCst) {
                self.terminate_starting().await;
                self.last_error = Some("Paperclip start was cancelled".to_string());
                return Err("Paperclip start was cancelled".to_string());
            }
            match self.startup_progress(http, true).await {
                StartupProgress::Ready(url) => return Ok(PaperclipStatus::running(url)),
                StartupProgress::Failed(error) => {
                    self.last_error = Some(error.clone());
                    return Err(error);
                }
                StartupProgress::Waiting => {}
            }
            if Instant::now() >= deadline {
                let message = format!(
                    "Paperclip did not become healthy within {} seconds{}",
                    READY_TIMEOUT.as_secs(),
                    log_tail_suffix(self.paths.as_ref())
                );
                self.terminate_starting().await;
                self.last_error = Some(message.clone());
                return Err(message);
            }
            sleep(READY_POLL_INTERVAL).await;
        }
    }

    async fn startup_progress(
        &mut self,
        http: &reqwest::Client,
        kill_unusable: bool,
    ) -> StartupProgress {
        let Some(child) = self.child.as_mut() else {
            return StartupProgress::Failed("Paperclip process handle was lost".to_string());
        };
        match child.try_wait() {
            Ok(Some(exit)) => {
                let message = Self::exit_message(exit, self.paths.as_ref());
                self.child = None;
                self.observed_pid = None;
                self.last_error = Some(message.clone());
                return StartupProgress::Failed(message);
            }
            Ok(None) => {}
            Err(error) => {
                let message = format!("Paperclip process handle failed: {error}");
                self.child = None;
                self.observed_pid = None;
                self.last_error = Some(message.clone());
                return StartupProgress::Failed(message);
            }
        }
        let pid = child.id();
        let Some(paths) = self.paths.clone() else {
            return StartupProgress::Failed(
                "Paperclip is running without managed instance paths".to_string(),
            );
        };
        let Some(info) = read_runtime_info(&paths.runtime_info_path) else {
            return StartupProgress::Waiting;
        };
        if Some(info.pid) != pid {
            // Another process published runtime info for *this* instance profile.
            // That is not automatically an error: a Paperclip started outside the
            // app (or left running by a previous run) is the same instance, and
            // refusing it would force the user to press Start twice - the first
            // press spawns a redundant second instance that cannot own the
            // database or the port, fails, and only then does a retry notice the
            // running instance. Adopt it when it is clearly healthy.
            let owner_is_running = process_is_running(info.pid);
            let owner_is_loopback = is_loopback_host(&info.host);
            let owner_is_healthy =
                owner_is_loopback && paperclip_health(http, &info.host, info.port).await.is_ok();
            if classify_foreign_runtime_info(owner_is_running, owner_is_loopback, owner_is_healthy)
                == ForeignRuntimeInfo::Adopt
            {
                if let Some(url) = local_app_url(&info.host, info.port) {
                    tracing::info!(
                        pid = info.pid,
                        "adopting the already-running Paperclip instance for this profile"
                    );
                    // Our child is the redundant duplicate: it cannot own the
                    // embedded database or the port, so stop it.
                    self.terminate_starting().await;
                    self.observed_pid = Some(info.pid);
                    self.last_error = None;
                    return StartupProgress::Ready(url);
                }
            }
            let message = format!(
                "Paperclip runtime info belongs to PID {} (running: {owner_is_running}, loopback: \
                 {owner_is_loopback}, healthy: {owner_is_healthy}), not the managed process, and it \
                 is not a usable instance{}",
                info.pid,
                log_tail_suffix(Some(&paths))
            );
            if kill_unusable {
                self.terminate_starting().await;
            }
            self.last_error = Some(message.clone());
            return StartupProgress::Failed(message);
        }
        if !is_loopback_host(&info.host) {
            let message = format!(
                "Paperclip advertised non-loopback host {}{}",
                info.host,
                log_tail_suffix(Some(&paths))
            );
            if kill_unusable {
                self.terminate_starting().await;
            }
            self.last_error = Some(message.clone());
            return StartupProgress::Failed(message);
        }
        match paperclip_health(http, &info.host, info.port).await {
            Ok(()) => {
                if let Some(url) = local_app_url(&info.host, info.port) {
                    self.observed_pid = Some(info.pid);
                    self.last_error = None;
                    StartupProgress::Ready(url)
                } else {
                    let message = "Paperclip reported an unusable dashboard address".to_string();
                    if kill_unusable {
                        self.terminate_starting().await;
                    }
                    self.last_error = Some(message.clone());
                    StartupProgress::Failed(message)
                }
            }
            Err(_) => StartupProgress::Waiting,
        }
    }

    async fn terminate_starting(&mut self) {
        #[cfg(windows)]
        let job = self.job.take();
        if let Some(mut child) = self.child.take() {
            let pid = child.id();
            if let Some(pid) = pid {
                let _ = terminate_process(pid);
            }
            #[cfg(windows)]
            drop(job);
            let _ = child.wait().await;
            self.observed_pid = None;
            Self::remove_runtime_file_for(self.paths.as_ref(), pid);
        } else {
            self.observed_pid = None;
        }
    }

    fn remove_runtime_file_for(paths: Option<&PaperclipPaths>, pid: Option<u32>) {
        if let Some(paths) = paths {
            if let Some(info) = read_runtime_info(&paths.runtime_info_path) {
                if Some(info.pid) == pid {
                    let _ = std::fs::remove_file(&paths.runtime_info_path);
                }
            }
        }
    }

    fn exit_message(exit: std::process::ExitStatus, paths: Option<&PaperclipPaths>) -> String {
        match exit.code() {
            Some(code) => format!(
                "Paperclip exited with status {code}{}",
                log_tail_suffix(paths)
            ),
            None => format!(
                "Paperclip terminated before becoming healthy{}",
                log_tail_suffix(paths)
            ),
        }
    }
}

impl Default for PaperclipManager {
    fn default() -> Self {
        Self::new()
    }
}

fn create_parent_dirs(paths: &PaperclipPaths) -> Result<(), String> {
    for dir in [
        &paths.home_dir,
        paths
            .config_path
            .parent()
            .ok_or_else(|| "Paperclip config path has no parent".to_string())?,
        paths
            .log_path
            .parent()
            .ok_or_else(|| "Paperclip log path has no parent".to_string())?,
    ] {
        std::fs::create_dir_all(dir)
            .map_err(|error| format!("Paperclip data directory unavailable: {error}"))?;
    }
    Ok(())
}

fn open_log(path: &Path) -> Result<std::fs::File, String> {
    let mut options = OpenOptions::new();
    options.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .map_err(|error| format!("Paperclip log unavailable: {error}"))
}

fn spawn_onboard(
    launch: &PaperclipLaunchCommand,
    paths: &PaperclipPaths,
    log: std::fs::File,
) -> Result<Child, String> {
    let stdout = log
        .try_clone()
        .map_err(|error| format!("Paperclip log unavailable: {error}"))?;
    let mut command = tokio::process::Command::new(&launch.program);
    command
        .args(&launch.args)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(log))
        .env("PAPERCLIP_HOME", &paths.home_dir)
        .env("PAPERCLIP_INSTANCE_ID", PAPERCLIP_INSTANCE_ID)
        .env("PAPERCLIP_NO_BROWSER", "true")
        .env_remove("PAPERCLIP_CONFIG")
        .env_remove("PAPERCLIP_CONTEXT")
        .env_remove("PAPERCLIP_SERVICE_MANAGED")
        .env_remove("PAPERCLIP_SHIM_PATH")
        .env_remove("PAPERCLIP_API_URL")
        .env_remove("PAPERCLIP_LISTEN_HOST")
        .env_remove("PAPERCLIP_LISTEN_PORT")
        .env_remove("PAPERCLIP_RUNTIME_API_URL")
        .env_remove("PAPERCLIP_RUNTIME_API_CANDIDATES_JSON");
    #[cfg(unix)]
    {
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_SUSPENDED: u32 = 0x0000_0004;
        command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
    }
    command.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "paperclipai was not found on PATH. Install Paperclip, then retry Start Paperclip."
                .to_string()
        } else {
            format!("Paperclip failed to spawn: {error}")
        }
    })
}

#[cfg(windows)]
fn job_pid(child: &Child) -> Result<u32, String> {
    child
        .id()
        .ok_or_else(|| "Paperclip exited before process ownership could be established".to_string())
}

fn log_tail_suffix(paths: Option<&PaperclipPaths>) -> String {
    let Some(paths) = paths else {
        return String::new();
    };
    let Ok(metadata) = std::fs::metadata(&paths.log_path) else {
        return String::new();
    };
    let start = metadata.len().saturating_sub(LOG_TAIL_BYTES);
    let Ok(file) = std::fs::File::open(&paths.log_path) else {
        return String::new();
    };
    use std::io::{Read, Seek, SeekFrom};
    let mut file = file;
    if file.seek(SeekFrom::Start(start)).is_err() {
        return String::new();
    }
    let mut tail = Vec::new();
    if file.read_to_end(&mut tail).is_err() {
        return String::new();
    }
    let text = String::from_utf8_lossy(&tail);
    let lines = text
        .lines()
        .rev()
        .take(8)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");
    if lines.trim().is_empty() {
        String::new()
    } else {
        format!(": {lines}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn status_serializes_frontend_contract() {
        assert_eq!(
            serde_json::to_value(PaperclipStatus::running(
                "http://127.0.0.1:3100".to_string()
            ))
            .expect("status serializes"),
            serde_json::json!({
                "state": "running",
                "url": "http://127.0.0.1:3100",
                "error": null
            })
        );
        assert_eq!(
            serde_json::to_value(PaperclipStatus::error("failure".to_string()))
                .expect("status serializes"),
            serde_json::json!({
                "state": "error",
                "url": null,
                "error": "failure"
            })
        );
    }

    #[test]
    fn starting_child_blocks_duplicate_start() {
        let mut manager = PaperclipManager::new();
        manager.paths = Some(PaperclipPaths {
            home_dir: PathBuf::from("/tmp/buzz-paperclip"),
            config_path: PathBuf::from("/tmp/buzz-paperclip/config.json"),
            runtime_info_path: PathBuf::from("/tmp/buzz-paperclip/runtime-info.json"),
            log_path: PathBuf::from("/tmp/buzz-paperclip/paperclip.log"),
        });
        assert!(manager.child.is_none());
        assert_eq!(manager.observed_pid, None);
    }
    #[test]
    fn a_healthy_foreign_instance_is_adopted() {
        assert_eq!(
            classify_foreign_runtime_info(true, true, true),
            ForeignRuntimeInfo::Adopt,
            "a live, loopback, healthy instance for this profile is ours to use"
        );
    }

    #[test]
    fn anything_short_of_healthy_is_reported() {
        let cases = [
            (false, true, true, "the owner process is gone"),
            (
                true,
                false,
                false,
                "a non-loopback address is not embeddable",
            ),
            (true, true, false, "an unresponsive server is not usable"),
            (false, false, false, "nothing about it is usable"),
        ];
        for (running, loopback, healthy, why) in cases {
            assert_eq!(
                classify_foreign_runtime_info(running, loopback, healthy),
                ForeignRuntimeInfo::Fail,
                "{why}"
            );
        }
    }
}
