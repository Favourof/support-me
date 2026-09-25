#![no_std]

//! CreatorRegistry: owns creator profile state (username, lifetime totals).
//!
//! The `donation` contract is the only party allowed to call
//! `record_donation` — it does so via a cross-contract call after it moves
//! funds from a donor to a creator, so this registry's stats always stay in
//! sync with real on-chain transfers.

use common::CreatorProfile;
use soroban_sdk::{
    contract, contractevent, contractimpl, symbol_short, Address, Env, String, Symbol,
};

const ADMIN_KEY: Symbol = symbol_short!("admin");
const DONATION_KEY: Symbol = symbol_short!("don_ctr");
const USERNAMES_KEY: Symbol = symbol_short!("usernames");

/// Emitted whenever a new creator profile is registered.
#[contractevent(topics = ["created"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CreatedEvent {
    #[topic]
    pub creator: Address,
    pub username: String,
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
        env.storage()
            .instance()
            .set(&DONATION_KEY, &donation_contract);
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
        env.storage()
            .instance()
            .set(&DONATION_KEY, &donation_contract);
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

        let username_key = (USERNAMES_KEY, username.clone());
        assert!(
            !env.storage().persistent().has(&username_key),
            "username already registered"
        );

        let profile = CreatorProfile {
            address: creator.clone(),
            username: username.clone(),
            total_donations: 0,
            donation_count: 0,
            created_at: env.ledger().timestamp(),
        };

        env.storage().persistent().set(&creator, &profile);
        env.storage().persistent().set(&username_key, &creator);
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

        profile.total_donations = profile
            .total_donations
            .checked_add(amount)
            .expect("lifetime donation total overflow");
        profile.donation_count = profile
            .donation_count
            .checked_add(1)
            .expect("donation count overflow");

        env.storage().persistent().set(&creator, &profile);
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
    fn test_register_creator_rejects_duplicate_username() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(CreatorRegistryContract, ());
        let client = CreatorRegistryContractClient::new(&env, &contract_id);

        let first_creator = Address::generate(&env);
        let second_creator = Address::generate(&env);
        let username = String::from_bytes(&env, b"awesome_dev");

        client.register_creator(&first_creator, &username);
        let result = client.try_register_creator(&second_creator, &username);

        assert!(result.is_err());
        assert!(client.get_creator(&second_creator).is_none());
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
    fn test_record_donation_accepts_lifetime_total_boundary() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(CreatorRegistryContract, ());
        let client = CreatorRegistryContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let donation_contract = Address::generate(&env);
        let creator = Address::generate(&env);
        client.initialize(&admin, &donation_contract);

        client.record_donation(&donation_contract, &creator, &(i128::MAX - 1));
        client.record_donation(&donation_contract, &creator, &1);

        let profile = client.get_creator(&creator).unwrap();
        assert_eq!(profile.total_donations, i128::MAX);
        assert_eq!(profile.donation_count, 2);
    }

    #[test]
    fn test_record_donation_rejects_lifetime_total_overflow_without_mutating() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(CreatorRegistryContract, ());
        let client = CreatorRegistryContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let donation_contract = Address::generate(&env);
        let creator = Address::generate(&env);
        client.initialize(&admin, &donation_contract);
        client.record_donation(&donation_contract, &creator, &i128::MAX);

        let result = client.try_record_donation(&donation_contract, &creator, &1);
        assert!(result.is_err());

        let profile = client.get_creator(&creator).unwrap();
        assert_eq!(profile.total_donations, i128::MAX);
        assert_eq!(profile.donation_count, 1);
    }

    #[test]
    fn test_record_donation_requires_caller_authentication() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(CreatorRegistryContract, ());
        let client = CreatorRegistryContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let donation_contract = Address::generate(&env);
        let creator = Address::generate(&env);
        client.initialize(&admin, &donation_contract);
        env.set_auths(&[]);

        assert!(client
            .try_record_donation(&donation_contract, &creator, &1)
            .is_err());
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
}
