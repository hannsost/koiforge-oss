# KE0 execution profile and test contract

Profile `linux-bwrap-systemd-v1`, fixed before acceptance runs. Development
implementation; tests below must pass before KE1/KE2 begin. Linux with a user
systemd manager, delegated cgroups v2 and bubblewrap is required. Missing support
fails closed; there is no in-process or Windows-driver fallback.

| Resource | Fixed boundary | Acceptance evidence |
| --- | --- | --- |
| Filesystem | Read-only `/usr`, executable at `/runtime/node`; private `/proc` and `/dev`; no host home, project, runtime data or sockets mounted | Host marker unreadable; `/usr` write denied; legitimate input from stdin works |
| Environment | Cleared by bubblewrap; no app credentials inherited | Synthetic environment marker absent |
| Network | Separate network namespace; no host listener or external interface | Host listener receives no connection |
| Privilege/processes | New user/PID/IPC namespaces, nested user namespaces disabled, all capabilities dropped; cgroup `TasksMax=16` | Effective configuration plus bounded child-process probe |
| Memory | cgroup `MemoryMax=268435456`, swap zero; Node old space 96 MiB | Normal data passes; allocation flood fails and next invocation works |
| CPU/time | CPU quota 100%, CPU limit 2 seconds, service lifetime 6 seconds, parent watchdog 9 seconds | Infinite loop stops; API remains usable |
| Input/code | 10 MiB source, 64 KiB generated code | Oversize input rejected before execution |
| Output/rows | 16 MiB output, 64 KiB diagnostics, 100,000 records | Oversize output/rows rejected; 10,001 records retained completely |
| Admission | At most two concurrent executions per API process; eight files of at most 10 MiB per import session | Third execution rejected while two run; upload limits checked before discovery |

The VM inside the worker is an evaluation adapter. OS configuration provides
the execution boundary. [Node documents the VM limitation](https://nodejs.org/api/vm.html);
[bubblewrap documents that the caller defines its policy](https://github.com/containers/bubblewrap).
The controller supplies all command arguments and profile values; model output
can provide code and data only. Each invocation gets a fresh execution component
and records its ID, profile, code/input/output hashes and times.

`ready` means a candidate can proceed to import. `resolved` requires actual
dataset registration and complete readback; generated rows must also match their
artifact checksum. Dynamic JavaScript parsers require independently confirmed
row counts and fields; fixture acceptance can additionally pin the expected row
hash. These structural checks do not prove arbitrary business semantics.

Candidates remain staged until import verification succeeds. Failed versions
must preserve the active artifact. Telemetry is separate from immutable content.
Legacy flat plugin JSONs are preserved but not automatically trusted. Runtime
driver tasks without an equivalent isolation/full-read profile are blocked.

Tests use synthetic data and temporary registries. No Windows `.koiforge` data
or user datasets belong in acceptance runs. Commands and results are recorded in
`KE0-VALIDATION.md` after execution, not inferred from this contract.
