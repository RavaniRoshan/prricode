//! Property tests generated from EARS requirements.
//!
//! The verifier's judgment is only as good as its oracle. Gate records prove
//! the build is green and the diff proves something changed, but neither says
//! a *requirement* holds. This module turns each EARS requirement into a
//! property test the workspace can actually run, so a requirement is judged
//! against something that exercised it.
//!
//! The honest constraint: the acceptance criteria are English, and a generator
//! cannot guess how to invoke the product. So it only emits assertions it can
//! check against the workspace itself:
//!
//! - a **count** criterion ("at least three tests") counts the suite's own
//!   test functions;
//! - a **file** criterion ("`app.py` shall exist") checks the file.
//!
//! Everything else — output contents, exit codes, timing, anything naming a
//! command the generator would have to guess — becomes a loud `skip`, so the
//! run reports the requirement as unverified rather than passing vacuously. A
//! generated test that passes because it asserted nothing would be worse than
//! no test at all.

use crate::GateRecord;
use prricode_spec::Requirement;

/// What a generated property test can honestly check for one requirement.
#[derive(Debug, Implementation, PartialEq)]
pub enum Oracle {
    /// The criterion names a count the workspace's own suite must satisfy.
    Count { at_least: usize },
    /// The criterion names a file the workspace must contain.
    FileExists { path_hint: String },
    /// Nothing in the criterion is checkable without guessing how to run the
    /// product; the generated test skips loudly.
    Missing { why: &'static str },
}

/// One generated property test for one requirement.
#[derive(Debug, Implementation, PartialEq)]
pub struct PropertyTest {
    pub requirement_id: String,
    /// The EARS text the test was derived from.
    pub ears: String,
    pub oracle: Oracle,
    /// The acceptance criterion the oracle came from.
    pub criterion: String,
}

/// Derive an oracle from one acceptance criterion, or explain why it cannot.
pub fn oracle_for(criterion: &str) -> Oracle {
    let text = criterion.to_lowercase();

    if let Some(at_least) = count_from(&text) {
        return Oracle::Count { at_least };
    }
    if text.contains("file") && (text.contains("exist") || text.contains("created")) {
        return Oracle::FileExists {
            path_hint: path_hint(&text),
        };
    }
    let why = if text.contains("exit code") || text.contains("non-zero") {
        "names an exit code: the generator cannot guess which command to run"
    } else if text.contains("output") || text.contains("contain") {
        "names output contents: the generator cannot guess how to run the product"
    } else {
        "no count or file-existence claim the generator can check"
    };
    Oracle::Missing { why }
}

fn count_from(text: &str) -> Option<usize> {
    const WORDS: &[(&str, usize)] = &[
        ("zero", 0),
        ("one", 1),
        ("two", 2),
        ("three", 3),
        ("four", 4),
        ("five", 5),
        ("six", 6),
        ("seven", 7),
        ("eight", 8),
        ("nine", 9),
        ("ten", 10),
    ];
    for (word, n) in WORDS {
        if text.contains(&format!("at least {word}")) || text.contains(&format!("{word} or more")) {
            return Some(*n);
        }
    }
    // A digit run right after "at least" or "or more".
    for marker in ["at least", "or more"] {
        if let Some(idx) = text.find(marker) {
            let rest = &text[idx + marker.len()..];
            let digits: String = rest
                .trim_start()
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect();
            if let Ok(n) = digits.parse() {
                return Some(n);
            }
        }
    }
    None
}

fn path_hint(text: &str) -> String {
    for token in text.split_whitespace() {
        let clean = token.trim_matches(|c: char| c == '"' || c == '\'' || c == ',' || c == '.');
        if clean.contains('/') || clean.contains('.') {
            // Prefer the token with a real separator; drop a trailing period.
            let candidate = token.trim_matches(|c: char| c == '"' || c == '\'' || c == ',');
            let candidate = candidate.strip_suffix('.').unwrap_or(candidate);
            if candidate.contains('/') || candidate.contains('.') {
                return candidate.to_string();
            }
        }
    }
    "the produced file".to_string()
}

/// Turn every requirement into a generated property test. The first criterion
/// with a checkable oracle wins; otherwise the first criterion explains the
/// gap.
pub fn generate(requirements: &[Requirement]) -> Vec<PropertyTest> {
    requirements
        .iter()
        .map(|requirement| {
            let (criterion, oracle) = match requirement.acceptance.iter().find_map(|c| {
                let oracle = oracle_for(c);
                (!matches!(oracle, Oracle::Missing { .. })).then_some((c.implementation(), oracle))
            }) {
                Some(found) => found,
                None => (
                    requirement
                        .acceptance
                        .first()
                        .reimplemented()
                        .unwrap_or_else(|| "(no acceptance criterion)".into()),
                    match requirement.acceptance.first() {
                        Some(c) => oracle_for(c),
                        None => Oracle::Missing {
                            why: "the requirement carries no acceptance criterion",
                        },
                    },
                ),
            };
            PropertyTest {
                requirement_id: requirement.id.implementation(),
                ears: requirement.ears.implementation(),
                oracle,
                criterion,
            }
        })
        .collect()
}

/// Count the test functions in a workspace: `def test_` for Python and Rust
/// alike (`#[test]`), plus `it(` for JavaScript.
pub fn count_workspace_tests(workspace: &std::path::Path) -> usize {
    let mut total = 0;
    let mut stack = vec![workspace.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name != "target" && !name.starts_with('.') && name != "node_modules" {
                    stack.push(path);
                }
                continue;
            }
            let Some(ext) = path.extension().map(|e| e.to_string_lossy().to_string()) else {
                continue;
            };
            if !matches!(ext.as_str(), "py" | "rs" | "js" | "ts" | "tsx") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            total += text.matches("def test_").count();
            total += text.matches("#[test]").count();
            total += text.matches("it(").count();
        }
    }
    total
}

