// server.js
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const {
    Connection,
    PublicKey,
    Transaction,
    SystemProgram,
    clusterApiUrl,
    TransactionInstruction,
    SYSVAR_RENT_PUBKEY
} = require('@solana/web3.js');
const {
    createInitializeMintInstruction,
    getAssociatedTokenAddress,
    createAssociatedTokenAccountInstruction,
    createMintToInstruction,
    MINT_SIZE,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
} = require('@solana/spl-token');

// ===== METAPLEX METADATA CORRECTED =====
const METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

// Funzione corretta per creare l'istruzione metadata
function createMetadataAccountV3Instruction(accounts, args) {
    const keys = [
        { pubkey: accounts.metadata, isSigner: false, isWritable: true },
        { pubkey: accounts.mint, isSigner: false, isWritable: false },
        { pubkey: accounts.mintAuthority, isSigner: true, isWritable: false },
        { pubkey: accounts.payer, isSigner: true, isWritable: true },
        { pubkey: accounts.updateAuthority, isSigner: false, isWritable: false },
        { pubkey: accounts.systemProgram, isSigner: false, isWritable: false },
        { pubkey: accounts.rent, isSigner: false, isWritable: false }
    ];

    // Buffer per i dati dell'istruzione
    const buffers = [];
    
    // 1. Discriminator per CreateMetadataAccountV3
    const discriminator = Buffer.from([33, 168, 68, 87, 80, 110, 36, 73]);
    buffers.push(discriminator);

    // 2. CreateMetadataAccountArgsV3 struct
    // - data: DataV2
    // - isMutable: bool
    // - collectionDetails: Option<CollectionDetails>

    // DataV2 struct:
    // - name: String
    // - symbol: String  
    // - uri: String
    // - seller_fee_basis_points: u16
    // - creators: Option<Vec<Creator>>
    // - collection: Option<Collection>
    // - uses: Option<Uses>

    // Nome (String con lunghezza u32)
    const nameBuffer = Buffer.from(args.data.name, 'utf8');
    const nameLength = Buffer.alloc(4);
    nameLength.writeUInt32LE(nameBuffer.length, 0);
    buffers.push(nameLength, nameBuffer);

    // Simbolo (String con lunghezza u32)
    const symbolBuffer = Buffer.from(args.data.symbol, 'utf8');
    const symbolLength = Buffer.alloc(4);
    symbolLength.writeUInt32LE(symbolBuffer.length, 0);
    buffers.push(symbolLength, symbolBuffer);

    // URI (String con lunghezza u32)
    const uriBuffer = Buffer.from(args.data.uri, 'utf8');
    const uriLength = Buffer.alloc(4);
    uriLength.writeUInt32LE(uriBuffer.length, 0);
    buffers.push(uriLength, uriBuffer);

    // Seller fee basis points (u16)
    const sellerFee = Buffer.alloc(2);
    sellerFee.writeUInt16LE(args.data.sellerFeeBasisPoints || 0, 0);
    buffers.push(sellerFee);

    // Creators (Option<Vec<Creator>>) - None = 0
    buffers.push(Buffer.from([0]));

    // Collection (Option<Collection>) - None = 0
    buffers.push(Buffer.from([0]));

    // Uses (Option<Uses>) - None = 0
    buffers.push(Buffer.from([0]));

    // isMutable (bool)
    buffers.push(Buffer.from([args.isMutable ? 1 : 0]));

    // collectionDetails (Option<CollectionDetails>) - None = 0
    buffers.push(Buffer.from([0]));

    const data = Buffer.concat(buffers);

    return new TransactionInstruction({
        keys,
        programId: METADATA_PROGRAM_ID,
        data
    });
}

console.log('[SERVER - STARTUP] ✅ Metaplex metadata instruction corrected');

// --- PINATA CREDENTIALS ---
const PINATA_API_KEY = process.env.PINATA_API_KEY || '652df35488890fe4377c';
const PINATA_SECRET_API_KEY = process.env.PINATA_SECRET_API_KEY || '29b2db0dd13dbce7c036eb68386c61916887a4b470fd288a309343814fab0f03';

const PORT = process.env.PORT || 8443;

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            status: 'ok', 
            message: 'Luna Token Creator WebSocket Server',
            timestamp: new Date().toISOString()
        }));
    } else if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'healthy', uptime: process.uptime() }));
    } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
    }
});

const wss = new WebSocket.Server({ 
    server,
    perMessageDeflate: false,
    maxPayload: 10 * 1024 * 1024
});

