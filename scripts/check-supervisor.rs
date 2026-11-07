//! The trusted PID-1 deadline supervisor for `buzz launchpad work-checks`.
//!
//! WHY THIS EXISTS: the previous shape ran Docker's built-in `--init` (tini)
//! plus the image's busybox `timeout`. A same-UID check inside the namespace
//! could SIGSTOP the busybox watchdog child (it is not PID 1) and hang past
//! its deadline. This program replaces both with one trusted binary:
//!
//! * It runs as the container's TRUE PID 1 (no `--init`, no tini). A same-UID
//!   child inside its PID namespace cannot give default-disposition signals
//!   (TERM/HUP/STOP/SIGKILL-as-default semantics apply) to the namespace
//!   init and cannot achieve anything by stopping it; it holds no
//!   capabilities (the container's `--cap-drop ALL` applies to the whole
//!   namespace), so there is no ptrace path either.
//! * It spawns the declared check as its direct child with stdio INHERITED
//!   (no pipes to dead-lock on), argv only — no shell.
//! * With a monotonic deadline: on the child's exit it reaps and exits with
//!   that code immediately; at the deadline it SIGKILLs the child, reaps it,
//!   and exits 124 immediately. When PID 1 exits, the kernel destroys the
//!   remaining processes of the PID namespace — every grandchild, orphan and
//!   `setsid` escape dies with the container, even if the host docker client
//!   itself was killed before the deadline.
//!
//! This is deliberately under 150 lines of pure `std`, no unsafe, no signal
//! handlers, no fork framework. It is separate trusted code, never part of
//! the artifact or the runtime image: the CLI verifies its size, mode and
//! sha256 against a paired manifest and mounts it read-only at a fixed path.
//!
//! Usage: check-supervisor <deadline-secs> <program> [args...]
//! Exit codes: 0/child's exit code on child exit; 124 on deadline; 64 on
//! usage error; 127/126 for spawn failures — reported on stderr in one line.

use std::process::Command;
use std::time::{Duration, Instant};

const SUPERVISOR_EXIT_USAGE: i32 = 64;
const SUPERVISOR_EXIT_TIMED_OUT: i32 = 124;

fn fail(code: i32, message: String) -> ! {
    eprintln!("check-supervisor: {message}");
    std::process::exit(code)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // The deadline comes first, then the program and its argv. Everything is
    // argv: the CLI builds this shape and never routes through a shell.
    let Some(deadline_secs) = args.first().map(|a| a.parse::<u64>()) else {
        fail(
            SUPERVISOR_EXIT_USAGE,
            "usage: check-supervisor <deadline-secs> <program> [args...]".into(),
        )
    };
    let deadline_secs = match deadline_secs {
        Ok(round) if (1..=86_400).contains(&round) => round,
        _ => fail(
            SUPERVISOR_EXIT_USAGE,
            "deadline-secs must be an integer 1..=86400".into(),
        ),
    };
    let program = args.get(1).map(|p| p.to_string()).unwrap_or_default();
    if program.is_empty() {
        fail(SUPERVISOR_EXIT_USAGE, "no program named".into());
    }

    let deadline = Instant::now() + Duration::from_secs(deadline_secs);
    let mut child = match Command::new(&program)
        .args(&args[2..])
        .spawn()
    {
        Ok(child) => child,
        Err(e) => fail(
            127,
            format!("could not start {program:?}: {e}"),
        ),
    };

    loop {
        match child.try_wait() {
            // The child (the declared check) exited: reap and report its
            // status. PID 1 exiting tears the namespace down — any daemon it
            // forked outside our supervision dies here with the container.
            Ok(Some(status)) => match status.code() {
                Some(code) => std::process::exit(code),
                // The child died by signal (its own SIGKILL etc.); report
                // 128+signal-equivalent so output is not a silent success.
                None => std::process::exit(137),
            },
            Ok(None) => {
                if Instant::now() >= deadline {
                    // The deadline: SIGKILL the direct child — same-UID or
                    // not, the child cannot have stopped, handler-escaped
                    // or ignored this from inside our own namespace. Then
                    // reap on a small bounded loop and exit; the kernel
                    // kills the rest of the namespace at our exit.
                    let _ = child.kill();
                    let reap_deadline = Instant::now() + Duration::from_secs(2);
                    loop {
                        match child.try_wait() {
                            Ok(Some(_)) | Err(_) => break,
                            Ok(None) => {
                                if Instant::now() >= reap_deadline {
                                    break;
                                }
                                std::thread::sleep(Duration::from_millis(4));
                            }
                        }
                    }
                    std::process::exit(SUPERVISOR_EXIT_TIMED_OUT);
                }
                std::thread::sleep(Duration::from_millis(4));
            }
            // try_wait on pid 1 breaking is fatal for the namespace anyway:
            // exit honestly, kernel-destroy the rest of the tree.
            Err(e) => fail(
                126,
                format!("waiting for {program:?} failed: {e}"),
            ),
        }
    }
}
