import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import { createTestIndexer } from "envio";

// Envio's chain id for Solana mainnet (`id: solana` in config.yaml).
const SOLANA = 7565164;
// Worm's own account: creator of curated markets, and a frequent counterparty.
const WORM = "HjXFH3RDdsZ4bWEJzupnCyHMCmPebn83qWKqogCGKthX";

// Real mainnet instructions, captured from HyperSync (test/fixtures.json).
type Fixture = {
  program: string;
  instruction: string;
  slot: number;
  time: number;
  path: number[];
  signature: string;
  accounts: string[];
  data: string;
};
const fixtures: Record<string, Fixture[]> = JSON.parse(
  readFileSync(new URL("./fixtures.json", import.meta.url), "utf8"),
);

const item = (f: Fixture) => ({
  program: f.program,
  instruction: f.instruction,
  slot: f.slot,
  path: f.path,
  accountArguments: f.accounts,
  data: Uint8Array.from(Buffer.from(f.data, "hex")),
  block: { time: f.time },
  transaction: { signature: f.signature, success: true },
});

const run = async (...names: string[]) => {
  const indexer = createTestIndexer();
  const simulate = names
    .flatMap((n) => fixtures[n]!)
    .sort((a, b) => a.slot - b.slot)
    .map(item) as never[];
  await indexer.process({ chains: { [SOLANA]: { simulate } } });
  return indexer;
};

