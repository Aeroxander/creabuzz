//! `buzz launchpad market …` — put a project's Shares on the Limit Break AMM (LBAMM).
//!
//! The DAO owns its Shares, and LBAMM lets a token's owner set the token's hook, so setting up a market is a DAO
//! decision like any other: this composes the one vote that does it, and prints the same intent the `work`
//! composers print (`propose`, `vote`, `queue`, `process` carry it from there). Nothing is sent from here.
//!
//! The vote is one batch the DAO runs as itself:
//!   1. keep the AMM's Shares out of the voting supply (the pool holds them; it can never vote),
//!   2. name the AMM's standard hook as the Shares' hook,
//!   3. configure that hook (a fee on the paired currency, paid to the token's side),
//!   4. approve the AMM for the Shares being seeded,
//!   5. create a dynamic-price pool of Shares against the currency,
//!   6. seed it with Shares only, from the starting price upward.
//!
//! Seeding is one-sided on purpose: the DAO puts in Shares it already holds, needs no currency, and sells into
//! demand as the price rises. The Shares' own milestone lock still binds every holder inside the pool's trades.
//!
//! LBAMM is evaluation-only software (see `docs/v3-review/LBAMM.md`): this composes calldata for contracts the
//! caller has deployed locally; it contains none of LBAMM's code.

use clap::{Args, Subcommand};
use num_bigint::BigUint;
use serde_json::json;

use buzz_evm_allowance::abi;

use crate::error::CliError;

use super::launchpad_gov::load_chain;
use super::launchpad_work::{
    address_word, bytes32_arg, call, encode_batch_calls, intent_json, nonce_arg, scaled_units,
    u64_word, word_of, Chain,
};
use super::org::{validate_eth_address, ENV_EVM_RPC_URL};

const SIG_DAO_SHARES: &str = "shares()";
const SIG_DAO_POLICY: &str = "votingWeight()";
const SIG_SET_EXCLUDED: &str = "setExcluded(address,bool)";
const SIG_APPROVE: &str = "approve(address,uint256)";
const SIG_AMM_SET_TOKEN: &str = "setTokenSettings(address,address,uint32)";
const SIG_HOOK_SET_TOKEN: &str = "setTokenSettings(address,(bool,bool,bool,bool,uint16,uint16,uint16,uint16,uint16,uint16,uint56,uint56,uint56),bytes32[],bytes[],bytes32[],bytes32[],address[])";
const SIG_CREATE_POOL: &str =
    "createPool((address,uint16,address,address,address,bytes),bytes,bytes,bytes,bytes)";
const SIG_ADD_LIQUIDITY: &str =
    "addLiquidity((address,bytes32,uint256,uint256,uint256,uint256,uint256,uint256,bytes),(bytes,bytes,bytes,bytes))";
const SIG_COMPUTE_POOL_ID: &str = "computePoolId((address,uint16,address,address,address,bytes))";
const SIG_COLLECT_HOOK_FEES: &str = "collectHookFeesByToken(address,address,address,uint256)";
const SIG_HOOK_FEES_OWED: &str = "getHookFeesOwedByToken(address,address)";
const SIG_SINGLE_SWAP: &str = "singleSwap((uint256,address,int256,uint256,uint256,address,address),bytes32,(address,uint256),(address,uint256),(bytes,bytes,bytes,bytes),bytes)";

/// The hook flags the AMM's standard hook is configured with: before and after a swap, when liquidity is added, and
/// when a pool is created.
const HOOK_FLAGS: u32 = (1 << 0) | (1 << 1) | (1 << 2) | (1 << 5);
const MIN_TICK: i32 = -887_272;
const MAX_TICK: i32 = 887_272;
const MAX_TICK_SPACING: i32 = 16_384;
/// The most a fee on the paired currency may be: 10%.
const MAX_TAX_BPS: u16 = 1_000;
/// A swap runs the token hooks, the pool and the fee transfers: well above a plain call, far below a block.
const SWAP_GAS_CAP: u64 = 2_000_000;

#[derive(Subcommand)]
pub enum MarketCmd {
    /// Compose the vote that puts the DAO's Shares on the Limit Break AMM (a one-sided pool, seeded with Shares)
    Seed(SeedArgs),
    /// Swap one token for another in a pool (sends two transactions: the approval, then the swap)
    Swap(SwapArgs),
    /// Compose the vote that moves the fees the Shares' hook has collected on trades into the treasury
    CollectFees(CollectFeesArgs),
}

#[derive(Args)]
pub struct CollectFeesArgs {
    /// The DAO that owns the Shares (`0x…`)
    #[arg(long)]
    pub dao: String,
    /// The AMM (`0x…`)
    #[arg(long)]
    pub amm: String,
    /// The currency the fees were charged in (`0x…`)
    #[arg(long)]
    pub currency: String,
    /// How much to collect, in the currency's base units; everything owed when omitted
    #[arg(long)]
    pub amount: Option<String>,
    /// The proposal nonce (0x + 64 hex); a fresh one is made when omitted
    #[arg(long)]
    pub nonce: Option<String>,
}

#[derive(Args)]
pub struct SwapArgs {
    /// The AMM (`0x…`)
    #[arg(long)]
    pub amm: String,
    /// The pool (`0x` + 64 hex)
    #[arg(long)]
    pub pool_id: String,
    /// The token paid in (`0x…`)
    #[arg(long)]
    pub token_in: String,
    /// The token received (`0x…`)
    #[arg(long)]
    pub token_out: String,
    /// How much to pay in, in whole units of the token paid in
    #[arg(long)]
    pub amount: String,
    /// Decimals of the token paid in
    #[arg(long)]
    pub decimals: u8,
    /// The least you accept back, in the received token's base units. There is no default: say it, even if it is 0
    #[arg(long)]
    pub min_out: String,
    /// Seconds from the chain's latest block until the swap expires
    #[arg(long, default_value_t = 3600)]
    pub deadline_seconds: u64,
}

