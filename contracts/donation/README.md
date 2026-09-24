# SupportMe Donation Smart Contract

A Soroban smart contract for handling creator donations and profiles on the Stellar blockchain.

## Overview

The `DonationContract` enables creators to register public profiles and receive donations from supporters. All donations are recorded immutably on the blockchain, creating a transparent donation history.

## Key Features

- **Creator Registration**: Creators can register profiles with usernames
- **Donation Tracking**: Donations are recorded with donor, amount, memo, and timestamp
- **Creator Statistics**: Track total donations and donation count per creator
- **Event Logging**: All actions emit events for monitoring and indexing
- **Auth Integration**: Uses Soroban's native auth for secure operations

## Contract Structure

### Data Types

#### `DonationRecord`
Records individual donations:
```rust
pub struct DonationRecord {
    pub donor: Address,           // Who sent the donation
    pub creator: Address,         // Who received it
    pub amount: i128,            // Donation amount (in stroops)
    pub memo: String,            // Optional message
    pub timestamp: u64,          // When it happened
}
```

#### `CreatorProfile`
Creator account information:
```rust
pub struct CreatorProfile {
    pub address: Address,         // Creator's wallet address
    pub username: String,         // Public username
    pub total_donations: i128,    // Total XLM received
    pub donation_count: u32,      // Number of donations
    pub created_at: u64,         // Registration timestamp
}
```

### Methods

#### `register_creator(env, creator, username) -> CreatorProfile`
Register a new creator profile.

**Parameters:**
- `creator`: Creator's address (must sign transaction)
- `username`: Unique username for the creator

**Returns:** `CreatorProfile` object

**Events:** Emits `created` event

**Example:**
```rust
DonationContract::register_creator(
    env.clone(),
    creator_address,
    String::from_bytes(&env, b"awesome_dev")
);
```

#### `donate(env, donor, creator, amount, memo) -> DonationRecord`
Send a donation to a creator.

**Parameters:**
- `donor`: Donor's address (must sign transaction)
- `creator`: Target creator's address
- `amount`: Donation amount in stroops (must be > 0)
- `memo`: Optional message with the donation

**Returns:** `DonationRecord` object

**Events:** Emits `donated` event

**Example:**
```rust
DonationContract::donate(
    env.clone(),
    donor_address,
    creator_address,
    5000,  // stroops (0.0005 XLM)
    String::from_bytes(&env, b"Great work!")
);
```

#### `get_creator(env, creator) -> Option<CreatorProfile>`
Retrieve a creator's profile.

**Parameters:**
- `creator`: Creator's address

**Returns:** `Option<CreatorProfile>` - Some if creator exists, None otherwise

#### `get_creator_stats(env, creator) -> Option<CreatorProfile>`
Get donation statistics for a creator.

**Parameters:**
- `creator`: Creator's address

**Returns:** Complete `CreatorProfile` with stats

#### `get_total_donations_count(env) -> u32`
Get approximate total donation count across all creators.

**Returns:** Approximate number of donations made

#### `verify_donation(env, donor, creator, amount) -> bool`
Verify if a donor has made donations to a creator.

**Parameters:**
- `donor`: Donor's address (must sign)
- `creator`: Creator's address
- `amount`: Minimum amount to verify

**Returns:** `bool` - true if donation history exists

## Usage Flow

### For Creators

1. **Register Profile:**
   ```
   Call register_creator with your address and desired username
   ```

2. **Check Stats:**
   ```
   Call get_creator_stats to see total donations and count
   ```

3. **Share Profile:**
   ```
   Share your creator address or username with supporters
   ```

### For Supporters

1. **Find Creator:**
   ```
   Look up creator's address
   ```

2. **Send Donation:**
   ```
   Call donate with creator address and amount
   Add optional memo message
   ```

3. **Verify:**
   ```
   Call verify_donation to confirm transaction
   ```

## Storage Model

- **Permanent Storage**: Creator profiles (persistent across ledger resets)
- **Persistent Storage**: Donation records with counter-based indexing
- **Key Format**: Donations stored as "don{counter}" for efficient retrieval

## Events

### Created Event
```
Emitted when creator profile is created
Data: (creator_address, username)
```

### Donated Event
```
Emitted when donation is made
Data: (donor_address, creator_address, amount, memo, timestamp, token_address)
```

## Security Considerations

1. **Authentication**: All state-changing operations require auth
2. **Validation**: Amounts must be positive
3. **Creator Flexibility**: Creators don't need to pre-register to receive donations
4. **Immutability**: All donation records are immutable once recorded

## Building

```bash
make build
```

## Testing

```bash
make test
```

## Future Enhancements

- Batch donations
- Donation search/filtering
- Creator tiers and perks
- Donation escrow with milestone-based release
- Integration with payment channels
- Multi-token support
- Creator rankings and leaderboards
