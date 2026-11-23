# ADR 0003 · Start with trusted local execution

Status: Accepted

Use an operator-controlled loopback fixture for the first capture vertical slice. Browser routing limits scope and provides useful failure diagnostics during development. Production access to untrusted targets requires network-enforced allowlists, isolated browser compute, tenant access checks, and private storage, verified before exposure. Hosted deployment requires express authorization.