#[derive(Args)]
pub struct SeedArgs {
    /// The DAO whose Shares are seeded (`0x…`)
    #[arg(long)]
    pub dao: String,
    /// The AMM (`0x…`)
    #[arg(long)]
    pub amm: String,
    /// The AMM's standard token hook (`0x…`)
    #[arg(long)]
    pub hook: String,
    /// The registry that holds the standard hook's per-token settings (`0x…`)
    #[arg(long)]
    pub registry: String,
    /// The dynamic-price pool type (`0x…`)
    #[arg(long)]
    pub pool_type: String,
    /// The currency the Shares trade against (`0x…`)
    #[arg(long)]
    pub currency: String,
    /// Decimals of that currency (read it from the token; there is no safe default)
    #[arg(long)]
    pub currency_decimals: u8,
    /// How many whole Shares to seed from the DAO's own balance
    #[arg(long)]
    pub shares: String,
    /// The starting price, in whole currency units per Share (rounded to the nearest price step)
    #[arg(long)]
    pub price: String,
    /// The pool's fee to liquidity providers, in basis points (30 = 0.30%)
    #[arg(long, default_value_t = 30)]
    pub pool_fee_bps: u16,
    /// A fee on the paired currency for every buy and sell, in basis points, paid to the token's side (at most 1000)
    #[arg(long, default_value_t = 100)]
    pub tax_bps: u16,
    /// Price step between liquidity positions, in ticks (each tick is 0.01%)
    #[arg(long, default_value_t = 200)]
    pub tick_spacing: i32,
    /// The proposal nonce (0x + 64 hex); a fresh one is made when omitted
    #[arg(long)]
    pub nonce: Option<String>,
}

pub async fn run(step: &MarketCmd) -> Result<(), CliError> {
    match step {
        MarketCmd::Seed(args) => cmd_seed(args).await,
        MarketCmd::Swap(args) => cmd_swap(args).await,
        MarketCmd::CollectFees(args) => cmd_collect_fees(args).await,
    }
}

// ── a small ABI encoder (head/tail), enough for the structs the AMM takes ─────────────────────────────

/// One ABI value. A static tuple is laid out inline, a dynamic one behind an offset.
#[derive(Clone)]
pub enum Tok {
    Word([u8; 32]),
    Bytes(Vec<u8>),
    Array(Vec<Tok>),
    Tuple(Vec<Tok>),
}

fn is_dynamic(t: &Tok) -> bool {
    match t {
        Tok::Word(_) => false,
        Tok::Bytes(_) | Tok::Array(_) => true,
        Tok::Tuple(items) => items.iter().any(is_dynamic),
    }
}

fn head_size(t: &Tok) -> usize {
    match t {
        Tok::Tuple(items) if !is_dynamic(t) => items.iter().map(head_size).sum(),
        _ => 32,
    }
}

fn encode_body(t: &Tok) -> Vec<u8> {
    match t {
        Tok::Word(w) => w.to_vec(),
        Tok::Bytes(b) => {
            let mut out = u64_word(b.len() as u64).to_vec();
            out.extend_from_slice(b);
            out.resize(32 + b.len().div_ceil(32) * 32, 0);
            out
        }
        Tok::Array(items) => {
            let mut out = u64_word(items.len() as u64).to_vec();
            out.extend(encode_seq(items));
            out
        }
        Tok::Tuple(items) => encode_seq(items),
    }
}

fn encode_seq(items: &[Tok]) -> Vec<u8> {
    let head_total: usize = items.iter().map(head_size).sum();
    let mut head = Vec::with_capacity(head_total);
    let mut tail: Vec<u8> = Vec::new();
    for item in items {
        if is_dynamic(item) {
            head.extend_from_slice(&u64_word((head_total + tail.len()) as u64));
            tail.extend(encode_body(item));
        } else {
            head.extend(encode_body(item));
        }
    }
    head.extend(tail);
    head
}

/// A call: the selector of `signature`, then the arguments encoded as one tuple.
pub fn encode_call(signature: &str, args: &[Tok]) -> Vec<u8> {
    let mut out = abi::selector(signature).to_vec();
    out.extend(encode_seq(args));
    out
}

fn tok_address(value: &str, what: &str) -> Result<Tok, CliError> {
    Ok(Tok::Word(address_word(value, what)?))
}

fn tok_uint(value: u64) -> Tok {
    Tok::Word(u64_word(value))
}

fn tok_big(value: &BigUint) -> Tok {
    Tok::Word(word_of(value))
}

fn tok_bool(value: bool) -> Tok {
    tok_uint(u64::from(value))
}

/// A signed integer as a two's-complement 32-byte word.
fn tok_int(value: i128) -> Tok {
    let mut word = if value < 0 { [0xffu8; 32] } else { [0u8; 32] };
    word[16..].copy_from_slice(&value.to_be_bytes());
    Tok::Word(word)
}

// ── prices and ticks ──────────────────────────────────────────────────────────────────────────────────

