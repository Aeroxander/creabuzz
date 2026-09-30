//! `buzz-paperclip` — project Paperclip issues into a Buzz community.
//!
//! Exit codes: `0` success, `1` configuration or transport error, `2` the run
//! completed but the relay refused at least one row.

use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use clap::{Args, Parser, Subcommand};

use buzz_paperclip::relay::{DryRunPublisher, RelayPublisher};
use buzz_paperclip::source::{JsonFileSource, PaperclipRestSource};
use buzz_paperclip::{
    invert_assignee_map, invite_member, run_apply, run_bridge, run_once, ApplyConfig, ApplyReport,
    BridgeConfig, BridgeError, BridgeRun, InviteRequest, JsonFileTaskFeed, ProjectionConfig,
    RelayMessagePublisher, RelayTaskFeed, RestInviteIssuer, RestIssueWriter, SyncReport, SyncState,
};

#[derive(Parser)]
#[command(
    name = "buzz-paperclip",
    about = "Project Paperclip issues into a Buzz community as kind:44011 task rows",
    version
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Fetch issues and publish the ones that changed.
    Sync(Box<SyncArgs>),
    /// Apply Buzz-authored task rows to Paperclip.
    Apply(Box<ApplyArgs>),
    /// Deprecated: standing two-way sync loop. See the Status section of
    /// docs/paperclip-bridge.md.
    ///
    /// The Paperclip integration is now an on-ramp — one-way import plus a
    /// private desktop sandbox (VISION_ORG.md). This loop still works, but it
    /// is scheduled for removal once native org parity covers task sync.
    Bridge(Box<BridgeArgs>),
    /// Create a Paperclip invite and announce it in a Buzz channel.
    Invite(Box<InviteArgs>),
}