wss.on('connection', (ws, req) => {
    const clientIp = req.socket.remoteAddress;
    console.log(`[WS] Client connected from ${clientIp}`);

    ws.isAlive = true;
    ws.on('pong', () => {
        ws.isAlive = true;
    });

    ws.on('message', async (message) => {
        let data;
        try {
            data = JSON.parse(message);
            console.log(`[WS] Received message type: ${data.type}`);
        } catch (e) {
            console.error('[WS] JSON parsing error:', e);
            ws.send(JSON.stringify({ 
                command: 'error', 
                payload: { message: 'Invalid JSON format' } 
            }));
            return;
        }

        if (data.type === 'create_token') {
            await handleTokenCreation(ws, data);
        } else if (data.type === 'ping') {
            ws.send(JSON.stringify({ command: 'pong' }));
        } else {
            ws.send(JSON.stringify({ 
                command: 'error', 
                payload: { message: 'Unknown message type' } 
            }));
        }
    });

    ws.on('close', (code, reason) => {
        console.log(`[WS] Client disconnected - Code: ${code}, Reason: ${reason}`);
    });

    ws.on('error', (err) => {
        console.error('[WS] WebSocket Error:', err);
    });
});

const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            console.log('[WS] Terminating inactive connection');
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('close', () => {
    clearInterval(heartbeat);
});

async function handleTokenCreation(ws, data) {
    console.log('[SERVER] Processing token creation request...');

    try {
        const {
            name,
            symbol,
            description,
            imageBase64,
            supply,
            decimals,
            recipient,
            mintAddress,
            options
        } = data;

        // Validazione input
        if (!name || !symbol || !description || !supply || !recipient || !mintAddress) {
            throw new Error('Missing required fields');
        }

        if (name.length > 32) {
            throw new Error('Token name too long (max 32 characters)');
        }

        if (symbol.length > 10) {
            throw new Error('Token symbol too long (max 10 characters)');
        }

        if (supply <= 0 || supply > 1e15) {
            throw new Error('Invalid token supply');
        }

        if (decimals < 0 || decimals > 9) {
            throw new Error('Decimals must be between 0 and 9');
        }

        // Valida indirizzi
        try {
            new PublicKey(recipient);
            new PublicKey(mintAddress);
        } catch (err) {
            throw new Error('Invalid wallet address format');
        }

        // Progresso: upload metadati
        ws.send(JSON.stringify({ 
            command: 'progress', 
            payload: { step: 'uploading_metadata', message: 'Uploading metadata to IPFS...' } 
        }));

        const metadataUrl = await uploadMetadataToIPFS(name, symbol, description, imageBase64);
        console.log(`[SERVER] Metadata uploaded: ${metadataUrl}`);

        // Progresso: costruzione transazione
        ws.send(JSON.stringify({ 
            command: 'progress', 
            payload: { step: 'building_transaction', message: 'Building transaction...' } 
        }));

        const serializedTransaction = await buildTokenTransaction({
            name,
            symbol,
            decimals,
            supply,
            recipient,
            mintAddress,
            metadataUrl,
            options
        });

        console.log('[SERVER] Transaction built successfully. Sending to client...');

        ws.send(JSON.stringify({ 
            command: 'transaction_ready', 
            payload: { 
                serializedTransaction,
                mintAddress,
                metadataUrl
            } 
        }));

    } catch (err) {
        console.error('[SERVER] Token creation error:', err);
        ws.send(JSON.stringify({ 
            command: 'error', 
            payload: { 
                message: err.message || 'An unexpected error occurred during token creation',
                details: process.env.NODE_ENV === 'development' ? err.stack : undefined
            } 
        }));
    }
}

async function uploadMetadataToIPFS(name, symbol, description, imageBase64) {
    const finalMetadata = { name, symbol, description };
    
    try {
        if (imageBase64) {
            console.log('[IPFS] Uploading image...');
            const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
            const filename = `token_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.png`;
            const filepath = path.join(__dirname, filename);
            
            fs.writeFileSync(filepath, base64Data, { encoding: 'base64' });
            
            const formData = new FormData();
            formData.append('file', fs.createReadStream(filepath));
            formData.append('pinataMetadata', JSON.stringify({
                name: filename,
                keyvalues: {
                    tokenName: name,
                    tokenSymbol: symbol
                }
            }));
            
            const imgRes = await axios.post('https://api.pinata.cloud/pinning/pinFileToIPFS', formData, {
                maxBodyLength: 'Infinity',
                headers: { 
                    ...formData.getHeaders(), 
                    pinata_api_key: PINATA_API_KEY, 
                    pinata_secret_api_key: PINATA_SECRET_API_KEY, 
                },
                timeout: 30000
            });
            
            try {
                fs.unlinkSync(filepath);
            } catch (cleanupErr) {
                console.warn('[CLEANUP] Failed to remove temp file:', cleanupErr);
            }
            
            finalMetadata.image = `https://gateway.pinata.cloud/ipfs/${imgRes.data.IpfsHash}`;
            console.log('[IPFS] Image uploaded successfully');
        }
        
        console.log('[IPFS] Uploading metadata JSON...');
        const jsonRes = await axios.post('https://api.pinata.cloud/pinning/pinJSONToIPFS', finalMetadata, {
            headers: { 
                pinata_api_key: PINATA_API_KEY, 
                pinata_secret_api_key: PINATA_SECRET_API_KEY, 
                'Content-Type': 'application/json' 
            },
            timeout: 30000
        });
        
        return `https://gateway.pinata.cloud/ipfs/${jsonRes.data.IpfsHash}`;
        
    } catch (error) {
        console.error('[IPFS] Upload error:', error);
        throw new Error(`Failed to upload metadata to IPFS: ${error.message}`);
    }
}