/// `sqrt(1.0001^tick)` as a Q64.96 number, computed in 256-bit fixed point and rounded up.
pub fn sqrt_price_at_tick(tick: i32) -> Result<BigUint, CliError> {
    if !(MIN_TICK..=MAX_TICK).contains(&tick) {
        return Err(CliError::Usage(format!(
            "tick {tick} is outside the supported range {MIN_TICK}..{MAX_TICK}"
        )));
    }
    let one = BigUint::from(1u8);
    // sqrt(1.0001) in Q256.
    let base = ((BigUint::from(10_001u32) << 512usize) / BigUint::from(10_000u32)).sqrt();
    let mul = |a: &BigUint, b: &BigUint| (a * b) >> 256usize;
    let mut ratio = one.clone() << 256usize;
    let mut power = base;
    let mut bits = tick.unsigned_abs();
    while bits > 0 {
        if bits & 1 == 1 {
            ratio = mul(&ratio, &power);
        }
        power = mul(&power, &power);
        bits >>= 1;
    }
    if tick < 0 {
        ratio = (one.clone() << 512usize) / ratio;
    }
    // Q256 to Q96, rounding up.
    Ok((ratio + ((one.clone() << 160usize) - one)) >> 160usize)
}

/// The tick whose price is nearest to `price` (token1 per token0, in base units), as a float estimate.
fn nearest_tick(price: f64) -> Result<i32, CliError> {
    if !price.is_finite() || price <= 0.0 {
        return Err(CliError::Usage("the price must be above zero".into()));
    }
    let tick = (price.ln() / 1.0001f64.ln()).round();
    if tick < f64::from(MIN_TICK) || tick > f64::from(MAX_TICK) {
        return Err(CliError::Usage(
            "that price is outside what the pool can represent".into(),
        ));
    }
    Ok(tick as i32)
}

fn align_nearest(tick: i32, spacing: i32) -> i32 {
    (tick + spacing / 2).div_euclid(spacing) * spacing
}
fn align_up(tick: i32, spacing: i32) -> i32 {
    -((-tick).div_euclid(spacing)) * spacing
}
fn align_down(tick: i32, spacing: i32) -> i32 {
    tick.div_euclid(spacing) * spacing
}

/// The pool the vote creates, worked out from the terms: which token sorts first, where it starts and where the
/// Shares sit.
#[derive(Debug, PartialEq, Eq)]
pub struct PoolShape {
    pub shares_is_token0: bool,
    pub start_tick: i32,
    /// The pool's starting price: one tick short of the first position, so the pool never straddles it.
    pub init_sqrt_price: BigUint,
    pub tick_lower: i32,
    pub tick_upper: i32,
    pub liquidity: u128,
}

/// Shares only, from the starting price in the direction the price moves as people buy.
///
/// `price_raw` is currency base units per Share base unit. Liquidity is rounded down by one part in a billion so the
/// deposit can never exceed the Shares being seeded.
pub fn pool_shape(
    shares_is_token0: bool,
    price_raw: f64,
    spacing: i32,
    shares_amount: &BigUint,
) -> Result<PoolShape, CliError> {
    if !(1..=MAX_TICK_SPACING).contains(&spacing) {
        return Err(CliError::Usage(format!(
            "the price step is 1 to {MAX_TICK_SPACING} ticks"
        )));
    }
    // The pool's price is token1 per token0: currency per Share when the Shares sort first, Shares per currency
    // otherwise.
    let pool_price = if shares_is_token0 {
        price_raw
    } else {
        1.0 / price_raw
    };
    let start_tick = align_nearest(nearest_tick(pool_price)?, spacing);
    let (tick_lower, tick_upper, init_tick) = if shares_is_token0 {
        // Buyers push the price up: Shares sit from the start upward, and the pool starts one tick below them.
        (start_tick, align_down(MAX_TICK, spacing), start_tick - 1)
    } else {
        // Buyers push the pool's price down: Shares sit from the start downward, and the pool starts one tick above.
        (align_up(MIN_TICK, spacing), start_tick, start_tick + 1)
    };
    if tick_lower >= tick_upper {
        return Err(CliError::Usage(
            "that price leaves no room for liquidity; pick a price the pool can hold".into(),
        ));
    }
    let q96 = BigUint::from(1u8) << 96usize;
    let a = sqrt_price_at_tick(tick_lower)?;
    let b = sqrt_price_at_tick(tick_upper)?;
    let span = &b - &a;
    let liquidity = if shares_is_token0 {
        shares_amount * (&a * &b / &q96) / &span
    } else {
        shares_amount * &q96 / &span
    };
    let liquidity = &liquidity - &liquidity / BigUint::from(1_000_000_000u32);
    let liquidity = u128::try_from(&liquidity)
        .ok()
        .filter(|l| *l < (1u128 << 127))
        .ok_or_else(|| CliError::Usage("that much liquidity does not fit the pool".into()))?;
    if liquidity == 0 {
        return Err(CliError::Usage(
            "that amount of Shares is too small to seed".into(),
        ));
    }
    Ok(PoolShape {
        shares_is_token0,
        start_tick,
        init_sqrt_price: sqrt_price_at_tick(init_tick)?,
        tick_lower,
        tick_upper,
        liquidity,
    })
}

// ── the calls ─────────────────────────────────────────────────────────────────────────────────────────

/// Everything the vote needs, resolved (the addresses are checked, the pool id read from the chain).
pub struct SeedPlan<'a> {
    pub policy: &'a str,
    pub shares: &'a str,
    pub amm: &'a str,
    pub hook: &'a str,
    pub registry: &'a str,
    pub pool_type: &'a str,
    pub currency: &'a str,
    pub shares_amount: &'a BigUint,
    pub shape: &'a PoolShape,
    pub pool_fee_bps: u16,
    pub tax_bps: u16,
    pub tick_spacing: i32,
}

fn token_order<'a>(plan: &SeedPlan<'a>) -> (&'a str, &'a str) {
    if plan.shape.shares_is_token0 {
        (plan.shares, plan.currency)
    } else {
        (plan.currency, plan.shares)
    }
}

