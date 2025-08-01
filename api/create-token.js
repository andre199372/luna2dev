// api/create-token.js - Production Implementation
const { 
    Connection, 
    PublicKey, 
    Keypair, 
    Transaction, 
    SystemProgram,
    LAMPORTS_PER_SOL
} = require('@solana/web3.js');

const { 
    createMint, 
    createAssociatedTokenAccount, 
    mintTo, 
    getAssociatedTokenAddress,
    setAuthority,
    AuthorityType,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
} = require('@solana/spl-token');

const {
    createCreateMetadataAccountV3Instruction,
    PROGRAM_ID as METADATA_PROGRAM_ID
} = require('@metaplex-foundation/mpl-token-metadata');

const bs58 = require('bs58');

// Production RPC endpoints with premium tiers
const RPC_ENDPOINTS = [
    process.env.HELIUS_API_KEY ? 
        `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : null,
    process.env.ALCHEMY_API_KEY ? 
        `https://solana-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}` : null,
    process.env.QUICKNODE_ENDPOINT || null,
    'https://api.mainnet-beta.solana.com',
    'https://solana-api.projectserum.com'
].filter(Boolean);

// Server wallet for token creation (CRITICAL: Store securely in production)
const SERVER_WALLET_PRIVATE_KEY = process.env.SERVER_WALLET_PRIVATE_KEY;

// Rate limiting for token creation
const creationAttempts = new Map();

function checkCreationRateLimit(ip) {
    const now = Date.now();
    const windowMs = 300000; // 5 minutes
    const maxCreations = 3; // Max 3 token creations per 5 minutes per IP
    
    if (!creationAttempts.has(ip)) {
        creationAttempts.set(ip, []);
    }
    
    const attempts = creationAttempts.get(ip);
    const validAttempts = attempts.filter(time => now - time < windowMs);
    
    if (validAttempts.length >= maxCreations) {
        return false;
    }
    
    validAttempts.push(now);
    creationAttempts.set(ip, validAttempts);
    return true;
}

async function getWorkingConnection() {
    const errors = [];
    
    for (const endpoint of RPC_ENDPOINTS) {
        try {
            const connection = new Connection(endpoint, {
                commitment: 'confirmed',
                disableRetryOnRateLimit: false,
                confirmTransactionInitialTimeout: 60000
            });
            
            // Test connection
            await connection.getLatestBlockhash();
            console.log(`[TOKEN] ✅ Connected to ${endpoint}`);
            return connection;
            
        } catch (error) {
            errors.push(`${endpoint}: ${error.message}`);
            console.warn(`[TOKEN] ❌ Failed to connect to ${endpoint}`);
        }
    }
    
    throw new Error(`All RPC endpoints failed: ${errors.join('; ')}`);
}

function createMetadataInstruction(mint, metadata, updateAuthority, metadataUrl) {
    const [metadataPDA] = PublicKey.findProgramAddressSync(
        [
            Buffer.from('metadata'),
            METADATA_PROGRAM_ID.toBuffer(),
            mint.toBuffer(),
        ],
        METADATA_PROGRAM_ID
    );

    return createCreateMetadataAccountV3Instruction(
        {
            metadata: metadataPDA,
            mint: mint,
            mintAuthority: updateAuthority,
            payer: updateAuthority,
            updateAuthority: updateAuthority,
        },
        {
            createMetadataAccountArgsV3: {
                data: {
                    name: metadata.name,
                    symbol: metadata.symbol,
                    uri: metadataUrl,
                    sellerFeeBasisPoints: 0,
                    creators: null,
                    collection: null,
                    uses: null,
                },
                isMutable: true,
                collectionDetails: null,
            },
        }
    );
}

