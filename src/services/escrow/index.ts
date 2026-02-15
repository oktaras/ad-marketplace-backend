import { prisma } from '../../lib/prisma.js';
import { tonService } from '../ton/index.js';
import { config } from '../../config/index.js';
import { Address, toNano, beginCell, fromNano } from '@ton/ton';
import { storeStateInit, type Transaction } from '@ton/core';
import { DealEscrow } from '../ton/contracts/DealEscrow.js';
import { type Prisma } from '@prisma/client';
import { dealService } from '../deal/index.js';

// Contract status constants (matching the Tact contract)
const STATUS_CREATED = 0n;
const STATUS_FUNDED = 1n;
const STATUS_RELEASED = 2n;
const STATUS_REFUNDED = 3n;
const STATUS_DISPUTED = 4n;
const ESCROW_DEPLOY_RESERVE = 0n;
const FUND_OPCODE = 1;
const ONCHAIN_DEAL_ID_SHIFT = 16n;
const MAX_ONCHAIN_ROTATION_ATTEMPTS = 65535;

interface EscrowMetadata {
  onChainDealId?: string;
  fundingAttempt?: number;
  invalidFirstFundingCount?: number;
  lastInvalidAt?: string;
  lastInvalidReason?: string;
  previousEscrowAddress?: string;
  historicalEscrowsAcknowledged?: string[]; // Track historical escrows we've already processed
  lastRotationTimestamp?: number; // Timestamp of last rotation for cooldown
}

interface FirstFundingValidationResult {
  valid: boolean;
  rotated: boolean;
  reason?: string;
  previousOnChainDealId?: string;
  nextOnChainDealId?: string;
  previousEscrowAddress?: string;
  nextEscrowAddress?: string;
}

interface HistoricalEscrowRefundResult {
  attempted: boolean;
  refunded: boolean;
  reason: string;
  transactionId?: string;
}

