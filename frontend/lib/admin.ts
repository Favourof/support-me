const configuredAdminWallets = (process.env.NEXT_PUBLIC_ADMIN_WALLETS || '')
  .split(',')
  .map((wallet) => wallet.trim())
  .filter(Boolean);

export const ADMIN_WALLETS = configuredAdminWallets;

export function isAdminWallet(walletAddress: string | null | undefined): boolean {
  return !!walletAddress && ADMIN_WALLETS.includes(walletAddress);
}
