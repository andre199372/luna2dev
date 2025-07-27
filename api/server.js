// /api/server.js

// Importazioni delle librerie necessarie
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const axios = require('axios');
const FormData = require('form-data');
const {
    Connection,
    PublicKey,
    Transaction,
    SystemProgram,
    clusterApiUrl,
    SYSVAR_RENT_PUBKEY
} = require('@solana/web3.js');
const {
    createInitializeMintInstruction,
    getAssociatedTokenAddress,
    createAssociatedTokenAccountInstruction,
    createMintToInstruction,
    MINT_SIZE,
    TOKEN_PROGRAM_ID,
} = require('@solana/spl-token');
const mplTokenMetadata = require('@metaplex-foundation/mpl-token-metadata');

const METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

console.log('[SERVER - STARTUP] Librerie caricate.');

// --- CREDENZIALI PINATA ---
const PINATA_API_KEY = process.env.PINATA_API_KEY || '652df35488890fe4377c';
const PINATA_SECRET_API_KEY = process.env.PINATA_SECRET_API_KEY || '29b2db0dd13dbce7c036eb68386c61916887a4b470fd288a309343814fab0f03';

// Crea un'istanza del WebSocket Server senza un server HTTP.
// Vercel fornirà il server.
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws) => {
    console.log('[WS] Client connesso con successo.');
    
    ws.on('message', (message) => handleWebSocketMessage(ws, message));
    ws.on('close', () => console.log('[WS] Client disconnesso'));
    ws.on('error', (err) => console.error('[WS] Errore WebSocket:', err));
});

async function handleWebSocketMessage(ws, message) {
    let data;
    try {
        data = JSON.parse(message);
    } catch (e) {
        console.error('[WS] Errore parsing JSON:', e);
        ws.send(JSON.stringify({ command: 'error', payload: { message: 'Invalid JSON' } }));
        return;
    }

    if (data.type === 'create_token') {
        await handleTokenCreation(ws, data);
    }
}

async function handleTokenCreation(ws, data) {
    console.log('[SERVER] Inizio creazione token...');
    try {
        const { name, symbol, description, imageBase64, supply, decimals, recipient, mintAddress, options } = data;

        if (!name || !symbol || !supply || !recipient || !mintAddress) {
            throw new Error('Campi obbligatori mancanti.');
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
        console.error('[SERVER] Errore durante la creazione del token:', err);
        ws.send(JSON.stringify({ command: 'error', payload: { message: err.message } }));
    }
}

async function uploadMetadataToIPFS(name, symbol, description, imageBase64) {
    const metadata = { name, symbol, description, seller_fee_basis_points: 0, properties: { files: [], category: '' } };
    if (imageBase64) {
        const buffer = Buffer.from(imageBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        const formData = new FormData();
        formData.append('file', buffer, { filename: 'image.png' });
        
        const imgRes = await axios.post('https://api.pinata.cloud/pinning/pinFileToIPFS', formData, {
            maxBodyLength: 'Infinity',
            headers: { ...formData.getHeaders(), pinata_api_key: PINATA_API_KEY, pinata_secret_api_key: PINATA_SECRET_API_KEY },
        });
        metadata.image = `https://gateway.pinata.cloud/ipfs/${imgRes.data.IpfsHash}`;
        metadata.properties.files.push({ uri: metadata.image, type: 'image/png' });
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

    const accounts = {
        metadata: metadataPDA,
        mint: mint,
        mintAuthority: mintAuthority,
        payer: payer,
        updateAuthority: mintAuthority,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
    };

    const dataV2 = {
        name: name,
        symbol: symbol,
        uri: metadataUrl,
        sellerFeeBasisPoints: 0,
        creators: [{ address: payer, verified: true, share: 100 }],
        collection: null,
        uses: null,
    };
    
    const args = {
        createMetadataAccountArgsV3: {
            data: dataV2,
            isMutable: !options?.revoke_update_authority,
            collectionDetails: null,
        },
    };

    const createMetadataInstruction = mplTokenMetadata.createCreateMetadataAccountV3Instruction(accounts, args);

    const transaction = new Transaction().add(
        SystemProgram.createAccount({ fromPubkey: payer, newAccountPubkey: mint, space: MINT_SIZE, lamports, programId: TOKEN_PROGRAM_ID }),
        createInitializeMintInstruction(mint, decimals, mintAuthority, freezeAuthority),
        createAssociatedTokenAccountInstruction(payer, associatedTokenAccount, payer, mint),
        createMintToInstruction(mint, associatedTokenAccount, mintAuthority, BigInt(supply) * BigInt(10 ** decimals)),
        createMetadataInstruction
    );

    transaction.feePayer = payer;
    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    return transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}

// ✅ Questo è l'handler serverless per Vercel
const server = createServer();
server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});

// Vercel non usa server.listen(), quindi lo rimuoviamo.
// Esportiamo il server per essere usato dalla piattaforma.
module.exports = server;
