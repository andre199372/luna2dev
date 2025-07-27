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

// ===== BLOCCO DI DEBUG AVANZATO PER METAPLEX =====
let createMetadataInstructionFunction; // Nome generico per la funzione
let METADATA_PROGRAM_ID; // Questo ora sarà un oggetto PublicKey

try {
    const metaplex = require('@metaplex-foundation/mpl-token-metadata');
    console.log('[SERVER - STARTUP] Libreria @metaplex-foundation/mpl-token-metadata caricata.');

    // Cerca la funzione corretta, dato che i nomi sono cambiati tra le versioni
    const possibleFunctionNames = [
        'createCreateMetadataAccountV3Instruction', 
        'createMetadataAccountV3Instruction',
        'createMetadataAccountV3'
    ];

    for (const name of possibleFunctionNames) {
        if (typeof metaplex[name] === 'function') {
            createMetadataInstructionFunction = metaplex[name];
            console.log(`[SERVER - STARTUP] Trovata funzione di creazione metadati valida: "${name}"`);
            break;
        }
    }
    
    // Correzione: il nome della variabile è cambiato nelle versioni recenti
    const programIdString = metaplex.MPL_TOKEN_METADATA_PROGRAM_ID;

    if (!createMetadataInstructionFunction) {
        console.error('[SERVER - STARTUP] ERRORE CRITICO: Nessuna funzione valida per la creazione dei metadati è stata trovata.');
    }

    if (!programIdString) {
        console.error('[SERVER - STARTUP] ERRORE CRITICO: "METADATA_PROGRAM_ID" non è stato trovato.');
    } else {
        METADATA_PROGRAM_ID = new PublicKey(programIdString);
        console.log('[SERVER - STARTUP] "METADATA_PROGRAM_ID" è stato trovato e convertito in PublicKey.');
    }

} catch (e) {
    console.error('[SERVER - STARTUP] ERRORE CRITICO: Impossibile caricare "@metaplex-foundation/mpl-token-metadata".', e.message);
}
// ===== FINE BLOCCO DI DEBUG =====


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

            // ===== BLOCCO DI VALIDAZIONE MIGLIORATO =====
            const { recipient, mintAddress } = data;
            if (!recipient || !mintAddress) {
                const errorMessage = `Dati mancanti dal client. Ricevuto recipient: ${recipient}, mintAddress: ${mintAddress}`;
                console.error(`[SERVER] ${errorMessage}`);
                ws.send(JSON.stringify({ command: 'error', payload: { message: errorMessage } }));
                return;
            }
            try {
                new PublicKey(recipient);
                new PublicKey(mintAddress);
            } catch (e) {
                const errorMessage = `Indirizzo non valido ricevuto dal client: ${e.message}`;
                console.error(`[SERVER] ${errorMessage}`);
                ws.send(JSON.stringify({ command: 'error', payload: { message: errorMessage } }));
                return;
            }
             if (!METADATA_PROGRAM_ID || !createMetadataInstructionFunction) {
                const errorMessage = "ERRORE INTERNO DEL SERVER: Le funzioni di Metaplex non sono disponibili. Controllare i log di avvio del server.";
                console.error(`[SERVER - RICHIESTA] ${errorMessage}`);
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

                const createAccountInstruction = SystemProgram.createAccount({ fromPubkey: payer, newAccountPubkey: mint, space: MINT_SIZE, lamports, programId: TOKEN_PROGRAM_ID, });
                const initializeMintInstruction = createInitializeMintInstruction(mint, decimals, mintAuthority, freezeAuthority, TOKEN_PROGRAM_ID);
                const associatedTokenAccount = await getAssociatedTokenAddress(mint, payer);
                const createAtaInstruction = createAssociatedTokenAccountInstruction(payer, associatedTokenAccount, payer, mint);
                const mintToInstruction = createMintToInstruction(mint, associatedTokenAccount, mintAuthority, supply * Math.pow(10, decimals));
                
                const metadataPDA = PublicKey.findProgramAddressSync([Buffer.from('metadata'), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()], METADATA_PROGRAM_ID)[0];
                
                const accounts = {
                    metadata: metadataPDA,
                    mint: mint,
                    mintAuthority: mintAuthority,
                    payer: payer,
                    updateAuthority: mintAuthority,
                    systemProgram: SystemProgram.programId, 
                };
                
                // CORREZIONE FINALE: L'oggetto 'args' è stato corretto per non avere il livello extra 'createMetadataAccountArgsV3'.
                const args = {
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
                };

                const createMetadataInstruction = createMetadataInstructionFunction(accounts, args);


                // 3. Creazione e invio della transazione serializzata
                const transaction = new Transaction().add(createAccountInstruction, initializeMintInstruction, createAtaInstruction, mintToInstruction, createMetadataInstruction);
                transaction.feePayer = payer;
                
                const serializedTransaction = transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
                console.log('[SERVER] Transazione creata e serializzata. Invio al client.');

                ws.send(JSON.stringify({ command: 'transaction_ready', payload: { serializedTransaction: serializedTransaction } }));

            } catch (err) {
                console.error('[SERVER] Errore durante la costruzione della transazione:', err.stack);
                ws.send(JSON.stringify({ command: 'error', payload: { message: err.message } }));
            }
        }
    });

    ws.on('close', () => console.log('[WS] Client disconnected'));
    ws.on('error', (err) => console.error('[WS] WebSocket Error:', err));
});

server.listen(PORT, () => {
    console.log(`[WS] Server in ascolto sulla porta ${PORT}`);
});
