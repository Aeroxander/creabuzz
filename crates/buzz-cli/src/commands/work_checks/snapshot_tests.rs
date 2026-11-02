//! Targeted tests binding the production snapshot seam
//! (`super::snapshot_artifact` and its bounded core), each of which fails on
//! the defects it was written to pin: flattened copy recursion, a digest over
//! the wrong tree, unbounded traversal, stat-then-copy races, and exposed or
//! foreign temp state.

use std::time::{Duration, Instant};

use tempfile::tempdir;

use super::{snapshot_artifact, snapshot_bounded, Snapshot, SnapshotBounds};

/// Small bounds so bound-refusal tests stay cheap; the production function
/// binds the production constants (its file/byte/escaping-link/special-file
/// seams are also covered by the shared work_checks tests).
fn tiny_bounds() -> SnapshotBounds {
    SnapshotBounds {
        max_files: 64,
        max_bytes: 1024,
        max_entries: 32,
        max_depth: 4,
        max_duration: Duration::from_secs(30),
    }
}

fn write_file(path: &std::path::Path, content: &[u8]) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(path, content).unwrap();
}

/// Re-hash the DELIVERED snapshot's own files, the claim the production
/// digest must make. This walks the snapshot WE created — the verification —
/// never a second walk of the untrusted source inside production.
fn self_digest(snapshot: &Snapshot) -> String {
    use sha2::Digest;
    fn collect(dir: &std::path::Path, relative: &str, out: &mut Vec<(String, [u8; 32])>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            let file_name = entry.file_name().to_string_lossy().into_owned();
            let own = if relative.is_empty() {
                file_name.clone()
            } else {
                format!("{relative}/{file_name}")
            };
            if path.is_dir() {
                collect(&path, &own, out);
            } else if entry.file_type().unwrap().is_file() {
                let bytes = std::fs::read(&path).unwrap();
                out.push((own, sha2::Sha256::digest(&bytes).into()));
            } else {
                panic!("the snapshot holds only regular files: {own:?}");
            }
        }
    }
    let mut manifest = Vec::new();
    collect(&snapshot.dir, "", &mut manifest);
    manifest.sort();
    let mut hasher = sha2::Sha256::new();
    for (relative, digest) in &manifest {
        hasher.update(relative.as_bytes());
        hasher.update([0u8]);
        hasher.update(digest);
        hasher.update(b"\n");
    }
    format!("0x{}", hex::encode(hasher.finalize()))
}

// ── hierarchy is preserved (fails the flattened re-rooted recursion) ────────

/// Two subdirectories each carrying a README and a nested `imports` file: the
/// recursion must keep the canonical artifact root through the whole walk, so
/// nested files land under their real relative names instead of being
/// flattened onto the snapshot root and overwriting one another.
#[test]
fn nested_directories_keep_their_relative_paths() {
    let dir = tempdir().unwrap();
    let artifact = dir.path();
    write_file(&artifact.join("a/README"), b"alpha readme");
    write_file(&artifact.join("a/imports/mod_1.txt"), b"alpha import");
    write_file(&artifact.join("b/README"), b"beta readme");
    write_file(&artifact.join("b/imports/mod_2.txt"), b"beta import");
    let snapshot = snapshot_artifact(artifact).unwrap();
    assert_eq!(
        std::fs::read(snapshot.dir.join("a/README")).unwrap(),
        b"alpha readme"
    );
    assert_eq!(
        std::fs::read(snapshot.dir.join("b/README")).unwrap(),
        b"beta readme"
    );
    assert_eq!(
        std::fs::read(snapshot.dir.join("a/imports/mod_1.txt")).unwrap(),
        b"alpha import"
    );
    assert_eq!(
        std::fs::read(snapshot.dir.join("b/imports/mod_2.txt")).unwrap(),
        b"beta import"
    );
    assert_eq!(snapshot.files, 4);
}

