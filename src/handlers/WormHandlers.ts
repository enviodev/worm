/*
 * Worm (worm.wtf) on Solana mainnet.
 *
 *   Worm    prediction markets: creation, resolution, order-book fills, the
 *           collateral locked behind orders, redemptions and creator fees
 *   Wallet  the smart wallets Worm makes for its users, and the collateral
 *           they put behind positions on leveraged markets
 *
 * Users sign messages and Worm's operator submits the transactions, so the
 * acting wallet is always read from the instruction's accounts, never from
 * the signers.
 *
 * Units: USDC and outcome shares in raw atoms (6 decimals). Prices are the YES
 * price in millionths of a dollar.
 */
import {
  indexer,
  type Account,
  type DailyStat,
  type Market,
  type Protocol,
  type SvmOnSlotContext,
} from "envio";
import * as decode from "./decode.js";
import * as layout from "./layout.js";

type Ctx = SvmOnSlotContext;

const PROTOCOL_ID = "worm";
const DAY = 86_400;
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const fields = {
  instruction: ["data", "accountArguments", "path"],
  transaction: ["signature", "success"],
  block: ["time"],
} as const;

const rowId = (signature: string, path: readonly number[]) => `${signature}-${path.join(".")}`;

// ---------------------------------------------------------------------------
// Entity defaults
// ---------------------------------------------------------------------------

async function getProtocol(context: Ctx): Promise<Protocol> {
  return (
    (await context.Protocol.get(PROTOCOL_ID)) ?? {
      id: PROTOCOL_ID,
      marketCount: 0,
      resolvedCount: 0,
      yesCount: 0,
      noCount: 0,
      splitCount: 0,
      tradedMarketCount: 0,
      fillCount: 0,
      volume: 0n,
      fees: 0n,
      creatorFees: 0n,
      traderCount: 0,
      lockCount: 0,
      unlockCount: 0,
      usdcLocked: 0n,
      usdcUnlocked: 0n,
      lockerCount: 0,
      redemptionCount: 0,
      redeemed: 0n,
      splitVolume: 0n,
      mergeVolume: 0n,
      walletCount: 0,
      walletDeposits: 0n,
      walletWithdrawals: 0n,
      positionCount: 0,
      positionCollateral: 0n,
      positionWalletCount: 0,
      lastSlot: 0,
      lastTime: 0,
    }
  );
}

async function getAccount(context: Ctx, id: string, time: number): Promise<Account> {
  const existing = await context.Account.get(id);
  if (existing) return { ...existing, lastSeen: time };
  return {
    id,
    owner: undefined,
    fillCount: 0,
    volume: 0n,
    lockCount: 0,
    usdcLocked: 0n,
    usdcUnlocked: 0n,
    redeemed: 0n,
    deposits: 0n,
    withdrawals: 0n,
    positionCount: 0,
    positionCollateral: 0n,
    firstSeen: time,
    lastSeen: time,
  };
}

/** Loads a market, or starts a row for one first seen after it was created. */
async function getMarket(context: Ctx, id: string): Promise<{ market: Market; isNew: boolean }> {
  const existing = await context.Market.get(id);
  if (existing) return { market: existing, isNew: false };
  return {
    isNew: true,
    market: {
      id,
      title: undefined,
      creator: undefined,
      yesMint: undefined,
      noMint: undefined,
      status: "OPEN",
      outcome: undefined,
      createdAt: undefined,
      resolvedAt: undefined,
      fillCount: 0,
      volume: 0n,
      shares: 0n,
      fees: 0n,
      creatorFeesPaid: 0n,
      feesSettled: 0n,
      lastPrice: undefined,
      lastFillAt: undefined,
      redeemed: 0n,
    },
  };
}

async function getDay(context: Ctx, time: number): Promise<DailyStat> {
  const day = Math.floor(time / DAY);
  return (
    (await context.DailyStat.get(String(day))) ?? {
      id: String(day),
      date: day * DAY,
      marketsCreated: 0,
      marketsResolved: 0,
      fills: 0,
      volume: 0n,
      fees: 0n,
      locks: 0,
      usdcLocked: 0n,
      redeemed: 0n,
      walletsCreated: 0,
      positions: 0,
      positionCollateral: 0n,
    }
  );
}

const stamp = (protocol: Protocol, slot: number, time: number): Protocol => ({ ...protocol, lastSlot: slot, lastTime: time });

// ---------------------------------------------------------------------------
// Markets
// ---------------------------------------------------------------------------

