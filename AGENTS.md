# Accord development

Accord has no runtime dependencies beyond Node. Use the unchanged embedded SQLite
store under vendor/messenger rather than a competing mailbox. Accord owns its thin
address adapter and authenticated host transport outbox.

Preserve these invariants:

- An unknown or unconfirmed release remains held.
- Every ownership mutation is transactional and checks the current leader.
- Revoked generations never reactivate, including after process restart.
- Driver receipts prove only effects the driver actually controls.
- Every tested capability is distinguished from future or simulated behavior.
- Fixtures never contact live agents, shared GPUs, or external model services.

Run `npm run verify` after ownership or recovery changes. Inspect both coordinator
events and driver audit. Add a regression case for every repaired failure mode.
Keep credentials, temporary databases and `evidence/` out of version control.

The initial JavaScript modules run directly on Node; no build toolchain is needed.
Number and checksum schema migrations. Published migrations never change; add a new one.

Passing local tests does not authorize touching a running service or shared hardware.