/// The digest describes the snapshot files that are actually delivered — not
/// a second walk over the untrusted source. The SOURCE is mutated after the
/// copy: whatever the record holds must still match the snapshot's own bytes,
/// and the delivered bytes must still read like what was copied. A flattened
/// copy of the same-name files would also make the digest undeliverable.
#[test]
fn digest_describes_the_delivered_snapshot_not_a_source_walk() {
    let dir = tempdir().unwrap();
    let artifact = dir.path();
    write_file(&artifact.join("shared/README"), b"one");
    write_file(&artifact.join("other/README"), b"two");
    let snapshot = snapshot_artifact(artifact).unwrap();
    // Mutate the source AFTER the copy: the digest must still describe what
    // was DELIVERED.
    std::fs::write(artifact.join("shared/README"), b"mutated").unwrap();
    std::fs::write(artifact.join("extra.txt"), b"late").unwrap();
    assert_eq!(
        snapshot.digest,
        self_digest(&snapshot),
        "the digest must be over the snapshot's delivered bytes"
    );
    assert_eq!(
        std::fs::read(snapshot.dir.join("shared/README")).unwrap(),
        b"one"
    );
    assert!(!snapshot.dir.join("extra.txt").exists());
    // Same-name nested files with different bytes: a flattened copy would
    // deliver one file's bytes under one name and the digest could not
    // describe the delivered snapshot.
    drop(snapshot);
    let dir2 = tempdir().unwrap();
    write_file(&dir2.path().join("x1/README"), b"left contents");
    write_file(&dir2.path().join("x2/README"), b"right contents");
    let snapshot2 = snapshot_artifact(dir2.path()).unwrap();
    assert_eq!(snapshot2.digest, self_digest(&snapshot2));
    drop(snapshot2);
}

// ── byte bound, including a growing source ──────────────────────────────────