interface CreateDealEscrowParams {
  dealId: string;
  dealNumber: number; // Used as on-chain dealId
  advertiserAddress: string;
  publisherAddress: string;
  amount: string; // in TON
  platformFeeBps: number;
  onChainDealId?: string;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEscrowMetadata(value: Prisma.JsonValue | null | undefined): EscrowMetadata {
  if (!isObjectRecord(value)) {
    return {};
  }
  const root = value as Record<string, unknown>;
  const raw = root.escrowValidation;
  if (!isObjectRecord(raw)) {
    return {};
  }

  return {
    onChainDealId: typeof raw.onChainDealId === 'string' ? raw.onChainDealId : undefined,
    fundingAttempt: typeof raw.fundingAttempt === 'number' ? raw.fundingAttempt : undefined,
    invalidFirstFundingCount: typeof raw.invalidFirstFundingCount === 'number' ? raw.invalidFirstFundingCount : undefined,
    lastInvalidAt: typeof raw.lastInvalidAt === 'string' ? raw.lastInvalidAt : undefined,
    lastInvalidReason: typeof raw.lastInvalidReason === 'string' ? raw.lastInvalidReason : undefined,
    previousEscrowAddress: typeof raw.previousEscrowAddress === 'string' ? raw.previousEscrowAddress : undefined,
    historicalEscrowsAcknowledged: Array.isArray(raw.historicalEscrowsAcknowledged) 
      ? (raw.historicalEscrowsAcknowledged.filter((v): v is string => typeof v === 'string'))
      : undefined,
    lastRotationTimestamp: typeof raw.lastRotationTimestamp === 'number' ? raw.lastRotationTimestamp : undefined,
  };
}

function resolveOnChainDealId(dealNumber: number, metadata: Prisma.JsonValue | null | undefined): bigint {
  const escrowMeta = parseEscrowMetadata(metadata);
  if (escrowMeta.onChainDealId) {
    try {
      const parsed = BigInt(escrowMeta.onChainDealId);
      if (parsed >= 0n) {
        return parsed;
      }
    } catch {
      // fallback to dealNumber
    }
  }
  return BigInt(dealNumber);
}

function buildRotatedOnChainDealId(dealNumber: number, attempt: number): bigint {
  return (BigInt(dealNumber) << ONCHAIN_DEAL_ID_SHIFT) + BigInt(attempt);
}

function appendSystemNote(existing: string | null, note: string): string {
  return existing ? `${existing}\n${note}` : note;
}

async function fetchInboundInternalTransactions(address: Address, maxTransactions = 100): Promise<Transaction[]> {
  const all: Transaction[] = [];
  let lt: string | undefined;
  let hash: string | undefined;
  const pageSize = 20;

  while (all.length < maxTransactions) {
    const batchLimit = Math.min(pageSize, maxTransactions - all.length);
    const page = await tonService.client.getTransactions(address, {
      limit: batchLimit,
      lt,
      hash,
      inclusive: false,
      archival: true,
    });

    if (page.length === 0) {
      break;
    }

    all.push(...page);

    if (page.length < batchLimit) {
      break;
    }

    const last = page[page.length - 1];
    lt = last.lt.toString();
    hash = last.hash().toString('base64');
  }

  return all
    .filter((tx) => tx.inMessage && tx.inMessage.info.type === 'internal')
    .sort((a, b) => (a.lt < b.lt ? -1 : a.lt > b.lt ? 1 : 0));
}

function describeFirstFundingViolation(parts: {
  senderMatches: boolean;
  hasDeployInit: boolean;
  opMatches: boolean;
  dealIdMatches: boolean;
  txSucceeded: boolean;
}): string {
  const issues: string[] = [];
  if (!parts.senderMatches) issues.push('sender is not advertiser');
  if (!parts.hasDeployInit) issues.push('missing deploy init in first tx');
  if (!parts.opMatches) issues.push('first tx is not Fund opcode');
  if (!parts.dealIdMatches) issues.push('dealId in first tx does not match expected');
  if (!parts.txSucceeded) issues.push('first tx aborted');
  return `Invalid first funding transaction: ${issues.join(', ')}`;
}

async function extractFundDealIdFromInboundTransactions(address: Address): Promise<bigint | null> {
  const inboundTransactions = await fetchInboundInternalTransactions(address, 100);

  for (const transaction of inboundTransactions) {
    const inMessage = transaction.inMessage;
    if (!inMessage || inMessage.info.type !== 'internal') {
      continue;
    }

    const bodySlice = inMessage.body.beginParse();
    if (bodySlice.remainingBits < 32) {
      continue;
    }

    const op = Number(bodySlice.loadUint(32));
    if (op !== FUND_OPCODE || bodySlice.remainingBits < 64) {
      continue;
    }

    return bodySlice.loadUintBig(64);
  }

  return null;
}

async function triggerHistoricalEscrowRefund(params: {
  dealId: string;
  escrowWalletId: string;
  contractAddress: string;
  advertiserWalletAddress: string | null;
  amountTon: string;
}): Promise<HistoricalEscrowRefundResult> {
  if (!params.advertiserWalletAddress) {
    return {
      attempted: false,
      refunded: false,
      reason: 'Advertiser wallet is not set, stale escrow refund skipped.',
    };
  }

  const idempotencyKey = `refund-stale-${params.dealId}-${params.escrowWalletId}`;
  const existingTx = await prisma.transaction.findUnique({
    where: { idempotencyKey },
  });

  if (existingTx) {
    return {
      attempted: true,
      refunded: existingTx.status === 'CONFIRMED',
      reason:
        existingTx.status === 'CONFIRMED'
          ? 'Stale escrow refund already confirmed.'
          : `Stale escrow refund already attempted (status: ${existingTx.status}).`,
      transactionId: existingTx.id,
    };
  }

  const contractAddress = Address.parse(params.contractAddress);
  const provider = tonService.getContractProvider(contractAddress);
  const contract = DealEscrow.fromAddress(contractAddress);
  const status = await contract.getStatus(provider);

  if (Number(status) !== Number(STATUS_FUNDED) && Number(status) !== Number(STATUS_DISPUTED)) {
    return {
      attempted: false,
      refunded: false,
      reason: `Stale escrow status is ${status.toString()}, refund skipped.`,
    };
  }

  const onChainDealId = await extractFundDealIdFromInboundTransactions(contractAddress);
  if (onChainDealId === null) {
    return {
      attempted: false,
      refunded: false,
      reason: 'Unable to extract on-chain deal id from stale escrow transactions.',
    };
  }

  const refundBody = beginCell()
    .storeUint(3, 32) // Refund opcode
    .storeUint(onChainDealId, 64)
    .endCell();

  const { seqno } = await tonService.sendFromPlatformWallet({
    to: contractAddress,
    value: toNano(config.escrow.operationGasTon),
    body: refundBody,
  });

  const refundTransaction = await prisma.transaction.create({
    data: {
      walletId: params.escrowWalletId,
      dealId: params.dealId,
      type: 'REFUND',
      status: 'PENDING',
      amount: params.amountTon,
      fromAddress: params.contractAddress,
      toAddress: params.advertiserWalletAddress,
      idempotencyKey,
    },
  });

  const platformWallet = await tonService.initPlatformWallet();
  const confirmed = await tonService.waitForSeqnoChange(platformWallet.contract.address, seqno, 60000);

  if (!confirmed) {
    const reason = 'Stale escrow refund transaction not confirmed in time.';
    await prisma.transaction.update({
      where: { id: refundTransaction.id },
      data: {
        status: 'FAILED',
        errorMessage: reason,
        retryCount: { increment: 1 },
      },
    });

    return {
      attempted: true,
      refunded: false,
      reason,
      transactionId: refundTransaction.id,
    };
  }

  const newStatus = await contract.getStatus(provider);
  if (Number(newStatus) !== Number(STATUS_REFUNDED)) {
    const reason = `Stale escrow refund sent, but contract status is ${newStatus.toString()} (expected ${STATUS_REFUNDED.toString()}).`;
    await prisma.transaction.update({
      where: { id: refundTransaction.id },
      data: {
        status: 'FAILED',
        errorMessage: reason,
        retryCount: { increment: 1 },
      },
    });

    return {
      attempted: true,
      refunded: false,
      reason,
      transactionId: refundTransaction.id,
    };
  }

  await prisma.$transaction([
    prisma.transaction.update({
      where: { id: refundTransaction.id },
      data: { status: 'CONFIRMED' },
    }),
    prisma.escrowWallet.update({
      where: { id: params.escrowWalletId },
      data: { status: 'RETIRED' },
    }),
  ]);

  return {
    attempted: true,
    refunded: true,
    reason: 'Stale escrow refund confirmed.',
    transactionId: refundTransaction.id,
  };
}

/**
 * Create a per-deal escrow wallet and deploy contract
 */
export async function createDealEscrow(params: CreateDealEscrowParams) {
  const { dealId, dealNumber, advertiserAddress, publisherAddress, amount, platformFeeBps, onChainDealId } = params;

  // Security: Validate platform fee before creating contract
  if (platformFeeBps < 0 || platformFeeBps > 2000) {
    throw new Error(`Invalid platformFeeBps: ${platformFeeBps}. Must be between 0 and 2000 (0-20%)`);
  }

  // Parse addresses
  const advertiser = Address.parse(advertiserAddress);
  const publisher = Address.parse(publisherAddress);
  const arbiter = Address.parse(config.platformFeeWalletAddress); // Platform is arbiter for disputes
  // Use platformFeeWalletAddress for feeReceiver - must be a deployed wallet to avoid bounces
  const feeReceiver = Address.parse(config.platformFeeWalletAddress);
  
  // Calculate refund deadline (seconds from now when advertiser can self-refund)
  const refundDeadline = BigInt(config.escrow.refundDeadlineSeconds);
  const expectedAmount = toNano(amount);
  const chainDealId = onChainDealId ? BigInt(onChainDealId) : BigInt(dealNumber);

  // Create DealEscrow contract instance with init data
  const contract = await DealEscrow.fromInit(
    chainDealId,
    advertiser,
    publisher,
    arbiter,
    feeReceiver,
    BigInt(platformFeeBps),
    expectedAmount,
    refundDeadline,
  );

  const contractAddress = contract.address.toString();

  console.log(`Creating escrow contract for deal ${dealId}:`, {
    contractAddress,
    dealNumber,
    chainDealId: chainDealId.toString(),
    advertiser: advertiserAddress,
    publisher: publisherAddress,
    arbiter: config.platformFeeWalletAddress,
    feeReceiver: config.platformFeeWalletAddress,
    feeBps: platformFeeBps,
    refundDeadlineSeconds: config.escrow.refundDeadlineSeconds,
  });

  // Create or update escrow wallet record in DB (upsert since contract address is deterministic)
  const escrowWallet = await prisma.escrowWallet.upsert({
    where: { address: contractAddress },
    create: {
      address: contractAddress,
      type: 'DEAL',
      dealId,
      contractAddress,
      isDeployed: false, // Will be deployed when advertiser funds it
      status: 'ACTIVE',
    },
    update: {
      // Update deal association if it changed
      dealId,
      status: 'ACTIVE',
    },
  });

  // Store the init code/data for deployment
  // The contract will be deployed when the advertiser sends the first Fund message
  // by including the init state with the transaction

  return escrowWallet;
}

/**
 * Deploy the escrow contract (called when advertiser is ready to fund)
 * WORKAROUND: Pre-deploy empty contract, then manually trigger Fund after detecting payment
 */
export async function deployEscrowContract(dealId: string) {
  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    include: {
      escrowWallet: true,
      advertiser: true,
      channelOwner: true,
    },
  });

  if (!deal || !deal.escrowWallet) {
    throw new Error('Deal or escrow wallet not found');
  }

  // Security: Validate platform fee before deploying contract
  if (config.platformFeeBps < 0 || config.platformFeeBps > 2000) {
    throw new Error(`Invalid platformFeeBps in config: ${config.platformFeeBps}. Must be between 0 and 2000 (0-20%)`);
  }

  // Parse addresses
  const advertiser = Address.parse(deal.advertiser.walletAddress!);
  const publisher = Address.parse(deal.channelOwner.walletAddress!);
  const arbiter = Address.parse(config.platformFeeWalletAddress);
  const feeReceiver = Address.parse(config.platformFeeWalletAddress); // Same as arbiter - must be deployed
  const refundDeadline = BigInt(config.escrow.refundDeadlineSeconds);
  const expectedAmountTon = deal.escrowAmount || deal.agreedPrice;
  if (!expectedAmountTon) {
    throw new Error(`Cannot deploy escrow for deal ${dealId}: missing expected escrow amount`);
  }
  const expectedAmount = toNano(expectedAmountTon);
  const onChainDealId = resolveOnChainDealId(deal.dealNumber, deal.metadata);

  // Recreate contract instance
  const contract = await DealEscrow.fromInit(
    onChainDealId,
    advertiser,
    publisher,
    arbiter,
    feeReceiver,
    BigInt(config.platformFeeBps),
    expectedAmount,
    refundDeadline,
  );

  // Check if contract is already deployed on chain
  const isDeployed = await tonService.isContractDeployed(contract.address);
  
  if (isDeployed) {
    console.log(`Escrow contract already deployed for deal ${dealId}`);
    
    // Update DB if needed
    if (!deal.escrowWallet.isDeployed) {
      await prisma.escrowWallet.update({
        where: { id: deal.escrowWallet.id },
        data: { isDeployed: true },
      });
    }
    
    return deal.escrowWallet;
  }

  // Deploy contract with minimal gas
  const deployValue = toNano('0.05');
  
  console.log(`Deploying escrow contract for deal ${dealId}...`);
  
  const { seqno } = await tonService.sendFromPlatformWallet({
    to: contract.address,
    value: deployValue,
    init: contract.init,
    body: beginCell().endCell(),
  });

  // Wait for confirmation
  const wallet = await tonService.initPlatformWallet();
  await tonService.waitForSeqnoChange(wallet.contract.address, seqno, 60000);

  // Update DB
  await prisma.escrowWallet.update({
    where: { id: deal.escrowWallet.id },
    data: { isDeployed: true },
  });

  console.log(`Escrow contract deployed at ${contract.address.toString()}`);
  
  return deal.escrowWallet;
}