indexer.onInstruction({ program: "Worm", instruction: "create_market", fields }, async ({ instruction, context }) => {
  if (!instruction.transaction.success) return;
  const ids = layout.createMarket(instruction.accountArguments);
  const { title } = decode.createMarket(instruction.data);
  const { slot, time } = instruction.block;

  const [{ market, isNew }, protocol, day] = await Promise.all([
    getMarket(context, ids.market),
    getProtocol(context),
    getDay(context, time),
  ]);
  context.Market.set({
    ...market,
    title: title ?? market.title,
    creator: ids.creator,
    yesMint: ids.yesMint,
    noMint: ids.noMint,
    createdAt: time,
  });
  context.Protocol.set(stamp({ ...protocol, marketCount: protocol.marketCount + (isNew ? 1 : 0) }, slot, time));
  context.DailyStat.set({ ...day, marketsCreated: day.marketsCreated + 1 });
});

indexer.onInstruction({ program: "Worm", instruction: "resolve_market", fields }, async ({ instruction, context }) => {
  if (!instruction.transaction.success) return;
  const ids = layout.resolveMarket(instruction.accountArguments);
  const outcome = decode.resolveMarket(instruction.data);
  const { slot, time } = instruction.block;

  const [{ market, isNew }, protocol, day] = await Promise.all([
    getMarket(context, ids.market),
    getProtocol(context),
    getDay(context, time),
  ]);
  const first = market.status !== "RESOLVED";
  // A market resolved twice keeps its first outcome, so the outcome counts stay consistent.
  context.Market.set(first ? { ...market, status: "RESOLVED", outcome, resolvedAt: time } : market);
  context.Protocol.set(
    stamp(
      {
        ...protocol,
        marketCount: protocol.marketCount + (isNew ? 1 : 0),
        resolvedCount: protocol.resolvedCount + (first ? 1 : 0),
        yesCount: protocol.yesCount + (first && outcome === "YES" ? 1 : 0),
        noCount: protocol.noCount + (first && outcome === "NO" ? 1 : 0),
        splitCount: protocol.splitCount + (first && outcome === "SPLIT" ? 1 : 0),
      },
      slot,
      time,
    ),
  );
  if (first) context.DailyStat.set({ ...day, marketsResolved: day.marketsResolved + 1 });
});

// ---------------------------------------------------------------------------
// Order-book fills
// ---------------------------------------------------------------------------

type FillInput = {
  kind: "MINT" | "SWAP" | "MERGE";
  market: string;
  yesMint: string;
  noMint: string;
  partyA: string;
  partyB: string;
  shares: bigint;
  price: number;
  usdc: bigint;
  fee: bigint;
  isYes: boolean | undefined;
};

async function recordFill(
  context: Ctx,
  fill: FillInput,
  at: { slot: number; time: number; signature: string; path: readonly number[] },
) {
  const { slot, time } = at;
  const same = fill.partyA === fill.partyB;
  const [{ market, isNew }, protocol, day, a, b] = await Promise.all([
    getMarket(context, fill.market),
    getProtocol(context),
    getDay(context, time),
    getAccount(context, fill.partyA, time),
    same ? undefined : getAccount(context, fill.partyB, time),
  ]);

  context.Fill.set({
    id: rowId(at.signature, at.path),
    market_id: fill.market,
    kind: fill.kind,
    shares: fill.shares,
    price: fill.price,
    usdc: fill.usdc,
    fee: fill.fee,
    partyA_id: fill.partyA,
    partyB_id: fill.partyB,
    isYes: fill.isYes,
    slot,
    time,
    txSignature: at.signature,
  });
  context.Market.set({
    ...market,
    yesMint: market.yesMint ?? fill.yesMint,
    noMint: market.noMint ?? fill.noMint,
    fillCount: market.fillCount + 1,
    volume: market.volume + fill.usdc,
    shares: market.shares + fill.shares,
    fees: market.fees + fill.fee,
    lastPrice: fill.price,
    lastFillAt: time,
  });

  let newTraders = 0;
  for (const account of [a, b]) {
    if (!account) continue;
    if (account.fillCount === 0) newTraders += 1;
    context.Account.set({ ...account, fillCount: account.fillCount + 1, volume: account.volume + fill.usdc });
  }
  context.Protocol.set(
    stamp(
      {
        ...protocol,
        marketCount: protocol.marketCount + (isNew ? 1 : 0),
        tradedMarketCount: protocol.tradedMarketCount + (market.fillCount === 0 ? 1 : 0),
        fillCount: protocol.fillCount + 1,
        volume: protocol.volume + fill.usdc,
        fees: protocol.fees + fill.fee,
        traderCount: protocol.traderCount + newTraders,
      },
      slot,
      time,
    ),
  );
  context.DailyStat.set({ ...day, fills: day.fills + 1, volume: day.volume + fill.usdc, fees: day.fees + fill.fee });
}