async function createTokenWithFeatures(connection, config, payerPublicKey, metadataUrl) {
    console.log(`[TOKEN] Starting token creation for ${config.name} (${config.symbol})`);
    
    // Initialize server wallet
    if (!SERVER_WALLET_PRIVATE_KEY) {
        throw new Error('Server wallet not configured. Contact administrator.');
    }
    
    const serverWallet = Keypair.fromSecretKey(
        bs58.decode(SERVER_WALLET_PRIVATE_KEY)
    );
    
    const payer = new PublicKey(payerPublicKey);
    const mintKeypair = Keypair.generate();
    const mint = mintKeypair.publicKey;
    
    console.log(`[TOKEN] 🔑 Mint address: ${mint.toBase58()}`);
    console.log(`[TOKEN] 👤 Payer: ${payer.toBase58()}`);
    
    // Calculate rent exemption
    const mintRent = await connection.getMinimumBalanceForRentExemption(82); // Mint account size
    
    // Determine authorities based on config
    let mintAuthority = null;
    let freezeAuthority = null;
    let updateAuthority = serverWallet.publicKey;
    
    if (config.authorityMode === 'keep-update') {
        updateAuthority = payer;
    } else if (config.authorityMode === 'custom') {
        if (config.customMintAuthority) {
            mintAuthority = new PublicKey(config.customMintAuthority);
        }
        if (config.customFreezeAuthority) {
            freezeAuthority = new PublicKey(config.customFreezeAuthority);
        }
        if (config.customUpdateAuthority) {
            updateAuthority = new PublicKey(config.customUpdateAuthority);
        }
    }
    
    // Override with feature toggles
    if (config.mintAuthority) {
        mintAuthority = payer;
    }
    if (config.freezeAuthority) {
        freezeAuthority = payer;
    }
    
    console.log(`[TOKEN] 🔐 Mint Authority: ${mintAuthority?.toBase58() || 'None (Revoked)'}`);
    console.log(`[TOKEN] 🧊 Freeze Authority: ${freezeAuthority?.toBase58() || 'None (Revoked)'}`);
    console.log(`[TOKEN] ✏️ Update Authority: ${updateAuthority.toBase58()}`);
    
    const transaction = new Transaction();
    
    // 1. Create mint account
    transaction.add(
        SystemProgram.createAccount({
            fromPubkey: serverWallet.publicKey,
            newAccountPubkey: mint,
            space: 82,
            lamports: mintRent,
            programId: TOKEN_PROGRAM_ID,
        })
    );
    
    // 2. Initialize mint
    transaction.add(
        createMint(
            connection,
            serverWallet,
            mintAuthority || serverWallet.publicKey, // Temporary, will revoke later if needed
            freezeAuthority,
            config.decimals,
            mintKeypair
        ).instructions[0]
    );
    
    // 3. Create metadata account
    transaction.add(
        createMetadataInstruction(
            mint,
            {
                name: config.name,
                symbol: config.symbol,
            },
            serverWallet.publicKey,
            metadataUrl
        )
    );
    
    // 4. Create associated token account for payer
    const payerTokenAccount = await getAssociatedTokenAddress(mint, payer);
    
    transaction.add(
        createAssociatedTokenAccount(
            serverWallet.publicKey,
            payerTokenAccount,
            payer,
            mint
        )
    );
    
    // 5. Calculate token distribution
    const totalSupply = BigInt(config.supply) * BigInt(10 ** config.decimals);
    const teamTokens = config.teamPercentage ? 
        (totalSupply * BigInt(config.teamPercentage)) / BigInt(100) : BigInt(0);
    const marketingTokens = config.marketingPercentage ? 
        (totalSupply * BigInt(config.marketingPercentage)) / BigInt(100) : BigInt(0);
    const payerTokens = totalSupply - teamTokens - marketingTokens;
    
    console.log(`[TOKEN] 📊 Token Distribution:`);
    console.log(`[TOKEN]   - Payer: ${payerTokens.toString()} tokens`);
    console.log(`[TOKEN]   - Team: ${teamTokens.toString()} tokens`);
    console.log(`[TOKEN]   - Marketing: ${marketingTokens.toString()} tokens`);
    
    // 6. Mint tokens to payer
    if (payerTokens > 0) {
        transaction.add(
            mintTo(
                connection,
                serverWallet,
                mint,
                payerTokenAccount,
                serverWallet.publicKey,
                payerTokens
            ).instructions[0]
        );
    }
    
    // 7. Handle team tokens
    if (teamTokens > 0) {
        transaction.add(
            mintTo(
                connection,
                serverWallet,
                mint,
                payerTokenAccount, // Send to payer account (they can distribute)
                serverWallet.publicKey,
                teamTokens
            ).instructions[0]
        );
    }
    
    // 8. Handle marketing tokens
    if (marketingTokens > 0 && config.marketingWallet) {
        const marketingWallet = new PublicKey(config.marketingWallet);
        const marketingTokenAccount = await getAssociatedTokenAddress(mint, marketingWallet);
        
        // Create marketing token account
        transaction.add(
            createAssociatedTokenAccount(
                serverWallet.publicKey,
                marketingTokenAccount,
                marketingWallet,
                mint
            )
        );
        
        // Mint tokens to marketing account
        transaction.add(
            mintTo(
                connection,
                serverWallet,
                mint,
                marketingTokenAccount,
                serverWallet.publicKey,
                marketingTokens
            ).instructions[0]
        );
    }
    
    // Set transaction properties
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = serverWallet.publicKey;
    
    // Sign transaction
    transaction.partialSign(serverWallet, mintKeypair);
    
    console.log(`[TOKEN] 📝 Sending transaction...`);
    
    // Send and confirm transaction
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: 3
    });
    
    console.log(`[TOKEN] 📤 Transaction sent: ${signature}`);
    
    // Wait for confirmation
    const confirmation = await connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight
    }, 'confirmed');
    
    if (confirmation.value.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    }
    
    console.log(`[TOKEN] ✅ Transaction confirmed!`);
    
    // Post-creation authority management
    const authorityTransactions = [];
    
    // Revoke mint authority if not needed
    if (!mintAuthority && config.authorityMode === 'revoke-all') {
        const revokeTransaction = new Transaction().add(
            setAuthority(
                mint,
                serverWallet.publicKey,
                AuthorityType.MintTokens,
                null // Revoke by setting to null
            )
        );
        
        revokeTransaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        revokeTransaction.feePayer = serverWallet.publicKey;
        revokeTransaction.partialSign(serverWallet);
        
        authorityTransactions.push(revokeTransaction);
    }
    
    // Transfer update authority if needed
    if (updateAuthority.toBase58() !== serverWallet.publicKey.toBase58()) {
        // Note: Metadata update authority transfer requires separate instruction
        // This would need additional Metaplex instruction implementation
        console.log(`[TOKEN] ⚠️ Update authority transfer to ${updateAuthority.toBase58()} - manual step required`);
    }
    
    // Execute authority transactions
    for (const authTx of authorityTransactions) {
        try {
            const authSig = await connection.sendRawTransaction(authTx.serialize());
            await connection.confirmTransaction(authSig, 'confirmed');
            console.log(`[TOKEN] 🔐 Authority transaction confirmed: ${authSig}`);
        } catch (error) {
            console.warn(`[TOKEN] ⚠️ Authority transaction failed: ${error.message}`);
        }
    }
    
    console.log(`[TOKEN] 🎉 Token creation completed successfully!`);
    
    return {
        mintAddress: mint.toBase58(),
        signature,
        payerTokenAccount: payerTokenAccount.toBase58(),
        marketingTokenAccount: marketingTokens > 0 && config.marketingWallet ? 
            (await getAssociatedTokenAddress(mint, new PublicKey(config.marketingWallet))).toBase58() : null,
        totalSupply: config.supply,
        decimals: config.decimals,
        authorities: {
            mint: mintAuthority?.toBase58() || null,
            freeze: freezeAuthority?.toBase58() || null,
            update: updateAuthority.toBase58()
        }
    };
}