/**
 * Get escrow contract info from chain
 */
export async function getContractInfo(contractAddress: string) {
  const address = Address.parse(contractAddress);
  const provider = tonService.getContractProvider(address);
  const contract = DealEscrow.fromAddress(address);
  
  try {
    console.log(`Getting contract info for ${contractAddress}`);
    const state = await tonService.client.getContractState(address);
    if (state.state !== 'active') {
      console.log('Contract is not active yet, skipping getter calls:', {
        state: state.state,
        balance: state.balance.toString(),
      });
      return null;
    }
    
    const info = await contract.getDealInfo(provider);
    const status = await contract.getStatus(provider);
    const balance = await contract.getBalance(provider);
    
    console.log('Raw contract data:', {
      info: JSON.stringify(info, (_, v) => typeof v === 'bigint' ? v.toString() : v),
      status: status.toString(),
      balance: balance.toString(),
    });
    
    return {
      advertiser: info.advertiser.toString(),
      publisher: info.publisher.toString(),
      amount: info.amount.toString(),
      platformFee: info.platformFee.toString(),
      publisherAmount: info.publisherAmount.toString(),
      fundedAt: info.fundedAt,
      status: Number(status),
      balance: balance.toString(),
    };
  } catch (error) {
    console.error('Error getting contract info:', error);
    return null;
  }
}

/**
 * Verify that escrow has been funded with correct amount
 */
export async function verifyFunding(contractAddress: string, expectedAmount: string): Promise<{
  funded: boolean;
  contractInfo?: Awaited<ReturnType<typeof getContractInfo>>;
}> {
  try {
    console.log(`Verifying funding for ${contractAddress}, expected: ${expectedAmount} TON`);
    
    const info = await getContractInfo(contractAddress);
    
    if (!info) {
      // Contract not deployed or not accessible
      console.log('Contract info not available - contract may not be deployed');
      return { funded: false };
    }

    console.log('Contract state:', {
      status: info.status,
      statusName: info.status === 0 ? 'CREATED' : info.status === 1 ? 'FUNDED' : 'OTHER',
      balance: info.balance,
      amount: info.amount,
      expectedFunded: Number(STATUS_FUNDED),
    });

    // Check if status is FUNDED (1)
    if (info.status === Number(STATUS_FUNDED)) {
      console.log('✓ Contract is in FUNDED status');
      return { funded: true, contractInfo: info };
    }

    // Check balance for contracts not yet in FUNDED status
    const balance = BigInt(info.balance);
    const expectedBigInt = toNano(expectedAmount);
    
    // Allow small variance for gas
    const minRequired = expectedBigInt - toNano('0.1');
    
    console.log('Balance check:', {
      balance: balance.toString(),
      expectedBigInt: expectedBigInt.toString(),
      minRequired: minRequired.toString(),
      balanceGteMin: balance >= minRequired,
    });
    
    if (balance >= minRequired && info.status === Number(STATUS_CREATED)) {
      console.log('Balance looks sufficient but status still CREATED; awaiting advertiser funding confirmation');
      return { funded: false, contractInfo: info };
    }

    const result = info.status === Number(STATUS_FUNDED);
    console.log(`Verification result: ${result ? '✓ FUNDED' : '✗ NOT FUNDED'}`);
    return { funded: result, contractInfo: info };
  } catch (error) {
    console.error('Error verifying funding:', error);
    return { funded: false };
  }
}