describe("Worm handlers", () => {
  it("follows a market from creation to payout", async (t) => {
    const indexer = await run("market");
    const MARKET = "GfWGNSqQHo9LrnY8UcW4uDNaWNoksiWnpZYpxR65t2Va";
    const YES_BUYER = "3xQGSjVrX3jTSYazgtwk7tqGYTXDpT2KfJwJNuJwGHFa";

    // One fill: 1.23 shares at a YES price of $0.22. The YES buyer pays
    // $0.2706 and the NO buyer $0.9594, so $1.23 changes hands.
    const [fill] = await indexer.Fill.getAll();
    t.expect(fill).toMatchObject({
      market_id: MARKET,
      kind: "MINT",
      shares: 1_230_000n,
      price: 220_000,
      usdc: 1_230_000n,
      fee: 43_788n,
      partyA_id: YES_BUYER,
      partyB_id: WORM,
    });

    // The market resolved YES, so the YES buyer's 1.23 shares paid $1.23, and
    // the fee settlement paid out exactly what the fill charged, half to the creator.
    t.expect(await indexer.Market.getOrThrow(MARKET)).toMatchObject({
      title: "Draw",
      creator: WORM,
      yesMint: "8SwXVqmafJ5qx7Nb1No1a6aCFdopb2p8ZaacAUq7LbzD",
      noMint: "GSucvaTJyyppBPVZ9spdpctNorPBnpRsaVzm6EeyDGMw",
      status: "RESOLVED",
      outcome: "YES",
      fillCount: 1,
      volume: 1_230_000n,
      fees: 43_788n,
      feesSettled: 43_788n,
      creatorFeesPaid: 21_894n,
      lastPrice: 220_000,
      redeemed: 1_230_000n,
    });
    const [redemption] = await indexer.Redemption.getAll();
    t.expect(redemption).toMatchObject({
      market_id: MARKET,
      account_id: YES_BUYER,
      payout: 1_230_000n,
      yesBurned: 1_230_000n,
      noBurned: 0n,
    });
    t.expect(await indexer.Protocol.getOrThrow("worm")).toMatchObject({
      marketCount: 1,
      resolvedCount: 1,
      yesCount: 1,
      noCount: 0,
      tradedMarketCount: 1,
      fillCount: 1,
      traderCount: 2,
      volume: 1_230_000n,
      fees: 43_788n,
      creatorFees: 21_894n,
      redemptionCount: 1,
      redeemed: 1_230_000n,
    });
  });

  it("values a swap at what the buyer paid", async (t) => {
    const indexer = await run("fill_swap");
    // 1.11 NO shares with YES at $0.10: the buyer pays 1.11 × $0.90.
    const [fill] = await indexer.Fill.getAll();
    t.expect(fill).toMatchObject({
      kind: "SWAP",
      shares: 1_110_000n,
      price: 100_000,
      usdc: 999_000n,
      fee: 64_380n,
      isYes: false,
      partyA_id: "9avH5XWe8tJycPX7rK4LpVwA66wLh1HUBTyewPAuZf61",
      partyB_id: "3wW9tDGp89LHLWS6Rf9aGKwm9wY5WYX97wcpGg53ryzq",
    });
  });

  it("values a merge at the USDC released", async (t) => {
    const indexer = await run("fill_merge");
    const [fill] = await indexer.Fill.getAll();
    t.expect(fill).toMatchObject({ kind: "MERGE", shares: 4_800_000n, price: 500_000, usdc: 4_800_000n, fee: 144_000n });
    // A fill on a market created before the first indexed slot still makes a market row.
    t.expect(await indexer.Market.getOrThrow("GkuMVCxzUbHwe1Vtxh14sENYZDmrtffZUa8ypyVD1Fus")).toMatchObject({
      status: "OPEN",
      fillCount: 1,
      volume: 4_800_000n,
    });
  });

  it("totals the USDC locked behind orders and released from them", async (t) => {
    const indexer = await run("lock", "unlock");
    t.expect(await indexer.Protocol.getOrThrow("worm")).toMatchObject({
      lockCount: 1,
      unlockCount: 1,
      lockerCount: 1,
      usdcLocked: 25_000_000n,
      usdcUnlocked: 20_000_000n,
    });
    t.expect(await indexer.Account.getOrThrow("6uZW3rsZBS3UFwM5ZMptp1ppRdtBa8UPdpfQ9F7uB9ud")).toMatchObject({
      lockCount: 1,
      usdcLocked: 25_000_000n,
    });
  });

  it("ignores an event that is not under the instruction that logs it", async (t) => {
    // A real redemption event, replayed in a transaction that has no `redeem` above it.
    const indexer = createTestIndexer();
    const forged = { ...item(fixtures.orphan_event![0]!), transaction: { signature: fixtures.lock![0]!.signature, success: true } };
    await indexer.process({ chains: { [SOLANA]: { simulate: [forged] as never[] } } });
    t.expect(await indexer.Redemption.getAll()).toEqual([]);
    t.expect(await indexer.Protocol.get("worm")).toBeUndefined();
  });

  it("creates a wallet and tracks its deposits", async (t) => {
    const indexer = await run("create_wallet", "deposit", "withdraw");
    t.expect(await indexer.Account.getOrThrow("3WqpanYBVrJeKAfdtoS32b3ybzx4pW3G8cAjLZtuzpZb")).toMatchObject({
      owner: WORM,
      deposits: 5_000_000n,
    });
    t.expect(await indexer.Protocol.getOrThrow("worm")).toMatchObject({
      walletCount: 1,
      walletDeposits: 5_000_000n,
      walletWithdrawals: 3_000_000n,
    });
  });

  it("reads both versions of a leveraged position's funding", async (t) => {
    const indexer = await run("fund_position", "fund_position_v1");
    const fundings = (await indexer.PositionFunding.getAll()).sort((a, b) => a.slot - b.slot);
    t.expect(fundings).toMatchObject([
      // The first version carries no side.
      { account_id: "3TcND8nruqwBeHGu5bT6YUqptjNrF3B8XRaHXmgLffhQ", position: "5joCdW5mtmk2bPcrefd7uDPtC4Pt2wpQJa6xbuZGM8vM", collateral: 1_000_000n, leverage: 100, isYes: undefined },
      { account_id: "DKceJWpPPfVMzr3RwUzMGAhY5VTD8TUQKXcda9WnQSR1", position: "CgL3kBTeQSmiS58wTnWpYvWbowqpeuncvSx96jkvTAXr", collateral: 1_000_000n, leverage: 100, isYes: true },
    ]);
    t.expect(await indexer.LeverageTier.getOrThrow("100")).toMatchObject({ count: 2, collateral: 2_000_000n });
    t.expect(await indexer.Protocol.getOrThrow("worm")).toMatchObject({
      positionCount: 2,
      positionWalletCount: 2,
      positionCollateral: 2_000_000n,
    });
  });
});