/// A file that GROWS while being snapshot must not push bytes past the bound
/// or smuggle growth into the snapshot: the copy reads exactly the opened
/// file's stated length, so either the grown file is refused at open, or the
/// copy delivers exactly its opening prefix and the appended bytes never
/// enter.
#[test]
fn a_growing_source_never_passes_its_opened_state() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("grower.txt");
    std::fs::write(&path, vec![b'x'; 200]).unwrap();
    let writer = {
        let path = path.clone();
        std::thread::spawn(move || {
            use std::io::Write;
            // Appends land after the snapshot usually opened the file, then
            // the writer stops after ~400ms (bounded, always joins).
            std::thread::sleep(Duration::from_millis(50));
            for _ in 0..40 {
                if let Ok(mut handle) = std::fs::OpenOptions::new().append(true).open(&path) {
                    let _ = handle.write_all(&[b'y'; 100]);
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        })
    };
    let mut bounds = tiny_bounds();
    bounds.max_bytes = 256;
    match snapshot_bounded(dir.path(), &bounds) {
        Ok(snapshot) => {
            // The copy opened the file while it still read 200 bytes: the
            // delivered file is exactly that prefix and the growth entered
            // nothing — neither the delivered file nor the accounting.
            let delivered = std::fs::read(snapshot.dir.join("grower.txt")).unwrap();
            assert_eq!(delivered, vec![b'x'; 200]);
            assert_eq!(snapshot.bytes, 200);
            assert!(snapshot.digest.starts_with("0x"));
        }
        Err(message) => {
            // The file had already grown past the byte budget when opened:
            // refused, and the message names the bound that fired.
            assert!(message.contains("bytes in total"), "{message}");
        }
    }
    writer.join().unwrap();
}

/// A plain over-bound file refuses the snapshot outright.
#[test]
fn a_file_past_the_byte_bound_refuses() {
    let dir = tempdir().unwrap();
    std::fs::write(dir.path().join("big.txt"), vec![b'z'; 2048]).unwrap();
    let message = snapshot_bounded(dir.path(), &tiny_bounds()).unwrap_err();
    assert!(message.contains("bytes in total"), "{message}");
}

// ── traversal bounds: depth, entry count ────────────────────────────────────

/// A tree nested deeper than the depth bound refuses the snapshot. This binds
/// the PRODUCTION function and its production depth bound: with no depth
/// bound the walk would happily complete and return a snapshot.
#[test]
fn a_tree_nesting_deeper_than_the_bound_refuses() {
    let dir = tempdir().unwrap();
    let mut path = dir.path().to_path_buf();
    for level in 0..80 {
        path = path.join(format!("d{level}"));
    }
    write_file(&path.join("bottom.txt"), b"deep");
    let message = snapshot_artifact(dir.path()).unwrap_err();
    assert!(message.contains("deeper than"), "{message}");
}

/// Empty-tree bombs are bounded: the ENTRY bound counts directories too. A
/// modest tree still snapshots; a pile of directories beyond the entry
/// budget refuses.
#[test]
fn empty_tree_directories_hit_the_entry_bound() {
    let within = tempdir().unwrap();
    for i in 0..8 {
        std::fs::create_dir(within.path().join(format!("dir-{i}"))).unwrap();
    }
    std::fs::write(within.path().join("seed.txt"), b"s").unwrap();
    let snapshot = snapshot_bounded(within.path(), &tiny_bounds())
        .unwrap_or_else(|e| panic!("8 empty dirs + 1 file must fit: {e}"));
    drop(snapshot);

    let beyond = tempdir().unwrap();
    for i in 0..48 {
        std::fs::create_dir(beyond.path().join(format!("dir-{i}"))).unwrap();
    }
    std::fs::write(beyond.path().join("seed.txt"), b"s").unwrap();
    let message = snapshot_bounded(beyond.path(), &tiny_bounds()).unwrap_err();
    assert!(message.contains("entries"), "{message}");
}

// ── IO error propagation ────────────────────────────────────────────────────

/// An unreadable directory is a REFUSED snapshot, never a silently skipped
/// one: the manifest cannot quietly omit whatever could not be read. Skipped
/// when the process would bypass the permissions it sets (root).
#[cfg(unix)]
#[test]
fn an_unreadable_directory_fails_the_snapshot_closed() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempdir().unwrap();
    std::fs::write(dir.path().join("ok.txt"), b"fine").unwrap();
    let nested = dir.path().join("locked");
    std::fs::create_dir(&nested).unwrap();
    write_file(&nested.join("secret.txt"), b"hidden");
    // w+x without r: read_dir fails (EACCES), but the snapshot's own drop
    // can still unlink through the directory (unlink needs write+search,
    // not read) — the refusal must strand NOTHING readable-or-not.
    std::fs::set_permissions(&nested, std::fs::Permissions::from_mode(0o300)).unwrap();
    // Empirical capability check: can this process even see the bound? A
    // process that bypasses permissions (root) asserts nothing here.
    let the_walk_would_hit_it = std::fs::read_dir(&nested).is_err();
    let result = snapshot_artifact(dir.path());
    std::fs::set_permissions(&nested, std::fs::Permissions::from_mode(0o755)).unwrap();
    if the_walk_would_hit_it {
        let message = result.unwrap_err();
        assert!(
            message.contains("cannot read") || message.contains("cannot enumerate"),
            "{message}"
        );
    } else {
        result.unwrap();
    }
}

// ── special files and links keep refusing ───────────────────────────────────

