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
    TransactionInstruction
} = require('@solana/web3.js');
const {
    createInitializeMintInstruction,
    getAssociatedTokenAddress,
    createAssociatedTokenAccountInstruction,
    createMintToInstruction,
    MINT_SIZE,
    TOKEN_PROGRAM_ID
} = require('@solana/spl-token');

// ===== METAPLEX METADATA HARDCODED =====
// Program ID di Metaplex Token Metadata (costante)
const METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

// Funzione per creare l'istruzione metadata manualmente
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

    // Serializza i dati per l'istruzione
    const dataLayout = Buffer.alloc(1000); // Buffer abbastanza grande
    let offset = 0;
    
    // Instruction discriminator per CreateMetadataAccountV3 = [33, 168, 68, 87, 80, 110, 36, 73]
    const discriminator = Buffer.from([33, 168, 68, 87, 80, 110, 36, 73]);
    discriminator.copy(dataLayout, offset);
    offset += discriminator.length;

    // Serializza i dati del token
    const nameBytes = Buffer.from(args.data.name, 'utf8');
    dataLayout.writeUInt32LE(nameBytes.length, offset);
    offset += 4;
    nameBytes.copy(dataLayout, offset);
    offset += nameBytes.length;

    const symbolBytes = Buffer.from(args.data.symbol, 'utf8');
    dataLayout.writeUInt32LE(symbolBytes.length, offset);
    offset += 4;
    symbolBytes.copy(dataLayout, offset);
    offset += symbolBytes.length;

    const uriBytes = Buffer.from(args.data.uri, 'utf8');
    dataLayout.writeUInt32LE(uriBytes.length, offset);
    offset += 4;
    uriBytes.copy(dataLayout, offset);
    offset += uriBytes.length;

    // Seller fee basis points
    dataLayout.writeUInt16LE(args.data.sellerFeeBasisPoints, offset);
    offset += 2;

    // Creators (null)
    dataLayout.writeUInt8(0, offset); // Option::None
    offset += 1;

    // Collection (null)
    dataLayout.writeUInt8(0, offset); // Option::None
    offset += 1;

    // Uses (null)
    dataLayout.writeUInt8(0, offset); // Option::None
    offset += 1;

    // isMutable
    dataLayout.writeUInt8(args.isMutable ? 1 : 0, offset);
    offset += 1;

    // collectionDetails (null)
    dataLayout.writeUInt8(0, offset); // Option::None
    offset += 1;

    const finalData = dataLayout.slice(0, offset);

    return new TransactionInstruction({
        keys,
        programId: METADATA_PROGRAM_ID,
        data: finalData
    });
}

console.log('[SERVER - STARTUP] ✅ Funzioni Metaplex implementate manualmente');
// ===== FINE METAPLEX HARDCODED =====

// --- CREDENZIALI PINATA ---
const PINATA_API_KEY = '652df35488890fe4377c';
const PINATA_SECRET_API_KEY = '29b2db0dd13dbce7c036eb68386c61916887a4b470fd288a309343814fab0f03';

