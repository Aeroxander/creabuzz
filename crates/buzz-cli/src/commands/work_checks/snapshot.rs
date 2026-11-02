//! The bounded read-only snapshot of the artifact: what the container is
//! allowed to see of the host filesystem. Regular files only, directories
//! recursed with their real hierarchy preserved, count-, entry-, depth-, time-
//! and byte-bounded, non-regular kinds rejected outright, and symlinks
//! accepted only when they resolve to a regular file *inside* the artifact —
//! an escaping or dead link refuses the snapshot outright, BEFORE any check
//! can run.
//!
//! How the copy itself is hardened (each bound is enforced on the bytes that
//! actually reach the snapshot, never on a claim taken earlier):
//!
//! * One exclusive private temp root per run (0700, random name, created
//!   uniquely, never a pre-existing path): the snapshot cannot be planted or
//!   pre-created by another process, and cleanup removes only the directory
//!   this run's own exclusive creation gave it.
//! * Files are copied by OPENED-FD: the byte budget is charged on the bytes
//!   actually streamed, and exactly the opened file's stated length is read —
//!   a file that grows past its opened state while copying cannot push extra
//!   bytes in, and one that truncates mid-read fails the snapshot closed
//!   instead of delivering torn state. Regular-ness is re-verified on the
//!   opened handle BEFORE any byte is written, so a swap that yields a
//!   socket, device, or fifo refuses the copy once open returns. This is NOT
//!   a claim of race-freedom: `File::open` itself can block (a swapped-in
//!   fifo blocks its open), and safe Rust cannot interrupt a blocked syscall
//!   or a blocked filesystem call.
//! * The sha256 manifest is hashed WHILE copying, over the bytes actually
//!   written into the snapshot under their delivered relative names. The
//!   digest therefore describes the snapshot the container actually sees —
//!   never a second walk over the untrusted source, and never a hash of a
//!   different tree than the one mounted.
//! * The time bound is COOPERATIVE: it is checked at every decision point
//!   this process controls — per directory entry and per copied chunk. A
//!   filesystem call that is itself blocked cannot be interrupted or
//!   re-claimed; the bound bounds the walk our code executes, not a hung
//!   syscall.
//!
//! Known limitation, stated plainly (recorded, not proven safe): pure `std`
//! offers no openat/dirfd capability API and the workspace carries no such fs
//! dependency, so components of the ARTIFACT tree — including directory
//! ancestry — can be swapped or re-pointed by a concurrently running
//! same-user process between this process's calls, and no bounded `std`-only
//! walk fully closes that. Every *declared shape* is still refused outright
//! (escaping links, special files, symlinked-directory entries), what is read
//! is re-verified on its opened handle, and the residual race can only
//! produce a snapshot of files the running user already owns; the user
//! controls the artifact and no host code is executed by this path before
//! the copy completes. No capability framework is being built around this
//! here; the residual is what the record honestly carries.
//!
//! The snapshot is a private temp copy: no artifact bytes outlive the run in
//! a shared location, and its sha256 manifest travels in the signed record.

use sha2::Digest;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Bounded snapshot: regular files only (directories recurse), count- and
/// byte-bounded, devices/sockets/fifos rejected, escaping symlinks rejected.
pub(crate) const SNAPSHOT_MAX_FILES: usize = 4_096;
pub(crate) const SNAPSHOT_MAX_BYTES: u64 = 128 * 1024 * 1024;
/// Total walked entries (files AND directories combined): bounds empty-tree
/// bombs and directory-count abuse, not just regular files.
const SNAPSHOT_MAX_ENTRIES: usize = 64 * 1024;
/// Directory-depth bound (pathological deep nesting, also stack safety).
const SNAPSHOT_MAX_DEPTH: usize = 64;
/// Whole-traversal cooperative wall-clock bound: checked per directory entry
/// and per copied chunk — wherever this process is executing its own code. A
/// filesystem call that is itself blocked cannot be interrupted by safe-Rust
/// code; the bound bounds the decision points, not a blocked syscall.
const SNAPSHOT_MAX_DURATION: Duration = Duration::from_secs(30);
/// Streamed copy chunk size.
const COPY_CHUNK_BYTES: usize = 64 * 1024;
/// The shared cooperative-timeout refusal, worded once.
const DEADLINE_EXCEEDED: &str =
    "the artifact snapshot exceeded its time bound; the artifact is too large or too \
     slow to read — list a smaller meaningful artifact";
/// The 0700 private root holds the readable artifact layer below it.
const ARTIFACT_LAYER_NAME: &str = "artifact";
/// Exclusive, recognizable temp prefix (forensic cleanup tooling only;
/// cleanup keys off exclusive creation, never prefix sweeps).
const TEMP_ROOT_PREFIX: &str = "buzz-check-artifact-";

