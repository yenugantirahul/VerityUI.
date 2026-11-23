# Risks

| Risk                                               | Impact                            | Control and verification gate                                                                                                            |
| -------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Platform-dependent font rasterization              | False changes                     | Exact browser/environment baseline identity, pinned worker image, repeated fixtures per platform in Phase 1.                             |
| Dynamic chart or data state                        | Flaky tests or hidden defects     | Explicit readiness, fixture data, deterministic clocks and narrow masking. Exercise seeded defects in Phases 1, 2 and 7.                 |
| Too much image memory                              | Worker timeout or host saturation | Bound physical pixel area, use process limits, and measure time/RSS. Validate Phase 2 and Phase 10 limits.                               |
| Browser reaches infrastructure                     | Sensitive systems exposed         | Keep trusted-only launch scope initially. Phase 9 requires network separation, controlled DNS, safe redirects and sandbox verification.  |
| Screenshot or cookie leakage                       | Customer data exposure            | Restricted evidence storage, tenant authorization, redaction, secure sessions and retention. Review in Phases 3, 5 and 9.                |
| Concurrent promotion or stale job writes           | Incorrect approved baseline       | Lock and compare active revisions and fence claims. Inject concurrency and recovery failures in Phases 3 and 4.                          |
| Blob and DB diverge                                | Dangling or orphaned evidence     | Write, verify and then commit references. Use grace-period cleanup and tested restore.                                                   |
| AI misclassifies a regression                      | Misleading review or CI result    | Run models outside the authoritative path, retain evidence and publish measured evaluation.                                              |
| Unavailable local Docker engine or hosted services | Gaps in environment verification  | Verify native loopback services and use real PostgreSQL integration where available. Keep hosted and container launch evidence explicit. |

Open decisions include identity provider, private target connectivity, data residency, retention and expected paid hosting envelope. They do not block the trusted local pipeline.
