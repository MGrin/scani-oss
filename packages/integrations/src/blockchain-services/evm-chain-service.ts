/**
 * EVM Chain Service
 * Handles balance fetching for EVM-compatible chains using Etherscan V2 unified API
 *
 * Uses the unified Etherscan V2 endpoint: https://api.etherscan.io/v2/api
 * with chainid parameter to specify which chain to query
 */

import { createComponentLogger } from '@scani/logging';
import { fetchWithTimeout } from '@scani/pricing-providers/utils';
import Decimal from 'decimal.js';
import type { ChainConfig } from './chain-config';
import type { BlockchainServiceConfig, IBlockchainService, TokenBalance } from './types';

const logger = createComponentLogger('evm-chain-service');

/**
 * Check if token is likely spam based on name/symbol patterns
 *
 * IMPORTANT: EVM chain tokens are filtered for spam to prevent importing scam tokens.
 * This function checks for common spam indicators including:
 * - URLs and domain names in token name/symbol
 * - Scam keywords (claim, visit, reward, airdrop, etc.)
 * - Telegram references
 * - HTML/code injection attempts
 *
 * Spam tokens are ignored and not imported into user portfolios.
 *
 * @param token - Token with name and symbol to check
 * @returns true if token appears to be spam, false otherwise
 */
function isLikelySpamToken(token: { name: string; symbol: string }): boolean {
  const suspiciousPatterns = [
    /https?:\/\//i, // Contains URL
    /www\./i, // Contains www.
    /\.com|\.xyz|\.cc|\.io|\.app|\.eu|\.org/i, // Domain extensions
    /claim|visit|reward|bonus|airdrop/i, // Scam keywords
    /^\$/, // Starts with $
    /t\.me|telegram/i, // Telegram references
    /swap.*on|claim.*on/i, // "Swap on" or "Claim on" patterns
    /<|>|\{|\}|\[|\]/i, // HTML/code injection attempts
  ];

  const nameMatch = suspiciousPatterns.some((pattern) => pattern.test(token.name));
  const symbolMatch = suspiciousPatterns.some((pattern) => pattern.test(token.symbol));

  return nameMatch || symbolMatch;
}

/**
 * Compute the ENS namehash for a domain name (EIP-137).
 */
function namehash(name: string): string {
  let node = keccak256Hex(''); // Start with 32 zero bytes
  node = '0'.repeat(64); // namehash('') = 0x00...00

  if (name) {
    const labels = name.split('.');
    for (let i = labels.length - 1; i >= 0; i--) {
      const label = labels[i]!;
      const labelHash = keccak256Hex(label);
      node = keccak256HexConcat(node, labelHash);
    }
  }

  return node;
}

/**
 * Keccak256 hash of a UTF-8 string, returning hex.
 */
function keccak256Hex(data: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { keccak_256 } = require('@noble/hashes/sha3') as {
    keccak_256: (data: Uint8Array) => Uint8Array;
  };
  return Buffer.from(keccak_256(new TextEncoder().encode(data))).toString('hex');
}

/**
 * Keccak256 hash of two concatenated hex strings.
 */
function keccak256HexConcat(a: string, b: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { keccak_256 } = require('@noble/hashes/sha3') as {
    keccak_256: (data: Uint8Array) => Uint8Array;
  };
  return Buffer.from(keccak_256(Buffer.from(a + b, 'hex'))).toString('hex');
}

/**
 * Decode an ABI-encoded string from an eth_call result.
 */
function decodeAbiString(hex: string): string | null {
  try {
    // Remove 0x prefix
    const data = hex.startsWith('0x') ? hex.slice(2) : hex;
    if (data.length < 128) return null;

    // First 32 bytes: offset to string data
    // Next 32 bytes: string length
    const length = parseInt(data.slice(64, 128), 16);
    if (length === 0 || length > 1000) return null;

    // Following bytes: string content
    const strHex = data.slice(128, 128 + length * 2);
    return Buffer.from(strHex, 'hex').toString('utf8');
  } catch {
    return null;
  }
}

