#![no_std]

//! Donation contract: moves the donated token from donor to creator and
//! keeps a local, append-only log of donations. Creator profile state
//! (username, lifetime totals) lives in a separate `creator-registry`
//! contract — this contract talks to it exclusively through cross-contract
//! calls (`env.invoke_contract`), so the two contracts can be deployed,
//! upgraded, and audited independently.

use common::{CreatorProfile, DonationRecord, Subscription};
use soroban_sdk::{
    contract, contractevent, contractimpl, symbol_short, token, Address, Env, IntoVal, Symbol,
    Val, Vec as SorobanVec, String,
};

const DONATIONS_KEY: Symbol = symbol_short!("donations");
const DONATION_COUNTER: Symbol = symbol_short!("counter");
const ADMIN_KEY: Symbol = symbol_short!("admin");
const REGISTRY_KEY: Symbol = symbol_short!("registry");
const SUBSCRIPTIONS_KEY: Symbol = symbol_short!("subs");
const SUB_COUNTER: Symbol = symbol_short!("sub_ctr");
const EXECUTOR_KEY: Symbol = symbol_short!("executor");
pub const MAX_MEMO_LENGTH: u32 = 140;

/// Emitted whenever a donation is settled on-chain. `donor` and `creator`
/// are indexed as topics so downstream systems (e.g. the backend's event
/// listener) can filter `getEvents` calls by either party without scanning
/// every ledger event.
#[contractevent(topics = ["donated"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DonatedEvent {
    #[topic]
    pub donor: Address,
    #[topic]
    pub creator: Address,
    pub amount: i128,
    pub memo: String,
    pub timestamp: u64,
    /// SAC address used for the transfer, so indexers do not have to guess
    /// which asset a DonatedEvent represents.
    pub token: Address,
}

/// Emitted when a supporter starts a recurring donation.
#[contractevent(topics = ["subscribed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SubscribedEvent {
    #[topic]
    pub supporter: Address,
    #[topic]
    pub creator: Address,
    pub subscription_id: u64,
    pub amount: i128,
    pub interval_secs: u64,
}

/// Emitted when a supporter cancels a recurring donation.
#[contractevent(topics = ["sub_cancelled"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SubscriptionCancelledEvent {
    #[topic]
    pub supporter: Address,
    pub subscription_id: u64,
}

#[contract]
pub struct DonationContract;

#[contractimpl]
impl DonationContract {
    /// One-time setup: points this contract at the CreatorRegistry it will
    /// report donations to.
    pub fn initialize(env: Env, admin: Address, registry: Address) {
        admin.require_auth();
        assert!(
            !env.storage().instance().has(&ADMIN_KEY),
            "donation contract already initialized"
        );
        env.storage().instance().set(&ADMIN_KEY, &admin);
        env.storage().instance().set(&REGISTRY_KEY, &registry);
    }

    /// Cross-contract call: delegates creator registration to the
    /// CreatorRegistry contract.
    pub fn register_creator(env: Env, creator: Address, username: String) -> CreatorProfile {
        let registry = Self::registry_address(&env);
        let args: SorobanVec<Val> = (creator, username).into_val(&env);
        env.invoke_contract(&registry, &Symbol::new(&env, "register_creator"), args)
    }

    /// Cross-contract call: reads a creator's profile from the
    /// CreatorRegistry contract.
    pub fn get_creator(env: Env, creator: Address) -> Option<CreatorProfile> {
        let registry = Self::registry_address(&env);
        let args: SorobanVec<Val> = (creator,).into_val(&env);
        env.invoke_contract(&registry, &Symbol::new(&env, "get_creator"), args)
    }

    /// Transfer `amount` of `token` from `donor` to `creator`, record the
    /// donation locally, and notify the CreatorRegistry (cross-contract) so
    /// the creator's lifetime stats stay in sync.
    pub fn donate(
        env: Env,
        donor: Address,
        creator: Address,
        token: Address,
        amount: i128,
        memo: String,
    ) -> DonationRecord {
        donor.require_auth();
        assert!(amount > 0, "Donation amount must be positive");
        assert!(
            memo.len() <= MAX_MEMO_LENGTH,
            "Donation memo exceeds maximum length"
        );

        // Move the funds from donor to creator via the token contract (e.g. native XLM SAC)
        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&donor, &creator, &amount);