#[derive(Args)]
struct InviteArgs {
    /// Paperclip base URL.
    #[arg(long, env = "PAPERCLIP_BASE_URL")]
    paperclip_url: Option<String>,
    /// Board API key with the `users:invite` permission (a viewer key cannot invite).
    #[arg(long, env = "PAPERCLIP_API_KEY")]
    paperclip_api_key: Option<String>,
    /// Paperclip company id.
    #[arg(long, env = "PAPERCLIP_COMPANY_ID")]
    company: Option<String>,
    /// Channel UUID to announce the invite in.
    #[arg(long, env = "BUZZ_CHANNEL_ID")]
    channel: Option<String>,
    /// Relay URL.
    #[arg(long, env = "BUZZ_RELAY_URL")]
    relay_url: Option<String>,
    /// Hex secret key the announcement is signed with.
    #[arg(long, env = "BUZZ_PRIVATE_KEY")]
    private_key: Option<String>,
    /// Role the invited human lands in: viewer, operator, admin, or owner.
    #[arg(long, default_value = "operator")]
    role: String,
    /// Create an agent invite instead of a human one.
    #[arg(long)]
    agent: bool,
    /// Create the invite and compose the message without posting either.
    #[arg(long)]
    dry_run: bool,
    /// Print the outcome as JSON.
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
struct BridgeArgs {
    /// Read Paperclip issues from a JSON file instead of an instance.
    #[arg(long, value_name = "PATH")]
    from_json: Option<PathBuf>,
    /// Read Buzz task rows from a JSON file instead of a relay.
    #[arg(long, value_name = "PATH")]
    tasks_from_json: Option<PathBuf>,
    /// Paperclip base URL.
    #[arg(long, env = "PAPERCLIP_BASE_URL")]
    paperclip_url: Option<String>,
    /// Board API key used for reads; a viewer key is fine.
    #[arg(long, env = "PAPERCLIP_API_KEY")]
    paperclip_api_key: Option<String>,
    /// Board API key used for writes; must NOT be a viewer key. Defaults to the
    /// read key.
    #[arg(long, env = "PAPERCLIP_WRITE_API_KEY")]
    write_api_key: Option<String>,
    /// Issues path; defaults to `/api/companies/<company>/issues`.
    #[arg(long)]
    issues_path: Option<String>,
    /// Incremental-filter query parameter, once verified against the instance.
    #[arg(
        long,
        env = "PAPERCLIP_INCREMENTAL_PARAM",
        default_value = "updatedSince"
    )]
    incremental_param: String,
    /// Paperclip company id.
    #[arg(long, env = "PAPERCLIP_COMPANY_ID")]
    company: Option<String>,
    /// Project new issues land in.
    #[arg(long)]
    project: Option<String>,
    /// Buzz channel UUID the task rows are scoped to.
    #[arg(long, env = "BUZZ_CHANNEL_ID")]
    channel: Option<String>,
    /// Relay URL.
    #[arg(long, env = "BUZZ_RELAY_URL")]
    relay_url: Option<String>,
    /// Hex secret key the bridge signs and authenticates with.
    #[arg(long, env = "BUZZ_PRIVATE_KEY")]
    private_key: Option<String>,
    /// JSON map of Paperclip ids to Buzz pubkeys; inverted for the apply side.
    #[arg(long)]
    assignee_map: Option<PathBuf>,
    /// Paperclip dashboard base URL, used for a link-back tag.
    #[arg(long)]
    dashboard_url: Option<String>,
    /// Durable state file.
    #[arg(long, default_value = ".buzz-paperclip-state.json")]
    state: PathBuf,
    /// Seconds between cycles.
    #[arg(long, default_value_t = 60)]
    interval_secs: u64,
    /// Stop after this many cycles; 0 runs until interrupted.
    #[arg(long, default_value_t = 0)]
    cycles: u32,
    /// Seconds subtracted from the stored scan start to form the cursor.
    #[arg(long, default_value_t = buzz_paperclip::DEFAULT_OVERLAP_SECONDS)]
    overlap_seconds: u64,
    /// Page cap for one Paperclip read.
    #[arg(long, default_value_t = 10)]
    max_pages: u32,
    /// Attempts per Paperclip write before giving up.
    #[arg(long, default_value_t = 3)]
    max_attempts: u32,
    /// Rehearse without publishing or writing.
    #[arg(long)]
    dry_run: bool,
    /// Print the run report as JSON when the loop stops.
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
struct ApplyArgs {
    /// Read task rows from a JSON file instead of a relay.
    #[arg(long, value_name = "PATH")]
    from_json: Option<PathBuf>,
    /// Relay URL to read task rows from.
    #[arg(long, env = "BUZZ_RELAY_URL")]
    relay_url: Option<String>,
    /// Hex secret key used to authenticate the relay read.
    #[arg(long, env = "BUZZ_PRIVATE_KEY")]
    private_key: Option<String>,
    /// Only read task rows for this channel UUID.
    #[arg(long, env = "BUZZ_CHANNEL_ID")]
    channel: Option<String>,
    /// Paperclip base URL.
    #[arg(long, env = "PAPERCLIP_BASE_URL")]
    paperclip_url: Option<String>,
    /// Paperclip board API key. A viewer key cannot write.
    #[arg(long, env = "PAPERCLIP_API_KEY")]
    paperclip_api_key: Option<String>,
    /// Paperclip company id.
    #[arg(long, env = "PAPERCLIP_COMPANY_ID")]
    company: Option<String>,
    /// Project new issues land in.
    #[arg(long)]
    project: Option<String>,
    /// The same assignee map `sync` uses (Paperclip id -> Buzz pubkey); it is
    /// inverted here so both directions agree on identities.
    #[arg(long)]
    assignee_map: Option<PathBuf>,
    /// Durable state file.
    #[arg(long, default_value = ".buzz-paperclip-state.json")]
    state: PathBuf,
    /// Attempts per write before giving up.
    #[arg(long, default_value_t = 3)]
    max_attempts: u32,
    /// Delay between attempts, in milliseconds.
    #[arg(long, default_value_t = 250)]
    retry_delay_ms: u64,
    /// Plan without writing to Paperclip.
    #[arg(long)]
    dry_run: bool,
    /// Print the run report as JSON.
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
struct SyncArgs {
    /// Read issues from a JSON file instead of a Paperclip instance.
    #[arg(long, value_name = "PATH")]
    from_json: Option<PathBuf>,
    /// Paperclip base URL, for example `https://tasks.example.com`.
    #[arg(long, env = "PAPERCLIP_BASE_URL")]
    paperclip_url: Option<String>,
    /// Issues path; defaults to `/api/companies/<company>/issues`.
    #[arg(long)]
    issues_path: Option<String>,
    /// Paperclip board API key used for reads.
    #[arg(long, env = "PAPERCLIP_API_KEY")]
    paperclip_api_key: Option<String>,
    /// Incremental-filter query parameter, once verified against the instance.
    #[arg(long, env = "PAPERCLIP_INCREMENTAL_PARAM")]
    incremental_param: Option<String>,
    /// Page size requested from the source.
    #[arg(long, default_value_t = 100)]
    page_size: u32,
    /// Paperclip company id; used in the tags and the default issues path.
    #[arg(long, env = "PAPERCLIP_COMPANY_ID")]
    company: Option<String>,
    /// Buzz channel id, published as the `h` tag.
    #[arg(long, env = "BUZZ_CHANNEL_ID")]
    channel: Option<String>,
    /// Relay URL, for example `ws://localhost:3000`.
    #[arg(long, env = "BUZZ_RELAY_URL")]
    relay_url: Option<String>,
    /// Hex secret key the projection signs with.
    #[arg(long, env = "BUZZ_PRIVATE_KEY")]
    private_key: Option<String>,
    /// JSON map of Paperclip assignee ids to 64-hex Buzz public keys.
    #[arg(long)]
    assignee_map: Option<PathBuf>,
    /// Paperclip dashboard base URL, used for a link-back tag.
    #[arg(long)]
    dashboard_url: Option<String>,
    /// Durable state file.
    #[arg(long, default_value = ".buzz-paperclip-state.json")]
    state: PathBuf,
    /// Map and plan without publishing, and without writing state.
    #[arg(long)]
    dry_run: bool,
    /// Print the run report as JSON.
    #[arg(long)]
    json: bool,
    /// Per-publish timeout, in seconds.
    #[arg(long, default_value_t = 15)]
    timeout_secs: u64,
    /// Seconds subtracted from the stored scan start to form the cursor.
    #[arg(long, default_value_t = buzz_paperclip::DEFAULT_OVERLAP_SECONDS)]
    overlap_seconds: u64,
    /// Page cap for one Paperclip read; hitting it is reported, never hidden.
    #[arg(long, default_value_t = 10)]
    max_pages: u32,
}

#[tokio::main]
async fn main() -> ExitCode {
    // Install ring as the process-level rustls provider before any TLS work:
    // a unified multi-package release build leaves rustls unable to select one.
    let _ = rustls::crypto::ring::default_provider().install_default();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let cli = Cli::parse();
    let result = match cli.command {
        Command::Sync(args) => run_sync(*args).await,
        Command::Apply(args) => run_apply_command(*args).await,
        Command::Bridge(args) => run_bridge_command(*args).await,
        Command::Invite(args) => run_invite_command(*args).await,
    };
    match result {
        Ok(code) => code,
        Err(error) => {
            eprintln!("buzz-paperclip: {error}");
            ExitCode::from(1)
        }
    }
}

async fn run_sync(args: SyncArgs) -> Result<ExitCode, BridgeError> {
    let config = build_config(&args)?;
    let mut state = SyncState::load(&args.state)?;
    state.overlap_seconds = args.overlap_seconds;
    // The cursor is the wall-clock start of this scan, never the newest source
    // timestamp: Paperclip filters on `updated_at` but orders by a different
    // expression, so a maximum-stamp cursor drops rows at page boundaries.
    let scan_started_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    if args.dry_run {
        let publisher = DryRunPublisher::new();
        let report = match source_for(&args)? {
            Source::File(source) => {
                run_once(
                    &source,
                    &publisher,
                    &config,
                    &mut state,
                    &scan_started_at,
                    true,
                )
                .await?
            }
            Source::Rest(source) => {
                run_once(
                    &source,
                    &publisher,
                    &config,
                    &mut state,
                    &scan_started_at,
                    true,
                )
                .await?
            }
        };
        if !args.json {
            print_dry_run(&publisher);
        }
        print_report(&report, args.json)?;
        return Ok(ExitCode::SUCCESS);
    }

    let relay_url = required(&args.relay_url, "--relay-url or BUZZ_RELAY_URL")?;
    let private_key = required(&args.private_key, "--private-key or BUZZ_PRIVATE_KEY")?;
    let keys = nostr::Keys::parse(private_key.trim())
        .map_err(|error| BridgeError::Config(format!("invalid projection key: {error}")))?;
    let publisher = RelayPublisher::new(relay_url, keys, args.timeout_secs);

    let report = match source_for(&args)? {
        Source::File(source) => {
            run_once(
                &source,
                &publisher,
                &config,
                &mut state,
                &scan_started_at,
                false,
            )
            .await?
        }
        Source::Rest(source) => {
            run_once(
                &source,
                &publisher,
                &config,
                &mut state,
                &scan_started_at,
                false,
            )
            .await?
        }
    };

    if report.failures == 0 {
        state.save(&args.state)?;
    } else {
        // The cursor is deliberately left where it was so the next run retries.
        tracing::warn!(
            failures = report.failures,
            "not advancing the projection cursor because some rows failed"
        );
    }
    print_report(&report, args.json)?;
    Ok(if report.failures == 0 {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(2)
    })
}

enum Source {
    File(JsonFileSource),
    Rest(PaperclipRestSource),
}

fn source_for(args: &SyncArgs) -> Result<Source, BridgeError> {
    if let Some(path) = args.from_json.as_ref() {
        return Ok(Source::File(JsonFileSource::new(path.clone())));
    }
    let base_url = required(&args.paperclip_url, "--paperclip-url or PAPERCLIP_BASE_URL")?;
    let company = required(&args.company, "--company or PAPERCLIP_COMPANY_ID")?;
    // A blank key is meaningful: a `local_trusted` instance serves the implicit
    // `local-board` actor when no credential is sent, while a wrong bearer is
    // rejected. So an omitted key is passed through rather than required.
    let api_key = args.paperclip_api_key.clone().unwrap_or_default();
    if api_key.trim().is_empty() {
        tracing::warn!(
            "no Paperclip API key supplied; this only works on a local_trusted instance"
        );
    }
    let path = args
        .issues_path
        .clone()
        .unwrap_or_else(|| format!("/api/companies/{company}/issues"));
    let mut source = PaperclipRestSource::new(base_url, path, api_key, args.page_size)?;
    if let Some(param) = args.incremental_param.clone() {
        source = source.with_incremental_param(param);
    }
    let source = source.with_max_pages(args.max_pages);
    Ok(Source::Rest(source))
}

fn build_config(args: &SyncArgs) -> Result<ProjectionConfig, BridgeError> {
    let company_id = required(&args.company, "--company or PAPERCLIP_COMPANY_ID")?;
    let assignee_map = match args.assignee_map.as_ref() {
        Some(path) => ProjectionConfig::load_assignee_map(path)?,
        None => Default::default(),
    };
    Ok(ProjectionConfig {
        company_id,
        channel_id: args.channel.clone(),
        dashboard_url: args.dashboard_url.clone(),
        assignee_map,
    })
}

fn required(value: &Option<String>, name: &str) -> Result<String, BridgeError> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| BridgeError::Config(format!("missing {name}")))
}

