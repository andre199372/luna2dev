// api/create-token.js - Versione compatibile con Metaplex v2.x
const { 
    Connection, 
    PublicKey, 
    Keypair, 
    Transaction, 
    SystemProgram,
    LAMPORTS_PER_SOL
} = require('@solana/web3.js');

const { 
    createInitializeMintInstruction,
    createAssociatedTokenAccountInstruction,
    createMintToInstruction,
    createSetAuthorityInstruction,
    getAssociatedTokenAddress,
    AuthorityType,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
} = require('@solana/spl-token');

// Import Metaplex v2.x (versione stabile)
const {
    createCreateMetadataAccountV3Instruction,
    PROGRAM_ID: METADATA_PROGRAM_ID
} = require('@metaplex-foundation/mpl-token-metadata');

const bs58 = require('bs58');

console.log('[TOKEN] 🔍 Metaplex PROGRAM_ID:', METADATA_PROGRAM_ID?.toString());

// RPC endpoints di produzione
const RPC_ENDPOINTS = [
    process.env.HELIUS_API_KEY ? 
        `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : null,
    process.env.ALCHEMY_API_KEY ? 
        `https://solana-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}` : null,
    process.env.QUICKNODE_ENDPOINT || null,
    'https://api.mainnet-beta.solana.com',
    'https://solana-api.projectserum.com'
].filter(Boolean);

// Rate limiting per la creazione di token
const creationAttempts = new Map();

function checkCreationRateLimit(ip) {
    const now = Date.now();
    const windowMs = 300000; // 5 minuti
    const maxCreations = 3; // Max 3 creazioni token per 5 minuti per IP
    
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
            
            // Test connessione
            await connection.getLatestBlockhash();
            console.log(`[TOKEN] ✅ Connesso a ${endpoint}`);
            return connection;
            
        } catch (error) {
            errors.push(`${endpoint}: ${error.message}`);
            console.warn(`[TOKEN] ❌ Fallito connessione a ${endpoint}`);
        }
    }
    
    throw new Error(`Tutti gli RPC endpoints sono falliti: ${errors.join('; ')}`);
}