interface EtherscanResponse<T> {
  status: string;
  message: string;
  result: T;
}

interface EtherscanTransaction {
  blockNumber: string;
  timeStamp: string;
  hash: string;
  from: string;
  to: string;
  value: string;
  [key: string]: unknown;
}

/**
 * EVM Chain Service using Etherscan V2 unified API
 */
export class EvmChainService implements IBlockchainService {
  private readonly chainConfig: ChainConfig;
  private readonly apiKey: string;
  private readonly rateLimiter?: BlockchainServiceConfig['rateLimiter'];

  constructor(chainConfig: ChainConfig, config: BlockchainServiceConfig) {
    this.chainConfig = chainConfig;
    this.apiKey = config.apiKey || '';
    this.rateLimiter = config.rateLimiter;

    if (!chainConfig.explorerApiUrl) {
      logger.warn(
        { chainId: chainConfig.chainId, chainName: chainConfig.name },
        'Chain has no explorerApiUrl configured'
      );
    }
  }

  getChainId(): string | number {
    return this.chainConfig.chainId;
  }

  getChainName(): string {
    return this.chainConfig.name;
  }

  /**
   * Build Etherscan V2 API URL with chainid parameter
   * The unified endpoint requires chainid for all requests
   */
  private buildApiUrl(params: Record<string, string | number>): string {
    if (!this.chainConfig.explorerApiUrl) {
      throw new Error(`No explorerApiUrl configured for chain ${this.chainConfig.name}`);
    }

    const urlParams = new URLSearchParams();

    // Add chainid parameter for Etherscan V2 unified API
    urlParams.append('chainid', this.chainConfig.chainId.toString());

    // Add all other parameters
    for (const [key, value] of Object.entries(params)) {
      urlParams.append(key, value.toString());
    }

    // Add API key
    urlParams.append('apikey', this.apiKey);

    return `${this.chainConfig.explorerApiUrl}?${urlParams.toString()}`;
  }

  /**
   * Check if address is valid EVM address (0x + 40 hex chars)
   */
  isValidAddress(address: string): boolean {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
  }

