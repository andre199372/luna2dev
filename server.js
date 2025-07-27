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

// ID del programma Metaplex Token Metadata
const METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

// Funzione custom per serializzare l'istruzione di creazione dei metadati
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

    const buffers = [];
    
    // 1. Discriminator (identificatore dell'istruzione)
    buffers.push(Buffer.from([33, 168, 68, 87, 80, 110, 36, 73]));

    // --- Inizio Dati (DataV2) ---
    // Nome
    const nameBuffer = Buffer.from(args.data.name, 'utf8');
    const nameLength = Buffer.alloc(4);
    nameLength.writeUInt32LE(nameBuffer.length, 0);
    buffers.push(nameLength, nameBuffer);

    // Simbolo
    const symbolBuffer = Buffer.from(args.data.symbol, 'utf8');
    const symbolLength = Buffer.alloc(4);
    symbolLength.writeUInt32LE(symbolBuffer.length, 0);
    buffers.push(symbolLength, symbolBuffer);

    // URI
    const uriBuffer = Buffer.from(args.data.uri, 'utf8');
    const uriLength = Buffer.alloc(4);
    uriLength.writeUInt32LE(uriBuffer.length, 0);
    buffers.push(uriLength, uriBuffer);

    // Seller fee basis points
    const sellerFee = Buffer.alloc(2);
    sellerFee.writeUInt16LE(args.data.sellerFeeBasisPoints || 0, 0);
    buffers.push(sellerFee);

    // ✅ CORREZIONE: Aggiunta la lista dei creatori, che è obbligatoria.
    // Option<Vec<Creator>>: Some(Vec)
    buffers.push(Buffer.from([1])); // 1 per Some (indica che la lista c'è)
    // Vec<Creator>: Lunghezza della lista (1 creatore)
    const creatorsLength = Buffer.alloc(4);
    creatorsLength.writeUInt32LE(1, 0);
    buffers.push(creatorsLength);
    // Dati del creatore
    buffers.push(accounts.payer.toBuffer()); // Indirizzo (32 bytes)
    buffers.push(Buffer.from([1])); // Verified: true (1 byte, perché il pagatore sta firmando)
    buffers.push(Buffer.from([100])); // Share: 100 (1 byte, 100%)
    
    // Collection (Option<Collection>) - None
    buffers.push(Buffer.from([0]));

    // Uses (Option<Uses>) - None
    buffers.push(Buffer.from([0]));
    // --- Fine Dati ---

    // isMutable (bool)
    buffers.push(Buffer.from([args.isMutable ? 1 : 0]));

    // collectionDetails (Option<CollectionDetails>) - None
    buffers.push(Buffer.from([0]));

    const data = Buffer.concat(buffers);

    return new TransactionInstruction({
        keys,
        programId: METADATA_PROGRAM_ID,
        data
    });
}

console.log('[SERVER - STARTUP] ✅ Metaplex metadata instruction loaded');

// --- CREDENZIALI PINATA ---
const PINATA_API_KEY = process.env.PINATA_API_KEY || '652df35488890fe4377c';
const PINATA_SECRET_API_KEY = process.env.PINATA_SECRET_API_KEY || '29b2db0dd13dbce7c036eb68386c61916887a4b470fd288a309343814fab0f03';

const PORT = process.env.PORT || 8443;

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', message: 'WebSocket Server' }));
});

const wss = new WebSocket.Server({ server, perMessageDeflate: false });

wss.on('connection', (ws) => {
    console.log('[WS] Client connesso');
    ws.on('message', (message) => handleWebSocketMessage(ws, message));
    ws.on('close', () => console.log('[WS] Client disconnesso'));
    ws.on('error', (err) => console.error('[WS] Errore WebSocket:', err));
});

async function handleWebSocketMessage(ws, message) {
    let data;
    try {
        data = JSON.parse(message);
    } catch (e) {
        return ws.send(JSON.stringify({ command: 'error', payload: { message: 'Invalid JSON' } }));
    }

    if (data.type === 'create_token') {
        await handleTokenCreation(ws, data);
    }
}

