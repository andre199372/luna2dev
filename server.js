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
const {
    createCreateMetadataAccountV3Instruction,
    PROGRAM_ID: METADATA_PROGRAM_ID
} = require('@metaplex-foundation/mpl-token-metadata');

// --- CREDENZIALI PINATA ---
// Assicurati che queste siano corrette
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
        try {
            const data = JSON.parse(message);

            if (data.type === 'create_token') {
                console.log('[SERVER] Ricevuta richiesta di creazione token:', data);
                const {
                    name,
                    symbol,
                    description,
                    imageBase64,
                    supply,
                    decimals,
                    recipient, // Indirizzo del wallet che riceverà i token
                    mintAddress, // Public Key del mint account generato dal client
                    options
                } = data;

                // 1. Caricamento Metadati su IPFS (Pinata)
                let metadataUrl = '';
                try {
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
                        fs.unlinkSync(filepath); // Rimuovi file temporaneo
                        
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

                } catch (ipfsError) {
                    console.error('[SERVER] Errore caricamento IPFS:', ipfsError);
                    ws.send(JSON.stringify({ command: 'error', payload: { message: 'Failed to upload metadata to IPFS.' } }));
                    return;
                }

                // 2. Costruzione della Transazione
                const connection = new Connection(clusterApiUrl('devnet'), 'confirmed');
                const mint = new PublicKey(mintAddress);
                const payer = new PublicKey(recipient); // L'utente che paga le fee è il destinatario
                const mintAuthority = payer; // L'utente è anche l'autorità di mint
                const freezeAuthority = options.freeze_authority ? payer : null;

                const lamports = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);

                // Istruzione per creare l'account del mint
                const createAccountInstruction = SystemProgram.createAccount({
                    fromPubkey: payer,
                    newAccountPubkey: mint,
                    space: MINT_SIZE,
                    lamports,
                    programId: TOKEN_PROGRAM_ID,
                });

                // Istruzione per inizializzare il mint
                const initializeMintInstruction = createInitializeMintInstruction(
                    mint,
                    decimals,
                    mintAuthority,
                    freezeAuthority,
                    TOKEN_PROGRAM_ID
                );
                
                // Indirizzo del token account associato del destinatario
                const associatedTokenAccount = await getAssociatedTokenAddress(mint, payer);

                // Istruzione per creare l'ATA
                const createAtaInstruction = createAssociatedTokenAccountInstruction(
                    payer,
                    associatedTokenAccount,
                    payer,
                    mint
                );

                // Istruzione per "mintare" i token all'ATA
                const mintToInstruction = createMintToInstruction(
                    mint,
                    associatedTokenAccount,
                    mintAuthority,
                    supply * Math.pow(10, decimals)
                );
                
                // Istruzione per creare i metadati (Token-Metadata Program)
                const metadataPDA = PublicKey.findProgramAddressSync(
                    [Buffer.from('metadata'), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
                    METADATA_PROGRAM_ID
                )[0];

                const createMetadataInstruction = createCreateMetadataAccountV3Instruction({
                    metadata: metadataPDA,
                    mint: mint,
                    mintAuthority: mintAuthority,
                    payer: payer,
                    updateAuthority: mintAuthority,
                }, {
                    createMetadataAccountArgsV3: {
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
                    },
                });

                // 3. Creazione e invio della transazione serializzata
                const transaction = new Transaction();
                transaction.add(createAccountInstruction);
                transaction.add(initializeMintInstruction);
                transaction.add(createAtaInstruction);
                transaction.add(mintToInstruction);
                transaction.add(createMetadataInstruction);
                
                // Il blockhash verrà impostato dal client
                transaction.feePayer = payer;

                // Serializza la transazione SENZA firmarla
                const serializedTransaction = transaction.serialize({
                    requireAllSignatures: false, // Molto importante
                    verifySignatures: false
                }).toString('base64');
                
                console.log('[SERVER] Transazione creata e serializzata. Invio al client.');

                ws.send(JSON.stringify({
                    command: 'transaction_ready',
                    payload: {
                        serializedTransaction: serializedTransaction
                    }
                }));
            }
        } catch (err) {
            console.error('[WS] Errore durante l\'elaborazione del messaggio:', err);
            ws.send(JSON.stringify({ command: 'error', payload: { message: err.message } }));
        }
    });

    ws.on('close', () => console.log('[WS] Client disconnected'));
    ws.on('error', (err) => console.error('[WS] WebSocket Error:', err));
});

server.listen(PORT, () => {
    console.log(`[WS] Server in ascolto sulla porta ${PORT}`);
});