/// `PoolCreationDetails` for the pool, as the AMM and the pool type take it.
pub fn pool_details(plan: &SeedPlan) -> Result<Tok, CliError> {
    let (token0, token1) = token_order(plan);
    let pool_params = encode_seq(&[
        tok_int(i128::from(plan.tick_spacing)),
        Tok::Word(word_of(&plan.shape.init_sqrt_price)),
    ]);
    Ok(Tok::Tuple(vec![
        tok_address(plan.pool_type, "pool type")?,
        tok_uint(u64::from(plan.pool_fee_bps)),
        tok_address(token0, "token0")?,
        tok_address(token1, "token1")?,
        tok_address("0x0000000000000000000000000000000000000000", "pool hook")?,
        Tok::Bytes(pool_params),
    ]))
}

/// One call the DAO makes in its batch: the target and the calldata.
pub type DaoCall = ([u8; 20], Vec<u8>);

/// The six calls, in order. `pool_id` is the pool type's own answer for these terms.
pub fn seed_calls(plan: &SeedPlan, pool_id: &[u8; 32]) -> Result<Vec<DaoCall>, CliError> {
    let to = |value: &str, what: &str| -> Result<[u8; 20], CliError> {
        abi::parse_address(&validate_eth_address(value, what)?)
            .map_err(|e| CliError::Usage(format!("{what}: {e}")))
    };
    let zero = "0x0000000000000000000000000000000000000000";
    let hook_settings = Tok::Tuple(vec![
        tok_bool(true),  // initialized
        tok_bool(false), // trading is not paused
        tok_bool(true),  // only pool swaps
        tok_bool(false), // no disabled-pool check
        tok_uint(0),     // no fee in the token itself, buying
        tok_uint(0),     // ... or selling
        tok_uint(u64::from(plan.tax_bps)),
        tok_uint(u64::from(plan.tax_bps)),
        tok_uint(0),      // no minimum fee
        tok_uint(10_000), // no maximum
        tok_uint(0),
        tok_uint(0),
        tok_uint(0),
    ]);
    let set_hook = encode_call(
        SIG_HOOK_SET_TOKEN,
        &[
            tok_address(plan.shares, "shares")?,
            hook_settings,
            Tok::Array(vec![]),
            Tok::Array(vec![]),
            Tok::Array(vec![]),
            Tok::Array(vec![]),
            Tok::Array(vec![tok_address(plan.hook, "hook")?]),
        ],
    );
    let shares_side = plan.shape.shares_is_token0;
    let amount = tok_big(plan.shares_amount);
    let zero_amount = tok_uint(0);
    let liquidity_params = Tok::Tuple(vec![
        tok_address(zero, "liquidity hook")?,
        Tok::Word(*pool_id),
        tok_uint(0),
        tok_uint(0),
        if shares_side {
            amount.clone()
        } else {
            zero_amount.clone()
        },
        if shares_side {
            zero_amount.clone()
        } else {
            amount
        },
        tok_uint(0),
        tok_uint(0),
        Tok::Bytes(encode_seq(&[
            tok_int(i128::from(plan.shape.tick_lower)),
            tok_int(i128::from(plan.shape.tick_upper)),
            tok_int(plan.shape.liquidity as i128),
            tok_uint(0),
        ])),
    ]);
    let no_hook_data = Tok::Tuple(vec![
        Tok::Bytes(vec![]),
        Tok::Bytes(vec![]),
        Tok::Bytes(vec![]),
        Tok::Bytes(vec![]),
    ]);
    Ok(vec![
        (
            to(plan.policy, "policy")?,
            call(
                SIG_SET_EXCLUDED,
                &[address_word(plan.amm, "amm")?, u64_word(1)],
            ),
        ),
        (
            to(plan.amm, "amm")?,
            encode_call(
                SIG_AMM_SET_TOKEN,
                &[
                    tok_address(plan.shares, "shares")?,
                    tok_address(plan.hook, "hook")?,
                    tok_uint(u64::from(HOOK_FLAGS)),
                ],
            ),
        ),
        (to(plan.registry, "registry")?, set_hook),
        (
            to(plan.shares, "shares")?,
            call(
                SIG_APPROVE,
                &[address_word(plan.amm, "amm")?, word_of(plan.shares_amount)],
            ),
        ),
        (
            to(plan.amm, "amm")?,
            encode_call(
                SIG_CREATE_POOL,
                &[
                    pool_details(plan)?,
                    Tok::Bytes(vec![]),
                    Tok::Bytes(vec![]),
                    Tok::Bytes(vec![]),
                    Tok::Bytes(vec![]),
                ],
            ),
        ),
        (
            to(plan.amm, "amm")?,
            encode_call(SIG_ADD_LIQUIDITY, &[liquidity_params, no_hook_data]),
        ),
    ])
}

/// `AMM.singleSwap(...)` for an exact amount paid in, to be received by `recipient`, with no fees on top.
pub fn encode_single_swap(
    recipient: &str,
    token_in: &str,
    token_out: &str,
    amount_in: &BigUint,
    min_out: &BigUint,
    deadline: u64,
    pool_id: &[u8; 32],
) -> Result<Vec<u8>, CliError> {
    let zero = "0x0000000000000000000000000000000000000000";
    let order = Tok::Tuple(vec![
        tok_uint(deadline),
        tok_address(recipient, "recipient")?,
        Tok::Word(word_of(amount_in)), // a positive amount is an exact amount paid in
        tok_uint(0),
        Tok::Word(word_of(min_out)),
        tok_address(token_in, "token in")?,
        tok_address(token_out, "token out")?,
    ]);
    let no_fee = Tok::Tuple(vec![tok_address(zero, "fee recipient")?, tok_uint(0)]);
    let no_hook_data = Tok::Tuple(vec![
        Tok::Bytes(vec![]),
        Tok::Bytes(vec![]),
        Tok::Bytes(vec![]),
        Tok::Bytes(vec![]),
    ]);
    Ok(encode_call(
        SIG_SINGLE_SWAP,
        &[
            order,
            Tok::Word(*pool_id),
            no_fee.clone(),
            no_fee,
            no_hook_data,
            Tok::Bytes(vec![]),
        ],
    ))
}