async function handleTokenCreation(ws, data) {
    console.log('[SERVER] Inizio creazione token...');
    try {
        const { name, symbol, description, imageBase64, supply, decimals, recipient, mintAddress, options } = data;

        // Validazione
        if (!name || !symbol || !supply || !recipient || !mintAddress) {
            throw new Error('Campi obbligatori mancanti');
        }

        const metadataUrl = await uploadMetadataToIPFS(name, symbol, description, imageBase64);
        console.log(`[SERVER] Metadati caricati: ${metadataUrl}`);

        const serializedTransaction = await buildTokenTransaction({ name, symbol, decimals, supply, recipient, mintAddress, metadataUrl, options });
        console.log('[SERVER] Transazione costruita. Invio al client...');

        ws.send(JSON.stringify({ 
            command: 'transaction_ready', 
            payload: { serializedTransaction, mintAddress } 
        }));

    } catch (err) {
        console.error('[SERVER] Errore creazione token:', err);
        ws.send(JSON.stringify({ command: 'error', payload: { message: err.message } }));
    }
}

async function uploadMetadataToIPFS(name, symbol, description, imageBase64) {
    const metadata = { name, symbol, description, seller_fee_basis_points: 0 };
    if (imageBase64) {
        const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');
        const formData = new FormData();
        formData.append('file', buffer, { filename: 'image.png' });
        
        const imgRes = await axios.post('https://api.pinata.cloud/pinning/pinFileToIPFS', formData, {
            maxBodyLength: 'Infinity',
            headers: { ...formData.getHeaders(), pinata_api_key: PINATA_API_KEY, pinata_secret_api_key: PINATA_SECRET_API_KEY },
        });
        metadata.image = `https://gateway.pinata.cloud/ipfs/${imgRes.data.IpfsHash}`;
    }
    
    const jsonRes = await axios.post('https://api.pinata.cloud/pinning/pinJSONToIPFS', metadata, {
        headers: { pinata_api_key: PINATA_API_KEY, pinata_secret_api_key: PINATA_SECRET_API_KEY, 'Content-Type': 'application/json' }
    });
    
    return `https://gateway.pinata.cloud/ipfs/${jsonRes.data.IpfsHash}`;
}

async function buildTokenTransaction(params) {
    const { name, symbol, decimals, supply, recipient, mintAddress, metadataUrl, options } = params;
    
    const connection = new Connection(clusterApiUrl('mainnet-beta'), 'confirmed');
    const mint = new PublicKey(mintAddress);
    const payer = new PublicKey(recipient);
    const mintAuthority = payer;
    const freezeAuthority = options?.freeze_authority ? payer : null;

    const lamports = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
    const associatedTokenAccount = await getAssociatedTokenAddress(mint, payer);

    const [metadataPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from('metadata'), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()], 
        METADATA_PROGRAM_ID
    );

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
                creators: null // La funzione custom ora gestisce questo internamente
            },
            isMutable: !options?.revoke_update_authority,
        }
    );

    const transaction = new Transaction().add(
        SystemProgram.createAccount({ fromPubkey: payer, newAccountPubkey: mint, space: MINT_SIZE, lamports, programId: TOKEN_PROGRAM_ID }),
        createInitializeMintInstruction(mint, decimals, mintAuthority, freezeAuthority),
        createAssociatedTokenAccountInstruction(payer, associatedTokenAccount, payer, mint),
        createMintToInstruction(mint, associatedTokenAccount, mintAuthority, BigInt(supply) * BigInt(10 ** decimals)),
        createMetadataInstruction
    );

    transaction.feePayer = payer;
    transaction.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;

    const serializedTransaction = transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
    
    return serializedTransaction;
}

server.listen(PORT, () => {
    console.log(`[SERVER] 🚀 Server in ascolto sulla porta ${PORT}`);
});