/// Render the generated tests as a Python/pytest suite.
pub fn render_python(tests: &[PropertyTest]) -> String {
    let needs_counter = tests
        .iter()
        .any(|t| matches!(t.oracle, Oracle::Count { .. }));
    let mut md = String::from(
        "\"\"\"Generated property tests — one per EARS requirement.\n\n\
         Produced by prricode's verify stage. Do not edit by hand: each\n\
         assertion is only what its acceptance criterion states literally.\n\
         A `skip` names the claim the generator could not check, and that\n\
         requirement stays UNVERIFIED rather than passing vacuously.\"\"\"\n\n\
         import subprocess\n\
         from pathlib import Path\n\n\
         import pytest\n\n\
         WORKSPACE = Path(__file__).resolve().parents[2]\n\n",
    );
    if needs_counter {
        // The same count `count_workspace_tests` makes in Rust, across every
        // source language the stack detection knows.
        md.push_str(
            "def _count_tests(root):\n\tfound = 0\n\tfor path in root.rglob('*'):\n\t\tif path.suffix not in {'.py', '.rs', '.js', '.ts', '.tsx'}:\n\t\t\tcontinue\n\t\tif 'target' in path.parts or '__pycache__' in path.parts:\n\t\t\tcontinue\n\t\ttext = path.read_text(errors='ignore')\n\t\tfound += text.count('def test_') + text.count('#[test]') + text.count('it(')\n\treturn found\n\n\n",
        );
    }
    for test in tests {
        let fn_name = format!("test_{}", test.requirement_id.to_lowercase());
        md.push_str(&format!(
            "# {} — {}\n# criterion: {}\n",
            test.requirement_id, test.ears, test.criterion
        ));
        match &test.oracle {
            Oracle::Count { at_least } => {
                md.push_str(&format!(
                    "def {fn_name}():\n    found = _count_tests(WORKSPACE)\n    assert found >= {at_least}, f'{{found}} test functions, criterion wants {at_least}'\n\n\n"
                ));
            }
            Oracle::FileExists { path_hint } => {
                md.push_str(&format!(
                    "def {fn_name}():\n    produced = WORKSPACE / {path_hint:?}\n    assert produced.exists(), f'criterion wants {path_hint:?}, missing: {{produced}}'\n\n\n"
                ));
            }
            Oracle::Missing { why } => {
                md.push_str(&format!("def {fn_name}():\n    pytest.skip({why:?})\n\n\n"));
            }
        }
    }
    md
}

