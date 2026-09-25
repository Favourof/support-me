#![no_std]

//! CreatorRegistry: owns creator profile state (username, lifetime totals).
//!
//! The `donation` contract is the only party allowed to call
//! `record_donation` — it does so via a cross-contract call after it moves
//! funds from a donor to a creator, so this registry's stats always stay in
//! sync with real on-chain transfers.

use common::CreatorProfile;
use soroban_sdk::{contract, contractevent, contractimpl, symbol_short, Address, Env, String, Symbol};

const ADMIN_KEY: Symbol = symbol_short!("admin");
const DONATION_KEY: Symbol = symbol_short!("don_ctr");
const GOAL_KEY: Symbol = symbol_short!("goal");

/// Emitted whenever a new creator profile is registered.
#[contractevent(topics = ["created"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CreatedEvent {
    #[topic]
    pub creator: Address,
    pub username: String,
}

/// Emitted whenever a donation is recorded in the registry. Carries the
/// donation amount as well as updated cumulative totals so indexers and
/// the backend can reconcile lifetime creator stats without extra RPC calls.
#[contractevent(topics = ["don_rec"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DonationRecordedEvent {
    #[topic]
    pub creator: Address,
    pub amount: i128,
    pub total_donations: i128,
    pub donation_count: u32,
}

/// Emitted whenever a creator sets or updates their funding goal.
#[contractevent(topics = ["goal_upd"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GoalUpdatedEvent {
    #[topic]
    pub creator: Address,
    pub goal_amount: i128,
    pub updated_at: u64,
}

#[contract]
pub struct CreatorRegistryContract;

#[contractimpl]
impl CreatorRegistryContract {
    /// One-time setup. `donation_contract` is the only address that will be
    /// permitted to call `record_donation`.
    pub fn initialize(env: Env, admin: Address, donation_contract: Address) {
        admin.require_auth();
        assert!(
            !env.storage().instance().has(&ADMIN_KEY),
            "registry already initialized"
        );
        env.storage().instance().set(&ADMIN_KEY, &admin);
        env.storage().instance().set(&DONATION_KEY, &donation_contract);
    }