export interface EscrowFundingTransaction {
  address: string;
  expectedAmountNano: string;
  reserveAmountNano: string;
  totalAmountNano: string;
  expectedAmountTon: string;
  reserveAmountTon: string;
  totalAmountTon: string;
  payload: string;
  stateInit?: string;
  deepLink: string;
}

function buildWalletDeepLink(
  address: Address,
  amountNano: bigint,
  payloadBase64: string,
  stateInitBase64?: string
): string {
  const friendly = address.toString({
    bounceable: false,
    testOnly: config.tonNetwork === 'testnet',
  });

  const params = new URLSearchParams();
  params.set('amount', amountNano.toString());
  params.set('bin', payloadBase64);
  if (stateInitBase64) {
    params.set('init', stateInitBase64);
  }

  return `ton://transfer/${friendly}?${params.toString()}`;
}

/**
 * Build a TonConnect-ready funding transaction for advertiser.
 * If contract is not yet deployed, includes stateInit and reserve.
 */
export async function getEscrowFundingTransaction(dealId: string): Promise<EscrowFundingTransaction> {
  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    include: {
      escrowWallet: true,
      advertiser: true,
      channelOwner: true,
    },
  });

  if (!deal || !deal.escrowWallet) {
    throw new Error('Deal or escrow wallet not found');
  }

  if (!deal.advertiser.walletAddress) {
    throw new Error('Advertiser wallet address is not set');
  }

  if (!deal.channelOwner.walletAddress) {
    throw new Error('Publisher wallet address is not set');
  }

  const advertiser = Address.parse(deal.advertiser.walletAddress);
  const publisher = Address.parse(deal.channelOwner.walletAddress);
  const arbiter = Address.parse(config.platformFeeWalletAddress);
  const feeReceiver = Address.parse(config.platformFeeWalletAddress);
  const refundDeadline = BigInt(config.escrow.refundDeadlineSeconds);

  const expectedAmountTon = deal.escrowAmount || deal.agreedPrice;
  if (!expectedAmountTon) {
    throw new Error(`Missing escrow amount for deal ${dealId}`);
  }

  const expectedAmountNano = toNano(expectedAmountTon);
  const onChainDealId = resolveOnChainDealId(deal.dealNumber, deal.metadata);
  const contract = await DealEscrow.fromInit(
    onChainDealId,
    advertiser,
    publisher,
    arbiter,
    feeReceiver,
    BigInt(deal.platformFeeBps),
    expectedAmountNano,
    refundDeadline,
  );

  const payloadCell = beginCell()
    .storeUint(1, 32) // Fund opcode
    .storeUint(onChainDealId, 64)
    .endCell();

  const isDeployed = await tonService.isContractDeployed(contract.address);
  const reserveAmountNano = isDeployed ? 0n : ESCROW_DEPLOY_RESERVE;
  const totalAmountNano = expectedAmountNano + reserveAmountNano;

  let stateInit: string | undefined = undefined;
  if (!isDeployed) {
    if (!contract.init) {
      throw new Error('Missing contract init for lazy deployment');
    }
    const stateInitCell = beginCell()
      .store(storeStateInit(contract.init))
      .endCell();
    stateInit = stateInitCell.toBoc().toString('base64');
  }

  const deepLink = buildWalletDeepLink(
    contract.address,
    totalAmountNano,
    payloadCell.toBoc().toString('base64'),
    stateInit,
  );

  return {
    address: contract.address.toString(),
    expectedAmountNano: expectedAmountNano.toString(),
    reserveAmountNano: reserveAmountNano.toString(),
    totalAmountNano: totalAmountNano.toString(),
    expectedAmountTon: fromNano(expectedAmountNano),
    reserveAmountTon: fromNano(reserveAmountNano),
    totalAmountTon: fromNano(totalAmountNano),
    payload: payloadCell.toBoc().toString('base64'),
    stateInit,
    deepLink,
  };
}

/**
 * Validate first inbound transaction for escrow wallet.
 * Requirement: first inbound tx must be advertiser + deploy + Fund(op=1, correct dealId).
 * If validation fails, escrow target is rotated to a fresh on-chain deal id/address.
 * 
 * @param dealId - The deal ID to validate
 * @param options.checkOnly - If true, only check status without triggering rotation
 */