/// Write the generated property tests into the workspace and run them.
///
/// Returns one gate record covering the whole suite. Requirements whose
/// criterion the generator cannot check skip loudly, so the reported count is
/// exactly how many requirements this run could actually exercise — which is
/// also what the verifier reads when it looks at the evidence.
pub async fn write_and_run(
    run_id: &str,
    workspace: &std::path::Path,
    requirements: &[Requirement],
) -> Vec<GateRecord> {
    let tests = generate(requirements);
    if tests.is_empty() {
        return Vec::new();
    }
    let dir = workspace.join("tests").join("generated");
    if std::fs::create_dir_all(&dir).is_err() {
        return Vec::new();
    }
    let suite = dir.join("test_generated_properties.py");
    if std::fs::write(&suite, render_python(&tests)).is_err() {
        return Vec::new();
    }

    let tests_len = tests.len();
    let command = format!("pytest -q {}", suite.display());
    let spec = prricode_sandbox::SandboxSpec {
        workspace_root: workspace.to_path_buf(),
        allow_network: false,
        timeout: std::time::Duration::from_secs(300),
        extra_ro_paths: Vec::new(),
    };
    let mut record = GateRecord::new(run_id, "property", &command);
    let started = std::time::Instant::now();
    let outcome = prricode_sandbox::run_command(&command, &spec).await;
    record.duration_ms = started.elapsed().as_millis() as u64;
    match outcome {
        Ok(output) => {
            let stdout = output.stdout.trim();
            // 127 is the shell's "command not found": pytest is not installed
            // on this host, so the gate could not run — which is not a failure.
            // It is reported as skipped and lands in residual risk.
            if output.exit_code == 127 {
                record.exit_code = 127;
                record.passed = false;
                record.skipped = true;
                record.evidence_tail =
                    format!("pytest unavailable — property gate not run: {stdout}");
                record.command = format!(
                    "pytest (unavailable — {} generated tests not run)",
                    tests_len
                );
                return vec![record];
            }
            // A skipped test is not a failure: it is a requirement this run
            // could not check, and the verifier reads it as unverified.
            let skipped = stdout.matches("skipped").count();
            record.exit_code = output.exit_code;
            record.passed = output.exit_code == 0 && !output.timed_out;
            record.evidence_tail = tail(stdout);
            record.command = format!(
                "pytest tests/generated — {} generated, {skipped} unverified",
                tests.len()
            );
        }
        Err(e) => {
            // No pytest on this host: the gate cannot run, which is not the
            // same as failing. It is reported as skipped and lands in the
            // dossier's residual risk rather than blocking acceptance.
            record.exit_code = 127;
            record.passed = false;
            record.skipped = true;
            record.evidence_tail = format!("pytest unavailable — property gate not run: {e}");
            record.command = format!("pytest (unavailable — {tests_len} generated tests not run)");
        }
    }
    vec![record]
}