for (const [instructionName, kind] of [
  ["fill_mint", "MINT"],
  ["fill_merge", "MERGE"],
] as const) {
  indexer.onInstruction({ program: "Worm", instruction: instructionName, fields }, async ({ instruction, context }) => {
    if (!instruction.transaction.success) return;
    const ids = layout.fillPair(instruction.accountArguments);
    const args = decode.fillPair(instruction.data);
    await recordFill(
      context,
      {
        kind,
        market: ids.market,
        yesMint: ids.yesMint,
        noMint: ids.noMint,
        partyA: ids.yesParty,
        partyB: ids.noParty,
        shares: args.shares,
        price: args.price,
        usdc: args.yesUsdc + args.noUsdc,
        fee: args.fee,
        isYes: undefined,
      },
      { ...instruction.block, signature: instruction.transaction.signature, path: instruction.path },
    );
  });
}

indexer.onInstruction({ program: "Worm", instruction: "fill_swap", fields }, async ({ instruction, context }) => {
  if (!instruction.transaction.success) return;
  const ids = layout.fillSwap(instruction.accountArguments);
  const args = decode.fillSwap(instruction.data);
  await recordFill(
    context,
    {
      kind: "SWAP",
      market: ids.market,
      yesMint: ids.yesMint,
      noMint: ids.noMint,
      partyA: ids.buyer,
      partyB: ids.seller,
      shares: args.shares,
      price: args.price,
      usdc: args.usdc,
      fee: args.fee,
      isYes: args.isYes,
    },
    { ...instruction.block, signature: instruction.transaction.signature, path: instruction.path },
  );
});

// ---------------------------------------------------------------------------
// Order collateral, splits and merges
// ---------------------------------------------------------------------------

indexer.onInstruction({ program: "Worm", instruction: "lock", fields }, async ({ instruction, context }) => {
  if (!instruction.transaction.success) return;
  const ids = layout.lock(instruction.accountArguments);
  const usdc = ids.mint === USDC ? decode.amount(instruction.data) : 0n;
  const { slot, time } = instruction.block;

  const [protocol, day, account] = await Promise.all([
    getProtocol(context),
    getDay(context, time),
    getAccount(context, ids.wallet, time),
  ]);
  context.Account.set({ ...account, lockCount: account.lockCount + 1, usdcLocked: account.usdcLocked + usdc });
  context.Protocol.set(
    stamp(
      {
        ...protocol,
        lockCount: protocol.lockCount + 1,
        usdcLocked: protocol.usdcLocked + usdc,
        lockerCount: protocol.lockerCount + (account.lockCount === 0 ? 1 : 0),
      },
      slot,
      time,
    ),
  );
  context.DailyStat.set({ ...day, locks: day.locks + 1, usdcLocked: day.usdcLocked + usdc });
});

indexer.onInstruction({ program: "Worm", instruction: "unlock", fields }, async ({ instruction, context }) => {
  if (!instruction.transaction.success) return;
  const ids = layout.unlock(instruction.accountArguments);
  const usdc = ids.mint === USDC ? decode.amount(instruction.data) : 0n;
  const { slot, time } = instruction.block;

  const [protocol, account] = await Promise.all([getProtocol(context), getAccount(context, ids.wallet, time)]);
  context.Account.set({ ...account, usdcUnlocked: account.usdcUnlocked + usdc });
  context.Protocol.set(
    stamp({ ...protocol, unlockCount: protocol.unlockCount + 1, usdcUnlocked: protocol.usdcUnlocked + usdc }, slot, time),
  );
});

for (const [instructionName, field] of [
  ["split", "splitVolume"],
  ["merge", "mergeVolume"],
] as const) {
  indexer.onInstruction({ program: "Worm", instruction: instructionName, fields }, async ({ instruction, context }) => {
    if (!instruction.transaction.success) return;
    const amount = decode.amount(instruction.data);
    const { slot, time } = instruction.block;
    const protocol = await getProtocol(context);
    context.Protocol.set(stamp({ ...protocol, [field]: protocol[field] + amount }, slot, time));
  });
}

