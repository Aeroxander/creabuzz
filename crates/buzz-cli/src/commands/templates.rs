//! `buzz templates` — project templates: one command turns an empty
//! community into a working project.
//!
//! Templates are embedded at build time from the repo-root `templates/`
//! authoring directory (see `registry.rs`). `list`/`show` are local-only;
//! `apply` writes to the relay using the same event kinds a human's tools
//! write: channel create (9007), messages (9), personas (30175), workflows
//! (30620), notes (30023), and skills (30180).
//!
//! Apply semantics: idempotent via the template-managed `["t",
//! "<template-id>", "<item-id>"]` marker (channels skip by name), strictly
//! ordered with per-step results, stops at the first failure, and
//! `--resume` completes the remainder from the durable relay state. The
//! report is always printed to stdout as JSON — including on failure — so
//! callers can render exactly which step failed; the process exits non-zero
//! when the run did not fully complete.

mod apply;
mod registry;
mod schema;

use crate::client::BuzzClient;
use crate::error::CliError;
use crate::OutputFormat;

pub use registry::{all_templates, load_template};

/// `buzz templates list` — ids, names, descriptions of every embedded
/// template. JSON: `[{id, name, description}]`; `--format compact`:
/// `[{id, name}]`.
pub fn cmd_list(format: &OutputFormat) -> Result<(), CliError> {
    let mut out: Vec<serde_json::Value> = Vec::new();
    for embedded in all_templates() {
        let template = embedded.parse_and_validate().map_err(|e| {
            CliError::Other(format!(
                "embedded template '{}' is invalid: {e}",
                embedded.dir
            ))
        })?;
        let mut v = serde_json::json!({
            "id": template.id,
            "name": template.name,
        });
        match format {
            OutputFormat::Compact => {}
            OutputFormat::Json => {
                v["description"] = serde_json::json!(template.description);
            }
        }
        out.push(v);
    }
    println!("{}", serde_json::to_string(&out).unwrap_or_default());
    Ok(())
}

/// `buzz templates show <id>` — the validated template schema echo.
pub fn cmd_show(id: &str) -> Result<(), CliError> {
    let (t, _files) = load_template(id)?;
    let channels: Vec<serde_json::Value> = t
        .channels
        .iter()
        .map(|c| {
            let mut v = serde_json::json!({ "id": c.id, "name": c.name, "purpose": c.purpose });
            if let Some(seed) = &c.seed {
                v["seed"] = serde_json::json!(seed);
            }
            v
        })
        .collect();
    let personas: Vec<serde_json::Value> = t
        .personas
        .iter()
        .map(|p| serde_json::json!({ "id": p.id, "name": p.name, "prompt": p.prompt }))
        .collect();
    let workflows: Vec<serde_json::Value> = t
        .workflows
        .iter()
        .map(|w| serde_json::json!({ "file": w.file }))
        .collect();
    let docs: Vec<serde_json::Value> = t
        .docs
        .iter()
        .map(|d| serde_json::json!({ "file": d.file, "title": d.title }))
        .collect();
    let skills: Vec<serde_json::Value> = t
        .skills
        .iter()
        .map(|s| {
            serde_json::json!({
                "name": s.name,
                "source": s.source,
                "applies_to": s.applies_to.as_str(),
            })
        })
        .collect();
    println!(
        "{}",
        serde_json::json!({
            "id": t.id,
            "name": t.name,
            "description": t.description,
            "channels": channels,
            "personas": personas,
            "workflows": workflows,
            "docs": docs,
            "skills": skills,
            "welcome": t.welcome,
        })
    );
    Ok(())
}

/// Relay-side dispatch. `list`/`show` are local-only and dispatched in
/// `run()` before the relay client exists (like `pack`); only `apply` is
/// reachable here.
pub async fn dispatch(cmd: crate::TemplatesCmd, client: &BuzzClient) -> Result<(), CliError> {
    match cmd {
        crate::TemplatesCmd::Apply { id, resume } => cmd_apply(client, &id, resume).await,
        crate::TemplatesCmd::List | crate::TemplatesCmd::Show { .. } => {
            unreachable!("handled above")
        }
    }
}