fn print_dry_run(publisher: &DryRunPublisher) {
    let tasks = publisher.tasks();
    println!("dry run: {} row(s) would be published", tasks.len());
    for task in tasks {
        let tags = task
            .tags
            .iter()
            .map(|tag| tag.join("="))
            .collect::<Vec<_>>()
            .join(" ");
        println!(
            "  d={} status={}\n    tags: {tags}\n    content: {}",
            task.d, task.status, task.content
        );
    }
}

fn print_report(report: &SyncReport, as_json: bool) -> Result<(), BridgeError> {
    if as_json {
        let text = serde_json::to_string_pretty(report)
            .map_err(|error| BridgeError::Config(format!("cannot serialize report: {error}")))?;
        println!("{text}");
        return Ok(());
    }
    println!(
        "created={} updated={} skipped={} failures={} dry_run={} cursor_advanced={}",
        report.created,
        report.updated,
        report.skipped,
        report.failures,
        report.dry_run,
        report.cursor_advanced
    );
    println!(
        "  cursor_used={} last_scan_started_at={} scan_was_complete={}",
        report.cursor_used.as_deref().unwrap_or("<full scan>"),
        report.last_scan_started_at.as_deref().unwrap_or("<none>"),
        !report.source_truncated
    );
    if report.source_truncated {
        println!(
            "  WARNING: the Paperclip read stopped at the page cap, so the cursor did not advance; \
             raise --max-pages or narrow the read"
        );
    }
    if !report.unresolved_assignees.is_empty() {
        println!(
            "  unresolved assignees (no Buzz key mapped): {}",
            report.unresolved_assignees.join(", ")
        );
    }
    if !report.unrecognized_statuses.is_empty() {
        println!(
            "  unrecognized statuses (mapped to open): {}",
            report.unrecognized_statuses.join(", ")
        );
    }
    if !report.unrecognized_priorities.is_empty() {
        println!(
            "  unrecognized priorities (mapped to normal): {}",
            report.unrecognized_priorities.join(", ")
        );
    }
    Ok(())
}

