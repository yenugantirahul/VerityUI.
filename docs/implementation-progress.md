# Implementation progress

## VerityUI alpha

| Blueprint workflow                          | Delivery                                                                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Capture two revisions of a real application | Configurable Playwright routes, browsers and viewports with same-origin fixtures, masks, a fixed clock and optional seeded randomness |
| Detect and explain changes                  | Pixel evidence, paired region crops, structural matching, property diffs, HTML reports and machine-readable results                   |
| Evaluate change intent                      | Versioned YAML contract, component and route protection, review and strict modes                                                      |
| Attribute evidence                          | Stable test IDs and component names, with application-supplied source locations                                                       |
| Classify changes                            | Opt-in multimodal adapter with bounded requests and validated citations. Approval remains a human decision                            |
| Run on pull requests                        | Repository workflow captures both revisions with one toolchain and retains evidence for review                                        |
| Review persisted runs                       | Local analytics workspace with PostgreSQL, a separate worker and transactional baseline review                                        |

CI captures can also enter the self-hosted workspace through project-scoped credentials. The worker compares uploaded PNG and DOM evidence, and reviewers can promote captures from the project's configured baseline branch. The dashboard displays measured seven-day run, review, completion and latency signals. See the [operations guide](operations.md).

Repository installation via a GitHub App, independent hosted artifact storage, verified merge provenance, source-map and AST attribution, agent repair loops and billing are later milestones in the blueprint.

## Deltaframe foundation

| Milestone                       | Status                     | Evidence                                                                                                                 |
| ------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Workspace and architecture      | Complete                   | Empty workspace with no Git repository. Requirements, decisions, diagrams, roadmap and risks reviewed against the brief. |
| Phase 0 · Local toolchain       | PASS                       | Clean install, formatting, lint, type-check, build, two tests and live health responses verified.                        |
| Phase 1 · Deterministic capture | PASS                       | All native checks passed, including 10 byte-identical captures per engine. Container smoke is environment-blocked.       |
| Phase 2 · Comparison            | PASS                       | 14 tests passed. Seeded defects detected, PNG evidence inspected, and comparison time and memory measured.               |
| Phase 3 · Baselines             | PASS                       | PostgreSQL 18.7 integration, immutable artifact tests, authorization, conflicting approvals and rollback passed.         |
| Phase 4 · Execution API         | PASS                       | Real HTTP, browser capture, worker termination and PostgreSQL restart integration passed.                                |
| Phase 5 · Review dashboard      | PASS                       | 18 tests passed, including browser sign-in, workspace authorization, evidence controls, review and mobile layout.        |
| Phase 6 · Evidence analysis     | PASS for rule-based advice | 30 cases evaluated, 20 viewport-held-out checks. Advisory feedback and inference fallback verified.                      |
| Phase 7 · Analytics assertions  | PASS                       | Ten seeded defects detected, visual and analytics states independent, cross-browser capture repeatability restored.      |
| Phase 8 · CLI and CI            | In progress                | Build developer commands and a least-privilege PR workflow. A hosted sample PR requires an authorized repository.        |

See `test-results.md` for command evidence and `next-steps.md` for the active phase plan.
