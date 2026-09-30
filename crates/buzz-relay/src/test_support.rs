const DEFAULT_DATABASE_URL: &str = "postgres://buzz:buzz_dev@localhost:5432/buzz"; // sadscan:disable np.postgres.1 -- local test-only credentials

/// Resolve the database URL shared by PostgreSQL-backed relay tests.
pub(crate) fn database_url() -> String {
    std::env::var("BUZZ_TEST_DATABASE_URL")
        .or_else(|_| std::env::var("TEST_DATABASE_URL"))
        .or_else(|_| std::env::var("DATABASE_URL"))
        .unwrap_or_else(|_| DEFAULT_DATABASE_URL.to_owned())
}

/// A fully wired [`crate::state::AppState`] against the local test Postgres
/// (`DATABASE_URL`) and Redis (`REDIS_URL`, default `redis://127.0.0.1:6379`),
/// with relay membership enforcement off. For `#[ignore = "requires
/// Postgres"]` tests that drive the real WS/HTTP handlers.
#[cfg(test)]
pub(crate) async fn test_state() -> std::sync::Arc<crate::state::AppState> {
    test_state_with(|_| {}).await
}

/// [`test_state`] with a caller hook to adjust the [`crate::config::Config`]
/// before the state is built.
#[cfg(test)]
pub(crate) async fn test_state_with(
    configure: impl FnOnce(&mut crate::config::Config),
) -> std::sync::Arc<crate::state::AppState> {
    let mut config = crate::config::Config::from_env().expect("default config loads");
    config.database_url = database_url();
    config.redis_url =
        std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379".to_string());
    config.relay_url = "wss://relay-test.local".to_string();
    config.require_auth_token = false;
    config.require_relay_membership = false;
    configure(&mut config);

    let pool = sqlx::PgPool::connect(&config.database_url)
        .await
        .expect("connect test Postgres (set DATABASE_URL)");
    let db = buzz_db::Db::from_pool(pool.clone());
    let redis_pool = deadpool_redis::Config::from_url(&config.redis_url)
        .create_pool(Some(deadpool_redis::Runtime::Tokio1))
        .expect("redis pool");
    let pubsub = std::sync::Arc::new(
        buzz_pubsub::PubSubManager::new(&config.redis_url, redis_pool.clone())
            .await
            .expect("pubsub manager (set REDIS_URL)"),
    );
    let audit = buzz_audit::AuditService::new(pool.clone());
    let auth = buzz_auth::AuthService::new(config.auth.clone());
    let search = buzz_search::SearchService::new(pool.clone());
    let workflow_engine = std::sync::Arc::new(buzz_workflow::WorkflowEngine::new(
        db.clone(),
        buzz_workflow::WorkflowConfig::default(),
    ));
    let media_storage = buzz_media::MediaStorage::new(&config.media).expect("media storage");
    let (state, _audit_shutdown) = crate::state::AppState::new(
        config,
        db,
        redis_pool,
        audit,
        pubsub,
        auth,
        search,
        workflow_engine,
        nostr::Keys::generate(),
        media_storage,
    );
    std::sync::Arc::new(state)
}

#[cfg(test)]
const CHILD_TEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
#[cfg(test)]
const MAX_CAPTURE_BYTES: u64 = 1024 * 1024;

#[cfg(test)]
struct CapturedStream {
    retained: Vec<u8>,
    total_bytes: u64,
}

#[cfg(test)]
fn capture_stream(mut stream: impl std::io::Read) -> CapturedStream {
    let mut retained = Vec::new();
    let mut total_bytes = 0_u64;
    let mut chunk = [0_u8; 8192];
    loop {
        let read = stream.read(&mut chunk).expect("read child output pipe");
        if read == 0 {
            break;
        }
        total_bytes = total_bytes.saturating_add(u64::try_from(read).expect("read size fits u64"));
        let remaining = usize::try_from(MAX_CAPTURE_BYTES)
            .expect("capture ceiling fits usize")
            .saturating_sub(retained.len());
        retained.extend_from_slice(&chunk[..read.min(remaining)]);
    }
    CapturedStream {
        retained,
        total_bytes,
    }
}

#[cfg(test)]
fn join_capture(capture: std::thread::JoinHandle<CapturedStream>, stream: &str) -> Vec<u8> {
    let capture = capture.join().expect("child capture thread must not panic");
    assert!(
        capture.total_bytes <= MAX_CAPTURE_BYTES,
        "child {stream} exceeded {MAX_CAPTURE_BYTES} bytes: {}",
        capture.total_bytes,
    );
    capture.retained
}

/// Run exactly one unit test in an isolated, deadline-bounded child process.
#[cfg(test)]
pub(crate) fn run_exact_test_child(test_name: &str, child_env: &str) {
    use std::{
        process::{Command, Stdio},
        thread,
        time::{Duration, Instant},
    };

    let mut child = Command::new(std::env::current_exe().expect("test executable"))
        .arg("--exact")
        .arg(test_name)
        .arg("--nocapture")
        .env(child_env, "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn isolated test child");
    let stdout = child.stdout.take().expect("child stdout pipe");
    let stderr = child.stderr.take().expect("child stderr pipe");
    let stdout = thread::spawn(move || capture_stream(stdout));
    let stderr = thread::spawn(move || capture_stream(stderr));

    let deadline = Instant::now() + CHILD_TEST_TIMEOUT;
    let (status, timed_out) = loop {
        if let Some(status) = child.try_wait().expect("poll isolated test child") {
            break (status, false);
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let status = child.wait().expect("reap timed-out test child");
            break (status, true);
        }
        thread::sleep(Duration::from_millis(10));
    };

    let stdout = join_capture(stdout, "stdout");
    let stderr = join_capture(stderr, "stderr");
    let output = format!(
        "{}{}",
        String::from_utf8_lossy(&stdout),
        String::from_utf8_lossy(&stderr)
    );

    assert!(
        !timed_out,
        "isolated test child exceeded {CHILD_TEST_TIMEOUT:?}:\n{output}"
    );
    assert!(status.success(), "isolated test child failed:\n{output}");
    assert!(
        output.contains("running 1 test") && output.contains(test_name),
        "exact selector did not run the intended test {test_name}:\n{output}"
    );
}