// ---------------------------------------------------------------------------
// Events logged under redeem, settle_fees and close_market
// ---------------------------------------------------------------------------

/*
 * The program logs events by calling itself with no accounts, so on its own an
 * event row cannot be told from a forged call. An event is accepted only when
 * it sits directly under the instruction that is expected to log it, which is
 * always handled first in the same transaction.
 */
const parents = { signature: "", byPath: new Map<string, string>() };

/** Remembers a parent instruction and the market it acts on, for the event that follows. */
function markParent(context: Ctx, signature: string, path: readonly number[], name: string, market: string) {
  if (context.isPreload) return;
  if (parents.signature !== signature) {
    parents.signature = signature;
    parents.byPath.clear();
  }
  parents.byPath.set(`${name}:${path.join(".")}`, market);
}

/** The market of the parent this event sits under, or undefined when there is no such parent. */
function parentMarket(signature: string, path: readonly number[], name: string) {
  if (parents.signature !== signature) return undefined;
  return parents.byPath.get(`${name}:${path.slice(0, -1).join(".")}`);
}

const parentFields = { instruction: ["accountArguments", "path"], transaction: ["signature", "success"] } as const;
const eventFields = { instruction: ["data", "path"], transaction: ["signature", "success"], block: ["time"] } as const;

// The market is the first account after the program in all three.
for (const name of ["redeem", "settle_fees", "close_market"] as const) {
  indexer.onInstruction({ program: "Worm", instruction: name, fields: parentFields }, async ({ instruction, context }) => {
    if (!instruction.transaction.success) return;
    markParent(context, instruction.transaction.signature, instruction.path, name, instruction.accountArguments[1]!);
  });
}

indexer.onInstruction(
  { program: "Worm", instruction: "redeemed_event", fields: eventFields },
  async ({ instruction, context }) => {
    const signature = instruction.transaction.signature;
    if (!instruction.transaction.success) return;
    const event = decode.redeemed(instruction.data);
    if (!context.isPreload && parentMarket(signature, instruction.path, "redeem") !== event.market) return;
    // Settling a market redeems its fee account too, which holds no shares.
    if (event.payout === 0n && event.yesBurned === 0n && event.noBurned === 0n) return;
    const { slot, time } = instruction.block;

    const [{ market, isNew }, protocol, day, account] = await Promise.all([
      getMarket(context, event.market),
      getProtocol(context),
      getDay(context, time),
      getAccount(context, event.wallet, time),
    ]);
    context.Redemption.set({
      id: rowId(signature, instruction.path),
      market_id: event.market,
      account_id: event.wallet,
      payout: event.payout,
      yesBurned: event.yesBurned,
      noBurned: event.noBurned,
      slot,
      time,
      txSignature: signature,
    });
    context.Market.set({ ...market, redeemed: market.redeemed + event.payout });
    context.Account.set({ ...account, redeemed: account.redeemed + event.payout });
    context.Protocol.set(
      stamp(
        {
          ...protocol,
          marketCount: protocol.marketCount + (isNew ? 1 : 0),
          redemptionCount: protocol.redemptionCount + 1,
          redeemed: protocol.redeemed + event.payout,
        },
        slot,
        time,
      ),
    );
    context.DailyStat.set({ ...day, redeemed: day.redeemed + event.payout });
  },
);

indexer.onInstruction(
  { program: "Worm", instruction: "fees_settled_event", fields: eventFields },
  async ({ instruction, context }) => {
    const signature = instruction.transaction.signature;
    if (!instruction.transaction.success) return;
    const event = decode.feesSettled(instruction.data);
    if (!context.isPreload && parentMarket(signature, instruction.path, "settle_fees") !== event.market) return;
    const { slot, time } = instruction.block;

    const [{ market, isNew }, protocol] = await Promise.all([getMarket(context, event.market), getProtocol(context)]);
    context.Market.set({
      ...market,
      creator: event.creator,
      creatorFeesPaid: market.creatorFeesPaid + event.creatorFee,
      feesSettled: market.feesSettled + event.total,
    });
    context.Protocol.set(
      stamp(
        {
          ...protocol,
          marketCount: protocol.marketCount + (isNew ? 1 : 0),
          creatorFees: protocol.creatorFees + event.creatorFee,
        },
        slot,
        time,
      ),
    );
  },
);