function createMetadataInstruction(mint, metadata, updateAuthority, metadataUrl) {
    console.log('[TOKEN] 🔧 Creazione istruzione metadata');
    
    if (!METADATA_PROGRAM_ID) {
        throw new Error('METADATA_PROGRAM_ID non definito. Controlla l\'import di Metaplex.');
    }
    
    // Trova il PDA per l'account metadata
    const [metadataPDA] = PublicKey.findProgramAddressSync(
        [
            Buffer.from('metadata'),
            METADATA_PROGRAM_ID.toBuffer(),
            mint.toBuffer(),
        ],
        METADATA_PROGRAM_ID
    );

    console.log('[TOKEN] 🔍 Metadata PDA:', metadataPDA.toString());

    // Crea l'istruzione per Metaplex v2.x
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
    console.log(`[TOKEN] Inizio creazione token per ${config.name} (${config.symbol})`);
    
    // Inizializza server wallet
    if (!process.env.SERVER_WALLET_PRIVATE_KEY) {
        throw new Error('Server wallet non configurato. Contatta l\'amministratore.');
    }
    
    const serverWallet = Keypair.fromSecretKey(
        bs58.decode(process.env.SERVER_WALLET_PRIVATE_KEY)
    );
    
    const payer = new PublicKey(payerPublicKey);
    const mintKeypair = Keypair.generate();
    const mint = mintKeypair.publicKey;
    
    console.log(`[TOKEN] 🔑 Mint address: ${mint.toBase58()}`);
    console.log(`[TOKEN] 👤 Payer: ${payer.toBase58()}`);
    console.log(`[TOKEN] 🏦 Server wallet: ${serverWallet.publicKey.toBase58()}`);
    
    // Controlla saldo server wallet
    const serverBalance = await connection.getBalance(serverWallet.publicKey);
    const serverBalanceSOL = serverBalance / LAMPORTS_PER_SOL;
    console.log(`[TOKEN] 💰 Saldo server wallet: ${serverBalanceSOL} SOL`);
    
    if (serverBalanceSOL < 0.02) {
        throw new Error(`Saldo server wallet insufficiente: ${serverBalanceSOL} SOL. Servono almeno 0.02 SOL.`);
    }
    
    // Calcola rent exemption
    const mintRent = await connection.getMinimumBalanceForRentExemption(82); // Dimensione account mint
    
    // Determina le autorità basate sulla config
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
    
    // Sovrascrivi con i toggle delle funzionalità
    if (config.mintAuthority) {
        mintAuthority = payer;
    }
    if (config.freezeAuthority) {
        freezeAuthority = payer;
    }
    
    console.log(`[TOKEN] 🔐 Mint Authority: ${mintAuthority?.toBase58() || 'Nessuna (Sarà revocata)'}`);
    console.log(`[TOKEN] 🧊 Freeze Authority: ${freezeAuthority?.toBase58() || 'Nessuna'}`);
    console.log(`[TOKEN] ✏️ Update Authority: ${updateAuthority.toBase58()}`);
    
    // Crea transazione
    const transaction = new Transaction();
    
    // 1. Crea account mint
    transaction.add(
        SystemProgram.createAccount({
            fromPubkey: serverWallet.publicKey,
            newAccountPubkey: mint,
            space: 82,
            lamports: mintRent,
            programId: TOKEN_PROGRAM_ID,
        })
    );
    
    // 2. Inizializza mint
    transaction.add(
        createInitializeMintInstruction(
            mint,
            config.decimals,
            mintAuthority || serverWallet.publicKey,
            freezeAuthority,
            TOKEN_PROGRAM_ID
        )
    );
    
    // 3. Crea account metadata
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
    
    // Imposta proprietà transazione
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = serverWallet.publicKey;
    
    // Firma transazione
    transaction.partialSign(serverWallet, mintKeypair);
    
    console.log(`[TOKEN] 📝 Invio transazione iniziale...`);
    
    // Invia e conferma transazione
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: 3
    });
    
    console.log(`[TOKEN] 📤 Transazione inviata: ${signature}`);
    
    // Aspetta conferma
    const confirmation = await connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight
    }, 'confirmed');
    
    if (confirmation.value.err) {
        throw new Error(`Transazione fallita: ${JSON.stringify(confirmation.value.err)}`);
    }
    
    console.log(`[TOKEN] ✅ Mint e metadata creati!`);
    
    // 4. Crea associated token account per payer e minta i token
    const payerTokenAccount = await getAssociatedTokenAddress(mint, payer);
    
    const mintTransaction = new Transaction();
    
    // Crea ATA
    mintTransaction.add(
        createAssociatedTokenAccountInstruction(
            serverWallet.publicKey,
            payerTokenAccount,
            payer,
            mint,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
        )
    );
    
    // Calcola distribuzione token
    const totalSupply = BigInt(config.supply) * BigInt(10 ** config.decimals);
    const teamTokens = config.teamPercentage ? 
        (totalSupply * BigInt(config.teamPercentage)) / BigInt(100) : BigInt(0);
    const marketingTokens = config.marketingPercentage ? 
        (totalSupply * BigInt(config.marketingPercentage)) / BigInt(100) : BigInt(0);
    const payerTokens = totalSupply - teamTokens - marketingTokens;
    
    console.log(`[TOKEN] 📊 Distribuzione Token:`);
    console.log(`[TOKEN]   - Payer: ${payerTokens.toString()} token`);
    console.log(`[TOKEN]   - Team: ${teamTokens.toString()} token`);
    console.log(`[TOKEN]   - Marketing: ${marketingTokens.toString()} token`);
    
    // Minta token al payer (include token team per ora)
    const totalPayerTokens = payerTokens + teamTokens;
    if (totalPayerTokens > 0) {
        mintTransaction.add(
            createMintToInstruction(
                mint,
                payerTokenAccount,
                serverWallet.publicKey,
                totalPayerTokens,
                [],
                TOKEN_PROGRAM_ID
            )
        );
    }
    
    // Gestisci token marketing se specificato
    let marketingTokenAccount = null;
    if (marketingTokens > 0 && config.marketingWallet) {
        const marketingWallet = new PublicKey(config.marketingWallet);
        marketingTokenAccount = await getAssociatedTokenAddress(mint, marketingWallet);
        
        // Crea ATA marketing
        mintTransaction.add(
            createAssociatedTokenAccountInstruction(
                serverWallet.publicKey,
                marketingTokenAccount,
                marketingWallet,
                mint,
                TOKEN_PROGRAM_ID,
                ASSOCIATED_TOKEN_PROGRAM_ID
            )
        );
        
        // Minta token all'account marketing
        mintTransaction.add(
            createMintToInstruction(
                mint,
                marketingTokenAccount,
                serverWallet.publicKey,
                marketingTokens,
                [],
                TOKEN_PROGRAM_ID
            )
        );
    }
    
    // Imposta proprietà transazione
    const { blockhash: mintBlockhash } = await connection.getLatestBlockhash();
    mintTransaction.recentBlockhash = mintBlockhash;
    mintTransaction.feePayer = serverWallet.publicKey;
    mintTransaction.partialSign(serverWallet);
    
    console.log(`[TOKEN] 📝 Invio transazione minting...`);
    
    // Invia transazione minting
    const mintSignature = await connection.sendRawTransaction(mintTransaction.serialize(), {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: 3
    });
    
    await connection.confirmTransaction(mintSignature, 'confirmed');
    console.log(`[TOKEN] ✅ Token mintati: ${mintSignature}`);
    
    // Revoca mint authority se richiesto
    if (config.authorityMode === 'revoke-all') {
        try {
            const revokeTransaction = new Transaction();
            
            revokeTransaction.add(
                createSetAuthorityInstruction(
                    mint,
                    serverWallet.publicKey,
                    AuthorityType.MintTokens,
                    null,
                    [],
                    TOKEN_PROGRAM_ID
                )
            );
            
            const { blockhash: revokeBlockhash } = await connection.getLatestBlockhash();
            revokeTransaction.recentBlockhash = revokeBlockhash;
            revokeTransaction.feePayer = serverWallet.publicKey;
            revokeTransaction.partialSign(serverWallet);
            
            const revokeSignature = await connection.sendRawTransaction(revokeTransaction.serialize());
            await connection.confirmTransaction(revokeSignature, 'confirmed');
            
            console.log(`[TOKEN] 🔐 Mint authority revocata: ${revokeSignature}`);
        } catch (error) {
            console.warn(`[TOKEN] ⚠️ Fallimento revoca mint authority: ${error.message}`);
        }
    }
    
    console.log(`[TOKEN] 🎉 Creazione token completata con successo!`);
    
    return {
        mintAddress: mint.toBase58(),
        signature,
        mintSignature,
        payerTokenAccount: payerTokenAccount.toBase58(),
        marketingTokenAccount: marketingTokenAccount?.toBase58() || null,
        totalSupply: config.supply,
        decimals: config.decimals,
        authorities: {
            mint: config.authorityMode === 'revoke-all' ? null : mintAuthority?.toBase58() || serverWallet.publicKey.toBase58(),
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
            error: 'Metodo non consentito' 
        });
    }
    
    // Rate limiting
    const clientIP = req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';
    if (!checkCreationRateLimit(clientIP)) {
        return res.status(429).json({ 
            success: false, 
            error: 'Limite di creazione token superato. Aspetta 5 minuti prima di creare un altro token.' 
        });
    }
    
    try {
        const { config, payerPublicKey, metadataUrl } = req.body;
        
        // Validazione
        if (!config || !payerPublicKey) {
            return res.status(400).json({ 
                success: false, 
                error: 'Campi obbligatori mancanti: config e payerPublicKey' 
            });
        }
        
        if (!metadataUrl) {
            return res.status(400).json({ 
                success: false, 
                error: 'URL metadata richiesto. Carica prima i metadata.' 
            });
        }
        
        // Valida payer public key
        try {
            new PublicKey(payerPublicKey);
        } catch (error) {
            return res.status(400).json({ 
                success: false, 
                error: 'Formato payer public key non valido' 
            });
        }
        
        // Valida config
        if (!config.name || !config.symbol || !config.supply) {
            return res.status(400).json({ 
                success: false, 
                error: 'Configurazione token obbligatoria mancante: name, symbol, supply' 
            });
        }
        
        if (config.supply <= 0 || config.supply > 1000000000000) {
            return res.status(400).json({ 
                success: false, 
                error: 'Supply token non valida. Deve essere tra 1 e 1 trilione.' 
            });
        }
        
        if (config.decimals < 0 || config.decimals > 9) {
            return res.status(400).json({ 
                success: false, 
                error: 'Decimali non validi. Devono essere tra 0 e 9.' 
            });
        }
        
        // Valida marketing wallet se fornito
        if (config.marketingWallet) {
            try {
                new PublicKey(config.marketingWallet);
            } catch (error) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Indirizzo marketing wallet non valido' 
                });
            }
        }
        
        console.log(`[TOKEN] 🚀 Inizio processo creazione token`);
        console.log(`[TOKEN] 📋 Config:`, {
            name: config.name,
            symbol: config.symbol,
            supply: config.supply,
            decimals: config.decimals,
            authorityMode: config.authorityMode
        });
        
        // Ottieni connessione
        const connection = await getWorkingConnection();
        
        // Crea token
        const result = await createTokenWithFeatures(connection, config, payerPublicKey, metadataUrl);
        
        console.log(`[TOKEN] ✅ Creazione token riuscita:`, result.mintAddress);
        
        // Ritorna risposta di successo
        res.status(200).json({
            success: true,
            message: 'Token creato con successo',
            mintAddress: result.mintAddress,
            signature: result.signature,
            mintSignature: result.mintSignature,
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
            },
            data: {
                mintAddress: result.mintAddress,
                signature: result.signature,
                mintSignature: result.mintSignature,
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
        console.error('[TOKEN] ❌ Creazione token fallita:', error);
        
        let errorMessage = error.message;
        let statusCode = 500;
        
        // Gestisci tipi di errore specifici
        if (error.message.includes('insufficient funds') || error.message.includes('Saldo server wallet insufficiente')) {
            errorMessage = 'SOL insufficiente nel server wallet. Contatta l\'amministratore.';
            statusCode = 503;
        } else if (error.message.includes('Invalid public key')) {
            errorMessage = 'Formato indirizzo fornito non valido.';
            statusCode = 400;
        } else if (error.message.includes('RPC') || error.message.includes('network')) {
            errorMessage = 'Errore rete blockchain. Riprova tra qualche minuto.';
            statusCode = 503;
        } else if (error.message.includes('Server wallet non configurato')) {
            statusCode = 503;
        } else if (error.message.includes('METADATA_PROGRAM_ID non definito')) {
            errorMessage = 'Errore configurazione libreria Metaplex. Controlla la versione del pacchetto.';
            statusCode = 500;
        }
        
        res.status(statusCode).json({ 
            success: false,
            error: errorMessage,
            timestamp: new Date().toISOString()
        });
    }
};
