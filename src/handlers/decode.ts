/*
 * Hand decoders for instruction data. Every layout starts after the 8-byte
 * instruction discriminator (or, for events, the 8-byte tag and 1-byte kind).
 */

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export const u64 = (b: Uint8Array, at: number) =>
  new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(at, true);
const u32 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at, true);

export function pubkey(b: Uint8Array, at: number): string {
  let n = 0n;
  for (let i = 0; i < 32; i++) n = (n << 8n) | BigInt(b[at + i]!);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (let i = 0; i < 32 && b[at + i] === 0; i++) out = "1" + out;
  return out;
}

/** A Borsh string: u32 length, then UTF-8. Undefined when it does not fit. */
function string(b: Uint8Array, at: number) {
  if (at + 4 > b.length) return undefined;
  const end = at + 4 + u32(b, at);
  if (end > b.length) return undefined;
  return new TextDecoder().decode(b.subarray(at + 4, end));
}

const AT = 8;
const EVENT_AT = 9;
const E18 = 10n ** 18n;

/** `create_market`: the title comes first in every version. */
export const createMarket = (d: Uint8Array) => ({ title: string(d, AT) });

/** `resolve_market`: the YES payout per share, scaled by 1e18. */
export function resolveMarket(d: Uint8Array) {
  const answer = u64(d, AT);
  return answer === E18 ? ("YES" as const) : answer === 0n ? ("NO" as const) : ("SPLIT" as const);
}

/**
 * `fill_mint` and `fill_merge` share a layout: shares, YES price, the YES and
 * NO sides' USDC (they sum to `shares`), then each side's fee.
 */
export function fillPair(d: Uint8Array) {
  return {
    shares: u64(d, AT),
    price: Number(u64(d, AT + 8)),
    yesUsdc: u64(d, AT + 16),
    noUsdc: u64(d, AT + 24),
    fee: u64(d, AT + 32) + u64(d, AT + 40),
  };
}

/** `fill_swap`: shares, YES price, the USDC paid, buyer and seller fees, and which token traded. */
export function fillSwap(d: Uint8Array) {
  return {
    shares: u64(d, AT),
    price: Number(u64(d, AT + 8)),
    usdc: u64(d, AT + 16),
    fee: u64(d, AT + 24) + u64(d, AT + 32),
    isYes: d[AT + 40] === 1,
  };
}

/** `lock`, `unlock`, `split`, `merge`: a single amount. */
export const amount = (d: Uint8Array) => u64(d, AT);

/** `create_wallet`: the key that controls the new wallet. */
export const createWallet = (d: Uint8Array) => ({ owner: pubkey(d, AT) });

/** Wallet `deposit` / `withdraw`: the counterparty key, a key-type byte, then the amount. */
export const transfer = (d: Uint8Array) => ({ amount: u64(d, AT + 33) });

/**
 * `fund_position`: owner key, key-type byte, leverage × 100, collateral, and —
 * from the second version — the side.
 */
export function fundPosition(d: Uint8Array, hasSide: boolean) {
  return {
    leverage: Number(u64(d, AT + 33)),
    collateral: u64(d, AT + 41),
    isYes: hasSide ? d[AT + 49] === 1 : undefined,
  };
}

/** Event under `redeem`: market, wallet, USDC paid, YES burned, NO burned. */
export function redeemed(d: Uint8Array) {
  return {
    market: pubkey(d, EVENT_AT),
    wallet: pubkey(d, EVENT_AT + 32),
    payout: u64(d, EVENT_AT + 64),
    yesBurned: u64(d, EVENT_AT + 72),
    noBurned: u64(d, EVENT_AT + 80),
  };
}

/** Event under `settle_fees`: market, creator fee account, the creator's half, the total. */
export function feesSettled(d: Uint8Array) {
  return {
    market: pubkey(d, EVENT_AT),
    creator: pubkey(d, EVENT_AT + 32),
    creatorFee: u64(d, EVENT_AT + 64),
    total: u64(d, EVENT_AT + 72),
  };
}

/** Event under `close_market`: the market account's final state, title last. */
export const marketClosed = (d: Uint8Array) => ({ title: string(d, EVENT_AT + 179) });
