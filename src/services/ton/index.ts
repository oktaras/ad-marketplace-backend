import { TonClient, Address, toNano, fromNano, WalletContractV4, internal, SendMode } from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { config } from '../../config/index.js';

// Initialize TON client
const client = new TonClient({
  endpoint: config.tonCenterApiUrl,
  apiKey: config.tonCenterApiKey || undefined,
});

// Cached wallet instances
let platformWallet: { contract: WalletContractV4; secretKey: Buffer } | null = null;
let backendWallet: { contract: WalletContractV4; secretKey: Buffer } | null = null;

/**
 * Initialize platform wallet from mnemonic
 */
async function initPlatformWallet() {
  if (platformWallet) return platformWallet;
  
  if (!config.platformMnemonic) {
    throw new Error('PLATFORM_MNEMONIC not configured');
  }
  
  const keyPair = await mnemonicToPrivateKey(config.platformMnemonic.split(' '));
  const contract = WalletContractV4.create({
    publicKey: keyPair.publicKey,
    workchain: 0,
  });
  
  platformWallet = { contract, secretKey: keyPair.secretKey };
  console.log('Platform wallet initialized:', contract.address.toString());
  return platformWallet;
}

/**
 * Initialize backend wallet from mnemonic (for factory operations)
 */
async function initBackendWallet() {
  if (backendWallet) return backendWallet;
  
  if (!config.backendWalletMnemonic) {
    throw new Error('BACKEND_WALLET_MNEMONIC not configured');
  }
  
  const keyPair = await mnemonicToPrivateKey(config.backendWalletMnemonic.split(' '));
  const contract = WalletContractV4.create({
    publicKey: keyPair.publicKey,
    workchain: 0,
  });
  
  backendWallet = { contract, secretKey: keyPair.secretKey };
  console.log('Backend wallet initialized:', contract.address.toString());
  return backendWallet;
}

/**
 * Get contract provider for a given address
 */
function getContractProvider(address: Address) {
  return client.provider(address);
}

/**
 * Send a message from platform wallet
 */
async function sendFromPlatformWallet(params: {
  to: Address;
  value: bigint;
  body?: import('@ton/core').Cell;
  init?: { code: import('@ton/core').Cell; data: import('@ton/core').Cell };
}) {
  const wallet = await initPlatformWallet();
  const provider = client.provider(wallet.contract.address);
  
  const seqno = await wallet.contract.getSeqno(provider);
  
  const transfer = wallet.contract.createTransfer({
    seqno,
    secretKey: wallet.secretKey,
    sendMode: SendMode.PAY_GAS_SEPARATELY,
    messages: [
      internal({
        to: params.to,
        value: params.value,
        body: params.body,
        init: params.init,
      }),
    ],
  });
  
  await client.sendExternalMessage(wallet.contract, transfer);
  
  return { seqno };
}

/**
 * Send a message from backend wallet
 */
async function sendFromBackendWallet(params: {
  to: Address;
  value: bigint;
  body?: import('@ton/core').Cell;
  init?: { code: import('@ton/core').Cell; data: import('@ton/core').Cell };
}) {
  const wallet = await initBackendWallet();
  const provider = client.provider(wallet.contract.address);
  
  const seqno = await wallet.contract.getSeqno(provider);
  
  const transfer = wallet.contract.createTransfer({
    seqno,
    secretKey: wallet.secretKey,
    sendMode: SendMode.PAY_GAS_SEPARATELY,
    messages: [
      internal({
        to: params.to,
        value: params.value,
        body: params.body,
        init: params.init,
      }),
    ],
  });
  
  await client.sendExternalMessage(wallet.contract, transfer);
  
  return { seqno };
}

/**
 * Wait for transaction to be confirmed by checking seqno change
 */
async function waitForSeqnoChange(
  walletAddress: Address,
  currentSeqno: number,
  timeout = 60000,
): Promise<boolean> {
  const startTime = Date.now();
  const provider = client.provider(walletAddress);
  
  while (Date.now() - startTime < timeout) {
    try {
      const contract = WalletContractV4.create({
        publicKey: Buffer.alloc(32), // Dummy, we just need the seqno
        workchain: 0,
      });
      // Use open to get seqno for any V4 wallet
      const seqno = await client.runMethod(walletAddress, 'seqno').then(r => r.stack.readNumber());
      if (seqno > currentSeqno) {
        return true;
      }
    } catch (error) {
      // Contract may not be deployed yet, keep waiting
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  return false;
}

/**
 * Check if contract is deployed
 */
async function isContractDeployed(address: Address): Promise<boolean> {
  try {
    const state = await client.getContractState(address);
    return state.state === 'active';
  } catch {
    return false;
  }
}

/**
 * Verify signature for wallet ownership proof
 */
export async function verifySignature(
  address: string,
  message: string,
  signature: string,
): Promise<boolean> {
  // TODO: Implement proper TON signature verification
  // This is a stub - in production, verify using tonweb or @ton/crypto
  
  try {
    // For now, just check that address is valid
    Address.parse(address);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get wallet balance
 */
export async function getBalance(address: string): Promise<string> {
  try {
    const addr = Address.parse(address);
    const balance = await client.getBalance(addr);
    return balance.toString();
  } catch (error) {
    console.error('Error getting balance:', error);
    return '0';
  }
}

/**
 * Check if address is a valid TON address
 */
export function isValidAddress(address: string): boolean {
  try {
    Address.parse(address);
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert TON to nanoTON
 */
export function toNanoTon(amount: string | number): string {
  return toNano(amount).toString();
}

/**
 * Convert nanoTON to TON
 */
export function fromNanoTon(amount: string | bigint): string {
  return fromNano(BigInt(amount));
}

/**
 * Wait for transaction confirmation
 */
export async function waitForTransaction(
  address: string,
  _timeout = 60000,
): Promise<boolean> {
  // TODO: Implement transaction polling
  // This is a stub
  console.log(`Waiting for transaction on ${address}`);
  return true;
}

export const tonService = {
  verifySignature,
  getBalance,
  isValidAddress,
  toNanoTon,
  fromNanoTon,
  waitForTransaction,
  client,
  // New wallet operations
  initPlatformWallet,
  initBackendWallet,
  getContractProvider,
  sendFromPlatformWallet,
  sendFromBackendWallet,
  waitForSeqnoChange,
  isContractDeployed,
};