/// `AMM.collectHookFeesByToken(token, feeToken, recipient, amount)`: the token's side collects what its hook charged.
pub fn encode_collect_fees(
    shares: &str,
    currency: &str,
    recipient: &str,
    amount: &BigUint,
) -> Result<Vec<u8>, CliError> {
    Ok(call(
        SIG_COLLECT_HOOK_FEES,
        &[
            address_word(shares, "shares")?,
            address_word(currency, "currency")?,
            address_word(recipient, "recipient")?,
            word_of(amount),
        ],
    ))
}

pub async fn cmd_collect_fees(args: &CollectFeesArgs) -> Result<(), CliError> {
    let dao = validate_eth_address(&args.dao, "dao")?;
    let amm = validate_eth_address(&args.amm, "amm")?;
    let currency = validate_eth_address(&args.currency, "currency")?;
    let rpc_url = std::env::var(ENV_EVM_RPC_URL)
        .ok()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| {
            CliError::Usage(format!(
                "market collect-fees reads the chain: set {ENV_EVM_RPC_URL}"
            ))
        })?;
    let chain = Chain::open(&rpc_url, &amm)?;
    let shares = chain.address_of(&dao, SIG_DAO_SHARES).await?;
    let owed = BigUint::from_bytes_be(
        &chain
            .word(
                &amm,
                &call(
                    SIG_HOOK_FEES_OWED,
                    &[
                        address_word(&shares, "shares")?,
                        address_word(&currency, "currency")?,
                    ],
                ),
            )
            .await?,
    );
    let amount = match &args.amount {
        Some(a) => BigUint::parse_bytes(a.trim().as_bytes(), 10)
            .ok_or_else(|| CliError::Usage("--amount is a whole number of base units".into()))?,
        None => owed.clone(),
    };
    if amount == BigUint::from(0u8) {
        return Err(CliError::Usage(
            "no fees are owed yet: they build up as the Shares trade".into(),
        ));
    }
    if amount > owed {
        return Err(CliError::Usage(format!(
            "only {owed} base units are owed, not {amount}"
        )));
    }
    // The DAO collects for itself: its treasury is the recipient.
    let data = encode_collect_fees(&shares, &currency, &dao, &amount)?;
    let nonce = nonce_arg(&args.nonce, "market-collect-fees", &data)?;
    let mut intent = intent_json(
        "market-collect-fees",
        &dao,
        &amm,
        &data,
        &nonce,
        "unrestricted",
        "Collecting the trading fees moves money into the treasury, so it takes the full vote.",
    );
    intent["market"] = json!({
        "shares": shares,
        "currency": currency,
        "owed": owed.to_string(),
        "collecting": amount.to_string(),
    });
    println!("{intent}");
    Ok(())
}

pub async fn cmd_swap(args: &SwapArgs) -> Result<(), CliError> {
    let amm = validate_eth_address(&args.amm, "amm")?;
    let token_in = validate_eth_address(&args.token_in, "token in")?;
    let token_out = validate_eth_address(&args.token_out, "token out")?;
    let pool_id = bytes32_arg(&args.pool_id, "pool id")?;
    if !args.pool_id.trim().starts_with("0x") {
        return Err(CliError::Usage(
            "the pool id is 0x + 64 hex characters".into(),
        ));
    }
    let amount = scaled_units(&args.amount, args.decimals, 255, "amount")?;
    if amount == BigUint::from(0u8) {
        return Err(CliError::Usage("swap more than nothing".into()));
    }
    let min_out = BigUint::parse_bytes(args.min_out.trim().as_bytes(), 10)
        .ok_or_else(|| CliError::Usage("--min-out is a whole number of base units".into()))?;
    let (rpc_url, spender) = load_chain()?;
    let me = format!(
        "0x{}",
        hex::encode(buzz_evm_allowance::tx::address_from_key(&spender))
    );
    let chain = Chain::open(&rpc_url, &amm)?;
    let deadline = chain.latest_block_time().await? + args.deadline_seconds;
    let swap = encode_single_swap(
        &me, &token_in, &token_out, &amount, &min_out, deadline, &pool_id,
    )?;
    let approve = call(SIG_APPROVE, &[address_word(&amm, "amm")?, word_of(&amount)]);
    let approved = chain
        .send(&spender, &token_in, &approve, "the approval")
        .await?;
    let swapped = chain
        .send_capped(&spender, &amm, &swap, "the swap", SWAP_GAS_CAP)
        .await?;
    println!(
        "{}",
        json!({
            "status": "ok",
            "step": "swap",
            "amm": amm,
            "poolId": args.pool_id,
            "tokenIn": token_in,
            "tokenOut": token_out,
            "amountIn": amount.to_string(),
            "approveTx": approved,
            "swapTx": swapped,
        })
    );
    Ok(())
}

// ── the command ───────────────────────────────────────────────────────────────────────────────────────

/// Currency base units per Share base unit, as a float (only used to choose a starting price step).
fn raw_price(price: &str, currency_decimals: u8) -> Result<f64, CliError> {
    let units = scaled_units(price, currency_decimals, 128, "price")?;
    if units == BigUint::from(0u8) {
        return Err(CliError::Usage("the price must be above zero".into()));
    }
    let as_f64: f64 = units
        .to_string()
        .parse()
        .map_err(|_| CliError::Usage("that price is not a number".into()))?;
    // `units` is the price in the currency's base units for one whole Share (1e18 Share base units).
    Ok(as_f64 / 1e18)
}