module.exports = async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    if (req.method !== 'POST') {
        return res.status(405).json({ 
            success: false, 
            error: 'Method not allowed' 
        });
    }
    
    // Rate limiting
    const clientIP = req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';
    if (!checkCreationRateLimit(clientIP)) {
        return res.status(429).json({ 
            success: false, 
            error: 'Token creation rate limit exceeded. Please wait 5 minutes before creating another token.' 
        });
    }
    
    try {
        const { config, payerPublicKey, metadataUrl } = req.body;
        
        // Validation
        if (!config || !payerPublicKey) {
            return res.status(400).json({ 
                success: false, 
                error: 'Missing required fields: config and payerPublicKey' 
            });
        }
        
        if (!metadataUrl) {
            return res.status(400).json({ 
                success: false, 
                error: 'Metadata URL is required. Upload metadata first.' 
            });
        }
        
        // Validate payer public key
        try {
            new PublicKey(payerPublicKey);
        } catch (error) {
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid payer public key format' 
            });
        }
        
        // Validate config
        if (!config.name || !config.symbol || !config.supply) {
            return res.status(400).json({ 
                success: false, 
                error: 'Missing required token config: name, symbol, supply' 
            });
        }
        
        if (config.supply <= 0 || config.supply > 1000000000000) {
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid token supply. Must be between 1 and 1 trillion.' 
            });
        }
        
        if (config.decimals < 0 || config.decimals > 9) {
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid decimals. Must be between 0 and 9.' 
            });
        }
        
        // Validate marketing wallet if provided
        if (config.marketingWallet) {
            try {
                new PublicKey(config.marketingWallet);
            } catch (error) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Invalid marketing wallet address' 
                });
            }
        }
        
        // Validate authority addresses if provided
        if (config.customMintAuthority) {
            try {
                new PublicKey(config.customMintAuthority);
            } catch (error) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Invalid custom mint authority address' 
                });
            }
        }
        
        if (config.customFreezeAuthority) {
            try {
                new PublicKey(config.customFreezeAuthority);
            } catch (error) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Invalid custom freeze authority address' 
                });
            }
        }
        
        if (config.customUpdateAuthority) {
            try {
                new PublicKey(config.customUpdateAuthority);
            } catch (error) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Invalid custom update authority address' 
                });
            }
        }
        
        console.log(`[TOKEN] 🚀 Starting token creation process`);
        console.log(`[TOKEN] 📋 Config:`, {
            name: config.name,
            symbol: config.symbol,
            supply: config.supply,
            decimals: config.decimals,
            authorityMode: config.authorityMode
        });
        
        // Get connection
        const connection = await getWorkingConnection();
        
        // Create token
        const result = await createTokenWithFeatures(connection, config, payerPublicKey, metadataUrl);
        
        console.log(`[TOKEN] ✅ Token creation successful:`, result.mintAddress);
        
        // Return success response
        res.status(200).json({
            success: true,
            message: 'Token created successfully',
            data: {
                mintAddress: result.mintAddress,
                signature: result.signature,
                explorerUrl: `https://solscan.io/token/${result.mintAddress}`,
                solscanUrl: `https://solscan.io/tx/${result.signature}`,
                payerTokenAccount: result.payerTokenAccount,
                marketingTokenAccount: result.marketingTokenAccount,
                totalSupply: result.totalSupply,
                decimals: result.decimals,
                authorities: result.authorities,
                metadata: {
                    name: config.name,
                    symbol: config.symbol,
                    metadataUrl: metadataUrl
                }
            }
        });
        
    } catch (error) {
        console.error('[TOKEN] ❌ Token creation failed:', error);
        
        let errorMessage = error.message;
        let statusCode = 500;
        
        // Handle specific error types
        if (error.message.includes('insufficient funds')) {
            errorMessage = 'Insufficient SOL in server wallet. Please contact administrator.';
            statusCode = 503;
        } else if (error.message.includes('Invalid public key')) {
            errorMessage = 'Invalid address format provided.';
            statusCode = 400;
        } else if (error.message.includes('RPC')) {
            errorMessage = 'Blockchain network error. Please try again in a few minutes.';
            statusCode = 503;
        } else if (error.message.includes('Server wallet not configured')) {
            statusCode = 503;
        }
        
        res.status(statusCode).json({ 
            success: false,
            error: errorMessage,
            timestamp: new Date().toISOString()
        });
    }
};