  /**
   * Get all token balances for an address including native token
   */
  async getTokenBalances(address: string): Promise<TokenBalance[]> {
    if (!this.isValidAddress(address)) {
      throw new Error(`Invalid EVM address: ${address}`);
    }

    if (!this.chainConfig.explorerApiUrl) {
      logger.warn(
        { chainId: this.chainConfig.chainId, address },
        'Cannot fetch balances: no explorer API URL configured'
      );
      return [];
    }

    const balances: TokenBalance[] = [];

    try {
      // Fetch native token balance and ERC-20 token balances in parallel
      const [nativeBalance, erc20Balances] = await Promise.all([
        this.getNativeBalance(address),
        this.getERC20Balances(address),
      ]);

      // Add native token if balance > 0
      if (nativeBalance && new Decimal(nativeBalance.balance).greaterThan(0)) {
        balances.push(nativeBalance);
      }

      // Add ERC-20 tokens with balance > 0
      for (const token of erc20Balances) {
        if (new Decimal(token.balance).greaterThan(0)) {
          balances.push(token);
        }
      }

      logger.debug(
        {
          chainId: this.chainConfig.chainId,
          chainName: this.chainConfig.name,
          address,
          totalTokens: balances.length,
        },
        `Fetched token balances on ${this.chainConfig.name}`
      );

      return balances;
    } catch (error) {
      logger.error(
        {
          chainId: this.chainConfig.chainId,
          chainName: this.chainConfig.name,
          address,
          explorerUrl: this.chainConfig.explorerApiUrl,
          error:
            error instanceof Error
              ? { name: error.name, message: error.message }
              : { name: 'Error', message: String(error) },
        },
        `Failed to fetch token balances on ${this.chainConfig.name}: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }

  /**
   * Get native token (ETH, BNB, etc.) balance
   */
  private async getNativeBalance(address: string): Promise<TokenBalance | null> {
    const url = this.buildApiUrl({
      module: 'account',
      action: 'balance',
      address: address,
      tag: 'latest',
    });

    const fetchBalance = async () => {
      const response = await fetchWithTimeout(url);

      if (!response.ok) {
        throw new Error(`Etherscan API error: ${response.statusText}`);
      }

      const data = (await response.json()) as EtherscanResponse<string>;

      if (data.status !== '1') {
        // Status '0' is not always an error - could be zero balance
        if (data.message === 'NOTOK') {
          throw new Error(`Etherscan API error: ${data.result}`);
        }
        // Return null for zero balance or no transactions
        return null;
      }

      // Convert from wei to token units (18 decimals for most native tokens)
      const balanceWei = new Decimal(data.result);
      const balance = balanceWei.dividedBy(new Decimal(10).pow(18));

      if (balance.isZero()) {
        return null;
      }

      return {
        tokenAddress: 'native',
        symbol: this.chainConfig.nativeSymbol,
        name: this.chainConfig.nativeName,
        balance: balance.toString(),
        decimals: 18,
        isNative: true,
      };
    };

    if (this.rateLimiter) {
      return this.rateLimiter.execute(fetchBalance);
    }
    return fetchBalance();
  }

  /**
   * Get all ERC-20 token balances
   */
  private async getERC20Balances(address: string): Promise<TokenBalance[]> {
    const url = this.buildApiUrl({
      module: 'account',
      action: 'tokentx',
      address: address,
      page: '1',
      offset: '10000',
      sort: 'desc',
    });

    const fetchBalances = async () => {
      const response = await fetchWithTimeout(url);

      if (!response.ok) {
        throw new Error(`Etherscan API error: ${response.statusText}`);
      }

      const data = (await response.json()) as EtherscanResponse<
        Array<{
          contractAddress: string;
          tokenName: string;
          tokenSymbol: string;
          tokenDecimal: string;
        }>
      >;

      if (data.status !== '1') {
        // No transactions is not an error
        if (data.message === 'No transactions found') {
          return [];
        }
        throw new Error(`Etherscan API error: ${data.result}`);
      }

      // Get unique token contracts from transactions
      const uniqueTokens = new Map<string, { name: string; symbol: string; decimals: number }>();

      for (const tx of data.result) {
        const contractAddress = tx.contractAddress.toLowerCase();
        if (!uniqueTokens.has(contractAddress)) {
          const tokenInfo = {
            name: tx.tokenName,
            symbol: tx.tokenSymbol,
            decimals: Number.parseInt(tx.tokenDecimal, 10),
          };

          // IMPORTANT: Filter out likely spam tokens to prevent importing scam/malicious tokens
          // This protects users from having spam tokens in their portfolios
          if (isLikelySpamToken(tokenInfo)) {
            logger.debug(
              {
                contractAddress,
                name: tokenInfo.name,
                symbol: tokenInfo.symbol,
              },
              'Filtered out likely spam token'
            );
            continue;
          }

          uniqueTokens.set(contractAddress, tokenInfo);
        }
      }

      // Fetch current balance for each token
      const balancePromises = Array.from(uniqueTokens.entries()).map(
        async ([contractAddress, tokenInfo]) => {
          try {
            const balanceRaw = await this.getTokenBalance(address, contractAddress);
            if (balanceRaw && new Decimal(balanceRaw).greaterThan(0)) {
              // Convert from raw balance to token units using decimals
              const balance = new Decimal(balanceRaw).dividedBy(
                new Decimal(10).pow(tokenInfo.decimals)
              );

              return {
                tokenAddress: contractAddress,
                symbol: tokenInfo.symbol,
                name: tokenInfo.name,
                balance: balance.toString(),
                decimals: tokenInfo.decimals,
                isNative: false,
                metadata: {
                  chainId: this.chainConfig.chainId,
                },
              } satisfies TokenBalance;
            }
            return null;
          } catch (error) {
            logger.warn(
              {
                contractAddress,
                error:
                  error instanceof Error
                    ? { name: error.name, message: error.message }
                    : { name: 'Error', message: String(error) },
              },
              'Failed to fetch token balance'
            );
            return null;
          }
        }
      );

      const results = await Promise.all(balancePromises);
      return results.filter((b) => b !== null) as TokenBalance[];
    };

    if (this.rateLimiter) {
      return this.rateLimiter.execute(fetchBalances);
    }
    return fetchBalances();
  }

  /**
   * Get balance for a specific ERC-20 token
   */
  private async getTokenBalance(address: string, contractAddress: string): Promise<string | null> {
    const url = this.buildApiUrl({
      module: 'account',
      action: 'tokenbalance',
      contractaddress: contractAddress,
      address: address,
      tag: 'latest',
    });

    const fetchBalance = async () => {
      const response = await fetchWithTimeout(url);

      if (!response.ok) {
        throw new Error(`Etherscan API error: ${response.statusText}`);
      }

      const data = (await response.json()) as EtherscanResponse<string>;

      if (data.status !== '1') {
        return null;
      }

      const balanceRaw = new Decimal(data.result);
      if (balanceRaw.isZero()) {
        return null;
      }

      return balanceRaw.toString();
    };

    if (this.rateLimiter) {
      return this.rateLimiter.execute(fetchBalance);
    }
    return fetchBalance();
  }

  /**
   * Check if wallet has any activity on this chain
   * Checks normal transactions, internal transactions, and token transactions in parallel
   * Returns true if any transaction history exists
   */
  async hasActivity(address: string): Promise<boolean> {
    if (!this.isValidAddress(address)) {
      return false;
    }

    if (!this.chainConfig.explorerApiUrl) {
      logger.debug(
        { chainId: this.chainConfig.chainId, address },
        'Cannot check activity: no explorer API URL configured'
      );
      return false;
    }

    try {
      // Check all transaction types in parallel for better performance
      const [hasNormalTx, hasInternalTx, hasTokenTx] = await Promise.all([
        this.hasNormalTransactions(address),
        this.hasInternalTransactions(address),
        this.hasTokenTransactions(address),
      ]);

      const hasActivity = hasNormalTx || hasInternalTx || hasTokenTx;

      if (hasActivity) {
        logger.debug(
          {
            chainId: this.chainConfig.chainId,
            address: `${address.substring(0, 10)}...`,
            hasNormalTx,
            hasInternalTx,
            hasTokenTx,
          },
          'Wallet has activity on chain'
        );
      } else {
        logger.debug(
          { chainId: this.chainConfig.chainId, address: `${address.substring(0, 10)}...` },
          'Wallet has no activity on this chain'
        );
      }

      return hasActivity;
    } catch (error) {
      logger.debug(
        {
          chainId: this.chainConfig.chainId,
          chainName: this.chainConfig.name,
          address: `${address.substring(0, 10)}...`,
          url: this.chainConfig.explorerApiUrl,
          error:
            error instanceof Error
              ? { name: error.name, message: error.message }
              : { name: 'Error', message: String(error) },
        },
        `Error checking wallet activity on ${this.chainConfig.name}: ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
  }

  /**
   * Check if address has normal transactions
   */
  private async hasNormalTransactions(address: string): Promise<boolean> {
    return this.hasTransactionsByAction(address, 'txlist');
  }

  /**
   * Check if address has internal transactions
   */
  private async hasInternalTransactions(address: string): Promise<boolean> {
    return this.hasTransactionsByAction(address, 'txlistinternal');
  }

  /**
   * Check if address has token transactions (ERC-20)
   */
  private async hasTokenTransactions(address: string): Promise<boolean> {
    return this.hasTransactionsByAction(address, 'tokentx');
  }

  /**
   * Generic method to check if address has transactions for a specific action
   */
  private async hasTransactionsByAction(
    address: string,
    action: 'txlist' | 'txlistinternal' | 'tokentx'
  ): Promise<boolean> {
    const url = this.buildApiUrl({
      module: 'account',
      action: action,
      address: address,
      page: '1',
      offset: '1',
      sort: 'desc',
    });

    const checkTransactions = async () => {
      try {
        const response = await fetchWithTimeout(url);

        if (!response.ok) {
          logger.debug(
            {
              chainId: this.chainConfig.chainId,
              chainName: this.chainConfig.name,
              action,
              status: response.status,
              statusText: response.statusText,
              url: this.chainConfig.explorerApiUrl,
            },
            `HTTP error while checking transactions on ${this.chainConfig.name}`
          );
          return false;
        }

        const data = (await response.json()) as EtherscanResponse<EtherscanTransaction[]>;

        // Status '1' means success and transactions found
        if (data.status === '1' && Array.isArray(data.result) && data.result.length > 0) {
          return true;
        }

        return false;
      } catch (error) {
        logger.debug(
          {
            chainId: this.chainConfig.chainId,
            chainName: this.chainConfig.name,
            action,
            url: this.chainConfig.explorerApiUrl,
            error:
              error instanceof Error
                ? { name: error.name, message: error.message }
                : { name: 'Error', message: String(error) },
          },
          `Error checking transactions on ${this.chainConfig.name}: ${error instanceof Error ? error.message : String(error)}`
        );
        return false;
      }
    };

    if (this.rateLimiter) {
      return this.rateLimiter.execute(checkTransactions);
    }
    return checkTransactions();
  }

  /**
   * Resolve ENS name for Ethereum mainnet using raw JSON-RPC calls.
   * Performs reverse resolution: address -> ENS name.
   */
  async resolveAddressName(address: string): Promise<string | null> {
    // ENS only works on Ethereum mainnet
    if (this.chainConfig.chainId !== 1) {
      return null;
    }

    if (!this.isValidAddress(address)) {
      return null;
    }

    const resolveEns = async (): Promise<string | null> => {
      try {
        // ENS reverse resolution: call the reverse registrar
        // The reverse node for an address is <address-without-0x>.addr.reverse
        const addrLower = address.toLowerCase().slice(2);
        const reverseNode = `${addrLower}.addr.reverse`;

        // namehash the reverse node
        const node = namehash(reverseNode);

        // Call the ENS Universal Resolver's reverse() or use the name() function
        // on the reverse registrar. We use eth_call to the ENS registry to get
        // the resolver, then call name() on it.
        const ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e';
        // resolver(bytes32) selector = 0x0178b8bf
        const resolverCalldata = `0x0178b8bf${node}`;

        const resolverResponse = await fetchWithTimeout('https://eth.llamarpc.com', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'eth_call',
            params: [{ to: ENS_REGISTRY, data: resolverCalldata }, 'latest'],
          }),
        });

        const resolverData = (await resolverResponse.json()) as { result?: string };
        if (!resolverData.result || resolverData.result === `0x${'0'.repeat(64)}`) {
          return null;
        }

        const resolverAddr = `0x${resolverData.result.slice(26)}`;
        if (resolverAddr === `0x${'0'.repeat(40)}`) return null;

        // Call name(bytes32) on the resolver. Selector = 0x691f3431
        const nameCalldata = `0x691f3431${node}`;

        const nameResponse = await fetchWithTimeout('https://eth.llamarpc.com', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'eth_call',
            params: [{ to: resolverAddr, data: nameCalldata }, 'latest'],
          }),
        });

        const nameData = (await nameResponse.json()) as { result?: string };
        if (!nameData.result || nameData.result.length <= 2) return null;

        // Decode the ABI-encoded string response
        const ensName = decodeAbiString(nameData.result);
        if (ensName) {
          logger.debug({ address: `${address.substring(0, 10)}...`, ensName }, 'ENS name resolved');
        }
        return ensName;
      } catch (error) {
        logger.debug(
          {
            address: `${address.substring(0, 10)}...`,
            error: error instanceof Error ? error.message : String(error),
          },
          'ENS lookup failed'
        );
        return null;
      }
    };

    try {
      if (this.rateLimiter) {
        return this.rateLimiter.execute(resolveEns);
      }
      return resolveEns();
    } catch (error) {
      logger.debug({ address, error }, 'Failed to resolve ENS name');
      return null;
    }
  }
}
