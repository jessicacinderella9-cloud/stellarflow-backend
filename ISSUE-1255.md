# Issue #1255: DAO Governance Voting Power Historical Checkpoint Indexer

## Description

Index `DelegateChanged` and `DelegateVotesChanged` contract events to maintain an
efficient checkpointed record of voting power per address over time.

## Requirements

- Parse governance vote checkpoint events from Soroban RPC ledger streams —
  `SorobanEventListener` polls both event topics alongside its existing ledger
  stream handling and forwards decoded payloads to the indexer.
- Store historical vote weight records with starting and ending block numbers —
  each `governance_voting_power_checkpoint` row is a `[fromLedger, toLedger)`
  range: a `DelegateVotesChanged` event closes the address' open range at the
  event ledger and opens a new range with the updated weight, so the previous
  range ends exactly where the next one starts. `DelegateChanged` events get the
  same range treatment on `governance_delegation_checkpoint`.
- Provide fast lookup `get_past_votes(address, ledger_sequence)` —
  `getPastVotes()` (contract-style alias `get_past_votes()`) resolves the
  covering range with a single indexed `findFirst` on
  `@@unique([accountId, fromLedger])`.

## Acceptance Criteria

- Querying past voting weight for any historical ledger sequence completes in
  < 10 ms — verified by `test/votingPowerCheckpointIndexer.jest.test.ts`:
  500 lookups across 20k checkpointed ranges stay far under budget, and each
  lookup is asserted to issue exactly one indexed query (point lookup, no scan).
- Accurately reflects historical delegation shifts — range closing/reopening,
  same-ledger folding, replay no-ops, per-address isolation, and
  delegation-induced vote shifts are all covered by the same suite (15 tests).