async fn run_apply_command(args: ApplyArgs) -> Result<ExitCode, BridgeError> {
    let company_id = required(&args.company, "--company or PAPERCLIP_COMPANY_ID")?;
    let assignee_by_npub = match args.assignee_map.as_ref() {
        Some(path) => invert_assignee_map(&ProjectionConfig::load_assignee_map(path)?),
        None => Default::default(),
    };
    let config = ApplyConfig {
        project_id: args.project.clone(),
        max_attempts: args.max_attempts.max(1),
        retry_delay: Duration::from_millis(args.retry_delay_ms),
        // One identity map, two roles: who the work is assigned to, and whose
        // work it is. Both are the same npub -> principal relation.
        responsible_by_npub: assignee_by_npub.clone(),
        assignee_by_npub,
    };
    let mut state = SyncState::load(&args.state)?;
    let write_key = args.paperclip_api_key.clone().unwrap_or_default();
    if write_key.trim().is_empty() {
        tracing::warn!(
            "no Paperclip API key supplied; writes only work on a local_trusted instance"
        );
    }
    let writer = RestIssueWriter::new(
        required(&args.paperclip_url, "--paperclip-url or PAPERCLIP_BASE_URL")?,
        company_id,
        write_key,
    )?;

    let report = match tasks_for(&args)? {
        TaskSource::File(feed) => {
            run_apply(&feed, &writer, &config, &mut state, args.dry_run).await?
        }
        TaskSource::Relay(feed) => {
            run_apply(&feed, &writer, &config, &mut state, args.dry_run).await?
        }
    };

    if !args.dry_run {
        state.save(&args.state)?;
    }
    print_apply_report(&report, args.json)?;
    Ok(if report.failures == 0 {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(2)
    })
}