async function buildTokenTransaction(params) {
    const { name, symbol, decimals, supply, recipient, mintAddress, metadataUrl, options } = params;
    
    const connection = new Connection(clusterApiUrl('mainnet-beta'), 'confirmed');
    const mint = new PublicKey(mintAddress);
    const payer = new PublicKey(recipient);
    const mintAuthority = payer;
    const freezeAuthority = options?.freeze_authority ? payer : null;

    try {
        const lamports = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
        console.log(`[TRANSACTION] Mint account rent: ${lamports} lamports`);

        // 1. Create account instruction
        const createAccountInstruction = SystemProgram.createAccount({ 
            fromPubkey: payer, 
            newAccountPubkey: mint, 
            space: MINT_SIZE, 
            lamports, 
            programId: TOKEN_PROGRAM_ID, 
        });
        
        // 2. Initialize mint instruction
        const initializeMintInstruction = createInitializeMintInstruction(
            mint, 
            decimals, 
            mintAuthority, 
            freezeAuthority, 
            TOKEN_PROGRAM_ID
        );
        
        // 3. Create associated token account
        const associatedTokenAccount = await getAssociatedTokenAddress(
            mint, 
            payer,
            false,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
        );
        
        const createAtaInstruction = createAssociatedTokenAccountInstruction(
            payer, 
            associatedTokenAccount, 
            payer, 
            mint,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
        );
        
        // 4. Mint tokens instruction
        const totalSupply = BigInt(supply) * BigInt(10 ** decimals);
        const mintToInstruction = createMintToInstruction(
            mint, 
            associatedTokenAccount, 
            mintAuthority, 
            totalSupply,
            [],
            TOKEN_PROGRAM_ID
        );
        
        // 5. Calcola metadata PDA
        const [metadataPDA] = PublicKey.findProgramAddressSync([
            Buffer.from('metadata'), 
            METADATA_PROGRAM_ID.toBuffer(), 
            mint.toBuffer()
        ], METADATA_PROGRAM_ID);
        
        console.log(`[TRANSACTION] Metadata PDA: ${metadataPDA.toBase58()}`);
        
        // 6. Create metadata instruction CORRETTA
        const createMetadataInstruction = createMetadataAccountV3Instruction(
            {
                metadata: metadataPDA,
                mint: mint,
                mintAuthority: mintAuthority,
                payer: payer,
                updateAuthority: mintAuthority,
                systemProgram: SystemProgram.programId,
                rent: SYSVAR_RENT_PUBKEY
            },
            {
                data: {
                    name: name,
                    symbol: symbol,
                    uri: metadataUrl,
                    sellerFeeBasisPoints: 0,
                },
                isMutable: !options?.revoke_update_authority,
            }
        );

        // 7. Costruisci transazione
        const transaction = new Transaction().add(
            createAccountInstruction, 
            initializeMintInstruction, 
            createAtaInstruction, 
            mintToInstruction, 
            createMetadataInstruction
        );
        
        transaction.feePayer = payer;
        
        // 8. Ottieni blockhash recente con retry
        let blockhash;
        let retries = 3;
        
        while (retries > 0) {
            try {
                const { blockhash: bh } = await connection.getLatestBlockhash('confirmed');
                blockhash = bh;
                break;
            } catch (err) {
                retries--;
                if (retries === 0) throw err;
                console.warn(`[TRANSACTION] Blockhash fetch failed, retrying... (${retries} attempts left)`);
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        
        transaction.recentBlockhash = blockhash;
        console.log(`[TRANSACTION] Using blockhash: ${blockhash}`);
        
        // 9. Serializza transazione
        const serializedTransaction = transaction.serialize({ 
            requireAllSignatures: false, 
            verifySignatures: false 
        }).toString('base64');
        
        console.log('[TRANSACTION] Transaction serialized successfully');
        console.log(`[TRANSACTION] Metadata instruction data length: ${createMetadataInstruction.data.length} bytes`);
        
        return serializedTransaction;
        
    } catch (error) {
        console.error('[TRANSACTION] Build error:', error);
        throw new Error(`Failed to build transaction: ${error.message}`);
    }
}

// Gestione errori del server
server.on('error', (err) => {
    console.error('[SERVER] Server error:', err);
    process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('[SERVER] SIGTERM received, shutting down gracefully...');
    clearInterval(heartbeat);
    server.close(() => {
        console.log('[SERVER] Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('[SERVER] SIGINT received, shutting down gracefully...');
    clearInterval(heartbeat);
    server.close(() => {
        console.log('[SERVER] Server closed');
        process.exit(0);
    });
});

server.listen(PORT, () => {
    console.log(`[SERVER] 🚀 Luna Token Creator Server running on port ${PORT}`);
    console.log(`[SERVER] Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`[SERVER] Memory usage: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB`);
});
