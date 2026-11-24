# Worm indexer

A [HyperIndex](https://docs.envio.dev) indexer for [Worm](https://www.worm.wtf) — prediction
markets on Solana — streamed from HyperSync on mainnet.

- **Dashboard:** https://enviodev.github.io/worm/ (source in `docs/`, a single static page)
- **GraphQL:** https://enviodev-6c13db0.internal.hyperindex.xyz/v1/graphql (Envio Cloud staging)
- **Coverage:** slot 391,005,474 (2026-01-03) to the chain head
- **Backfill time:** about 5 minutes on a laptop

## Programs

| Program | Address | What it does |
|---|---|---|
| Worm | [`SormXyTMQ69ux8yhn9CBQ8v7UuqepefMHbM5TcNDtkf`](https://solscan.io/account/SormXyTMQ69ux8yhn9CBQ8v7UuqepefMHbM5TcNDtkf) | Markets, the order book's settlement, order collateral, redemptions, creator fees |
| Wallet | [`WoLTqkqChjwAmYPheinNZYvUZHZyLxw6WBD3Tf3siQg`](https://solscan.io/account/WoLTqkqChjwAmYPheinNZYvUZHZyLxw6WBD3Tf3siQg) | The smart wallets Worm makes for its users, and the collateral they put behind leveraged positions |

The addresses were found by following a market's condition id (from Worm's public API) to
the program that owns the account. Users sign messages and Worm's operator submits the
transactions, so wallets are read from each instruction's accounts, not from the signers.

## What it indexes

| Instruction | Becomes |
|---|---|
| `create_market`, `resolve_market` | `Market` — title, outcome mints, status, outcome |
| `fill_mint`, `fill_swap`, `fill_merge` | `Fill`, plus volume, fees and last price on `Market` |
| `lock`, `unlock` | Order collateral totals on `Account` and `Protocol` |
| `redeem` | `Redemption` — what each holder was paid after resolution |
| `settle_fees` | Fees paid out per `Market`, and the creator's half |
| `split`, `merge` | USDC turned into complete sets of shares, and back |
| `create_wallet`, `deposit`, `withdraw` | `Account.owner`, wallet deposits and withdrawals |
| `fund_position` (both versions) | `PositionFunding`, `LeverageTier` |

Plus `Protocol` (one row of totals) and `DailyStat` (UTC-day buckets for charts). Entities are
described in `schema.graphql`.

The instruction names are this indexer's own: neither program publishes an IDL or logs its
instruction names.

Amounts are raw atoms: USDC and outcome shares both have 6 decimals. Prices are the YES
price in millionths of a dollar.

**Volume** is the USDC that changes hands in a fill, before fees. A fill settles one of
three ways: a YES buyer meets a NO buyer and new shares are minted (`MINT`, volume = shares);
a buyer meets a seller of the same token (`SWAP`, volume = shares × that token's price); or
a YES seller meets a NO seller and the shares are burned (`MERGE`, volume = shares).

## Accuracy

The instruction and account layouts in `src/handlers/` were recovered from mainnet
transactions, then checked (data to 2026-10-28):

- Fill count and matched shares per market equal what Worm's API reports
  (`api.worm.wtf/markets/{id}/trades/`) for **8 of 8** markets compared in full, and a fill's
  price and fees equal the API's `price`, `maker_fee` and `taker_fee`.
- The YES and NO sides of every `MINT` and `MERGE` fill sum to its share count.
- Every fee settlement that paid anything pays the creator exactly half: **85 of 85**.
- Redemptions in order-book markets pay exactly $1 per winning share burned: **661 of 661**. (Markets from the January AMM version pay pro rata from a pool instead.)
- Totals equal an independent pass over the raw instructions: 1,838 fills, 2,958 position
  fundings, $7,304.26 of collateral.

Things to know:

- **Leveraged markets are not on Solana.** Worm routes them to other venues; what is on-chain
  is the collateral a wallet puts behind each position (`PositionFunding`), not the market,
  the fill or the PnL. `leverage` and `isYes` are read from undocumented fields: the values
  seen (1x, 1.5x, 2.5x, 3x) match the range Worm's docs describe.
- **History starts at slot 391,005,474** (2026-01-03), as far back as HyperSync serves these
  programs. Markets created before then appear when they are first traded, resolved or
  redeemed, without a title or creation time.
- **Titles are cut at 40 bytes** — that is what the program stores. The full question lives
  in Worm's API, keyed by the same market id.
- **Not indexed:** the first AMM version of January 2026 (113 trades), the migration to the
  order book on 2026-02-01, market-maker and reward payouts, and admin instructions.
- `redeem` and `settle_fees` take no arguments, so their amounts come from the event the
  program logs under them. An event is accepted only when it sits directly under the
  instruction that logs it and names the same market.
- Worm's own account (`HjXFH3RD…`) creates the curated markets and is often the other side
  of a fill.

If Worm shares the programs' IDLs, the hand-written layouts can be replaced with `idl:` in
`config.yaml`, and every instruction and event decoded by name.

## Run it

Requirements: Node 22.15+, pnpm, Docker, and an Envio API token
(free at https://envio.dev/app/api-tokens).

```bash
cp .env.example .env   # then paste your token into ENVIO_API_TOKEN
pnpm install
pnpm test              # handler tests on real mainnet transactions, no network needed
pnpm dev               # Postgres + Hasura + indexer; GraphQL at http://localhost:8080
```

The GraphQL playground is at http://localhost:8080 (admin secret `testing`).

## Example queries

Protocol totals:

```graphql
{
  Protocol { marketCount resolvedCount yesCount noCount fillCount volume fees traderCount positionCount positionCollateral redeemed }
}
```

The most traded markets:

```graphql
{
  Market(where: { fillCount: { _gt: 0 } }, order_by: { volume: desc }, limit: 20) {
    id title status outcome fillCount volume fees lastPrice
  }
}
```

One market's fills (the id is the condition id in Worm's URLs and API):

```graphql
query MarketFills($market: String!) {
  Fill(where: { market_id: { _eq: $market } }, order_by: { slot: asc }) {
    kind shares price usdc fee isYes partyA_id partyB_id time txSignature
  }
}
```

A wallet's activity:

```graphql
query Wallet($wallet: String!) {
  Account(where: { id: { _eq: $wallet } }) {
    owner fillCount volume usdcLocked redeemed deposits withdrawals positionCount positionCollateral
  }
  Redemption(where: { account_id: { _eq: $wallet } }, order_by: { time: desc }) { payout market { title outcome } }
}
```

What market creators have earned:

```graphql
{
  Market(where: { creatorFeesPaid: { _gt: "0" } }, order_by: { creatorFeesPaid: desc }, limit: 20) {
    title creator creatorFeesPaid volume
  }
}
```

Leverage chosen, and the latest funded positions:

```graphql
{
  LeverageTier(order_by: { leverage: asc }) { leverage count collateral }
  PositionFunding(order_by: { time: desc }, limit: 20) { account_id collateral leverage isYes time }
}
```

## Layout

- `config.yaml` — program ids, start slot, instruction discriminators
- `schema.graphql` — entities
- `src/handlers/WormHandlers.ts` — handlers
- `src/handlers/decode.ts` — instruction and event data layouts
- `src/handlers/layout.ts` — account positions, including the layouts retired by upgrades
- `test/` — tests built on real mainnet instructions
- `docs/index.html` — the dashboard, served by GitHub Pages

## Deployment

Envio Cloud deploys the indexer from the `envio` branch; `main` carries everything else, so
dashboard changes don't trigger a re-index. To ship an indexer change:
`git push origin main:envio`.
