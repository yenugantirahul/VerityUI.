# ADR 0001 · Keep one control plane and separate browser execution

Status: Accepted

Use a single Node/TypeScript codebase and Fastify API, with PostgreSQL for persistence and jobs. Keep browser and image CPU work in a worker process with a separate execution boundary for untrusted pages. One runtime shares validation and capture contracts. Database leases keep run submission and durable work consistent without requiring another backing service. Redis and microservices bring deployment and reconciliation costs before throughput warrants them. Revisit the queue when claim latency, table churn or API interference exceeds its staging budget.