enum TaskSource {
    File(JsonFileTaskFeed),
    Relay(RelayTaskFeed),
}

fn tasks_for(args: &ApplyArgs) -> Result<TaskSource, BridgeError> {
    if let Some(path) = args.from_json.as_ref() {
        return Ok(TaskSource::File(JsonFileTaskFeed::new(path.clone())));
    }
    let relay_url = required(&args.relay_url, "--relay-url or BUZZ_RELAY_URL")?;
    let private_key = required(&args.private_key, "--private-key or BUZZ_PRIVATE_KEY")?;
    let keys = nostr::Keys::parse(private_key.trim())
        .map_err(|error| BridgeError::Config(format!("invalid bridge key: {error}")))?;
    Ok(TaskSource::Relay(RelayTaskFeed::new(
        relay_url,
        keys,
        args.channel.clone(),
        Duration::from_secs(15),
    )))
}

fn print_apply_report(report: &ApplyReport, as_json: bool) -> Result<(), BridgeError> {
    if as_json {
        let text = serde_json::to_string_pretty(report)
            .map_err(|error| BridgeError::Config(format!("cannot serialize report: {error}")))?;
        println!("{text}");
        return Ok(());
    }
    println!(
        "created={} patched={} skipped={} failures={} dry_run={} feed_truncated={}",
        report.created,
        report.patched,
        report.skipped,
        report.failures,
        report.dry_run,
        report.feed_truncated
    );
    if report.feed_truncated {
        println!(
            "  WARNING: the Buzz task-row read stopped early (relay timeout or the row cap), \
             so this pass only covers the rows it read; re-run to pick up the rest"
        );
    }
    if !report.unmapped_assignees.is_empty() {
        println!(
            "  assignees with no Paperclip mapping (created unassigned): {}",
            report.unmapped_assignees.join(", ")
        );
    }
    if !report.unmapped_authors.is_empty() {
        println!(
            "  authors with no Paperclip mapping (Paperclip will record the creating actor): {}",
            report.unmapped_authors.join(", ")
        );
    }
    for detail in &report.failure_details {
        println!("  failed {detail}");
    }
    Ok(())
}

