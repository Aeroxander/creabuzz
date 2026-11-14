//! `buzz-admin reports`: the moderation reports across every community on this
//! server, newest first. `--escalated` lists the ones a community's moderators
//! passed on to the server's owner, for operators without the web app.

use std::fmt::Write as _;

use anyhow::Result;
use buzz_db::admin_moderation::AdminReport;

/// List reports as plain text: escalated ones with `--escalated`, else every status.
pub async fn run(escalated: bool, limit: u16) -> Result<i32> {
    let db = crate::connect_db().await?;
    let status = escalated.then_some("escalated");
    let reports = db
        .admin_list_reports(None, status, None, None, None, None, None, i64::from(limit))
        .await?;
    print!("{}", report_lines(&reports, escalated));
    Ok(0)
}

/// What the operator reads: one block per report, or a line saying there are none.
pub(crate) fn report_lines(reports: &[AdminReport], escalated: bool) -> String {
    if reports.is_empty() {
        return if escalated {
            "No escalated reports.\n".to_string()
        } else {
            "No reports.\n".to_string()
        };
    }
    let mut out = String::new();
    for report in reports {
        // An escalated report's decision time is when it was passed on; one
        // that arrived escalated (an illegal-content report) has none.
        let when = report.resolved_at.unwrap_or(report.created_at);
        let _ = writeln!(
            out,
            "{}  {}  {}  {}",
            when.format("%Y-%m-%d %H:%M UTC"),
            report.community_host,
            report.report_type,
            report.status
        );
        let about = match report.target_kind.as_str() {
            "event" => match &report.target_author_pubkey {
                Some(author) => format!("post {} by {author}", report.target),
                None => format!("post {}", report.target),
            },
            "pubkey" => format!("person {}", report.target),
            other => format!("{other} {}", report.target),
        };
        let _ = writeln!(out, "  about:       {about}");
        if let Some(channel) = report.channel_id {
            let _ = writeln!(out, "  room/board:  {channel}");
        }
        let _ = writeln!(out, "  reported by: {}", report.reporter_pubkey);
        if let Some(note) = &report.note {
            let _ = writeln!(out, "  why:         {note}");
        }
        let _ = writeln!(out, "  report id:   {}", report.id);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;
    use uuid::Uuid;

    fn report(status: &str) -> AdminReport {
        AdminReport {
            id: Uuid::nil(),
            community_id: Uuid::nil(),
            community_host: "pilot.example".to_string(),
            report_event_id: "e".repeat(64),
            reporter_pubkey: "a".repeat(64),
            target_kind: "event".to_string(),
            target: "b".repeat(64),
            target_author_pubkey: Some("c".repeat(64)),
            channel_id: None,
            report_type: "spam".to_string(),
            note: Some("buy now".to_string()),
            status: status.to_string(),
            resolved_by: Some("d".repeat(64)),
            resolved_at: Some("2026-11-01T09:30:00Z".parse().unwrap()),
            action_id: None,
            created_at: "2026-10-31T08:00:00Z".parse().unwrap(),
        }
    }

    #[test]
    fn reports_command_parses_escalated_and_limit() {
        let cli =
            crate::Cli::try_parse_from(["buzz-admin", "reports", "--escalated", "--limit", "5"])
                .expect("parse reports command");
        assert!(matches!(
            cli.command,
            crate::Command::Reports {
                escalated: true,
                limit: 5
            }
        ));
        let cli = crate::Cli::try_parse_from(["buzz-admin", "reports"]).expect("parse");
        assert!(matches!(
            cli.command,
            crate::Command::Reports {
                escalated: false,
                limit: 50
            }
        ));
    }

    #[test]
    fn an_escalated_report_names_when_where_what_and_who() {
        let text = report_lines(&[report("escalated")], true);
        assert!(text.starts_with("2026-11-01 09:30 UTC  pilot.example  spam  escalated\n"));
        assert!(text.contains(&format!("post {} by {}", "b".repeat(64), "c".repeat(64))));
        assert!(text.contains(&format!("reported by: {}", "a".repeat(64))));
        assert!(text.contains("why:         buy now"));
        assert!(text.contains(&format!("report id:   {}", Uuid::nil())));
    }

    #[test]
    fn a_report_that_arrived_escalated_is_dated_when_it_was_made() {
        let mut arrived = report("escalated");
        arrived.resolved_at = None;
        assert!(report_lines(&[arrived], true).starts_with("2026-10-31 08:00 UTC"));
    }

    #[test]
    fn no_reports_says_so() {
        assert_eq!(report_lines(&[], true), "No escalated reports.\n");
        assert_eq!(report_lines(&[], false), "No reports.\n");
    }
}
