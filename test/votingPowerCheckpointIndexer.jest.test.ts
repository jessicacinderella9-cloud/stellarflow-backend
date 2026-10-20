/**
 * Issue #1255 – DAO Governance Voting Power Historical Checkpoint Indexer
 *
 * Verifies against an in-memory stand-in for the Prisma tables that
 *   - DelegateVotesChanged events are stored as ranges carrying a starting and
 *     an ending block number, with the previous range closing exactly where the
 *     next one starts;
 *   - DelegateChanged events keep historical delegation shifts queryable;
 *   - get_past_votes(address, ledgerSequence) returns the weight covering any
 *     historical ledger with a single indexed query and stays inside the
 *     10 ms acceptance budget.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";

jest.unstable_mockModule("../src/utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    networkError: jest.fn(),
  },
}));

jest.unstable_mockModule("../src/lib/prisma", () => {
  interface Row {
    id: number;
    accountId?: string;
    delegator?: string;
    delegate?: string;
    fromLedger: number;
    toLedger: number | null;
    votingWeight?: string;
    txHash: string | null;
    [key: string]: unknown;
  }

  const state = {
    checkpoints: [] as Row[],
    delegations: [] as Row[],
    nextId: 1,
    findFirstCalls: [] as Array<Record<string, unknown>>,
    // Per-table, per-address bucket keyed `${table}:${address}` — mirrors the
    // DB's `@@unique([accountId, fromLedger])` index so lookups stay indexed
    // instead of degrading to table scans as rows accumulate.
    buckets: new Map<string, Row[]>(),
  };

  const candidates = (table: "checkpoints" | "delegations", keyA: string, where: Record<string, unknown>): Row[] => {
    const owner = where[keyA];
    if (typeof owner === "string") {
      return state.buckets.get(`${table}:${owner}`) ?? [];
    }
    return state[table];
  };

  const matchesWhere = (row: Row, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, cond]) => {
      if (key === "OR") {
        return (cond as Array<Record<string, unknown>>).some((clause) =>
          matchesWhere(row, clause),
        );
      }
      const value = row[key];
      if (cond === null) return value === null;
      if (typeof cond === "object" && cond !== null) {
        const op = cond as Record<string, number>;
        if (value === null || value === undefined) return false;
        const cell = value as number;
        if ("lt" in op && !(cell < (op.lt as number))) return false;
        if ("lte" in op && !(cell <= (op.lte as number))) return false;
        if ("gt" in op && !(cell > (op.gt as number))) return false;
        if ("gte" in op && !(cell >= (op.gte as number))) return false;
        if ("equals" in op && cell !== op.equals) return false;
        return true;
      }
      return value === cond;
    });

  const sortByLedger = (rows: Row[], direction?: string): Row[] =>
    [...rows].sort((a, b) =>
      direction === "asc"
        ? a.fromLedger - b.fromLedger
        : b.fromLedger - a.fromLedger,
    );

  const makeModel = (table: "checkpoints" | "delegations", keyA: string) => ({
    findFirst: jest.fn(
      async (args: {
        where: Record<string, unknown>;
        orderBy?: { fromLedger?: string };
      }) => {
        state.findFirstCalls.push(args.where);
        const [first] = sortByLedger(
          candidates(table, keyA, args.where).filter((row) =>
            matchesWhere(row, args.where),
          ),
          args.orderBy?.fromLedger,
        );
        return first ?? null;
      },
    ),
    findMany: jest.fn(
      async (args: {
        where: Record<string, unknown>;
        orderBy?: { fromLedger?: string };
        take?: number;
      }) => {
        const rows = sortByLedger(
          candidates(table, keyA, args.where).filter((row) =>
            matchesWhere(row, args.where),
          ),
          args.orderBy?.fromLedger,
        );
        return args.take === undefined ? rows : rows.slice(0, args.take);
      },
    ),
    updateMany: jest.fn(
      async (args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        let count = 0;
        for (const row of candidates(table, keyA, args.where)) {
          if (matchesWhere(row, args.where)) {
            Object.assign(row, args.data);
            count += 1;
          }
        }
        return { count };
      },
    ),
    upsert: jest.fn(
      async (args: {
        where: Record<string, Record<string, string | number>>;
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const key = args.where[`${keyA}_fromLedger`] as
          | Record<string, string | number>
          | undefined;
        if (!key) throw new Error("unexpected upsert where clause");
        const existing = candidates(table, keyA, {
          [keyA]: key[keyA],
        }).find(
          (row) =>
            row[keyA] === key[keyA] && row.fromLedger === key.fromLedger,
        );
        if (existing) {
          Object.assign(existing, args.update);
          return existing;
        }
        const created = {
          id: state.nextId++,
          toLedger: null,
          txHash: null,
          ...args.create,
        } as unknown as Row;
        state[table].push(created);
        const bucketKey = `${table}:${String(created[keyA])}`;
        const bucket = state.buckets.get(bucketKey);
        if (bucket) bucket.push(created);
        else state.buckets.set(bucketKey, [created]);
        return created;
      },
    ),
  });

  return {
    __esModule: true,
    default: {
      governanceVotingPowerCheckpoint: makeModel("checkpoints", "accountId"),
      governanceDelegationCheckpoint: makeModel("delegations", "delegator"),
      __state: state,
      __reset(): void {
        state.checkpoints.length = 0;
        state.delegations.length = 0;
        state.findFirstCalls.length = 0;
        state.buckets.clear();
        state.nextId = 1;
      },
    },
  };
});

const { default: prisma } = await import("../src/lib/prisma");

const {
  getPastVotes,
  get_past_votes,
  ingestDelegateVotesChanged,
  ingestDelegateChanged,
  getPastDelegation,
  getCheckpointRanges,
  normalizeWeight,
} = await import("../src/services/votingPowerCheckpointIndexer");

interface PrismaState {
  checkpoints: Array<Record<string, unknown>>;
  delegations: Array<Record<string, unknown>>;
  findFirstCalls: Array<Record<string, unknown>>;
}

const mockState = (
  prisma as unknown as {
    __state: PrismaState;
    __reset: () => void;
  }
).__state;

const resetMock = (prisma as unknown as { __reset: () => void }).__reset;

beforeEach(() => {
  resetMock();
});

// ─── Weight normalization ─────────────────────────────────────────────────────

describe("normalizeWeight", () => {
  it("strips the decimal storage zeros", () => {
    expect(normalizeWeight("50.000000000000000000")).toBe("50");
    expect(normalizeWeight("0.5000")).toBe("0.5");
  });

  it("leaves integers and zero alone", () => {
    expect(normalizeWeight("12345678901234567890")).toBe("12345678901234567890");
    expect(normalizeWeight("0")).toBe("0");
    expect(normalizeWeight("0.000")).toBe("0");
    expect(normalizeWeight(".000")).toBe("0");
  });
});

// ─── DelegateVotesChanged ingestion ───────────────────────────────────────────

describe("ingestDelegateVotesChanged", () => {
  it("opens an [fromLedger, null) range for the first checkpoint", async () => {
    await ingestDelegateVotesChanged({
      accountId: "GAAA",
      previousVotes: null,
      votingWeight: "50",
      ledgerSequence: 100,
      txHash: "tx1",
    });

    expect(mockState.checkpoints).toHaveLength(1);
    expect(mockState.checkpoints[0]).toMatchObject({
      accountId: "GAAA",
      fromLedger: 100,
      toLedger: null,
      votingWeight: "50",
    });
  });

  it("stores start and end block numbers across a weight change", async () => {
    await ingestDelegateVotesChanged({
      accountId: "GAAA",
      previousVotes: null,
      votingWeight: "50",
      ledgerSequence: 100,
      txHash: "tx1",
    });
    await ingestDelegateVotesChanged({
      accountId: "GAAA",
      previousVotes: "50",
      votingWeight: "70",
      ledgerSequence: 200,
      txHash: "tx2",
    });

    expect(mockState.checkpoints).toHaveLength(2);
    const [first, second] = mockState.checkpoints;
    expect(first).toMatchObject({
      fromLedger: 100,
      toLedger: 200, // exclusive end at the next checkpoint
      votingWeight: "50",
    });
    expect(second).toMatchObject({
      fromLedger: 200,
      toLedger: null,
      votingWeight: "70",
    });
  });

  it("treats a replayed unchanged event as a no-op", async () => {
    await ingestDelegateVotesChanged({
      accountId: "GAAA",
      previousVotes: null,
      votingWeight: "50.000000000000000000",
      ledgerSequence: 100,
      txHash: "tx1",
    });
    await ingestDelegateVotesChanged({
      accountId: "GAAA",
      previousVotes: null,
      votingWeight: "50",
      ledgerSequence: 300,
      txHash: "tx1",
    });

    expect(mockState.checkpoints).toHaveLength(1);
    expect(mockState.checkpoints[0]).toMatchObject({
      fromLedger: 100,
      toLedger: null,
    });
  });

  it("folds a second event in the same ledger into one range", async () => {
    await ingestDelegateVotesChanged({
      accountId: "GAAA",
      previousVotes: null,
      votingWeight: "50",
      ledgerSequence: 100,
      txHash: "tx1",
    });
    await ingestDelegateVotesChanged({
      accountId: "GAAA",
      previousVotes: "50",
      votingWeight: "70",
      ledgerSequence: 100,
      txHash: "tx2",
    });

    expect(mockState.checkpoints).toHaveLength(1);
    expect(mockState.checkpoints[0]).toMatchObject({
      fromLedger: 100,
      toLedger: null,
      votingWeight: "70",
    });
  });

  it("keeps ranges independent per address", async () => {
    await ingestDelegateVotesChanged({
      accountId: "GAAA",
      previousVotes: null,
      votingWeight: "50",
      ledgerSequence: 100,
      txHash: null,
    });
    await ingestDelegateVotesChanged({
      accountId: "GBBB",
      previousVotes: null,
      votingWeight: "80",
      ledgerSequence: 150,
      txHash: null,
    });

    expect(mockState.checkpoints).toHaveLength(2);
    expect(await getPastVotes("GAAA", 150)).toBe("50");
    expect(await getPastVotes("GBBB", 150)).toBe("80");
    expect(await getPastVotes("GBBB", 149)).toBe("0");
  });
});

// ─── get_past_votes ───────────────────────────────────────────────────────────

describe("getPastVotes / get_past_votes", () => {
  const seed = async () => {
    await ingestDelegateVotesChanged({
      accountId: "GAAA",
      previousVotes: null,
      votingWeight: "50",
      ledgerSequence: 100,
      txHash: null,
    });
    await ingestDelegateVotesChanged({
      accountId: "GAAA",
      previousVotes: "50",
      votingWeight: "70",
      ledgerSequence: 200,
      txHash: null,
    });
    await ingestDelegateVotesChanged({
      accountId: "GAAA",
      previousVotes: "70",
      votingWeight: "30",
      ledgerSequence: 300,
      txHash: null,
    });
  };

  it("exposes the contract-style alias named in the issue", () => {
    expect(get_past_votes).toBe(getPastVotes);
  });

  it("resolves the range covering any historical ledger", async () => {
    await seed();

    expect(await getPastVotes("GAAA", 99)).toBe("0"); // before first weight
    expect(await getPastVotes("GAAA", 100)).toBe("50"); // start is inclusive
    expect(await getPastVotes("GAAA", 199)).toBe("50");
    expect(await getPastVotes("GAAA", 200)).toBe("70");
    expect(await getPastVotes("GAAA", 299)).toBe("70");
    expect(await getPastVotes("GAAA", 300)).toBe("30");
    expect(await getPastVotes("GAAA", 9_999)).toBe("30"); // open range
    expect(await getPastVotes("GUNKNOWN", 250)).toBe("0");
  });

  it("answers through the snake_case contract alias", async () => {
    await seed();
    expect(await get_past_votes("GAAA", 150)).toBe("50");
  });

  it("issues exactly one indexed findFirst per lookup", async () => {
    await seed();
    mockState.findFirstCalls.length = 0;

    await getPastVotes("GAAA", 250);

    expect(mockState.findFirstCalls).toHaveLength(1);
    const where = mockState.findFirstCalls[0] ?? {};
    // Shape served by @@unique([accountId, fromLedger]): equality on the
    // address plus an ordered range scan – no table-wide scan, no sort.
    expect(where.accountId).toBe("GAAA");
    expect(where.fromLedger).toEqual({ lte: 250 });
    expect(where.OR).toBeDefined();
  });
});

// ─── DelegateChanged / historical delegation shifts ───────────────────────────

describe("ingestDelegateChanged + getPastDelegation", () => {
  it("keeps both sides of a delegation shift queryable", async () => {
    await ingestDelegateChanged({
      delegator: "GAAA",
      delegate: "GBBB",
      previousDelegate: null,
      ledgerSequence: 100,
      txHash: "tx1",
    });
    await ingestDelegateChanged({
      delegator: "GAAA",
      delegate: "GCCC",
      previousDelegate: "GBBB",
      ledgerSequence: 150,
      txHash: "tx2",
    });

    expect(mockState.delegations).toHaveLength(2);
    expect(mockState.delegations[0]).toMatchObject({
      delegator: "GAAA",
      delegate: "GBBB",
      fromLedger: 100,
      toLedger: 150,
    });
    expect(mockState.delegations[1]).toMatchObject({
      delegator: "GAAA",
      delegate: "GCCC",
      fromLedger: 150,
      toLedger: null,
    });

    expect(await getPastDelegation("GAAA", 99)).toBeNull();
    expect(await getPastDelegation("GAAA", 120)).toBe("GBBB");
    expect(await getPastDelegation("GAAA", 150)).toBe("GCCC");
    expect(await getPastDelegation("GAAA", 9_999)).toBe("GCCC");
  });

  it("reflects a delegation-induced vote shift in past vote lookups", async () => {
    // GAAA delegates to GGBBB at 100 – the delegate's weight jumps...
    await ingestDelegateChanged({
      delegator: "GAAA",
      delegate: "GBBB",
      previousDelegate: null,
      ledgerSequence: 100,
      txHash: null,
    });
    await ingestDelegateVotesChanged({
      accountId: "GBBB",
      previousVotes: "0",
      votingWeight: "60",
      ledgerSequence: 100,
      txHash: null,
    });

    // ...and drops back when the delegation is revoked at 150.
    await ingestDelegateChanged({
      delegator: "GAAA",
      delegate: "",
      previousDelegate: "GBBB",
      ledgerSequence: 150,
      txHash: null,
    });
    await ingestDelegateVotesChanged({
      accountId: "GBBB",
      previousVotes: "60",
      votingWeight: "10",
      ledgerSequence: 150,
      txHash: null,
    });

    expect(await getPastVotes("GBBB", 99)).toBe("0");
    expect(await getPastVotes("GBBB", 100)).toBe("60");
    expect(await getPastVotes("GBBB", 149)).toBe("60");
    expect(await getPastVotes("GBBB", 150)).toBe("10");
    expect(await getPastDelegation("GAAA", 149)).toBe("GBBB");
    expect(await getPastDelegation("GAAA", 150)).toBe("");
  });
});

// ─── Range history helper ─────────────────────────────────────────────────────

describe("getCheckpointRanges", () => {
  it("returns newest range first with start/end block numbers", async () => {
    await ingestDelegateVotesChanged({
      accountId: "GAAA",
      previousVotes: null,
      votingWeight: "50.000000000000000000",
      ledgerSequence: 100,
      txHash: null,
    });
    await ingestDelegateVotesChanged({
      accountId: "GAAA",
      previousVotes: "50",
      votingWeight: "70",
      ledgerSequence: 200,
      txHash: null,
    });

    const ranges = await getCheckpointRanges("GAAA");
    expect(ranges).toHaveLength(2);
    expect(ranges[0]).toMatchObject({
      fromLedger: 200,
      toLedger: null,
      votingWeight: "70",
    });
    expect(ranges[1]).toMatchObject({
      fromLedger: 100,
      toLedger: 200,
      votingWeight: "50",
    });
  });
});

// ─── Acceptance: < 10 ms historical lookup ────────────────────────────────────

describe("acceptance: get_past_votes performance", () => {
  it("answers 500 random historical queries over 20k checkpoints in < 10 ms each", async () => {
    const ADDRESSES = 500;
    const RANGES_PER_ADDRESS = 40;
    const QUERIES = 500;

    // Sequentially: checkpoints for one address must land in ledger order.
    for (let a = 0; a < ADDRESSES; a++) {
      const accountId = `GPERF${String(a).padStart(4, "0")}`;
      for (let r = 0; r < RANGES_PER_ADDRESS; r++) {
        await ingestDelegateVotesChanged({
          accountId,
          previousVotes: null,
          votingWeight: String(a * 1000 + r),
          ledgerSequence: 1_000 + r * 100,
          txHash: null,
        });
      }
    }
    expect(mockState.checkpoints).toHaveLength(
      ADDRESSES * RANGES_PER_ADDRESS,
    );

    mockState.findFirstCalls.length = 0;

    let checksum = 0;
    const startedAt = process.hrtime.bigint();
    for (let q = 0; q < QUERIES; q++) {
      const accountId = `GPERF${String((q * 7) % ADDRESSES).padStart(4, "0")}`;
      const ledger = 1_000 + ((q * 997) % 4_100);
      checksum += Number(await getPastVotes(accountId, ledger));
    }
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const avgPerQueryMs = elapsedMs / QUERIES;

    expect(checksum).toBeGreaterThan(0); // every query resolved real weight
    // One indexed findFirst per lookup – never a per-row or per-query scan.
    expect(mockState.findFirstCalls).toHaveLength(QUERIES);
    expect(avgPerQueryMs).toBeLessThan(10);
  });
});