async fn run_bridge_command(args: BridgeArgs) -> Result<ExitCode, BridgeError> {
    let company_id = required(&args.company, "--company or PAPERCLIP_COMPANY_ID")?;
    let assignee_map = match args.assignee_map.as_ref() {
        Some(path) => ProjectionConfig::load_assignee_map(path)?,
        None => Default::default(),
    };
    let sync_config = ProjectionConfig {
        company_id: company_id.clone(),
        channel_id: args.channel.clone(),
        dashboard_url: args.dashboard_url.clone(),
        assignee_map: assignee_map.clone(),
    };
    let apply_config = ApplyConfig {
        project_id: args.project.clone(),
        max_attempts: args.max_attempts.max(1),
        retry_delay: Duration::from_millis(250),
        assignee_by_npub: invert_assignee_map(&assignee_map),
        responsible_by_npub: invert_assignee_map(&assignee_map),
    };

    let paperclip_url = required(&args.paperclip_url, "--paperclip-url or PAPERCLIP_BASE_URL")?;
    let read_key = args.paperclip_api_key.clone().unwrap_or_default();
    let explicit_write_key = args
        .write_api_key
        .clone()
        .filter(|value| !value.trim().is_empty());
    let write_key = explicit_write_key
        .clone()
        .unwrap_or_else(|| read_key.clone());
    // The silent fallback used to be the read key, so a real run could happily
    // 403 every write. A rehearsal performs no writes, so it has nothing to warn
    // about. Print to stderr so it is loud in scripts and CI, not a hidden
    // tracing line.
    if explicit_write_key.is_none() && !args.dry_run {
        eprintln!(
            "warning: --write-api-key was not set; falling back to the read key              (--paperclip-api-key). Writes will use that key and will likely be              rejected with 403 unless it is a non-viewer key."
        );
    }
    if read_key.trim().is_empty() || write_key.trim().is_empty() {
        tracing::warn!(
            "no Paperclip API key supplied; this only works on a local_trusted instance, where \
             the implicit local-board actor applies when no credential is sent"
        );
    }
    let issues_path = args
        .issues_path
        .clone()
        .unwrap_or_else(|| format!("/api/companies/{company_id}/issues"));

    let mut state = SyncState::load(&args.state)?;
    state.overlap_seconds = args.overlap_seconds;
    let config = BridgeConfig {
        interval: Duration::from_secs(args.interval_secs),
        // A rehearsal plans the current state and binds nothing, so repeating it
        // would just report the same plan again with inflated totals. One cycle.
        cycles: if args.dry_run {
            Some(1)
        } else {
            (args.cycles > 0).then_some(args.cycles)
        },
        dry_run: args.dry_run,
    };

    // Build both directions. The publisher needs the relay and the bridge key;
    // the responder needs Paperclip read and write access.
    let read_source = PaperclipRestSource::new(paperclip_url.clone(), issues_path, read_key, 1000)?
        .with_incremental_param(args.incremental_param.clone())
        .with_max_pages(args.max_pages);
    let writer = RestIssueWriter::new(paperclip_url, company_id, write_key)?;

    let report = match bridge_endpoints(&args)? {
        (Endpoints::Files { issues, tasks }, publisher) => {
            let source = JsonFileSource::new(issues);
            let feed = JsonFileTaskFeed::new(tasks);
            Box::pin(run_bridge(
                BridgeRun {
                    source: &source,
                    publisher: &publisher,
                    feed: &feed,
                    writer: &writer,
                    sync_config: &sync_config,
                    apply_config: &apply_config,
                    state: &mut state,
                },
                &config,
                &args.state,
                shutdown_signal(),
            ))
            .await?
        }
        (Endpoints::Relay { feed }, publisher) => {
            Box::pin(run_bridge(
                BridgeRun {
                    source: &read_source,
                    publisher: &publisher,
                    feed: &feed,
                    writer: &writer,
                    sync_config: &sync_config,
                    apply_config: &apply_config,
                    state: &mut state,
                },
                &config,
                &args.state,
                shutdown_signal(),
            ))
            .await?
        }
    };

    if args.json {
        let text = serde_json::to_string_pretty(&report)
            .map_err(|error| BridgeError::Config(format!("cannot serialize report: {error}")))?;
        println!("{text}");
    } else {
        println!(
            "cycles={} created={} patched={} projected={} publish_failures={} sync_failures={} apply_failures={} shutdown={}",
            report.cycles,
            report.created,
            report.patched,
            report.projected_created + report.projected_updated,
            report.publish_failures,
            report.sync_failures,
            report.apply_failures,
            report.shutdown_requested
        );
        if let Some(error) = report.last_error.as_deref() {
            println!("  last error: {error}");
        }
    }
    Ok(if report.sync_failures == 0 && report.apply_failures == 0 {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(2)
    })
}

