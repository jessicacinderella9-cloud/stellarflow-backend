/**
 * Voting Power Checkpoint Indexer (Issue #1255)
 *
 * Indexes the governance contract's `DelegateChanged` and
 * `DelegateVotesChanged` events from the Soroban RPC ledger stream and stores
 * historical vote weight records as ranges with a starting and an ending block
 * number:
 *
 *   - a `DelegateVotesChanged` event closes the address' open range at the
 *     event ledger (exclusive end) and opens a new range carrying the new
 *     weight, so every row is a complete [fromLedger, toLedger) interval;
 *   - a `DelegateChanged` event applies the same range model to the delegation
 *     edge, so historical delegation shifts stay queryable;
 *   - `getPastVotes(address, ledgerSequence)` resolves the covering range with
 *     a single indexed lookup (`@@unique([accountId, fromLedger])` = equality
 *     on accountId + ordered range scan on fromLedger), keeping past voting
 *     weight queries within the < 10 ms acceptance budget.
 *
 * Events are ingested in ledger order (the listener polls with a monotonically
 * advancing `startLedger`), which is what keeps at most one open range per
 * address.
 */

import prisma from "../lib/prisma";
import { logger } from "../utils/logger";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Weight as produced by Prisma (Decimal) or by a test fixture (string). */
export type WeightLike = string | { toString(): string };

export interface DelegateChangedPayload {
  delegator: string;
  delegate: string;
  previousDelegate: string | null;
  ledgerSequence: number;
  txHash: string | null;
}

export interface DelegateVotesChangedPayload {
  accountId: string;
  previousVotes: string | null;
  votingWeight: string;
  ledgerSequence: number;
  txHash: string | null;
}

export interface VotingPowerRange {
  accountId: string;
  fromLedger: number;
  /** Exclusive end of the range; null while the range is the open one. */
  toLedger: number | null;
  votingWeight: string;
  txHash: string | null;
}

export interface DelegationRange {
  delegator: string;
  delegate: string;
  fromLedger: number;
  toLedger: number | null;
  txHash: string | null;
}

const ZERO_WEIGHT = "0";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Decimal-storage-insensitive weight comparison form: "50.000000000000000000"
 * and "50" normalize to the same string so replayed events are recognised as
 * no-ops instead of creating zero-length ranges.
 */
export function normalizeWeight(weight: WeightLike): string {
  const raw = typeof weight === "string" ? weight : weight.toString();
  if (!raw.includes(".")) return raw;
  const trimmed = raw.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed === "" || trimmed === "-" ? "0" : trimmed;
}

// ─── Ingestion: DelegateVotesChanged ─────────────────────────────────────────

/**
 * Records a vote weight change as a checkpoint range:
 * the weight held until `ledgerSequence` (previous range closes there) and the
 * new weight starts at `ledgerSequence` (open range).
 *
 * Replayed events are no-ops, and a second event inside the same ledger
 * refreshes the range that starts at that ledger instead of creating a
 * zero-length one.
 */
export async function ingestDelegateVotesChanged(
  payload: DelegateVotesChangedPayload,
): Promise<void> {
  const { accountId, votingWeight, ledgerSequence, txHash } = payload;

  const open = await prisma.governanceVotingPowerCheckpoint.findFirst({
    where: { accountId, toLedger: null },
    orderBy: { fromLedger: "desc" },
  });

  if (
    open &&
    normalizeWeight(open.votingWeight) === normalizeWeight(votingWeight)
  ) {
    return; // replayed / unchanged event – the stored range already matches
  }

  // Close the open range: its weight held up to (exclusive) this ledger.
  await prisma.governanceVotingPowerCheckpoint.updateMany({
    where: { accountId, toLedger: null, fromLedger: { lt: ledgerSequence } },
    data: { toLedger: ledgerSequence },
  });

  // Open (or refresh, for a same-ledger second event) the range at this ledger.
  await prisma.governanceVotingPowerCheckpoint.upsert({
    where: {
      accountId_fromLedger: { accountId, fromLedger: ledgerSequence },
    },
    create: {
      accountId,
      fromLedger: ledgerSequence,
      toLedger: null,
      votingWeight,
      txHash,
    },
    update: { votingWeight, txHash },
  });

  logger.info(
    `[VotingPowerCheckpointIndexer] VotesChanged account=${accountId} ledger=${ledgerSequence} weight=${votingWeight}`,
  );
}