    /// Point the registry at a new donation contract (e.g. after a
    /// redeployment). Admin only.
    pub fn set_donation_contract(env: Env, donation_contract: Address) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&ADMIN_KEY)
            .expect("registry not initialized");
        admin.require_auth();
        env.storage().instance().set(&DONATION_KEY, &donation_contract);
    }

    /// Register a new creator profile. Must be signed by the creator.
    pub fn register_creator(env: Env, creator: Address, username: String) -> CreatorProfile {
        creator.require_auth();
        assert!(
            env.storage()
                .persistent()
                .get::<_, CreatorProfile>(&creator)
                .is_none(),
            "creator already registered"
        );

        let profile = CreatorProfile {
            address: creator.clone(),
            username: username.clone(),
            total_donations: 0,
            donation_count: 0,
            created_at: env.ledger().timestamp(),
        };

        env.storage().persistent().set(&creator, &profile);
        CreatedEvent { creator, username }.publish(&env);

        profile
    }

    /// Read a creator's profile, if one exists.
    pub fn get_creator(env: Env, creator: Address) -> Option<CreatorProfile> {
        env.storage().persistent().get(&creator)
    }

    /// Cross-contract entry point: only the authorized donation contract may
    /// call this, and only to report a donation it just settled on-chain.
    pub fn record_donation(env: Env, caller: Address, creator: Address, amount: i128) {
        caller.require_auth();

        let authorized_donation_contract: Address = env
            .storage()
            .instance()
            .get(&DONATION_KEY)
            .expect("registry not initialized");
        assert_eq!(
            caller, authorized_donation_contract,
            "caller is not the authorized donation contract"
        );
        assert!(amount > 0, "amount must be positive");

        let mut profile = env
            .storage()
            .persistent()
            .get::<_, CreatorProfile>(&creator)
            .unwrap_or_else(|| CreatorProfile {
                address: creator.clone(),
                username: String::from_bytes(&env, &[]),
                total_donations: 0,
                donation_count: 0,
                created_at: env.ledger().timestamp(),
            });

        profile.total_donations += amount;
        profile.donation_count += 1;

        env.storage().persistent().set(&creator, &profile);

        // Emit event with full payload so downstream backends/indexers can
        // reconcile lifetime statistics without extra RPC calls.
        DonationRecordedEvent {
            creator,
            amount,
            total_donations: profile.total_donations,
            donation_count: profile.donation_count,
        }
        .publish(&env);
    }

    /// Sets or updates a creator's funding goal. Must be authenticated by the creator.
    pub fn set_goal(env: Env, creator: Address, goal_amount: i128) {
        creator.require_auth();
        assert!(goal_amount >= 0, "Goal amount cannot be negative");

        env.storage().persistent().set(&(GOAL_KEY, creator.clone()), &goal_amount);

        GoalUpdatedEvent {
            creator,
            goal_amount,
            updated_at: env.ledger().timestamp(),
        }
        .publish(&env);
    }

    /// Reads a creator's funding goal, if set.
    pub fn get_goal(env: Env, creator: Address) -> Option<i128> {
        env.storage().persistent().get(&(GOAL_KEY, creator))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};

    #[test]
    fn test_register_creator() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(CreatorRegistryContract, ());
        let client = CreatorRegistryContractClient::new(&env, &contract_id);

        let creator = Address::generate(&env);
        env.ledger().with_mut(|li| li.sequence_number = 100);

        let profile = client.register_creator(&creator, &String::from_bytes(&env, b"awesome_dev"));

        assert_eq!(profile.donation_count, 0);
        assert_eq!(profile.total_donations, 0);
    }

    #[test]
    #[should_panic(expected = "creator already registered")]
    fn test_register_creator_twice_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(CreatorRegistryContract, ());
        let client = CreatorRegistryContractClient::new(&env, &contract_id);

        let creator = Address::generate(&env);
        let username = String::from_bytes(&env, b"awesome_dev");
        client.register_creator(&creator, &username);
        client.register_creator(&creator, &username);
    }

    #[test]
    fn test_record_donation_updates_stats() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(CreatorRegistryContract, ());
        let client = CreatorRegistryContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let donation_contract = Address::generate(&env);
        let creator = Address::generate(&env);

        client.initialize(&admin, &donation_contract);
        client.record_donation(&donation_contract, &creator, &1000);
        client.record_donation(&donation_contract, &creator, &500);

        let profile = client.get_creator(&creator).unwrap();
        assert_eq!(profile.total_donations, 1500);
        assert_eq!(profile.donation_count, 2);
    }

    #[test]
    #[should_panic(expected = "caller is not the authorized donation contract")]
    fn test_record_donation_rejects_unauthorized_caller() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(CreatorRegistryContract, ());
        let client = CreatorRegistryContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let donation_contract = Address::generate(&env);
        let impostor = Address::generate(&env);
        let creator = Address::generate(&env);

        client.initialize(&admin, &donation_contract);
        client.record_donation(&impostor, &creator, &1000);
    }

    #[test]
    #[should_panic(expected = "registry already initialized")]
    fn test_initialize_twice_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(CreatorRegistryContract, ());
        let client = CreatorRegistryContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let donation_contract = Address::generate(&env);

        client.initialize(&admin, &donation_contract);
        client.initialize(&admin, &donation_contract);
    }

    #[test]
    fn test_set_and_get_goal() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(CreatorRegistryContract, ());
        let client = CreatorRegistryContractClient::new(&env, &contract_id);

        let creator = Address::generate(&env);
        assert_eq!(client.get_goal(&creator), None);

        client.set_goal(&creator, &5000);
        assert_eq!(client.get_goal(&creator), Some(5000));

        client.set_goal(&creator, &10000);
        assert_eq!(client.get_goal(&creator), Some(10000));
    }
}