/// A link resolving INSIDE the artifact but to a special file (a socket) is
/// not a regular file and must refuse the snapshot.
#[cfg(unix)]
#[test]
fn a_link_to_a_socket_inside_the_artifact_refuses() {
    let dir = tempdir().unwrap();
    std::fs::write(dir.path().join("ok.txt"), b"fine").unwrap();
    let socket = dir.path().join("sock");
    let _listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
    std::os::unix::fs::symlink("sock", dir.path().join("alias.sock")).unwrap();
    let message = snapshot_artifact(dir.path()).unwrap_err();
    // Entry order is unspecified: the walk may refuse the raw socket or the
    // link first — either refusal is fail-closed.
    assert!(
        message.contains("non-regular file")
            || message.contains("does not resolve to a regular file inside it"),
        "{message}"
    );
}

/// A link resolving to a device (anywhere outside the artifact) refuses even
/// though a device is "readable": containment is not negotiable.
#[cfg(unix)]
#[test]
fn a_link_to_a_device_refuses() {
    let dir = tempdir().unwrap();
    std::fs::write(dir.path().join("ok.txt"), b"fine").unwrap();
    std::os::unix::fs::symlink("/dev/null", dir.path().join("blackhole")).unwrap();
    let message = snapshot_artifact(dir.path()).unwrap_err();
    assert!(
        message.contains("does not resolve to a regular file inside it"),
        "{message}"
    );
}

/// A link resolving to a directory inside the artifact refuses: the walk's
/// directory ancestry is real directories only, and a link copy is regular
/// files only.
#[cfg(unix)]
#[test]
fn a_link_to_a_directory_refuses() {
    let dir = tempdir().unwrap();
    std::fs::create_dir(dir.path().join("realdir")).unwrap();
    std::fs::write(dir.path().join("realdir/leaf.txt"), b"leaf").unwrap();
    std::os::unix::fs::symlink("realdir", dir.path().join("linkdir")).unwrap();
    let message = snapshot_artifact(dir.path()).unwrap_err();
    assert!(
        message.contains("does not resolve to a regular file inside it"),
        "{message}"
    );
}

// ── cooperative deadline ────────────────────────────────────────────────────

/// An already-expired deadline refuses the walk at its FIRST decision point:
/// per directory entry, before any file is copied. The deadline is
/// cooperative — std cannot interrupt a blocked syscall — so this binds the
/// decision points, and the module docs record the blockable remainder.
#[test]
fn an_expired_cooperative_deadline_refuses_during_the_walk() {
    let dir = tempdir().unwrap();
    for i in 0..3 {
        std::fs::write(dir.path().join(format!("f{i}.txt")), format!("data {i}")).unwrap();
    }
    let mut bounds = tiny_bounds();
    bounds.max_duration = Duration::ZERO;
    let message = snapshot_bounded(dir.path(), &bounds).unwrap_err();
    assert!(message.contains("time bound"), "{message}");
}

/// The copied chunk is a decision point too: one large file cannot walk the
/// chunk loop forever against the deadline. This calls the production
/// `copy_regular` directly with an already-expired context: no size, file,
/// or byte bound on this path can refuse such a file, so any refusal must
/// come from the per-chunk deadline check that guards the loop itself.
#[test]
fn the_chunk_loop_refuses_once_the_deadline_passes() {
    use super::{copy_regular, CopyContext};
    let dir = tempdir().unwrap();
    let src_path = dir.path().join("many-chunks.txt");
    std::fs::write(&src_path, vec![b'c'; 5 * super::COPY_CHUNK_BYTES]).unwrap();
    let dest = dir.path().join("chunk-dest.txt");
    let mut bounds = tiny_bounds();
    bounds.max_bytes = 16 * 1024 * 1024; // the byte bound stays far away
    let mut ctx = CopyContext {
        bounds: &bounds,
        root_canonical: dir.path().to_path_buf(),
        manifest: Vec::new(),
        files: 0,
        bytes: 0,
        entries: 0,
        deadline: Instant::now(),
    };
    let mut src_file = std::fs::File::open(&src_path).unwrap();
    let relative = std::path::PathBuf::from("many-chunks.txt");
    let message =
        copy_regular("many-chunks.txt", &relative, &mut src_file, &dest, &mut ctx).unwrap_err();
    assert!(message.contains("time bound"), "{message}");
    // Nothing was copied into the manifest: the refusal sits on the loop's
    // own check, before the first chunk is read or the file is recorded.
    assert!(ctx.manifest.is_empty(), "{:?}", ctx.manifest);
}