#[derive(Debug)]
/// A bounded snapshot of the artifact under a self-removing temp directory.
pub(crate) struct Snapshot {
    /// The readable artifact layer the container mounts read-only. It always
    /// sits under the private 0700 temp root held by `_root`.
    pub dir: PathBuf,
    pub files: usize,
    pub bytes: u64,
    /// sha256 over the snapshot's delivered sorted (relative path, sha256)
    /// manifest — computed while copying, over bytes actually in `dir`.
    pub digest: String,
    /// The owned, exclusive temp root (0700). Dropping the snapshot removes
    /// this root and everything inside it — a path this run's own exclusive
    /// creation gave it, never a pre-existing one.
    _root: tempfile::TempDir,
}

/// The bounds one snapshot enforces, in one place so callers cannot deliver a
/// half-bounded walk.
#[derive(Debug, Clone)]
pub(crate) struct SnapshotBounds {
    pub max_files: usize,
    pub max_bytes: u64,
    pub max_entries: usize,
    pub max_depth: usize,
    pub max_duration: Duration,
}

impl SnapshotBounds {
    /// The production bounds (the two shared ones are re-exported by the
    /// sandbox for its record).
    pub(crate) fn production() -> Self {
        SnapshotBounds {
            max_files: SNAPSHOT_MAX_FILES,
            max_bytes: SNAPSHOT_MAX_BYTES,
            max_entries: SNAPSHOT_MAX_ENTRIES,
            max_depth: SNAPSHOT_MAX_DEPTH,
            max_duration: SNAPSHOT_MAX_DURATION,
        }
    }
}

pub(crate) fn snapshot_artifact(artifact_dir: &Path) -> Result<Snapshot, String> {
    snapshot_bounded(artifact_dir, &SnapshotBounds::production())
}

fn snapshot_bounded(artifact_dir: &Path, bounds: &SnapshotBounds) -> Result<Snapshot, String> {
    if !artifact_dir.is_dir() {
        return Err(format!("{} is not a directory", artifact_dir.display()));
    }
    if bounds.max_files == 0 || bounds.max_bytes == 0 {
        return Err(
            "the snapshot bounds are degenerate (no file or no byte would \
                    fit); refusing the run"
                .into(),
        );
    }
    // One canonical root, resolved ONCE: every containment check below
    // compares against this exact tree, not a per-link re-resolution of it.
    let root_canonical = std::fs::canonicalize(artifact_dir)
        .map_err(|e| format!("cannot resolve the artifact root: {e}"))?;
    let deadline = Instant::now() + bounds.max_duration;

    // Exclusive private root (0700): creation fails if the path already
    // exists — a pre-planted or foreign path is never removed, the run fails
    // closed instead — and the name is random, so there is no guessable path
    // for another process's state to walk into.
    let mut builder = tempfile::Builder::new();
    builder.prefix(TEMP_ROOT_PREFIX);
    #[cfg(unix)]
    builder.permissions({
        use std::os::unix::fs::PermissionsExt;
        std::fs::Permissions::from_mode(0o700)
    });
    let root = builder
        .tempdir()
        .map_err(|e| format!("snapshot temp dir: {e}"))?;
    // The readable artifact layer (0755) with 0644 files: the container's
    // fixed non-root uid can read the approved copy after the bind, while
    // host-side exposure stays bounded by the 0700 private root around it.
    let out_dir = root.path().join(ARTIFACT_LAYER_NAME);
    mkdir_layer(&out_dir)?;

    let mut ctx = CopyContext {
        bounds,
        root_canonical,
        manifest: Vec::new(),
        files: 0,
        bytes: 0,
        entries: 0,
        deadline,
    };
    copy_tree(artifact_dir, Path::new(""), &out_dir, &mut ctx, 0)?;

    if ctx.files == 0 {
        return Err(
            "the artifact directory has no regular files; nothing would be readable \
             inside the sandbox"
                .into(),
        );
    }
    // The digest is over the DELIVERED snapshot: the manifest was assembled
    // while the bytes were written into this very tree.
    let mut manifest = ctx.manifest;
    manifest.sort();
    let mut hasher = sha2::Sha256::new();
    for (relative, digest) in &manifest {
        hasher.update(relative.as_bytes());
        hasher.update([0u8]);
        hasher.update(digest);
        hasher.update(b"\n");
    }
    Ok(Snapshot {
        dir: out_dir,
        files: ctx.files,
        bytes: ctx.bytes,
        digest: format!("0x{}", hex::encode(hasher.finalize())),
        _root: root,
    })
}