        // Cross-contract call: tell the registry to update the creator's
        // lifetime stats. The registry only accepts this call from the
        // donation contract address it was initialized with.
        let registry = Self::registry_address(&env);
        let record_args: SorobanVec<Val> =
            (env.current_contract_address(), creator.clone(), amount).into_val(&env);
        let (): () = env.invoke_contract(&registry, &Symbol::new(&env, "record_donation"), record_args);

        let donation = DonationRecord {
            donor: donor.clone(),
            creator: creator.clone(),
            amount,
            memo: memo.clone(),
            timestamp: env.ledger().timestamp(),
        };

        // Store donation record with counter-based key
        let counter: u32 = env
            .storage()
            .persistent()
            .get(&DONATION_COUNTER)
            .unwrap_or(0);

        env.storage()
            .persistent()
            .set(&(DONATIONS_KEY, counter), &donation);
        env.storage()
            .persistent()
            .set(&DONATION_COUNTER, &(counter + 1));

        // Emit event (consumed by the backend's event listener for
        // real-time dashboard updates).
        DonatedEvent {
            donor,
            creator,
            amount,
            memo,
            timestamp: env.ledger().timestamp(),
            token,
        }
        .publish(&env);

        donation
    }

    /// Admin-gated: sets (or rotates) the backend-held address permitted to
    /// trigger `charge_subscription`. This address pays each charge's
    /// transaction fee but never custodies donor funds itself —
    /// `transfer_from`'s `to` is always the subscription's stored creator,
    /// so a compromised executor key can at most accelerate/replay already
    /// approved charges, not redirect funds.
    pub fn set_executor(env: Env, executor: Address) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&ADMIN_KEY)
            .expect("donation contract not initialized: call initialize() first");
        admin.require_auth();
        env.storage().instance().set(&EXECUTOR_KEY, &executor);
    }

    /// Starts a recurring donation. `supporter` must separately grant this
    /// contract a SAC allowance on `token` (via the token contract's own
    /// `approve`) covering at least `amount` per interval — `subscribe`
    /// only records the schedule, it does not touch funds.
    pub fn subscribe(
        env: Env,
        supporter: Address,
        creator: Address,
        token: Address,
        amount: i128,
        interval_secs: u64,
    ) -> u64 {
        supporter.require_auth();
        assert!(amount > 0, "Subscription amount must be positive");
        assert!(interval_secs > 0, "Interval must be positive");

        let id: u64 = env.storage().persistent().get(&SUB_COUNTER).unwrap_or(0);
        let now = env.ledger().timestamp();

        let subscription = Subscription {
            supporter: supporter.clone(),
            creator: creator.clone(),
            token,
            amount,
            interval_secs,
            next_charge_at: now + interval_secs,
            active: true,
        };

        env.storage()
            .persistent()
            .set(&(SUBSCRIPTIONS_KEY, id), &subscription);
        env.storage().persistent().set(&SUB_COUNTER, &(id + 1));

        SubscribedEvent {
            supporter,
            creator,
            subscription_id: id,
            amount,
            interval_secs,
        }
        .publish(&env);

        id
    }

    /// Executes one due charge of a subscription by drawing on the SAC
    /// allowance the supporter granted this contract, then records and
    /// reports it exactly like a one-off `donate`. Callable only by the
    /// authorized executor (see `set_executor`).
    pub fn charge_subscription(env: Env, executor: Address, subscription_id: u64) -> DonationRecord {
        executor.require_auth();
        let authorized_executor: Address = env
            .storage()
            .instance()
            .get(&EXECUTOR_KEY)
            .expect("executor not set: call set_executor() first");
        assert_eq!(
            executor, authorized_executor,
            "caller is not the authorized executor"
        );

        let mut subscription: Subscription = env
            .storage()
            .persistent()
            .get(&(SUBSCRIPTIONS_KEY, subscription_id))
            .expect("subscription not found");
        assert!(subscription.active, "subscription is not active");

        let now = env.ledger().timestamp();
        assert!(now >= subscription.next_charge_at, "subscription not yet due");

        // Draw on the allowance: this contract is the `spender`, authorized
        // implicitly since it is the direct invoker (same trick used below
        // to call the registry as our own contract identity).
        let token_client = token::Client::new(&env, &subscription.token);
        token_client.transfer_from(
            &env.current_contract_address(),
            &subscription.supporter,
            &subscription.creator,
            &subscription.amount,
        );

        let registry = Self::registry_address(&env);
        let record_args: SorobanVec<Val> = (
            env.current_contract_address(),
            subscription.creator.clone(),
            subscription.amount,
        )
            .into_val(&env);
        let (): () =
            env.invoke_contract(&registry, &Symbol::new(&env, "record_donation"), record_args);

        let memo = String::from_str(&env, "recurring");
        let donation = DonationRecord {
            donor: subscription.supporter.clone(),
            creator: subscription.creator.clone(),
            amount: subscription.amount,
            memo: memo.clone(),
            timestamp: now,
        };

        let counter: u32 = env
            .storage()
            .persistent()
            .get(&DONATION_COUNTER)
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&(DONATIONS_KEY, counter), &donation);
        env.storage()
            .persistent()
            .set(&DONATION_COUNTER, &(counter + 1));

        subscription.next_charge_at = now + subscription.interval_secs;
        env.storage()
            .persistent()
            .set(&(SUBSCRIPTIONS_KEY, subscription_id), &subscription);

        DonatedEvent {
            donor: subscription.supporter.clone(),
            creator: subscription.creator.clone(),
            amount: subscription.amount,
            memo,
            timestamp: now,
            token: subscription.token,
        }
        .publish(&env);

        donation
    }

    /// Cancels a subscription and, in the same transaction, zeroes the
    /// remaining on-chain allowance so the supporter doesn't need a second
    /// signature to fully revoke it. Must be signed by the supporter.
    pub fn cancel_subscription(env: Env, supporter: Address, subscription_id: u64) {
        supporter.require_auth();

        let mut subscription: Subscription = env
            .storage()
            .persistent()
            .get(&(SUBSCRIPTIONS_KEY, subscription_id))
            .expect("subscription not found");
        assert_eq!(
            subscription.supporter, supporter,
            "not the subscription owner"
        );

        subscription.active = false;
        env.storage()
            .persistent()
            .set(&(SUBSCRIPTIONS_KEY, subscription_id), &subscription);

        let token_client = token::Client::new(&env, &subscription.token);
        token_client.approve(&supporter, &env.current_contract_address(), &0, &0);

        SubscriptionCancelledEvent {
            supporter,
            subscription_id,
        }
        .publish(&env);
    }

    /// Fetch a subscription by its counter-based id.
    pub fn get_subscription(env: Env, subscription_id: u64) -> Option<Subscription> {
        env.storage()
            .persistent()
            .get(&(SUBSCRIPTIONS_KEY, subscription_id))
    }

    /// Get all donations count (approximate, stored in counter)
    pub fn get_total_donations_count(env: Env) -> u32 {
        env.storage()
            .persistent()
            .get(&DONATION_COUNTER)
            .unwrap_or(0)
    }

    /// Fetch a single donation record by its counter-based index.
    pub fn get_donation(env: Env, index: u32) -> Option<DonationRecord> {
        env.storage().persistent().get(&(DONATIONS_KEY, index))
    }

    fn registry_address(env: &Env) -> Address {
        env.storage()
            .instance()
            .get(&REGISTRY_KEY)
            .expect("donation contract not initialized: call initialize() first")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use creator_registry::{CreatorRegistryContract, CreatorRegistryContractClient};
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::token::StellarAssetClient;

    fn create_token_contract(env: &Env, admin: &Address) -> Address {
        env.register_stellar_asset_contract_v2(admin.clone())
            .address()
    }

    /// Deploys both contracts into the same test `Env` and wires them
    /// together, mirroring the real two-contract deployment.
    fn setup(env: &Env) -> (Address, DonationContractClient<'_>, CreatorRegistryContractClient<'_>) {
        let admin = Address::generate(env);
        let registry_id = env.register(CreatorRegistryContract, ());
        let donation_id = env.register(DonationContract, ());

        let registry_client = CreatorRegistryContractClient::new(env, &registry_id);
        let donation_client = DonationContractClient::new(env, &donation_id);

        registry_client.initialize(&admin, &donation_id);
        donation_client.initialize(&admin, &registry_id);

        (admin, donation_client, registry_client)
    }

    #[test]
    fn test_register_creator_via_registry() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (_admin, donation_client, _registry_client) = setup(&env);

        let creator = Address::generate(&env);
        env.ledger().with_mut(|li| li.sequence_number = 100);

        let profile = donation_client.register_creator(&creator, &String::from_bytes(&env, b"awesome_dev"));

        assert_eq!(profile.donation_count, 0);
        assert_eq!(profile.total_donations, 0);
    }

    #[test]
    fn test_donate_updates_registry_cross_contract() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, registry_client) = setup(&env);

        let donor = Address::generate(&env);
        let creator = Address::generate(&env);

        env.ledger().with_mut(|li| li.sequence_number = 100);

        let token_address = create_token_contract(&env, &admin);
        StellarAssetClient::new(&env, &token_address).mint(&donor, &10_000);

        donation_client.register_creator(&creator, &String::from_bytes(&env, b"awesome_dev"));

        let donation = donation_client.donate(
            &donor,
            &creator,
            &token_address,
            &1000,
            &String::from_bytes(&env, b"Great work!"),
        );

        assert_eq!(donation.amount, 1000);
        assert_eq!(donation.donor, donor);
        assert_eq!(donation.creator, creator);
        assert_eq!(donation.memo, String::from_bytes(&env, b"Great work!"));
        assert_eq!(donation_client.get_donation(&0).unwrap().memo, donation.memo);

        // Verify the transfer actually happened
        let token_client = token::Client::new(&env, &token_address);
        assert_eq!(token_client.balance(&creator), 1000);
        assert_eq!(token_client.balance(&donor), 9_000);

        // Verify the registry (a *separate* contract) picked up the stats
        // update via the cross-contract call made inside `donate`.
        let stats = registry_client.get_creator(&creator).unwrap();
        assert_eq!(stats.total_donations, 1000);
        assert_eq!(stats.donation_count, 1);

        // And the donation contract's own view of the registry agrees.
        let stats_via_donation = donation_client.get_creator(&creator).unwrap();
        assert_eq!(stats_via_donation.total_donations, 1000);
    }

    #[test]
    fn test_donate_without_prior_registration_creates_profile() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, registry_client) = setup(&env);

        let donor = Address::generate(&env);
        let creator = Address::generate(&env);

        let token_address = create_token_contract(&env, &admin);
        StellarAssetClient::new(&env, &token_address).mint(&donor, &5_000);

        donation_client.donate(
            &donor,
            &creator,
            &token_address,
            &250,
            &String::from_bytes(&env, b"First!"),
        );

        let stats = registry_client.get_creator(&creator).unwrap();
        assert_eq!(stats.total_donations, 250);
        assert_eq!(stats.donation_count, 1);
    }

    #[test]
    #[should_panic(expected = "Donation amount must be positive")]
    fn test_donate_rejects_non_positive_amount() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let donor = Address::generate(&env);
        let creator = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        StellarAssetClient::new(&env, &token_address).mint(&donor, &1_000);

        donation_client.donate(
            &donor,
            &creator,
            &token_address,
            &0,
            &String::from_bytes(&env, b"nope"),
        );
    }

    #[test]
    #[should_panic]
    fn test_donate_rejects_insufficient_balance() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let donor = Address::generate(&env);
        let creator = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        StellarAssetClient::new(&env, &token_address).mint(&donor, &10);

        donation_client.donate(
            &donor,
            &creator,
            &token_address,
            &1000,
            &String::from_bytes(&env, b"too much"),
        );
    }

    #[test]
    #[should_panic(expected = "Donation memo exceeds maximum length")]
    fn test_donate_rejects_oversized_memo() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let donor = Address::generate(&env);
        let creator = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        StellarAssetClient::new(&env, &token_address).mint(&donor, &1_000);
        let oversized_memo = [b'x'; MAX_MEMO_LENGTH as usize + 1];

        donation_client.donate(
            &donor,
            &creator,
            &token_address,
            &100,
            &String::from_bytes(&env, &oversized_memo),
        );
    }

    #[test]
    fn test_multiple_donations_increment_counter_and_history() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let donor = Address::generate(&env);
        let creator = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        StellarAssetClient::new(&env, &token_address).mint(&donor, &10_000);

        donation_client.donate(&donor, &creator, &token_address, &100, &String::from_bytes(&env, b"one"));
        donation_client.donate(&donor, &creator, &token_address, &200, &String::from_bytes(&env, b"two"));

        assert_eq!(donation_client.get_total_donations_count(), 2);
        assert_eq!(donation_client.get_donation(&0).unwrap().amount, 100);
        assert_eq!(donation_client.get_donation(&1).unwrap().amount, 200);
    }

    #[test]
    fn test_subscribe_records_schedule() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let supporter = Address::generate(&env);
        let creator = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);

        env.ledger().with_mut(|li| li.timestamp = 1_000);

        let id = donation_client.subscribe(&supporter, &creator, &token_address, &100, &2_592_000);
        let subscription = donation_client.get_subscription(&id).unwrap();

        assert_eq!(subscription.supporter, supporter);
        assert_eq!(subscription.creator, creator);
        assert_eq!(subscription.amount, 100);
        assert_eq!(subscription.interval_secs, 2_592_000);
        assert_eq!(subscription.next_charge_at, 1_000 + 2_592_000);
        assert!(subscription.active);
    }

    #[test]
    fn test_charge_subscription_draws_allowance_and_updates_registry() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, registry_client) = setup(&env);

        let supporter = Address::generate(&env);
        let creator = Address::generate(&env);
        let executor = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        StellarAssetClient::new(&env, &token_address).mint(&supporter, &10_000);

        env.ledger().with_mut(|li| li.timestamp = 1_000);

        donation_client.set_executor(&executor);
        let id = donation_client.subscribe(&supporter, &creator, &token_address, &500, &1_000);

        let token_client = token::Client::new(&env, &token_address);
        token_client.approve(&supporter, &donation_client.address, &500, &1_000);

        env.ledger().with_mut(|li| li.timestamp = 2_000);
        let donation = donation_client.charge_subscription(&executor, &id);

        assert_eq!(donation.amount, 500);
        assert_eq!(donation.donor, supporter);
        assert_eq!(token_client.balance(&creator), 500);
        assert_eq!(token_client.balance(&supporter), 9_500);

        let stats = registry_client.get_creator(&creator).unwrap();
        assert_eq!(stats.total_donations, 500);
        assert_eq!(stats.donation_count, 1);

        let subscription = donation_client.get_subscription(&id).unwrap();
        assert_eq!(subscription.next_charge_at, 2_000 + 1_000);
    }

    #[test]
    #[should_panic(expected = "caller is not the authorized executor")]
    fn test_charge_subscription_rejects_unauthorized_executor() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let supporter = Address::generate(&env);
        let creator = Address::generate(&env);
        let executor = Address::generate(&env);
        let impostor = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);

        donation_client.set_executor(&executor);
        let id = donation_client.subscribe(&supporter, &creator, &token_address, &500, &1_000);

        donation_client.charge_subscription(&impostor, &id);
    }

    #[test]
    #[should_panic(expected = "subscription not yet due")]
    fn test_charge_subscription_rejects_before_due() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let supporter = Address::generate(&env);
        let creator = Address::generate(&env);
        let executor = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        StellarAssetClient::new(&env, &token_address).mint(&supporter, &10_000);

        env.ledger().with_mut(|li| li.timestamp = 1_000);
        donation_client.set_executor(&executor);
        let id = donation_client.subscribe(&supporter, &creator, &token_address, &500, &1_000);

        let token_client = token::Client::new(&env, &token_address);
        token_client.approve(&supporter, &donation_client.address, &500, &1_000);

        // Still at timestamp 1_000, next_charge_at is 2_000 — too early.
        donation_client.charge_subscription(&executor, &id);
    }

    #[test]
    fn test_cancel_subscription_deactivates_and_revokes_allowance() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let supporter = Address::generate(&env);
        let creator = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);

        env.ledger().with_mut(|li| li.timestamp = 1_000);
        let id = donation_client.subscribe(&supporter, &creator, &token_address, &500, &1_000);

        let token_client = token::Client::new(&env, &token_address);
        token_client.approve(&supporter, &donation_client.address, &500, &1_000);
        assert_eq!(token_client.allowance(&supporter, &donation_client.address), 500);

        donation_client.cancel_subscription(&supporter, &id);

        assert!(!donation_client.get_subscription(&id).unwrap().active);
        assert_eq!(token_client.allowance(&supporter, &donation_client.address), 0);
    }

    #[test]
    #[should_panic(expected = "subscription is not active")]
    fn test_charge_subscription_rejects_cancelled() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let supporter = Address::generate(&env);
        let creator = Address::generate(&env);
        let executor = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        StellarAssetClient::new(&env, &token_address).mint(&supporter, &10_000);

        env.ledger().with_mut(|li| li.timestamp = 1_000);
        donation_client.set_executor(&executor);
        let id = donation_client.subscribe(&supporter, &creator, &token_address, &500, &1_000);

        let token_client = token::Client::new(&env, &token_address);
        token_client.approve(&supporter, &donation_client.address, &500, &1_000);

        donation_client.cancel_subscription(&supporter, &id);

        env.ledger().with_mut(|li| li.timestamp = 2_000);
        donation_client.charge_subscription(&executor, &id);
    }
}