const PORT = process.env.PORT || 8443;
const server = http.createServer((req, res) => {
    if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('WebSocket server is running.');
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    console.log('[WS] Client connected');

    ws.on('message', async (message) => {
        let data;
        try {
            data = JSON.parse(message);
        } catch (e) {
            console.error('[WS] Errore parsing JSON:', e);
            return;
        }

        if (data.type === 'create_token') {
            console.log('[SERVER] Ricevuta richiesta di creazione token.');

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

                // 1. Caricamento Metadati su IPFS (Pinata)
                let metadataUrl = '';
                const finalMetadata = { name, symbol, description };
                
                if (imageBase64) {
                    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
                    const filename = `token_${Date.now()}.png`;
                    const filepath = path.join(__dirname, filename);
                    fs.writeFileSync(filepath, base64Data, { encoding: 'base64' });
                    
                    const formData = new FormData();
                    formData.append('file', fs.createReadStream(filepath));
                    
                    const imgRes = await axios.post('https://api.pinata.cloud/pinning/pinFileToIPFS', formData, {
                        maxBodyLength: 'Infinity',
                        headers: { 
                            ...formData.getHeaders(), 
                            pinata_api_key: PINATA_API_KEY, 
                            pinata_secret_api_key: PINATA_SECRET_API_KEY, 
                        },
                    });
                    
                    fs.unlinkSync(filepath);
                    finalMetadata.image = `https://gateway.pinata.cloud/ipfs/${imgRes.data.IpfsHash}`;
                }
                
                const jsonRes = await axios.post('https://api.pinata.cloud/pinning/pinJSONToIPFS', finalMetadata, {
                    headers: { 
                        pinata_api_key: PINATA_API_KEY, 
                        pinata_secret_api_key: PINATA_SECRET_API_KEY, 
                        'Content-Type': 'application/json' 
                    }
                });
                
                metadataUrl = `https://gateway.pinata.cloud/ipfs/${jsonRes.data.IpfsHash}`;
                console.log(`[SERVER] Metadati caricati su IPFS: ${metadataUrl}`);

                // 2. Costruzione della Transazione
                const connection = new Connection(clusterApiUrl('devnet'), 'confirmed');
                const mint = new PublicKey(mintAddress);
                const payer = new PublicKey(recipient);
                const mintAuthority = payer;
                const freezeAuthority = options.freeze_authority ? payer : null;

                const lamports = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);

                // Istruzioni base per il token
                const createAccountInstruction = SystemProgram.createAccount({ 
                    fromPubkey: payer, 
                    newAccountPubkey: mint, 
                    space: MINT_SIZE, 
                    lamports, 
                    programId: TOKEN_PROGRAM_ID, 
                });
                
                const initializeMintInstruction = createInitializeMintInstruction(
                    mint, 
                    decimals, 
                    mintAuthority, 
                    freezeAuthority, 
                    TOKEN_PROGRAM_ID
                );
                
                const associatedTokenAccount = await getAssociatedTokenAddress(mint, payer);
                const createAtaInstruction = createAssociatedTokenAccountInstruction(
                    payer, 
                    associatedTokenAccount, 
                    payer, 
                    mint
                );
                
                const mintToInstruction = createMintToInstruction(
                    mint, 
                    associatedTokenAccount, 
                    mintAuthority, 
                    supply * Math.pow(10, decimals)
                );
                
                // Calcolo PDA per i metadati
                const metadataPDA = PublicKey.findProgramAddressSync([
                    Buffer.from('metadata'), 
                    METADATA_PROGRAM_ID.toBuffer(), 
                    mint.toBuffer()
                ], METADATA_PROGRAM_ID)[0];
                
                // Istruzione per i metadati usando la funzione custom
                const createMetadataInstruction = createMetadataAccountV3Instruction(
                    {
                        metadata: metadataPDA,
                        mint: mint,
                        mintAuthority: mintAuthority,
                        payer: payer,
                        updateAuthority: mintAuthority,
                        systemProgram: SystemProgram.programId,
                        rent: new PublicKey("SysvarRent111111111111111111111111111111111")
                    },
                    {
                        data: {
                            name: name,
                            symbol: symbol,
                            uri: metadataUrl,
                            creators: null,
                            sellerFeeBasisPoints: 0,
                            uses: null,
                            collection: null,
                        },
                        isMutable: !options.revoke_update_authority,
                        collectionDetails: null,
                    }
                );

                // 3. Creazione e invio della transazione serializzata
                const transaction = new Transaction().add(
                    createAccountInstruction, 
                    initializeMintInstruction, 
                    createAtaInstruction, 
                    mintToInstruction, 
                    createMetadataInstruction
                );
                
                transaction.feePayer = payer;
                
                const serializedTransaction = transaction.serialize({ 
                    requireAllSignatures: false, 
                    verifySignatures: false 
                }).toString('base64');
                
                console.log('[SERVER] Transazione creata e serializzata. Invio al client.');

                ws.send(JSON.stringify({ 
                    command: 'transaction_ready', 
                    payload: { serializedTransaction: serializedTransaction } 
                }));

            } catch (err) {
                console.error('[SERVER] Errore durante la costruzione della transazione:', err);
                console.error(err.stack);
                ws.send(JSON.stringify({ 
                    command: 'error', 
                    payload: { message: `Errore del server: ${err.message}` } 
                }));
            }
        }
    });

    ws.on('close', () => console.log('[WS] Client disconnected'));
    ws.on('error', (err) => console.error('[WS] WebSocket Error:', err));
});

server.listen(PORT, () => {
    console.log(`[WS] Server in ascolto sulla porta ${PORT}`);
});