export async function validateAndRotateFirstFundingTransaction(
  dealId: string, 
  options?: { checkOnly?: boolean }
): Promise<FirstFundingValidationResult> {
  const checkOnly = options?.checkOnly ?? false;
  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    include: {
      escrowWallet: true,
      advertiser: { select: { walletAddress: true } },
      channelOwner: { select: { walletAddress: true } },
    },
  });

  if (!deal || !deal.escrowWallet || !deal.escrowWallet.contractAddress) {
    return { valid: true, rotated: false };
  }

  if (!deal.advertiser.walletAddress || !deal.channelOwner.walletAddress) {
    return { valid: true, rotated: false };
  }

  const contractAddress = Address.parse(deal.escrowWallet.contractAddress);
  const advertiserAddress = Address.parse(deal.advertiser.walletAddress);
  const contractState = await tonService.client.getContractState(contractAddress);
  const currentEscrowMeta = parseEscrowMetadata(deal.metadata);

  // Check rotation cooldown - prevent rapid repeated rotations for the same issue
  const ROTATION_COOLDOWN_MS = 60000; // 60 seconds
  if (!checkOnly && currentEscrowMeta.lastRotationTimestamp) {
    const timeSinceLastRotation = Date.now() - currentEscrowMeta.lastRotationTimestamp;
    if (timeSinceLastRotation < ROTATION_COOLDOWN_MS) {
      // Within cooldown period - return previous rotation result without creating new escrow
      const previousOnChainDealId = resolveOnChainDealId(deal.dealNumber, deal.metadata);
      return {
        valid: false,
        rotated: false,
        reason: `${currentEscrowMeta.lastInvalidReason || 'Previous validation failed'}. Cooldown active (${Math.ceil((ROTATION_COOLDOWN_MS - timeSinceLastRotation) / 1000)}s remaining).`,
        previousOnChainDealId: previousOnChainDealId.toString(),
        nextOnChainDealId: currentEscrowMeta.onChainDealId || previousOnChainDealId.toString(),
        previousEscrowAddress: currentEscrowMeta.previousEscrowAddress,
        nextEscrowAddress: deal.escrowWallet.contractAddress || undefined,
      };
    }
  }

  if (contractState.state !== 'active' && contractState.balance > 0n) {
    const reason = `Invalid first funding state: escrow is ${contractState.state} with balance ${fromNano(contractState.balance)} TON before valid deploy+Fund`;
    const expectedOnChainDealId = resolveOnChainDealId(deal.dealNumber, deal.metadata);
    
    // Check-only mode: return validation result without rotation
    if (checkOnly) {
      return {
        valid: false,
        rotated: false,
        reason,
        previousOnChainDealId: expectedOnChainDealId.toString(),
        nextOnChainDealId: currentEscrowMeta.onChainDealId || expectedOnChainDealId.toString(),
        previousEscrowAddress: deal.escrowWallet.contractAddress,
        nextEscrowAddress: deal.escrowWallet.contractAddress || undefined,
      };
    }
    const currentAttempt = currentEscrowMeta.fundingAttempt ?? 0;
    const nextAttempt = Math.min(currentAttempt + 1, MAX_ONCHAIN_ROTATION_ATTEMPTS);
    const nextOnChainDealId = buildRotatedOnChainDealId(deal.dealNumber, nextAttempt);
    const expectedAmount = deal.escrowAmount || deal.agreedPrice;

    const nextEscrowWallet = await createDealEscrow({
      dealId: deal.id,
      dealNumber: deal.dealNumber,
      advertiserAddress: deal.advertiser.walletAddress,
      publisherAddress: deal.channelOwner.walletAddress,
      amount: expectedAmount,
      platformFeeBps: deal.platformFeeBps,
      onChainDealId: nextOnChainDealId.toString(),
    });

    const metadataBase: Prisma.JsonObject = isObjectRecord(deal.metadata)
      ? (deal.metadata as Prisma.JsonObject)
      : {};
    const nextEscrowMeta: Prisma.JsonObject = {
      ...currentEscrowMeta,
      fundingAttempt: nextAttempt,
      onChainDealId: nextOnChainDealId.toString(),
      invalidFirstFundingCount: (currentEscrowMeta.invalidFirstFundingCount ?? 0) + 1,
      lastInvalidAt: new Date().toISOString(),
      lastInvalidReason: reason,
      previousEscrowAddress: deal.escrowWallet.contractAddress,
      lastRotationTimestamp: Date.now(),
    };
    const nextMetadata: Prisma.InputJsonValue = {
      ...metadataBase,
      escrowValidation: nextEscrowMeta,
    } as Prisma.JsonObject;

    const rotationNote = `[${new Date().toISOString()}] ${reason}. Rotated escrow from ${deal.escrowWallet.contractAddress} to ${nextEscrowWallet.contractAddress}.`;

    await prisma.$transaction([
      prisma.escrowWallet.update({
        where: { id: deal.escrowWallet.id },
        data: { status: 'LOCKED' },
      }),
      prisma.deal.update({
        where: { id: deal.id },
        data: {
          escrowWalletId: nextEscrowWallet.id,
          escrowStatus: 'PENDING',
          metadata: nextMetadata,
          notes: appendSystemNote(deal.notes, rotationNote),
        },
      }),
      prisma.dealEvent.create({
        data: {
          dealId: deal.id,
          type: 'ESCROW_FIRST_FUNDING_INVALID',
          actorType: 'SYSTEM',
          fromStatus: deal.status,
          toStatus: deal.status,
          data: {
            reason,
            previousEscrowAddress: deal.escrowWallet.contractAddress,
            nextEscrowAddress: nextEscrowWallet.contractAddress,
            previousOnChainDealId: expectedOnChainDealId.toString(),
            nextOnChainDealId: nextOnChainDealId.toString(),
          },
        },
      }),
    ]);

    return {
      valid: false,
      rotated: true,
      reason,
      previousOnChainDealId: expectedOnChainDealId.toString(),
      nextOnChainDealId: nextOnChainDealId.toString(),
      previousEscrowAddress: deal.escrowWallet.contractAddress,
      nextEscrowAddress: nextEscrowWallet.contractAddress ?? undefined,
    };
  }

  // Detect stale payments to previously assigned escrow addresses for this deal.
  // This happens when frontend/wallet uses an outdated deeplink after rotation.
  const historicalEscrows = await prisma.escrowWallet.findMany({
    where: {
      dealId: deal.id,
      id: { not: deal.escrowWallet.id },
      contractAddress: { not: null },
    },
    select: {
      id: true,
      contractAddress: true,
      status: true,
    },
  });

  const acknowledgedEscrows = currentEscrowMeta.historicalEscrowsAcknowledged || [];

  for (const historicalEscrow of historicalEscrows) {
    const historicalAddress = historicalEscrow.contractAddress;
    if (!historicalAddress) {
      continue;
    }

    // Skip if we've already acknowledged and handled this historical escrow
    if (acknowledgedEscrows.includes(historicalAddress)) {
      continue;
    }

    let historicalState;
    try {
      historicalState = await tonService.client.getContractState(Address.parse(historicalAddress));
    } catch {
      // Ignore transient TON API failures for historical addresses.
      continue;
    }

    if (historicalState.balance > 0n) {
      const expectedAmount = deal.escrowAmount || deal.agreedPrice;
      
      // Check-only mode: just report the issue without rotation or refund
      if (checkOnly) {
        const reason = `Funds detected on previous escrow address ${historicalAddress}. Use the latest funding transaction.`;
        const expectedOnChainDealId = resolveOnChainDealId(deal.dealNumber, deal.metadata);
        return {
          valid: false,
          rotated: false,
          reason,
          previousOnChainDealId: expectedOnChainDealId.toString(),
          nextOnChainDealId: currentEscrowMeta.onChainDealId || expectedOnChainDealId.toString(),
          previousEscrowAddress: historicalAddress,
          nextEscrowAddress: deal.escrowWallet.contractAddress || undefined,
        };
      }

      // TODO: Improve historical escrow refund handling
      // Current implementation only works if contract is in FUNDED or DISPUTED state.
      // If contract never reached FUNDED (raw TON sent without proper Fund message),
      // the Refund opcode won't work and requires alternative approach:
      // - For uninit contracts: consider deploying first, then refunding
      // - For active but non-funded contracts: may need to call destroy or similar
      // - For very small amounts: may be more cost-effective to just mark as lost
      // For now, attempt refund but don't block on failures.
      const refundResult = await triggerHistoricalEscrowRefund({
        dealId: deal.id,
        escrowWalletId: historicalEscrow.id,
        contractAddress: historicalAddress,
        advertiserWalletAddress: deal.advertiser.walletAddress,
        amountTon: expectedAmount,
      });

      const reason = `Funds detected on previous escrow address ${historicalAddress}. ${refundResult.reason} Use the latest funding transaction.`;
      const expectedOnChainDealId = resolveOnChainDealId(deal.dealNumber, deal.metadata);
      const currentAttempt = currentEscrowMeta.fundingAttempt ?? 0;
      const nextAttempt = Math.min(currentAttempt + 1, MAX_ONCHAIN_ROTATION_ATTEMPTS);
      const nextOnChainDealId = buildRotatedOnChainDealId(deal.dealNumber, nextAttempt);

      const nextEscrowWallet = await createDealEscrow({
        dealId: deal.id,
        dealNumber: deal.dealNumber,
        advertiserAddress: deal.advertiser.walletAddress,
        publisherAddress: deal.channelOwner.walletAddress,
        amount: expectedAmount,
        platformFeeBps: deal.platformFeeBps,
        onChainDealId: nextOnChainDealId.toString(),
      });

      const metadataBase: Prisma.JsonObject = isObjectRecord(deal.metadata)
        ? (deal.metadata as Prisma.JsonObject)
        : {};
      const nextEscrowMeta: Prisma.JsonObject = {
        ...currentEscrowMeta,
        fundingAttempt: nextAttempt,
        onChainDealId: nextOnChainDealId.toString(),
        invalidFirstFundingCount: (currentEscrowMeta.invalidFirstFundingCount ?? 0) + 1,
        lastInvalidAt: new Date().toISOString(),
        lastInvalidReason: reason,
        previousEscrowAddress: deal.escrowWallet.contractAddress,
        historicalEscrowsAcknowledged: [...acknowledgedEscrows, historicalAddress],
        lastRotationTimestamp: Date.now(),
      };
      const nextMetadata: Prisma.InputJsonValue = {
        ...metadataBase,
        escrowValidation: nextEscrowMeta,
      } as Prisma.JsonObject;

      const rotationNote = `[${new Date().toISOString()}] ${reason} Rotated active escrow from ${deal.escrowWallet.contractAddress} to ${nextEscrowWallet.contractAddress}.`;

      await prisma.$transaction([
        prisma.escrowWallet.update({
          where: { id: deal.escrowWallet.id },
          data: { status: 'LOCKED' },
        }),
        prisma.deal.update({
          where: { id: deal.id },
          data: {
            escrowWalletId: nextEscrowWallet.id,
            escrowStatus: 'PENDING',
            metadata: nextMetadata,
            notes: appendSystemNote(deal.notes, rotationNote),
          },
        }),
        prisma.dealEvent.create({
          data: {
            dealId: deal.id,
            type: 'ESCROW_FIRST_FUNDING_INVALID',
            actorType: 'SYSTEM',
            fromStatus: deal.status,
            toStatus: deal.status,
            data: {
              reason,
              staleEscrowAddress: historicalAddress,
              rotatedFromEscrowAddress: deal.escrowWallet.contractAddress,
              nextEscrowAddress: nextEscrowWallet.contractAddress,
              previousOnChainDealId: expectedOnChainDealId.toString(),
              nextOnChainDealId: nextOnChainDealId.toString(),
              refundAttempted: refundResult.attempted,
              refundConfirmed: refundResult.refunded,
              refundReason: refundResult.reason,
              refundTransactionId: refundResult.transactionId,
            },
          },
        }),
      ]);

      return {
        valid: false,
        rotated: true,
        reason,
        previousOnChainDealId: expectedOnChainDealId.toString(),
        nextOnChainDealId: nextOnChainDealId.toString(),
        previousEscrowAddress: historicalAddress,
        nextEscrowAddress: nextEscrowWallet.contractAddress ?? undefined,
      };
    }
  }

  const inboundTransactions = await fetchInboundInternalTransactions(contractAddress, 100);

  if (inboundTransactions.length === 0) {
    return { valid: true, rotated: false };
  }

  const firstInbound = inboundTransactions[0];
  const inMessage = firstInbound.inMessage;
  if (!inMessage || inMessage.info.type !== 'internal') {
    return { valid: true, rotated: false };
  }

  const expectedOnChainDealId = resolveOnChainDealId(deal.dealNumber, deal.metadata);
  const bodySlice = inMessage.body.beginParse();
  const op = bodySlice.remainingBits >= 32 ? Number(bodySlice.loadUint(32)) : null;
  const bodyDealId = bodySlice.remainingBits >= 64 ? bodySlice.loadUintBig(64) : null;

  const senderMatches = inMessage.info.src.equals(advertiserAddress);
  const hasDeployInit = inMessage.init !== null && inMessage.init !== undefined;
  const opMatches = op === FUND_OPCODE;
  const dealIdMatches = bodyDealId !== null && bodyDealId === expectedOnChainDealId;
  const txSucceeded = firstInbound.description.type !== 'generic' || !firstInbound.description.aborted;

  if (senderMatches && hasDeployInit && opMatches && dealIdMatches && txSucceeded) {
    return { valid: true, rotated: false };
  }

  const reason = describeFirstFundingViolation({
    senderMatches,
    hasDeployInit,
    opMatches,
    dealIdMatches,
    txSucceeded,
  });
  
  // Check-only mode: return validation result without rotation
  if (checkOnly) {
    return {
      valid: false,
      rotated: false,
      reason,
      previousOnChainDealId: expectedOnChainDealId.toString(),
      nextOnChainDealId: currentEscrowMeta.onChainDealId || expectedOnChainDealId.toString(),
      previousEscrowAddress: deal.escrowWallet.contractAddress,
      nextEscrowAddress: deal.escrowWallet.contractAddress || undefined,
    };
  }

  const currentAttempt = currentEscrowMeta.fundingAttempt ?? 0;
  const nextAttempt = Math.min(currentAttempt + 1, MAX_ONCHAIN_ROTATION_ATTEMPTS);
  const nextOnChainDealId = buildRotatedOnChainDealId(deal.dealNumber, nextAttempt);

  const expectedAmount = deal.escrowAmount || deal.agreedPrice;
  const nextEscrowWallet = await createDealEscrow({
    dealId: deal.id,
    dealNumber: deal.dealNumber,
    advertiserAddress: deal.advertiser.walletAddress,
    publisherAddress: deal.channelOwner.walletAddress,
    amount: expectedAmount,
    platformFeeBps: deal.platformFeeBps,
    onChainDealId: nextOnChainDealId.toString(),
  });

  const metadataBase: Prisma.JsonObject = isObjectRecord(deal.metadata)
    ? (deal.metadata as Prisma.JsonObject)
    : {};
  const nextEscrowMeta: Prisma.JsonObject = {
    ...currentEscrowMeta,
    fundingAttempt: nextAttempt,
    onChainDealId: nextOnChainDealId.toString(),
    invalidFirstFundingCount: (currentEscrowMeta.invalidFirstFundingCount ?? 0) + 1,
    lastInvalidAt: new Date().toISOString(),
    lastInvalidReason: reason,
    previousEscrowAddress: deal.escrowWallet.contractAddress,
    lastRotationTimestamp: Date.now(),
  };
  const nextMetadata: Prisma.InputJsonValue = {
    ...metadataBase,
    escrowValidation: nextEscrowMeta,
  } as Prisma.JsonObject;

  const rotationNote = `[${new Date().toISOString()}] ${reason}. Rotated escrow from ${deal.escrowWallet.contractAddress} to ${nextEscrowWallet.contractAddress}.`;

  await prisma.$transaction([
    prisma.escrowWallet.update({
      where: { id: deal.escrowWallet.id },
      data: { status: 'LOCKED' },
    }),
    prisma.deal.update({
      where: { id: deal.id },
      data: {
        escrowWalletId: nextEscrowWallet.id,
        escrowStatus: 'PENDING',
        metadata: nextMetadata,
        notes: appendSystemNote(deal.notes, rotationNote),
      },
    }),
    prisma.dealEvent.create({
      data: {
        dealId: deal.id,
        type: 'ESCROW_FIRST_FUNDING_INVALID',
        actorType: 'SYSTEM',
        fromStatus: deal.status,
        toStatus: deal.status,
        data: {
          reason,
          previousEscrowAddress: deal.escrowWallet.contractAddress,
          nextEscrowAddress: nextEscrowWallet.contractAddress,
          previousOnChainDealId: expectedOnChainDealId.toString(),
          nextOnChainDealId: nextOnChainDealId.toString(),
        },
      },
    }),
  ]);

  return {
    valid: false,
    rotated: true,
    reason,
    previousOnChainDealId: expectedOnChainDealId.toString(),
    nextOnChainDealId: nextOnChainDealId.toString(),
    previousEscrowAddress: deal.escrowWallet.contractAddress,
    nextEscrowAddress: nextEscrowWallet.contractAddress ?? undefined,
  };
}