/// State threaded through the whole traversal; every global bound is checked
/// against this shared context, so no subtree can evade a cap.
struct CopyContext<'a> {
    bounds: &'a SnapshotBounds,
    root_canonical: PathBuf,
    manifest: Vec<(String, [u8; 32])>,
    files: usize,
    bytes: u64,
    entries: usize,
    deadline: Instant,
}

/// Rejects the non-regular and the escaping before copying anything, recurses
/// real directories with their RELATIVE path preserved (the root passed down
/// is exactly the artifact root — a nested directory is never re-homed as a
/// new one), and hashes every delivered file as it is copied.
fn copy_tree(
    src_dir: &Path,
    rel_dir: &Path,
    out_dir: &Path,
    ctx: &mut CopyContext,
    depth: usize,
) -> Result<(), String> {
    if Instant::now() >= ctx.deadline {
        return Err(DEADLINE_EXCEEDED.into());
    }
    if depth >= ctx.bounds.max_depth {
        return Err(format!(
            "the artifact nests deeper than {} directories; the snapshot is bounded — \
             flatten the artifact",
            ctx.bounds.max_depth
        ));
    }
    let entries = std::fs::read_dir(src_dir)
        .map_err(|e| format!("cannot read {}: {e}", src_dir.display()))?;
    for entry in entries {
        // An unreadable entry is a failed snapshot, never a silently skipped
        // one: dropping the error would hide part of the artifact from the
        // container and from the record.
        let entry = entry.map_err(|e| format!("cannot enumerate {}: {e}", src_dir.display()))?;
        ctx.entries += 1;
        if ctx.entries > ctx.bounds.max_entries {
            return Err(format!(
                "the artifact has more than {} entries (files and directories); the \
                 snapshot is bounded — list the meaningful artifact instead of a whole \
                 tree",
                ctx.bounds.max_entries
            ));
        }
        // The deadline is COOPERATIVE — it is checked per directory entry and
        // per copied chunk, wherever this process gets to decide anything. If
        // a filesystem call is itself blocked, no safe-Rust code can interrupt
        // it, and no safe-Rust wall clock can fire mid-syscall.
        if Instant::now() >= ctx.deadline {
            return Err(DEADLINE_EXCEEDED.into());
        }
        let path = entry.path();
        // Losslessly-required names: a lossy conversion could collapse two
        // distinct invalid names into the same copied path and silently
        // overwrite one of them, so a non-UTF-8 name refuses the snapshot.
        let name = match entry.file_name().to_str() {
            Some(name) => name.to_string(),
            None => {
                return Err(format!(
                    "the artifact contains a file name that is not valid UTF-8 \
                     (lossy: {:?}); the snapshot carries names losslessly and two \
                     unclearable names could overwrite one another — rename it",
                    entry.file_name().to_string_lossy()
                ))
            }
        };
        if name.contains('/') {
            return Err(format!("unexpected artifact file name {name:?}"));
        }
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(e) => return Err(format!("cannot stat {}: {e}", path.display())),
        };
        let file_type = metadata.file_type();
        let relative = rel_dir.join(&name);
        if file_type.is_dir() {
            // Real directory ENTRIES recurse (the entry itself was stat'ed
            // without following links). This bounds declared shapes only: a
            // directory component above or below can still be replaced by a
            // concurrently running same-uid process between our calls — that
            // is the recorded residual, not a proven-closed path.
            let nested = out_dir.join(&name);
            mkdir_layer(&nested)?;
            copy_tree(&path, &relative, &nested, ctx, depth + 1)?;
            continue;
        }
        if file_type.is_symlink() {
            // Link resolution against the ONE canonical artifact root: the
            // link must resolve, once, to a regular file inside it. What is
            // read afterwards is an opened handle that is re-verified as a
            // regular file before any byte is written, so a resolution that
            // yields a directory, socket, or device once the copy starts
            // refuses the snapshot rather than delivering it.
            let resolved = std::fs::canonicalize(&path)
                .map_err(|e| format!("cannot resolve link {name:?}: {e}"))?;
            let inside = resolved.starts_with(&ctx.root_canonical);
            if !inside || !resolved.is_file() {
                return Err(format!(
                    "the artifact contains a link {name:?} that does not resolve to a \
                     regular file inside it: remove it or list the real file instead"
                ));
            }
            let dest = out_dir.join(&name);
            let mut file =
                std::fs::File::open(&resolved).map_err(|e| format!("cannot open {name:?}: {e}"))?;
            copy_regular(&name, &relative, &mut file, &dest, ctx)?;
            continue;
        }
        if !file_type.is_file() {
            return Err(format!(
                "the artifact contains a non-regular file {name:?} (device, socket, or \
                 fifo); the sandbox copies regular files only — remove it or list a real \
                 file for the record"
            ));
        }
        // The entry is opened and the regular-file check happens on the
        // OPENED HANDLE inside copy_regular, before any byte is written: a
        // swap between stat and read that yields a special file refuses once
        // open returns. It does NOT make the race impossible — `File::open`
        // itself can block (a swapped-in fifo blocks its open), and nothing
        // in safe Rust interrupts a blocked syscall — the residual is
        // recorded in the module docs, not proven away.
        let dest = out_dir.join(&name);
        let mut file = std::fs::File::open(&path)
            .map_err(|e| format!("cannot open {}: {e}", path.display()))?;
        copy_regular(&name, &relative, &mut file, &dest, ctx)?;
    }
    Ok(())
}

