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
    clusterApiUrl
} = require('@solana/web3.js');
const {
    createInitializeMintInstruction,
    getAssociatedTokenAddress,
    createAssociatedTokenAccountInstruction,
    createMintToInstruction,
    MINT_SIZE,
    TOKEN_PROGRAM_ID
} = require('@solana/spl-token');

// ===== IMPORT DIRETTO METAPLEX =====
let createCreateMetadataAccountV3Instruction;
let MPL_TOKEN_METADATA_PROGRAM_ID;

try {
    // Import diretto delle funzioni specifiche
    const metaplexModule = require('@metaplex-foundation/mpl-token-metadata');
    
    console.log('[SERVER - STARTUP] Contenuto modulo Metaplex:', Object.keys(metaplexModule).slice(0, 30));
    
    // Trova la funzione corretta
    if (metaplexModule.createCreateMetadataAccountV3Instruction) {
        createCreateMetadataAccountV3Instruction = metaplexModule.createCreateMetadataAccountV3Instruction;
        console.log('[SERVER - STARTUP] ✅ createCreateMetadataAccountV3Instruction trovata');
    } else if (metaplexModule.createMetadataV3) {
        createCreateMetadataAccountV3Instruction = metaplexModule.createMetadataV3;
        console.log('[SERVER - STARTUP] ✅ createMetadataV3 trovata');
    }
    
    // Trova il Program ID
    if (metaplexModule.MPL_TOKEN_METADATA_PROGRAM_ID) {
        MPL_TOKEN_METADATA_PROGRAM_ID = metaplexModule.MPL_TOKEN_METADATA_PROGRAM_ID;
        console.log('[SERVER - STARTUP] ✅ MPL_TOKEN_METADATA_PROGRAM_ID trovato');
    }
    
} catch (e) {
    console.error('[SERVER - STARTUP] ❌ Errore caricamento Metaplex:', e.message);
}

// Fallback con valori hardcoded se necessario
if (!MPL_TOKEN_METADATA_PROGRAM_ID) {
    MPL_TOKEN_METADATA_PROGRAM_ID = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
    console.log('[SERVER - STARTUP] 🔧 Usando Program ID hardcoded');
}
// ===== FINE IMPORT METAPLEX =====


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

            // ===== BLOCCO DI VALIDAZIONE =====
            if (!MPL_TOKEN_METADATA_PROGRAM_ID || !createCreateMetadataAccountV3Instruction) {
                const errorMessage = "ERRORE INTERNO DEL SERVER: Le funzioni di Metaplex non sono disponibili.";
                console.error(`[SERVER - RICHIESTA] ${errorMessage}`);
                console.error(`[SERVER - DEBUG] Program ID: ${MPL_TOKEN_METADATA_PROGRAM_ID ? '✅' : '❌'}`);
                console.error(`[SERVER - DEBUG] Function: ${createCreateMetadataAccountV3Instruction ? '✅' : '❌'}`);
                ws.send(JSON.stringify({ command: 'error', payload: { message: errorMessage } }));
                return;
            }
            // ===== FINE BLOCCO DI VALIDAZIONE =====

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
                        headers: { ...formData.getHeaders(), pinata_api_key: PINATA_API_KEY, pinata_secret_api_key: PINATA_SECRET_API_KEY, },
                    });
                    fs.unlinkSync(filepath);
                    finalMetadata.image = `https://gateway.pinata.cloud/ipfs/${imgRes.data.IpfsHash}`;
                }
                const jsonRes = await axios.post('https://api.pinata.cloud/pinning/pinJSONToIPFS', finalMetadata, {
                    headers: { pinata_api_key: PINATA_API_KEY, pinata_secret_api_key: PINATA_SECRET_API_KEY, 'Content-Type': 'application/json' }
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
                
                // ✅ CORREZIONE: Calcolo corretto del PDA per i metadati
                const metadataPDA = PublicKey.findProgramAddressSync([
                    Buffer.from('metadata'), 
                    new PublicKey(MPL_TOKEN_METADATA_PROGRAM_ID).toBuffer(), 
                    mint.toBuffer()
                ], new PublicKey(MPL_TOKEN_METADATA_PROGRAM_ID))[0];
                
                // ✅ CORREZIONE: Usa la funzione importata direttamente
                const createMetadataInstruction = createCreateMetadataAccountV3Instruction(
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
                console.error(err.stack); // Aggiunge uno stack trace più dettagliato
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