/**
 * Release funds from escrow to publisher (called by platform as arbiter)
 */
export async function releaseFunds(dealId: string): Promise<string | null> {
  // Idempotency check - if release transaction already exists, skip
  const existingTx = await prisma.transaction.findUnique({
    where: { idempotencyKey: `release-${dealId}` },
  });
  
  if (existingTx) {
    console.log(`Release already processed for deal ${dealId}, tx: ${existingTx.id}, status: ${existingTx.status}`);
    return existingTx.id;
  }

  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    include: {
      escrowWallet: true,
      channelOwner: true,
    },
  });

  if (!deal || !deal.escrowWallet) {
    throw new Error('Deal or escrow wallet not found');
  }
  const onChainDealId = resolveOnChainDealId(deal.dealNumber, deal.metadata);

  if (!deal.escrowWallet.contractAddress) {
    throw new Error('No contract address for escrow wallet');
  }

  const contractAddress = Address.parse(deal.escrowWallet.contractAddress);
  const provider = tonService.getContractProvider(contractAddress);
  const contract = DealEscrow.fromAddress(contractAddress);

  // Get contract info for logging
  const contractInfo = await getContractInfo(deal.escrowWallet.contractAddress);
  const platformWallet = await tonService.initPlatformWallet();
  
  console.log(`📤 Releasing funds for deal ${dealId}:`, {
    contractAddress: deal.escrowWallet.contractAddress,
    contractStatus: contractInfo?.status,
    contractBalance: contractInfo?.balance,
    publisherAmount: contractInfo?.publisherAmount,
    platformFee: contractInfo?.platformFee,
    platformWalletSending: platformWallet.contract.address.toString(),
  });

  // Verify contract is in funded state
  const status = await contract.getStatus(provider);
  if (Number(status) !== Number(STATUS_FUNDED)) {
    // If already released, just update DB
    if (Number(status) === Number(STATUS_RELEASED)) {
      console.log(`Contract already RELEASED, updating DB...`);
      await prisma.deal.update({
        where: { id: dealId },
        data: { escrowStatus: 'RELEASED' },
      });
      return null;
    }
    throw new Error(`Cannot release: contract status is ${status}, expected ${STATUS_FUNDED}`);
  }

  // Send Release message from platform wallet (as arbiter)
  const releaseValue = toNano(config.escrow.operationGasTon);
  
  const releaseBody = beginCell()
    .storeUint(2, 32) // Release opcode
    .storeUint(onChainDealId, 64) // dealId
    .endCell();

  const { seqno } = await tonService.sendFromPlatformWallet({
    to: contractAddress,
    value: releaseValue,
    body: releaseBody,
  });

  // Create release transaction record
  const tx = await prisma.transaction.create({
    data: {
      walletId: deal.escrowWallet.id,
      dealId,
      type: 'RELEASE',
      status: 'PENDING',
      amount: deal.publisherAmount || '0',
      fromAddress: deal.escrowWallet.contractAddress,
      toAddress: deal.channelOwner.walletAddress,
      idempotencyKey: `release-${dealId}`,
    },
  });

  // Create platform fee transaction record
  const feeTx = await prisma.transaction.create({
    data: {
      walletId: deal.escrowWallet.id,
      dealId,
      type: 'PLATFORM_FEE',
      status: 'PENDING',
      amount: deal.platformFeeAmount || '0',
      fromAddress: deal.escrowWallet.contractAddress,
      toAddress: config.platformFeeWalletAddress,
      idempotencyKey: `fee-${dealId}`,
    },
  });

  // Wait for confirmation
  const wallet = await tonService.initPlatformWallet();
  const confirmed = await tonService.waitForSeqnoChange(wallet.contract.address, seqno, 60000);

  if (confirmed) {
    // Wait a bit for the blockchain to process
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Verify release was successful
    const newStatus = await contract.getStatus(provider);
    if (Number(newStatus) === Number(STATUS_RELEASED)) {
      await prisma.$transaction([
        prisma.transaction.update({
          where: { id: tx.id },
          data: { status: 'CONFIRMED' },
        }),
        prisma.transaction.update({
          where: { id: feeTx.id },
          data: { status: 'CONFIRMED' },
        }),
        // Update deal escrowStatus to RELEASED
        prisma.deal.update({
          where: { id: dealId },
          data: { escrowStatus: 'RELEASED' },
        }),
      ]);
      
      console.log(`✅ Funds released for deal ${dealId}`);
    } else {
      const reason = `Release sent but contract status is ${newStatus}, expected ${STATUS_RELEASED}`;
      console.warn(`⚠️ ${reason}`);
      await prisma.$transaction([
        prisma.transaction.update({
          where: { id: tx.id },
          data: {
            status: 'FAILED',
            errorMessage: reason,
            retryCount: { increment: 1 },
          },
        }),
        prisma.transaction.update({
          where: { id: feeTx.id },
          data: {
            status: 'FAILED',
            errorMessage: reason,
            retryCount: { increment: 1 },
          },
        }),
      ]);
    }
  } else {
    const reason = 'Release transaction not confirmed (seqno did not change within timeout)';
    console.error(`❌ ${reason} for deal ${dealId}`);
    await prisma.$transaction([
      prisma.transaction.update({
        where: { id: tx.id },
        data: {
          status: 'FAILED',
          errorMessage: reason,
          retryCount: { increment: 1 },
        },
      }),
      prisma.transaction.update({
        where: { id: feeTx.id },
        data: {
          status: 'FAILED',
          errorMessage: reason,
          retryCount: { increment: 1 },
        },
      }),
    ]);
  }

  return tx.id;
}