/// Copy one regular file from an OPENED, re-verified handle into `dest`,
/// fully bounded: the byte budget is charged before and while streaming, the
/// exact declared length is read (a source that grows past its opened state
/// cannot widen the snapshot; one that truncates mid-read fails closed), the
/// streamed bytes are hashed into the manifest, and the delivered copy is
/// made readable to the container's fixed non-root uid.
fn copy_regular(
    display_name: &str,
    relative: &Path,
    src: &mut std::fs::File,
    dest: &Path,
    ctx: &mut CopyContext,
) -> Result<(), String> {
    if ctx.files >= ctx.bounds.max_files {
        return Err(format!(
            "the artifact has more than {} regular files; the snapshot is bounded — \
             list the meaningful artifact instead of a whole tree",
            ctx.bounds.max_files
        ));
    }
    // The opened handle's own state, not a path stat: regular-ness and length
    // of exactly what we are about to read.
    let opened = src
        .metadata()
        .map_err(|e| format!("cannot size {display_name:?}: {e}"))?;
    if !opened.file_type().is_file() {
        return Err(format!(
            "the artifact entry {display_name:?} opened to a non-regular file; the \
             sandbox copies regular files only"
        ));
    }
    let declared = opened.len();
    if ctx.bytes + declared > ctx.bounds.max_bytes {
        return Err(format!(
            "the artifact is more than {} bytes in total; the snapshot is bounded — \
             list the meaningful artifact instead of a whole tree",
            ctx.bounds.max_bytes
        ));
    }
    // Streamed copy: exactly `declared` bytes are read in chunks, charged,
    // hashed, and written. The cooperative deadline is checked per CHUNK
    // (first check: written 0 — the whole copy), not once per file; a large
    // single file or a wide directory is still bounded by it. A source that
    // grew past its opened state cannot push more bytes in; a truncated
    // source surfaces as a short read and refuses the snapshot instead of
    // delivering torn state.
    let mut digest = sha2::Sha256::new();
    let mut out = std::fs::File::create(dest)
        .map_err(|e| format!("cannot create {}: {e}", dest.display()))?;
    let mut written: u64 = 0;
    let mut buffer = vec![0u8; COPY_CHUNK_BYTES];
    while written < declared {
        if Instant::now() >= ctx.deadline {
            return Err(DEADLINE_EXCEEDED.into());
        }
        let want = usize::try_from(declared - written)
            .unwrap_or(buffer.len())
            .min(buffer.len());
        std::io::Read::read_exact(src, &mut buffer[..want]).map_err(|e| {
            format!(
                "the artifact file {display_name:?} changed while copying ({e}); \
                 refusing the snapshot — re-run when the artifact is stable"
            )
        })?;
        let chunk = &buffer[..want];
        digest.update(chunk);
        std::io::Write::write_all(&mut out, chunk)
            .map_err(|e| format!("cannot write {}: {e}", dest.display()))?;
        written += want as u64;
    }
    chmod_read_layer(dest)?;
    ctx.files += 1;
    ctx.bytes += written;
    ctx.manifest.push((
        relative
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/"),
        digest.finalize().into(),
    ));
    Ok(())
}

/// A directory of the readable artifact layer: 0755 so the container's fixed
/// non-root uid can traverse the copied hierarchy — beneath the 0700 private
/// root, so nothing is exposed to other host users. The 0755 is SET after
/// creation, not merely requested: mkdir's mode passes through the process
/// umask, and a strict umask would silently strand the container's uid.
fn mkdir_layer(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir(path).map_err(|e| format!("snapshot mkdir: {e}"))?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("cannot set permissions on {}: {e}", path.display()))
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir(path).map_err(|e| format!("snapshot mkdir: {e}"))
    }
}

/// A delivered file of the readable artifact layer: 0644, so the container's
/// fixed non-root user reads even a source that was 0600 on the host.
fn chmod_read_layer(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o644))
            .map_err(|e| format!("cannot set permissions on {}: {e}", path.display()))
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

#[cfg(test)]
#[path = "snapshot_tests.rs"]
mod snapshot_tests;