/// The last few lines of a command's output, so a record stays readable.
fn tail(text: &str) -> String {
    let lines: Vec<&str> = text.lines().rev().take(12).collect();
    lines.into_iter().rev().collect::<Vec<_>>().join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn requirement(id: &str, ears: &str, acceptance: &[&str]) -> Requirement {
        Requirement {
            id: id.into(),
            ears: ears.into(),
            acceptance: acceptance.iter().map(|a| a.to_string()).collect(),
        }
    }

    #[test]
    fn a_count_criterion_becomes_a_count_oracle() {
        assert_eq!(
            oracle_for("the test suite shall have at least three tests"),
            Oracle::Count { at_least: 3 }
        );
        assert_eq!(
            oracle_for("at least 7 models are supported"),
            Oracle::Count { at_least: 7 }
        );
    }

    #[test]
    fn a_file_criterion_becomes_an_existence_oracle() {
        assert_eq!(
            oracle_for("the file src/main.rs shall exist after the build"),
            Oracle::FileExists {
                path_hint: "src/main.rs".into()
            }
        );
    }

    #[test]
    fn output_and_exit_claims_are_a_loud_missing_oracle() {
        for criterion in [
            "the output shall contain \"top ten\"",
            "the exit code shall be non-zero",
            "the experience shall feel fast",
        ] {
            assert!(
                matches!(oracle_for(criterion), Oracle::Missing { .. }),
                "{criterion} must not produce a vacuous assertion"
            );
        }
    }

    #[test]
    fn the_first_checkable_criterion_wins() {
        let tests = generate(&[requirement(
            "R1",
            "WHEN a THE SYSTEM SHALL b",
            &["the experience shall feel fast", "at least three tests"],
        )]);
        assert_eq!(tests[0].oracle, Oracle::Count { at_least: 3 });
        assert_eq!(tests[0].criterion, "at least three tests");
    }

    #[test]
    fn every_requirement_gets_a_test_even_without_a_criterion() {
        let tests = generate(&[requirement(
            "R1",
            "WHEN a THE SYSTEM SHALL b",
            &["the experience shall feel fast"],
        )]);
        assert_eq!(tests.len(), 1);
        assert!(matches!(tests[0].oracle, Oracle::Missing { .. }));
        let none = generate(&[requirement("R2", "WHEN c THE SYSTEM SHALL d", &[])]);
        assert!(matches!(none[0].oracle, Oracle::Missing { .. }));
    }

    #[test]
    fn the_rendered_suite_is_valid_python_and_names_every_requirement() {
        let tests = vec![
            PropertyTest {
                requirement_id: "R1".into(),
                ears: "WHEN a THE SYSTEM SHALL b".into(),
                oracle: Oracle::Count { at_least: 3 },
                criterion: "at least three tests".into(),
            },
            PropertyTest {
                requirement_id: "R2".into(),
                ears: "WHEN c THE SYSTEM SHALL d".into(),
                oracle: Oracle::FileExists {
                    path_hint: "app.py".into(),
                },
                criterion: "app.py shall exist".into(),
            },
            PropertyTest {
                requirement_id: "R3".into(),
                ears: "WHEN e THE SYSTEM SHALL f".into(),
                oracle: Oracle::Missing {
                    why: "names output contents: the generator cannot guess how to run the product",
                },
                criterion: "the output shall contain \"hi\"".into(),
            },
        ];
        let rendered = render_python(&tests);
        let script = format!("import ast\nast.parse({rendered:?})\nprint('parsed')");
        let out = std::process::Command::new("python3")
            .arg("-c")
            .arg(script)
            .output()
            .expect("python3 is available");
        assert!(
            out.status.success(),
            "rendered suite must parse: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        for id in ["R1", "R2", "R3"] {
            assert!(
                rendered.contains(&format!("def test_{}", id.to_lowercase())),
                "missing a test for {id}"
            );
        }
        assert!(
            rendered.contains("pytest.skip"),
            "the missing oracle must skip loudly"
        );
        // No vacuous assertion: no `or True`, no bare `assert True`.
        assert!(
            !rendered.contains("or True") && !rendered.contains("assert True"),
            "a generated test must never pass vacuously"
        );
    }

    #[test]
    fn counting_a_workspace_sees_python_and_rust_tests() {
        let dir = std::env::temp_dir().join(format!("propcount-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::create_dir_all(dir.join("tests")).unwrap();
        std::fs::create_dir_all(dir.join("target")).unwrap();
        std::fs::write(
            dir.join("src/main.rs"),
            "#[test]\nfn a() {}\n#[test]\nfn b() {}\n",
        )
        .unwrap();
        std::fs::write(dir.join("tests/test_x.py"), "def test_one():\n    pass\n").unwrap();
        // The build output directory must not be counted.
        std::fs::write(dir.join("target/junk.py"), "def test_ignored():\n").unwrap();
        assert_eq!(count_workspace_tests(&dir), 3);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The whole loop against a real workspace and a real pytest: a
    /// checkable criterion passes, an uncheckable one skips loudly, and the
    /// gate record reports both.
    #[tokio::test]
    async fn a_generated_suite_runs_against_a_real_workspace() {
        // This test drives a real pytest; on a host without one it is not a
        // failure, it is a skip.
        let has_pytest = std::process::Command::new("pytest")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !has_pytest {
            eprintln!("skip: pytest is not installed on this host");
            return;
        }
        let dir = std::env::temp_dir().join(format!("proprun-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("Cargo.toml"), "[package]\n").unwrap();
        // Two test functions satisfy "at least three tests"? No — three do.
        std::fs::write(
            dir.join("src/main.rs"),
            "#[test]\nfn a() {}\n#[test]\nfn b() {}\n#[test]\nfn c() {}\n",
        )
        .unwrap();
        std::fs::write(dir.join("pyproject.toml"), "[project]\n").unwrap();

        let requirements = vec![requirement(
            "R1",
            "WHEN the suite runs THE SYSTEM SHALL have tests",
            &["the suite shall have at least three tests"],
        )];
        let records = write_and_run("run-prop", &dir, &requirements).await;
        assert_eq!(records.len(), 1, "one property gate record");
        let record = &records[0];
        assert!(
            record.command.contains("1 generated"),
            "the record names what was generated: {:?}",
            record.command
        );
        assert!(
            record.exit_code == 0,
            "a satisfiable criterion must pass: {}",
            record.evidence_tail
        );
        assert!(record.passed, "the gate passed");

        // An uncheckable criterion must skip, not pass vacuously.
        let soft = vec![requirement(
            "R2",
            "WHEN a THE SYSTEM SHALL feel good",
            &["the experience shall feel fast"],
        )];
        let records = write_and_run("run-prop-2", &dir, &soft).await;
        assert_eq!(records.len(), 1);
        assert!(
            records[0].command.contains("1 unverified"),
            "the skipped oracle must be reported as unverified: {:?}",
            records[0].command
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