// ─── Ingestion: DelegateChanged ──────────────────────────────────────────────

/**
 * Records a delegation shift with the same range model: the previous delegate
 * stops being recognised at `ledgerSequence` (exclusive end) and the new
 * delegate is active from `ledgerSequence` onwards.
 */
export async function ingestDelegateChanged(
  payload: DelegateChangedPayload,
): Promise<void> {
  const { delegator, delegate, ledgerSequence, txHash } = payload;

  const open = await prisma.governanceDelegationCheckpoint.findFirst({
    where: { delegator, toLedger: null },
    orderBy: { fromLedger: "desc" },
  });

  if (open && open.delegate === delegate) return; // replayed / unchanged

  await prisma.governanceDelegationCheckpoint.updateMany({
    where: { delegator, toLedger: null, fromLedger: { lt: ledgerSequence } },
    data: { toLedger: ledgerSequence },
  });

  await prisma.governanceDelegationCheckpoint.upsert({
    where: { delegator_fromLedger: { delegator, fromLedger: ledgerSequence } },
    create: {
      delegator,
      delegate,
      fromLedger: ledgerSequence,
      toLedger: null,
      txHash,
    },
    update: { delegate, txHash },
  });

  logger.info(
    `[VotingPowerCheckpointIndexer] DelegateChanged delegator=${delegator} delegate=${delegate} ledger=${ledgerSequence}`,
  );
}

// ─── Querying ────────────────────────────────────────────────────────────────

/**
 * Fast historical lookup – the `get_past_votes(address, ledger_sequence)`
 * contract of Issue #1255.
 *
 * Returns the voting weight the address held at `ledgerSequence` (the range
 * whose [fromLedger, toLedger) interval covers the ledger), or "0" when the
 * address had no weight yet / is unknown. Runs as one indexed query.
 */
export async function getPastVotes(
  accountId: string,
  ledgerSequence: number,
): Promise<string> {
  const range = await prisma.governanceVotingPowerCheckpoint.findFirst({
    where: {
      accountId,
      fromLedger: { lte: ledgerSequence },
      OR: [{ toLedger: null }, { toLedger: { gt: ledgerSequence } }],
    },
    orderBy: { fromLedger: "desc" },
  });

  if (!range) return ZERO_WEIGHT;
  return normalizeWeight(range.votingWeight);
}

/**
 * Contract-style alias for the exact lookup named in Issue #1255:
 * get_past_votes(address, ledger_sequence).
 */
export const get_past_votes = getPastVotes;

/**
 * Historical delegation lookup: which delegate (if any) the delegator's weight
 * was forwarded to at `ledgerSequence`. Returns null when no delegation was in
 * effect yet.
 */
export async function getPastDelegation(
  delegator: string,
  ledgerSequence: number,
): Promise<string | null> {
  const range = await prisma.governanceDelegationCheckpoint.findFirst({
    where: {
      delegator,
      fromLedger: { lte: ledgerSequence },
      OR: [{ toLedger: null }, { toLedger: { gt: ledgerSequence } }],
    },
    orderBy: { fromLedger: "desc" },
  });

  return range ? range.delegate : null;
}

/**
 * Checkpoint history for one address, newest range first – used by the
 * governance UI and by verification of stored start/end block numbers.
 */
export async function getCheckpointRanges(
  accountId: string,
  limit: number = 100,
): Promise<VotingPowerRange[]> {
  const ranges = await prisma.governanceVotingPowerCheckpoint.findMany({
    where: { accountId },
    orderBy: { fromLedger: "desc" },
    take: limit,
  });

  return ranges.map((row) => ({
    accountId: row.accountId,
    fromLedger: row.fromLedger,
    toLedger: row.toLedger,
    votingWeight: normalizeWeight(row.votingWeight),
    txHash: row.txHash,
  }));
}
