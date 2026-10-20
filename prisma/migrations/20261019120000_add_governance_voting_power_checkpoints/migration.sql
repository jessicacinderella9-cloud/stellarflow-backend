-- Issue #1255: DAO Governance Voting Power Historical Checkpoint Indexer.
-- DelegateVotesChanged / DelegateChanged events are stored as ranges with a
-- starting block (fromLedger, inclusive) and an ending block (toLedger,
-- exclusive, NULL while the range is still open), so past voting weight can be
-- resolved for any historical ledger sequence with a single indexed lookup.

-- CreateTable
CREATE TABLE "GovernanceVotingPowerCheckpoint" (
    "id" SERIAL NOT NULL,
    "accountId" TEXT NOT NULL,
    "fromLedger" INTEGER NOT NULL,
    "toLedger" INTEGER,
    "votingWeight" DECIMAL(38,18) NOT NULL,
    "txHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GovernanceVotingPowerCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GovernanceDelegationCheckpoint" (
    "id" SERIAL NOT NULL,
    "delegator" TEXT NOT NULL,
    "delegate" TEXT NOT NULL,
    "fromLedger" INTEGER NOT NULL,
    "toLedger" INTEGER,
    "txHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GovernanceDelegationCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GovernanceVotingPowerCheckpoint_accountId_toLedger_idx" ON "GovernanceVotingPowerCheckpoint"("accountId", "toLedger");

-- CreateIndex
CREATE INDEX "GovernanceVotingPowerCheckpoint_fromLedger_idx" ON "GovernanceVotingPowerCheckpoint"("fromLedger");

-- CreateIndex
CREATE UNIQUE INDEX "GovernanceVotingPowerCheckpoint_accountId_fromLedger_key" ON "GovernanceVotingPowerCheckpoint"("accountId", "fromLedger");

-- CreateIndex
CREATE INDEX "GovernanceDelegationCheckpoint_delegator_toLedger_idx" ON "GovernanceDelegationCheckpoint"("delegator", "toLedger");

-- CreateIndex
CREATE UNIQUE INDEX "GovernanceDelegationCheckpoint_delegator_fromLedger_key" ON "GovernanceDelegationCheckpoint"("delegator", "fromLedger");