/// Where the bridge reads Buzz task rows from.
enum Endpoints {
    Files { issues: PathBuf, tasks: PathBuf },
    Relay { feed: RelayTaskFeed },
}

fn bridge_endpoints(args: &BridgeArgs) -> Result<(Endpoints, RelayPublisher), BridgeError> {
    let relay_url = required(&args.relay_url, "--relay-url or BUZZ_RELAY_URL")?;
    let private_key = required(&args.private_key, "--private-key or BUZZ_PRIVATE_KEY")?;
    let keys = nostr::Keys::parse(private_key.trim())
        .map_err(|error| BridgeError::Config(format!("invalid bridge key: {error}")))?;
    let publisher = RelayPublisher::new(relay_url.clone(), keys.clone(), 15);

    if let (Some(issues), Some(tasks)) = (args.from_json.as_ref(), args.tasks_from_json.as_ref()) {
        return Ok((
            Endpoints::Files {
                issues: issues.clone(),
                tasks: tasks.clone(),
            },
            publisher,
        ));
    }
    Ok((
        Endpoints::Relay {
            feed: RelayTaskFeed::new(
                relay_url,
                keys,
                args.channel.clone(),
                Duration::from_secs(15),
            ),
        },
        publisher,
    ))
}

/// Resolve when the process is asked to stop.
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = match signal(SignalKind::terminate()) {
            Ok(term) => term,
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
                return;
            }
        };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

async fn run_invite_command(args: InviteArgs) -> Result<ExitCode, BridgeError> {
    let company_id = required(&args.company, "--company or PAPERCLIP_COMPANY_ID")?;
    let channel = required(&args.channel, "--channel or BUZZ_CHANNEL_ID")?;
    let request = if args.agent {
        InviteRequest::agent()
    } else {
        InviteRequest::human(&args.role).map_err(BridgeError::Config)?
    };

    let issuer = RestInviteIssuer::new(
        required(&args.paperclip_url, "--paperclip-url or PAPERCLIP_BASE_URL")?,
        company_id,
        args.paperclip_api_key.clone().unwrap_or_default(),
    )?;

    let relay_url = required(&args.relay_url, "--relay-url or BUZZ_RELAY_URL")?;
    let private_key = required(&args.private_key, "--private-key or BUZZ_PRIVATE_KEY")?;
    let keys = nostr::Keys::parse(private_key.trim())
        .map_err(|error| BridgeError::Config(format!("invalid bridge key: {error}")))?;
    let publisher =
        RelayMessagePublisher::new(RelayPublisher::new(relay_url, keys.clone(), 15), keys);

    let outcome = invite_member(&issuer, &publisher, &channel, &request, args.dry_run).await?;

    if args.json {
        let text = serde_json::to_string_pretty(&outcome)
            .map_err(|error| BridgeError::Config(format!("cannot serialize outcome: {error}")))?;
        println!("{text}");
    } else {
        if let Some(url) = outcome.invite_url.as_deref() {
            println!("invite url: {url}");
        }
        if let Some(url) = outcome.onboarding_text_url.as_deref() {
            println!("agent onboarding: {url}");
        }
        if let Some(expiry) = outcome.expires_at.as_deref() {
            println!("expires: {expiry}");
        }
        println!("message: {}", outcome.message);
        match outcome.posted_event_id.as_deref() {
            Some(event_id) => println!("announced in the channel as {event_id}"),
            None if outcome.dry_run => println!("(rehearsal: nothing was created or posted)"),
            None => println!(
                "NOT announced: {}",
                outcome.post_error.as_deref().unwrap_or("unknown error")
            ),
        }
    }

    Ok(if outcome.post_error.is_none() {
        ExitCode::SUCCESS
    } else {
        // The invite exists and is single-use; the operator can still share the
        // link, so this is a partial failure rather than a clean success.
        ExitCode::from(2)
    })
}
