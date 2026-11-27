//! `buzz launchpad` commands: the project and manager commands the agent docs use.
//!
//! The chain is the ledger; Nostr is the record. This file only routes: each command lives in its own
//! `launchpad_*` module.

use crate::client::BuzzClient;
use crate::error::CliError;

const LAUNCH_ID_RE: &str = "^[a-z0-9][a-z0-9_-]{0,63}$";

pub(crate) fn validate_launch_id(id: &str) -> Result<(), CliError> {
    let ok = !id.is_empty() && id.len() <= 64 && {
        let bytes = id.as_bytes();
        (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
            && bytes[1..]
                .iter()
                .all(|&b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
    };
    if ok {
        Ok(())
    } else {
        Err(CliError::Usage(format!(
            "launch id must match {LAUNCH_ID_RE} (got {id:?})"
        )))
    }
}

pub async fn dispatch(cmd: crate::LaunchpadCmd, client: &BuzzClient) -> Result<(), CliError> {
    use crate::LaunchpadCmd;
    match cmd {
        LaunchpadCmd::Start {
            name,
            goal,
            how,
            pitch,
        } => {
            super::launchpad_start::cmd_start(
                client,
                &super::launchpad_start::StartArgs {
                    name,
                    goal,
                    how,
                    pitch,
                },
            )
            .await
        }
        LaunchpadCmd::Tasks { step } => super::launchpad_tasks::dispatch(step, client).await,
        LaunchpadCmd::Brain { step } => super::launchpad_brain::dispatch(&step),
        LaunchpadCmd::Manager { step } => super::launchpad_manager::dispatch(step, client).await,
        LaunchpadCmd::Seasons { step } => super::launchpad_seasons::dispatch(step, client).await,
        LaunchpadCmd::Updates { step } => super::launchpad_record::dispatch(step, client).await,
        LaunchpadCmd::Record { id, author } => {
            super::launchpad_record::cmd_record(client, &id, author.as_deref()).await
        }
        LaunchpadCmd::WorkChecks {
            launch,
            launch_author,
            claim,
            mandate,
            evidence_hash,
            check_text,
            check_hash,
            work_area_text,
            work_area_hash,
            task,
            evidence,
            checks,
            dir,
            timeout_secs,
            total_cap_secs,
            output_cap_bytes,
            env,
            summarize,
            model,
            no_publish,
            sandbox_image,
            sandbox_supervisor,
        } => {
            crate::commands::work_checks::cmd_work_checks(
                &crate::commands::work_checks::WorkChecksArgs {
                    launch,
                    launch_author,
                    claim,
                    mandate,
                    evidence_hash,
                    check_text,
                    check_hash,
                    work_area_text,
                    work_area_hash,
                    task,
                    evidence,
                    checks_file: checks,
                    dir,
                    timeout_secs,
                    total_cap_secs,
                    output_cap_bytes,
                    envs: env,
                    summarize,
                    model,
                    no_publish,
                    sandbox_image,
                    sandbox_supervisor,
                },
                client,
            )
            .await
        }
    }
}