/**
 * Refund funds from escrow to advertiser (called by platform as arbiter)
 */
export async function refundFunds(dealId: string): Promise<string | null> {
  // Idempotency check - if refund transaction already exists, skip
  const existingTx = await prisma.transaction.findUnique({
    where: { idempotencyKey: `refund-${dealId}` },
  });
  
  if (existingTx) {
    console.log(`Refund already processed for deal ${dealId}, tx: ${existingTx.id}, status: ${existingTx.status}`);
    return existingTx.id;
  }

  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    include: {
      escrowWallet: true,
      advertiser: true,
    },
  });

  if (!deal || !deal.escrowWallet) {
    throw new Error('Deal or escrow wallet not found');
  }
  const onChainDealId = resolveOnChainDealId(deal.dealNumber, deal.metadata);

  const contractAddress = Address.parse(deal.escrowWallet.contractAddress!);
  const provider = tonService.getContractProvider(contractAddress);
  const contract = DealEscrow.fromAddress(contractAddress);

  // Verify contract is in funded or disputed state
  const status = await contract.getStatus(provider);
  if (Number(status) !== Number(STATUS_FUNDED) && Number(status) !== Number(STATUS_DISPUTED)) {
    throw new Error(`Cannot refund: contract status is ${status}`);
  }

  console.log(`Refunding funds for deal ${dealId}...`);

  // Send Refund message from platform wallet (as arbiter)
  const refundValue = toNano(config.escrow.operationGasTon);
  
  const refundBody = beginCell()
    .storeUint(3, 32) // Refund opcode
    .storeUint(onChainDealId, 64) // dealId
    .endCell();

  const { seqno } = await tonService.sendFromPlatformWallet({
    to: contractAddress,
    value: refundValue,
    body: refundBody,
  });

  // Create refund transaction record
  const tx = await prisma.transaction.create({
    data: {
      walletId: deal.escrowWallet.id,
      dealId,
      type: 'REFUND',
      status: 'PENDING',
      amount: deal.escrowAmount || deal.agreedPrice,
      fromAddress: deal.escrowWallet.contractAddress,
      toAddress: deal.advertiser.walletAddress,
      idempotencyKey: `refund-${dealId}`,
    },
  });

  // Wait for confirmation
  const wallet = await tonService.initPlatformWallet();
  const confirmed = await tonService.waitForSeqnoChange(wallet.contract.address, seqno, 60000);

  if (confirmed) {
    // Verify refund was successful
    const newStatus = await contract.getStatus(provider);
    if (Number(newStatus) === Number(STATUS_REFUNDED)) {
      await prisma.$transaction([
        prisma.transaction.update({
          where: { id: tx.id },
          data: { status: 'CONFIRMED' },
        }),
        prisma.escrowWallet.update({
          where: { id: deal.escrowWallet.id },
          data: { status: 'RETIRED' },
        }),
        prisma.deal.update({
          where: { id: deal.id },
          data: {
            escrowStatus: 'REFUNDED',
          },
        }),
      ]);

      await dealService.updateStatus(deal.id, 'REFUNDED', 'SYSTEM', {
        reason: 'Escrow refund confirmed on-chain',
      });
      
      console.log(`Funds refunded for deal ${dealId}`);
    }
  }

  return tx.id;
}