// ── lossless names: non-UTF-8 refuses ──────────────────────────────────────

/// A non-UTF-8 file name refuses the snapshot: a lossy conversion could
/// collapse it into another distinct name ("bad<ff>name" reads lossy as
/// "bad<U+FFFD>name", exactly the second file here) and the two copies would
/// silently overwrite one another on the same path.
#[cfg(unix)]
#[test]
fn a_non_utf8_file_name_refuses() {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;
    let dir = tempdir().unwrap();
    // A name whose bytes are invalid UTF-8, and a sibling whose name is
    // exactly what a lossy conversion of it would produce: the pair that a
    // to_string_lossy walk could collide.
    let unclearable = dir.path().join(OsStr::from_bytes(b"bad\xffname.txt"));
    if let Err(e) = std::fs::write(&unclearable, b"one") {
        // Some filesystems validate names themselves (macOS/APFS rejects
        // these bytes outright), so the production refusal can never be
        // reached there; on filesystems that accept arbitrary bytes (e.g.
        // Linux ext4, where CI runs) the test runs for real.
        println!(
            "skipped: this filesystem already rejects unclearable names ({e}); \
             collision impossible by platform"
        );
        return;
    }
    std::fs::write(dir.path().join("bad\u{fffd}name.txt"), b"two").unwrap();
    let message = snapshot_artifact(dir.path()).unwrap_err();
    assert!(message.contains("not valid UTF-8"), "{message}");
}

// ── private permissions and foreign paths ───────────────────────────────────

/// The private-root contract: a 0700 exclusive root nobody else planted, a
/// 0755 artifact layer with 0644 files so the container's fixed non-root uid
/// reads the approved copy (a 0600 SOURCE reads too), and cleanup removing
/// ONLY what this run created — a foreign sibling is never touched, and the
/// guard's name deliberately avoids the snapshot's temp prefix so refused
/// runs never read it as a leftover.
#[cfg(unix)]
#[test]
fn private_root_readable_layer_and_only_owned_cleanup() {
    use std::os::unix::fs::PermissionsExt;

    let artifact = tempdir().unwrap();
    std::fs::write(artifact.path().join("artifact.txt"), b"the artifact").unwrap();

    // A foreign, similarly named directory with a sentinel: the snapshot must
    // not remove it on success, on refusal, or on drop — there is no
    // guessed-path deletion, ever.
    let foreign = std::env::temp_dir().join(format!(
        "buzz-snapshot-foreign-guard-{}",
        std::process::id()
    ));
    std::fs::create_dir(&foreign).unwrap();
    std::fs::write(foreign.join("sentinel"), b"mine").unwrap();

    let snapshot = snapshot_artifact(artifact.path()).unwrap();
    let root = snapshot.dir.parent().unwrap().to_path_buf();
    assert_eq!(
        std::fs::metadata(&root).unwrap().permissions().mode() & 0o777,
        0o700,
        "the temp root must stay private"
    );
    assert_eq!(
        std::fs::metadata(&snapshot.dir)
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o755,
        "the artifact layer must be traversable by the container uid"
    );
    assert_eq!(
        std::fs::metadata(snapshot.dir.join("artifact.txt"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o644,
        "delivered files must be readable by the container uid"
    );
    assert!(foreign.join("sentinel").exists());
    let layer = snapshot.dir.clone();
    drop(snapshot);
    assert!(!layer.exists(), "a dropped snapshot cleans its own root");
    assert!(
        foreign.join("sentinel").exists(),
        "foreign state is untouched"
    );
    std::fs::remove_dir_all(&foreign).unwrap();
}
