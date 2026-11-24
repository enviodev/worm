/*
 * Account positions for each indexed instruction.
 *
 * Worm publishes no IDL, and a few instructions gained or lost accounts in
 * program upgrades, so slots are read by position and — where a layout changed —
 * chosen by how many accounts the call carries. Positions were recovered from
 * mainnet transactions (token balance changes, the program's own events and
 * Worm's public API); see README, "Accuracy".
 */

type Accounts = readonly string[];

/**
 * `create_market`. The first version (14 accounts, February 2026) had no
 * outcome mints; markets made by users carry one extra account, which shifts
 * the mints by one.
 */
export function createMarket(a: Accounts) {
  const mints =
    a.length === 19 ? { yesMint: a[5], noMint: a[7] } : a.length === 20 ? { yesMint: a[6], noMint: a[8] } : {};
  return { creator: a[1]!, market: a[2]!, yesMint: mints.yesMint, noMint: mints.noMint };
}

export const resolveMarket = (a: Accounts) => ({ market: a[1]! });

/** `fill_mint`: the YES buyer and the NO buyer. `fill_merge`: the YES seller and the NO seller. */
export const fillPair = (a: Accounts) => ({ market: a[1]!, yesMint: a[3]!, noMint: a[4]!, yesParty: a[5]!, noParty: a[9]! });

/** `fill_swap`: one outcome token changes hands for USDC. */
export const fillSwap = (a: Accounts) => ({ market: a[1]!, yesMint: a[2]!, noMint: a[3]!, buyer: a[4]!, seller: a[8]! });

/** `lock`: 13 accounts since the wallet program arrived, 12 before. */
export const lock = (a: Accounts) => ({ wallet: a[1]!, mint: a.length >= 13 ? a[6]! : a[5]! });
export const unlock = (a: Accounts) => ({ wallet: a[1]!, mint: a[5]! });

/** Wallet program. */
export const createWallet = (a: Accounts) => ({ wallet: a[1]! });
export const deposit = (a: Accounts) => ({ from: a[1]!, wallet: a[3]!, mint: a[5]! });
export const withdraw = (a: Accounts) => ({ wallet: a[1]!, to: a[3]!, mint: a[5]! });
/** `fund_position`, both versions: the wallet, and the position account it funds. */
export const fundPosition = (a: Accounts) => ({ wallet: a[1]!, position: a[6]! });