/**
 * Sync escrow wallet state from chain
 */
export async function syncContractState(walletId: string): Promise<{
  status: string;
  balance: string;
  contractInfo: Awaited<ReturnType<typeof getContractInfo>> | null;
}> {
  const wallet = await prisma.escrowWallet.findUnique({
    where: { id: walletId },
    include: { deals: true },
  });

  if (!wallet || !wallet.contractAddress) {
    throw new Error('Wallet not found');
  }

  const contractInfo = await getContractInfo(wallet.contractAddress);
  
  if (!contractInfo) {
    return {
      status: 'NOT_DEPLOYED',
      balance: '0',
      contractInfo: null,
    };
  }

  // Map on-chain status to DB status for return value
  const statusMap: Record<number, string> = {
    0: 'CREATED',
    1: 'FUNDED',
    2: 'RELEASED',
    3: 'REFUNDED',
    4: 'DISPUTED',
  };

  // Map on-chain status to Prisma WalletStatus enum
  let prismaStatus: 'ACTIVE' | 'LOCKED' | 'RETIRED' = 'ACTIVE';
  if (contractInfo.status === 2 || contractInfo.status === 3) {
    // Released or Refunded - wallet is retired
    prismaStatus = 'RETIRED';
  } else if (contractInfo.status === 4) {
    // Disputed - wallet is locked
    prismaStatus = 'LOCKED';
  }

  // Update wallet in DB
  await prisma.escrowWallet.update({
    where: { id: walletId },
    data: {
      cachedBalance: contractInfo.balance,
      lastSyncedAt: new Date(),
      status: prismaStatus,
    },
  });

  const dbStatus = statusMap[contractInfo.status] || 'ACTIVE';

  return {
    status: dbStatus,
    balance: contractInfo.balance,
    contractInfo,
  };
}

/**
 * Sync escrow wallet balance from chain (legacy function)
 */
export async function syncWalletBalance(walletId: string): Promise<string> {
  const result = await syncContractState(walletId);
  return result.balance;
}

export const escrowService = {
  createDealEscrow,
  deployEscrowContract,
  getEscrowFundingTransaction,
  validateAndRotateFirstFundingTransaction,
  getContractInfo,
  verifyFunding,
  releaseFunds,
  refundFunds,
  syncContractState,
  syncWalletBalance,
};