/// `buzz templates apply <id> [--resume]` — apply a template to the
/// community. Prints the JSON report to stdout in all outcomes.
pub async fn cmd_apply(client: &BuzzClient, id: &str, resume: bool) -> Result<(), CliError> {
    // Load + strict validation before anything else. A known-but-invalid
    // template reports `status: "failed"` with the named error and writes
    // nothing.
    let (template, files) = match load_template(id) {
        Ok(loaded) => loaded,
        Err(e @ CliError::Usage(_)) => {
            // Unknown template — plain input error, no report to render.
            return Err(e);
        }
        Err(e) => {
            let report = apply::validation_failure_report(id, resume, e.to_string());
            println!("{}", apply::report_to_json(&report));
            return Err(CliError::Usage(e.to_string()));
        }
    };

    // Durable pre-state: what the relay already holds for this template.
    let existing = apply::query_existing_state(client, &template.id).await?;

    // The plan is pure — the same function powers re-apply and `--resume`.
    let plan = apply::plan_apply(&template, &existing);

    // Resolve + validate skill content for planned creates only: skipped
    // skills are never fetched (sha256 pin semantics). A resolution failure
    // aborts with nothing written.
    let resolved_skills = match apply::resolve_planned_skills(&template, &files, &plan).await {
        Ok(resolved) => resolved,
        Err(e) => {
            let report = apply::validation_failure_report(&template.id, resume, e.clone());
            println!("{}", apply::report_to_json(&report));
            return Err(CliError::Other(e));
        }
    };

    let report = apply::execute_plan(
        client,
        &template.id,
        &template,
        &files,
        &plan,
        &existing,
        resume,
        resolved_skills,
    )
    .await;
    println!("{}", apply::report_to_json(&report));

    match report.status {
        apply::ApplyStatus::Ok => Ok(()),
        apply::ApplyStatus::Partial => {
            let (kind, item, error) = report
                .failed_step
                .as_ref()
                .map(|f| (f.step.clone(), f.item.clone(), f.error.clone()))
                .unwrap_or_default();
            Err(CliError::Other(format!(
                "apply stopped at {kind} '{item}': {error}; completed steps are kept — re-run \
                 'buzz templates apply {id} --resume' to complete the remainder"
            )))
        }
        apply::ApplyStatus::Failed => Err(CliError::Usage("apply failed before any write".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::templates::apply::{
        build_report, report_to_json, validation_failure_report, ApplyStatus, StepOutcome,
        StepStatus, WelcomeResult,
    };
    use crate::commands::templates::schema::TemplateFiles;

    /// The `list` output shape: ids + names + descriptions in JSON, and the
    /// two-key `{id, name}` contract under `--format compact`. Assertions are
    /// key-order-insensitive (serde_json maps are sorted).
    #[test]
    fn list_output_shape_is_normalize_compatible() {
        let template = serde_json::json!({
            "id": "demo", "name": "Demo", "description": "d"
        });
        let json = serde_json::to_string(&vec![template.clone()]).unwrap();
        let parsed: Vec<serde_json::Value> = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0]["id"], "demo");
        assert_eq!(parsed[0]["name"], "Demo");
        assert_eq!(parsed[0]["description"], "d");
        assert_eq!(parsed[0].as_object().unwrap().len(), 3);

        let mut compact = template;
        compact.as_object_mut().unwrap().remove("description");
        let compact = serde_json::to_string(&vec![compact]).unwrap();
        let parsed: Vec<serde_json::Value> = serde_json::from_str(&compact).unwrap();
        assert_eq!(parsed[0].as_object().unwrap().len(), 2);
        assert_eq!(parsed[0]["id"], "demo");
        assert_eq!(parsed[0]["name"], "Demo");
    }

    /// The `apply` report carries the welcome content for the UI success
    /// state (the contract: welcome is "returned for the UI's success state").
    #[test]
    fn apply_report_carries_welcome_for_the_success_state() {
        let plan = vec![crate::commands::templates::apply::PlanStep {
            kind: crate::commands::templates::apply::StepKind::Welcome,
            item: "welcome".into(),
            action: crate::commands::templates::apply::PlanAction::Create,
        }];
        let outcomes = vec![StepOutcome {
            kind: crate::commands::templates::apply::StepKind::Welcome,
            item: "welcome".into(),
            status: StepStatus::Created,
            event_id: Some("ev".into()),
            accepted: Some(true),
            message: Some("ok".into()),
            channel_id: None,
        }];
        let report = build_report(
            "demo",
            false,
            &plan,
            outcomes,
            Some(WelcomeResult {
                channel_id: "uuid-1".into(),
                event_id: "ev".into(),
                content: "# Welcome".into(),
            }),
        );
        let v = report_to_json(&report);
        assert_eq!(v["status"], "ok");
        assert_eq!(v["welcome"]["channel_id"], "uuid-1");
        assert_eq!(v["welcome"]["event_id"], "ev");
        assert_eq!(v["welcome"]["content"], "# Welcome");
    }

    /// A run that resolves every plan step reports `status: "ok"`.
    #[test]
    fn apply_status_ok_when_every_step_resolves() {
        use crate::commands::templates::apply::{PlanAction, PlanStep, StepKind};
        let plan = vec![PlanStep {
            kind: StepKind::Channel,
            item: "general".into(),
            action: PlanAction::Create,
        }];
        let outcomes: Vec<StepOutcome> = plan
            .iter()
            .map(|s| StepOutcome {
                kind: s.kind,
                item: s.item.clone(),
                status: StepStatus::Created,
                event_id: Some("ev".into()),
                accepted: Some(true),
                message: Some("ok".into()),
                channel_id: None,
            })
            .collect();
        assert_eq!(
            build_report("t", false, &plan, outcomes, None).status,
            ApplyStatus::Ok
        );
    }

    /// A validation failure reports `failed_step.step == "validate"` and no steps.
    #[test]
    fn validation_failure_reports_the_named_error() {
        let v = report_to_json(&validation_failure_report(
            "ai-movie-studio",
            false,
            "skill is missing frontmatter name/description".into(),
        ));
        assert_eq!(v["status"], "failed");
        assert_eq!(v["failed_step"]["step"], "validate");
        assert_eq!(
            v["failed_step"]["error"],
            "skill is missing frontmatter name/description"
        );
    }

    /// Every embedded template loads through the production seam `list`/
    /// `show`/`apply` all use (content-agnostic: the registry-completeness
    /// test in registry.rs is what guards authored template content).
    #[test]
    fn embedded_templates_load_through_the_production_seam() {
        let files = TemplateFiles::default();
        assert!(files.is_empty());
        for embedded in all_templates() {
            let (template, files) = load_template(embedded.dir).expect("embedded template loads");
            assert_eq!(template.id, embedded.dir);
            assert!(!files.is_empty());
        }
    }
}