// Closing a market account logs its final state. It is the only place to read
// the title of a market that was created before this indexer's first slot.
indexer.onInstruction(
  { program: "Worm", instruction: "market_closed_event", fields: eventFields },
  async ({ instruction, context }) => {
    if (!instruction.transaction.success || context.isPreload) return;
    const id = parentMarket(instruction.transaction.signature, instruction.path, "close_market");
    const { title } = decode.marketClosed(instruction.data);
    if (id === undefined || title === undefined) return;
    const market = await context.Market.get(id);
    if (market && market.title === undefined) context.Market.set({ ...market, title });
  },
);

// ---------------------------------------------------------------------------
// Wallet program
// ---------------------------------------------------------------------------

indexer.onInstruction({ program: "Wallet", instruction: "create_wallet", fields }, async ({ instruction, context }) => {
  if (!instruction.transaction.success) return;
  const ids = layout.createWallet(instruction.accountArguments);
  const { owner } = decode.createWallet(instruction.data);
  const { slot, time } = instruction.block;

  const [protocol, day, account] = await Promise.all([
    getProtocol(context),
    getDay(context, time),
    getAccount(context, ids.wallet, time),
  ]);
  context.Account.set({ ...account, owner });
  if (account.owner !== undefined) return;
  context.Protocol.set(stamp({ ...protocol, walletCount: protocol.walletCount + 1 }, slot, time));
  context.DailyStat.set({ ...day, walletsCreated: day.walletsCreated + 1 });
});

indexer.onInstruction({ program: "Wallet", instruction: "deposit", fields }, async ({ instruction, context }) => {
  if (!instruction.transaction.success) return;
  const ids = layout.deposit(instruction.accountArguments);
  if (ids.mint !== USDC) return;
  const { amount } = decode.transfer(instruction.data);
  const { slot, time } = instruction.block;

  const [protocol, account] = await Promise.all([getProtocol(context), getAccount(context, ids.wallet, time)]);
  context.Account.set({ ...account, deposits: account.deposits + amount });
  context.Protocol.set(stamp({ ...protocol, walletDeposits: protocol.walletDeposits + amount }, slot, time));
});

indexer.onInstruction({ program: "Wallet", instruction: "withdraw", fields }, async ({ instruction, context }) => {
  if (!instruction.transaction.success) return;
  const ids = layout.withdraw(instruction.accountArguments);
  if (ids.mint !== USDC) return;
  const { amount } = decode.transfer(instruction.data);
  const { slot, time } = instruction.block;

  const [protocol, account] = await Promise.all([getProtocol(context), getAccount(context, ids.wallet, time)]);
  context.Account.set({ ...account, withdrawals: account.withdrawals + amount });
  context.Protocol.set(stamp({ ...protocol, walletWithdrawals: protocol.walletWithdrawals + amount }, slot, time));
});

for (const [instructionName, hasSide] of [
  ["fund_position", true],
  ["fund_position_v1", false],
] as const) {
  indexer.onInstruction({ program: "Wallet", instruction: instructionName, fields }, async ({ instruction, context }) => {
    if (!instruction.transaction.success) return;
    const ids = layout.fundPosition(instruction.accountArguments);
    const args = decode.fundPosition(instruction.data, hasSide);
    const { slot, time } = instruction.block;
    const signature = instruction.transaction.signature;

    const [protocol, day, account, tier] = await Promise.all([
      getProtocol(context),
      getDay(context, time),
      getAccount(context, ids.wallet, time),
      context.LeverageTier.get(String(args.leverage)),
    ]);
    context.LeverageTier.set({
      id: String(args.leverage),
      leverage: args.leverage,
      count: (tier?.count ?? 0) + 1,
      collateral: (tier?.collateral ?? 0n) + args.collateral,
    });
    context.PositionFunding.set({
      id: rowId(signature, instruction.path),
      account_id: ids.wallet,
      position: ids.position,
      collateral: args.collateral,
      leverage: args.leverage,
      isYes: args.isYes,
      slot,
      time,
      txSignature: signature,
    });
    context.Account.set({
      ...account,
      positionCount: account.positionCount + 1,
      positionCollateral: account.positionCollateral + args.collateral,
    });
    context.Protocol.set(
      stamp(
        {
          ...protocol,
          positionCount: protocol.positionCount + 1,
          positionCollateral: protocol.positionCollateral + args.collateral,
          positionWalletCount: protocol.positionWalletCount + (account.positionCount === 0 ? 1 : 0),
        },
        slot,
        time,
      ),
    );
    context.DailyStat.set({
      ...day,
      positions: day.positions + 1,
      positionCollateral: day.positionCollateral + args.collateral,
    });
  });
}