fn same(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

pub async fn cmd_seed(args: &SeedArgs) -> Result<(), CliError> {
    let dao = validate_eth_address(&args.dao, "dao")?;
    let amm = validate_eth_address(&args.amm, "amm")?;
    let hook = validate_eth_address(&args.hook, "hook")?;
    let registry = validate_eth_address(&args.registry, "registry")?;
    let pool_type = validate_eth_address(&args.pool_type, "pool type")?;
    let currency = validate_eth_address(&args.currency, "currency")?;
    if args.pool_fee_bps == 0 || args.pool_fee_bps > 10_000 {
        return Err(CliError::Usage(
            "the pool fee is 1 to 10000 basis points".into(),
        ));
    }
    if args.tax_bps > MAX_TAX_BPS {
        return Err(CliError::Usage(format!(
            "the fee on the paired currency is at most {MAX_TAX_BPS} basis points (10%)"
        )));
    }
    let shares_amount = scaled_units(&args.shares, 18, 128, "shares")?;
    if shares_amount == BigUint::from(0u8) {
        return Err(CliError::Usage("seed at least some Shares".into()));
    }
    let price = raw_price(&args.price, args.currency_decimals)?;

    let rpc_url = std::env::var(ENV_EVM_RPC_URL)
        .ok()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| {
            CliError::Usage(format!(
                "market seed reads the chain: set {ENV_EVM_RPC_URL}"
            ))
        })?;
    let chain = Chain::open(&rpc_url, &dao)?;
    let shares = chain.address_of(&dao, SIG_DAO_SHARES).await?;
    let policy = chain.address_of(&dao, SIG_DAO_POLICY).await?;
    if same(&shares, &currency) {
        return Err(CliError::Usage(
            "the currency cannot be the Shares themselves".into(),
        ));
    }
    let shares_is_token0 = shares.to_lowercase() < currency.to_lowercase();
    let shape = pool_shape(shares_is_token0, price, args.tick_spacing, &shares_amount)?;

    let plan = SeedPlan {
        policy: &policy,
        shares: &shares,
        amm: &amm,
        hook: &hook,
        registry: &registry,
        pool_type: &pool_type,
        currency: &currency,
        shares_amount: &shares_amount,
        shape: &shape,
        pool_fee_bps: args.pool_fee_bps,
        tax_bps: args.tax_bps,
        tick_spacing: args.tick_spacing,
    };
    // The pool type names the pool for these terms; the liquidity call needs that id before the pool exists.
    let compute = encode_call(SIG_COMPUTE_POOL_ID, &[pool_details(&plan)?]);
    let pool_id = chain.word(&pool_type, &compute).await?;
    let calls = seed_calls(&plan, &pool_id)?;
    let data = encode_batch_calls(&calls);
    let nonce = nonce_arg(&args.nonce, "market-seed", &data)?;
    let mut intent = intent_json(
        "market-seed",
        &dao,
        &dao,
        &data,
        &nonce,
        "unrestricted",
        "Putting the Shares on a market changes what the treasury holds and who can trade, so it takes the full vote.",
    );
    // What a person wants to check before voting, and what the trades that follow need, next to the intent.
    intent["market"] = json!({
        "poolId": format!("0x{}", hex::encode(pool_id)),
        "shares": shares,
        "currency": currency,
        "sharesAreToken0": shape.shares_is_token0,
        "startTick": shape.start_tick,
        "tickLower": shape.tick_lower,
        "tickUpper": shape.tick_upper,
        "sharesSeeded": args.shares,
        "paidFeeBps": args.tax_bps,
    });
    println!("{intent}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn big(s: &str) -> BigUint {
        BigUint::parse_bytes(s.as_bytes(), 10).unwrap()
    }

    /// The pool's own sqrt-price table: values the deployed contract returns for a spread of ticks.
    #[test]
    fn sqrt_price_matches_the_chain() {
        let table = [
            (0, "79228162514264337593543950336"),
            (1, "79232123823359799118286999568"),
            (-1, "79224201403219477170569942574"),
            (200, "80024378775772204256025656563"),
            (-200, "78439868342809377387252074393"),
            (100_000, "11755562826496067164730007768450"),
            (-100_000, "533968626430936354154228408"),
            (-322_400, "7914118585746382533284"),
            (322_400, "793152347589530806273839517798025305"),
            (887_200, "1456195216270955103206513029158776779468408838535"),
            (-887_200, "4310618292"),
            (887_272, "1461446703485210103287273052203988822378723970342"),
            (-887_272, "4295128739"),
            (-230_000, "803050292342716926398368"),
            (123_456, "37980312163600838849089827163598"),
        ];
        for (tick, expected) in table {
            let got = sqrt_price_at_tick(tick).unwrap();
            let want = big(expected);
            let diff = if got > want {
                &got - &want
            } else {
                &want - &got
            };
            // This is the exact value (checked against 120-digit arithmetic); the contract's own table is a rounded
            // approximation that drifts from it by up to about 2e-20 at the extreme ticks and by nothing visible
            // elsewhere. A pool only needs a position's edge on the right side of the starting price, and the starting
            // price sits a whole tick (one part in 1e4) away from it.
            assert!(
                diff <= BigUint::from(1u8) || diff * BigUint::from(10u8).pow(19) <= want,
                "tick {tick}: got {got}, want {want}"
            );
        }
        assert!(sqrt_price_at_tick(MAX_TICK + 1).is_err());
    }

    #[test]
    fn ticks_align_in_both_directions() {
        assert_eq!(align_down(887_272, 200), 887_200);
        assert_eq!(align_up(-887_272, 200), -887_200);
        assert_eq!(align_nearest(-322_410, 200), -322_400);
        assert_eq!(align_up(-100, 200), 0);
        assert_eq!(align_down(-100, 200), -200);
        assert_eq!(align_nearest(99, 200), 0);
        assert_eq!(align_nearest(100, 200), 200);
    }

    #[test]
    fn a_pool_with_shares_first_starts_below_its_liquidity_and_holds_only_shares() {
        let shares = big("100000000000000000000000000");
        let shape = pool_shape(true, 1e-14, 200, &shares).unwrap();
        assert!(shape.shares_is_token0);
        assert!(shape.tick_lower > shape.start_tick - 1);
        assert_eq!(shape.tick_lower, shape.start_tick);
        assert_eq!(shape.tick_upper, 887_200);
        // The pool starts one tick under the first position, so none of it is on the wrong side.
        assert_eq!(
            shape.init_sqrt_price,
            sqrt_price_at_tick(shape.start_tick - 1).unwrap()
        );
        assert!(shape.liquidity > 0);
    }

    #[test]
    fn a_pool_with_shares_second_starts_above_its_liquidity() {
        let shares = big("100000000000000000000000000");
        let shape = pool_shape(false, 1e-14, 200, &shares).unwrap();
        assert!(!shape.shares_is_token0);
        assert_eq!(shape.tick_upper, shape.start_tick);
        assert_eq!(shape.tick_lower, -887_200);
        assert_eq!(
            shape.init_sqrt_price,
            sqrt_price_at_tick(shape.start_tick + 1).unwrap()
        );
    }

    #[test]
    fn the_starting_price_is_the_nearest_price_step_to_what_was_asked() {
        // $0.01 a Share in a 6-decimal currency: 1e4 base units per 1e18 Share base units.
        let price = raw_price("0.01", 6).unwrap();
        assert!((price - 1e-14).abs() < 1e-20, "{price}");
        let shape = pool_shape(true, price, 200, &big("1000000000000000000")).unwrap();
        // Within half a step (1%) of the asked price.
        let got = 1.0001f64.powi(shape.start_tick);
        assert!((got / 1e-14 - 1.0).abs() < 0.0101, "{got}");
    }

    #[test]
    fn bad_terms_are_refused_before_a_vote_is_composed() {
        let s = big("1000000000000000000");
        assert!(pool_shape(true, 0.0, 200, &s).is_err());
        assert!(pool_shape(true, 1e-14, 0, &s).is_err());
        assert!(pool_shape(true, 1e-14, 20_000, &s).is_err());
        assert!(pool_shape(true, 1e-14, 200, &BigUint::from(0u8)).is_err());
        assert!(raw_price("0", 6).is_err());
        assert!(raw_price("0.0000001", 6).is_err());
    }

    #[test]
    fn selectors_match_the_deployed_contracts() {
        // Read from the built contracts' method identifiers.
        let cases = [
            (SIG_AMM_SET_TOKEN, "d14fde55"),
            (SIG_HOOK_SET_TOKEN, "6d818ba5"),
            (SIG_CREATE_POOL, "aefee19a"),
            (SIG_ADD_LIQUIDITY, "9a85ed11"),
            (SIG_COMPUTE_POOL_ID, "e655986a"),
            (SIG_COLLECT_HOOK_FEES, "5f06713d"),
            (SIG_HOOK_FEES_OWED, "271e88f9"),
            (SIG_SINGLE_SWAP, "60d194b3"),
        ];
        for (signature, expected) in cases {
            assert_eq!(
                hex::encode(abi::selector(signature)),
                expected,
                "{signature}"
            );
        }
    }

    fn test_plan<'a>(shape: &'a PoolShape, amount: &'a BigUint) -> SeedPlan<'a> {
        SeedPlan {
            policy: "0x00000000000000000000000000000000000000ee",
            shares: "0x00000000000000000000000000000000000000aa",
            amm: "0x00000000000000000000000000000000000000ff",
            hook: "0x0000000000000000000000000000000000000011",
            registry: "0x0000000000000000000000000000000000000022",
            pool_type: "0x00000000000000000000000000000000000000cc",
            currency: "0x00000000000000000000000000000000000000bb",
            shares_amount: amount,
            shape,
            pool_fee_bps: 30,
            tax_bps: 100,
            tick_spacing: 200,
        }
    }

    fn shape(shares_is_token0: bool, lower: i32, upper: i32) -> PoolShape {
        PoolShape {
            shares_is_token0,
            start_tick: 0,
            init_sqrt_price: BigUint::from(79_228_162_514_264_337_593_543_950_336u128),
            tick_lower: lower,
            tick_upper: upper,
            liquidity: 7,
        }
    }

    /// Every golden below is `cast calldata` / `cast abi-encode` for the same inputs.
    #[test]
    fn the_pool_creation_and_id_calls_are_what_cast_encodes() {
        let amount = BigUint::from(5u8);
        let s = shape(true, 0, 200);
        let plan = test_plan(&s, &amount);
        let create = encode_call(
            SIG_CREATE_POOL,
            &[
                pool_details(&plan).unwrap(),
                Tok::Bytes(vec![]),
                Tok::Bytes(vec![]),
                Tok::Bytes(vec![]),
                Tok::Bytes(vec![]),
            ],
        );
        assert_eq!(format!("0x{}", hex::encode(&create)), "0xaefee19a00000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000001c000000000000000000000000000000000000000000000000000000000000001e00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000022000000000000000000000000000000000000000000000000000000000000000cc000000000000000000000000000000000000000000000000000000000000001e00000000000000000000000000000000000000000000000000000000000000aa00000000000000000000000000000000000000000000000000000000000000bb000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c0000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000c800000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000");
        let compute = encode_call(SIG_COMPUTE_POOL_ID, &[pool_details(&plan).unwrap()]);
        assert_eq!(format!("0x{}", hex::encode(&compute)), "0xe655986a000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000cc000000000000000000000000000000000000000000000000000000000000001e00000000000000000000000000000000000000000000000000000000000000aa00000000000000000000000000000000000000000000000000000000000000bb000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c0000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000c80000000000000000000000000000000000000001000000000000000000000000");
    }

    #[test]
    fn the_seed_calls_are_what_cast_encodes_in_both_orders() {
        let amount = BigUint::from(5u8);
        let pool = [0x11u8; 32];

        let first = shape(true, 0, 200);
        let calls = seed_calls(&test_plan(&first, &amount), &pool).unwrap();
        assert_eq!(calls.len(), 6);
        assert_eq!(format!("0x{}", hex::encode(&calls[1].1)), "0xd14fde5500000000000000000000000000000000000000000000000000000000000000aa00000000000000000000000000000000000000000000000000000000000000110000000000000000000000000000000000000000000000000000000000000027");
        assert_eq!(format!("0x{}", hex::encode(&calls[2].1)), "0x6d818ba500000000000000000000000000000000000000000000000000000000000000aa00000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000640000000000000000000000000000000000000000000000000000000000000064000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000027100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000260000000000000000000000000000000000000000000000000000000000000028000000000000000000000000000000000000000000000000000000000000002a000000000000000000000000000000000000000000000000000000000000002c000000000000000000000000000000000000000000000000000000000000002e0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000011");
        assert_eq!(format!("0x{}", hex::encode(&calls[5].1)), "0x9a85ed11000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000000111111111111111111111111111111111111111111111111111111111111111100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000500000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001200000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c800000000000000000000000000000000000000000000000000000000000000070000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000000e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000");

        // Shares second: the ticks are negative (two's complement), and the Shares are the second token.
        let second = shape(false, -400, -200);
        let calls = seed_calls(&test_plan(&second, &amount), &pool).unwrap();
        assert_eq!(format!("0x{}", hex::encode(&calls[5].1)), "0x9a85ed11000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000000111111111111111111111111111111111111111111111111111111111111111100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000050000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001200000000000000000000000000000000000000000000000000000000000000080fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe70ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff3800000000000000000000000000000000000000000000000000000000000000070000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000000e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000");
    }

    #[test]
    fn the_vote_runs_six_calls_as_the_dao_in_the_order_that_works() {
        let amount = BigUint::from(5u8);
        let s = shape(true, 0, 200);
        let calls = seed_calls(&test_plan(&s, &amount), &[0x11u8; 32]).unwrap();
        let targets: Vec<String> = calls
            .iter()
            .map(|(t, _)| format!("{:02x}", t[19]))
            .collect();
        // policy, amm, registry, shares, amm, amm
        assert_eq!(targets, ["ee", "ff", "22", "aa", "ff", "ff"]);
        let selectors: Vec<String> = calls.iter().map(|(_, d)| hex::encode(&d[..4])).collect();
        assert_eq!(selectors[1], "d14fde55");
        assert_eq!(selectors[2], "6d818ba5");
        assert_eq!(selectors[3], "095ea7b3");
        assert_eq!(selectors[4], "aefee19a");
        assert_eq!(selectors[5], "9a85ed11");
        // The batch the DAO runs is Moloch's batchCalls.
        assert_eq!(hex::encode(&encode_batch_calls(&calls)[..4]), "11c76fd9");
    }

    /// `cast calldata "singleSwap(…)" "(1000,0x…cc,5,0,3,0x…aa,0x…bb)" 0x1111… "(0x0,0)" "(0x0,0)" "(0x,0x,0x,0x)" 0x`
    #[test]
    fn the_swap_call_is_what_cast_encodes() {
        let data = encode_single_swap(
            "0x00000000000000000000000000000000000000cc",
            "0x00000000000000000000000000000000000000aa",
            "0x00000000000000000000000000000000000000bb",
            &BigUint::from(5u8),
            &BigUint::from(3u8),
            1000,
            &[0x11u8; 32],
        )
        .unwrap();
        assert_eq!(format!("0x{}", hex::encode(&data)), "0x60d194b300000000000000000000000000000000000000000000000000000000000003e800000000000000000000000000000000000000000000000000000000000000cc00000000000000000000000000000000000000000000000000000000000000050000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000300000000000000000000000000000000000000000000000000000000000000aa00000000000000000000000000000000000000000000000000000000000000bb1111111111111111111111111111111111111111111111111111111111111111000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001c000000000000000000000000000000000000000000000000000000000000002c0000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000000e000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000");
        assert_eq!(hex::encode(&data[..4]), "60d194b3");
    }

    /// `cast calldata "collectHookFeesByToken(address,address,address,uint256)" 0x…aa 0x…bb 0x…dd 123`
    #[test]
    fn the_fee_collection_call_is_what_cast_encodes() {
        let data = encode_collect_fees(
            "0x00000000000000000000000000000000000000aa",
            "0x00000000000000000000000000000000000000bb",
            "0x00000000000000000000000000000000000000dd",
            &BigUint::from(123u8),
        )
        .unwrap();
        assert_eq!(format!("0x{}", hex::encode(data)), "0x5f06713d00000000000000000000000000000000000000000000000000000000000000aa00000000000000000000000000000000000000000000000000000000000000bb00000000000000000000000000000000000000000000000000000000000000dd000000000000000000000000000000000000000000000000000000000000007b");
    }
}
