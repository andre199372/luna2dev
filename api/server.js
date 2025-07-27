// server.js (Full Stack: Client HTML + WebSocket Server for Vercel)
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
    SYSVAR_RENT_PUBKEY
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

// --- PINATA CREDENTIALS ---
const PINATA_API_KEY = process.env.PINATA_API_KEY || '652df35488890fe4377c';
const PINATA_SECRET_API_KEY = process.env.PINATA_SECRET_API_KEY || '29b2db0dd13dbce7c036eb68386c61916887a4b470fd288a309343814fab0f03';

// --- WebSocket Server Logic ---
const wss = new WebSocket.Server({ noServer: true });

wss.on('connection', (ws) => {
    console.log('[WS] Client connected successfully!');
    
    ws.on('message', async (message) => {
        let data;
        try {
            data = JSON.parse(message.toString());
        } catch (e) {
            console.error('[WS] JSON parsing error:', e);
            ws.send(JSON.stringify({ command: 'error', payload: { message: 'Invalid JSON format.' } }));
            return;
        }

        if (data.type === 'create_token') {
            console.log('[SERVER] Received token creation request.');
            try {
                const metadataUrl = await uploadMetadataToIPFS(data);
                console.log(`[SERVER] Metadata uploaded: ${metadataUrl}`);

                const serializedTransaction = await buildTokenTransaction({ ...data, metadataUrl });
                console.log('[SERVER] Transaction built. Sending to client...');

                ws.send(JSON.stringify({ 
                    command: 'transaction_ready', 
                    payload: { serializedTransaction } 
                }));

            } catch (err) {
                console.error('[SERVER] Error during token creation:', err);
                ws.send(JSON.stringify({ command: 'error', payload: { message: err.message || 'An unknown error occurred.' } }));
            }
        }
    });

    ws.on('close', () => console.log('[WS] Client disconnected.'));
    ws.on('error', (err) => console.error('[WS] WebSocket Error:', err));
});


// --- Vercel Serverless Function Handler ---
module.exports = (req, res) => {
    if (req.headers['upgrade']?.toLowerCase() === 'websocket') {
        wss.handleUpgrade(req, req.socket, Buffer.alloc(0), (ws) => {
            wss.emit('connection', ws, req);
        });
    } else {
        // Serve the HTML client page
        res.setHeader('Content-Type', 'text/html');
        res.status(200).send(getHtmlClient());
    }
};

// --- Helper Functions ---

async function uploadMetadataToIPFS({ name, symbol, description, imageBase64 }) {
    const metadata = { name, symbol, description, seller_fee_basis_points: 0, properties: { files: [], category: 'image' }};
    
    if (imageBase64) {
        const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');
        const formData = new FormData();
        formData.append('file', buffer, { filename: 'image.png' });
        
        const imgRes = await axios.post('https://api.pinata.cloud/pinning/pinFileToIPFS', formData, {
            maxBodyLength: Infinity,
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
        creators: null,
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

    const createMetadataInstruction = createCreateMetadataAccountV3Instruction(accounts, args);

    const transaction = new Transaction().add(
        SystemProgram.createAccount({ fromPubkey: payer, newAccountPubkey: mint, space: MINT_SIZE, lamports, programId: TOKEN_PROGRAM_ID }),
        createInitializeMintInstruction(mint, decimals, mintAuthority, freezeAuthority),
        createAssociatedTokenAccountInstruction(payer, associatedTokenAccount, payer, mint),
        createMintToInstruction(mint, associatedTokenAccount, mintAuthority, BigInt(supply) * BigInt(10 ** decimals)),
        createMetadataInstruction
    );

    transaction.feePayer = payer;
    transaction.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;

    return transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}


function getHtmlClient() {
    return `
        <!DOCTYPE html>
        <html lang="it">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Luna Launch - Create Solana Token</title>
            
            <script src="https://cdn.jsdelivr.net/npm/sweetalert2@11"></script>
            <script src="https://unpkg.com/@solana/web3.js@latest/lib/index.iife.min.js"></script>
            
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #000; color: #fff; margin: 0; display: flex; flex-direction: column; min-height: 100vh; }
                header, footer { text-align: center; padding: 20px; border-bottom: 1px solid #333; }
                footer { border-bottom: none; border-top: 1px solid #333; margin-top: auto; }
                main { flex: 1; display: flex; justify-content: center; padding: 40px 20px; }
                .container { max-width: 600px; width: 100%; }
                h1 { margin-bottom: 10px; }
                p { color: #aaa; margin-bottom: 40px; }
                .form { background-color: #1a1a1a; border-radius: 16px; padding: 30px; }
                .form-group { margin-bottom: 20px; }
                label { display: block; font-weight: 500; margin-bottom: 8px; }
                input, textarea { width: 100%; background-color: #2c2c2c; border: 1px solid #444; border-radius: 8px; color: white; padding: 12px; font-size: 16px; box-sizing: border-box; }
                .checkbox-group { display: flex; align-items: center; gap: 10px; }
                .btn { display: block; width: 100%; background-color: #6c63ff; color: white; border: none; border-radius: 30px; padding: 15px; font-size: 16px; font-weight: 600; cursor: pointer; transition: background-color 0.3s, opacity 0.3s; }
                .btn:disabled { background-color: #555; opacity: 0.7; cursor: not-allowed; }
                .btn:hover:not(:disabled) { background-color: #5a52d5; }
                .upload-area { border: 2px dashed #444; border-radius: 10px; padding: 20px; text-align: center; cursor: pointer; }
                #logo-preview { max-width: 100px; max-height: 100px; margin-top: 10px; border-radius: 8px; display: none; }
            </style>
        </head>
        <body>
            <header>
                <h1>Solana Token Creator</h1>
            </header>
            <main>
                <div class="container">
                    <p>Crea il tuo token Solana in pochi semplici passaggi.</p>
                    <form class="form" id="token-form">
                        <div class="form-group">
                            <label for="tokenName">Nome Token *</label>
                            <input required type="text" id="tokenName" placeholder="Es: Pepe Coin">
                        </div>
                        <div class="form-group">
                            <label for="tokenSymbol">Simbolo Token *</label>
                            <input type="text" id="tokenSymbol" placeholder="Es: PEPE" required>
                        </div>
                        <div class="form-group">
                            <label for="tokenDecimals">Decimali *</label>
                            <input type="number" id="tokenDecimals" value="9" required>
                        </div>
                        <div class="form-group">
                            <label for="tokenSupply">Fornitura *</label>
                            <input type="number" id="tokenSupply" required value="1000000">
                        </div>
                        <div class="form-group">
                            <label for="tokenDescription">Descrizione *</label>
                            <textarea id="tokenDescription" rows="3" placeholder="Descrivi il tuo token" required></textarea>
                        </div>
                        <div class="form-group">
                             <label>Logo (Opzionale)</label>
                             <div class="upload-area" id="logoDropzone">
                                 <span>Trascina o clicca per caricare</span>
                                 <input type="file" id="logoUpload" accept="image/*" style="display: none;">
                                 <img id="logo-preview" />
                             </div>
                        </div>
                         <div class="form-group checkbox-group">
                            <input type="checkbox" id="revokeUpdate" />
                            <label for="revokeUpdate">Rendi i metadati immutabili</label>
                        </div>
                         <div class="form-group checkbox-group">
                            <input type="checkbox" id="revokeFreeze" checked />
                            <label for="revokeFreeze">Disabilita il congelamento</label>
                        </div>
                        <div class="form-group">
                            <label for="tokenRecipient">Destinatario dei Token (il tuo wallet) *</label>
                            <input type="text" id="tokenRecipient" placeholder="Connetti il wallet per compilare automaticamente" required>
                        </div>
                        <button type="button" class="btn" id="connectWalletBtn">Connetti Wallet</button>
                        <button type="submit" class="btn" id="launchTokenBtn" style="margin-top: 10px;" disabled>Connessione al server...</button>
                    </form>
                </div>
            </main>
            <footer>
                <p>© Luna Launch 2025</p>
            </footer>

            <script>
                document.addEventListener('DOMContentLoaded', () => {
                    const connectWalletBtn = document.getElementById('connectWalletBtn');
                    const launchTokenBtn = document.getElementById('launchTokenBtn');
                    const tokenForm = document.getElementById('token-form');
                    const tokenRecipientInput = document.getElementById('tokenRecipient');
                    const logoDropzone = document.getElementById('logoDropzone');
                    const logoUpload = document.getElementById('logoUpload');
                    const logoPreview = document.getElementById('logo-preview');
                    let ws;
                    let mintKeypair;
                    let logoBase64 = null;

                    // --- WebSocket Connection ---
                    function connectWebSocket() {
                        launchTokenBtn.textContent = 'Connessione al server...';
                        launchTokenBtn.disabled = true;

                        const wsUrl = 'wss://' + window.location.host;
                        ws = new WebSocket(wsUrl);

                        ws.onopen = () => {
                            console.log('[WS] Connessione aperta.');
                            launchTokenBtn.textContent = 'Lancia Token';
                            launchTokenBtn.disabled = false;
                        };

                        ws.onmessage = async (event) => {
                            const data = JSON.parse(event.data);
                            if (data.command === 'error') {
                                Swal.fire('Errore dal Server', data.payload.message, 'error');
                            } else if (data.command === 'transaction_ready') {
                                await signAndSendTransaction(data.payload.serializedTransaction);
                            }
                        };

                        ws.onclose = () => {
                            console.warn('[WS] Connessione chiusa.');
                            launchTokenBtn.textContent = 'Riconnessione... (Ricarica la pagina)';
                            launchTokenBtn.disabled = true;
                        };

                        ws.onerror = (err) => {
                            console.error('[WS] Errore di connessione.', err);
                            launchTokenBtn.textContent = 'Connessione Fallita (Ricarica la pagina)';
                            launchTokenBtn.disabled = true;
                        };
                    }
                    connectWebSocket();

                    // --- Wallet Logic ---
                    const getProvider = () => window.phantom?.solana;
                    
                    connectWalletBtn.addEventListener('click', async () => {
                        const provider = getProvider();
                        if (provider) {
                            try {
                                const resp = await provider.connect();
                                const publicKey = resp.publicKey.toString();
                                connectWalletBtn.textContent = \`Connesso: \${publicKey.slice(0, 4)}...\${publicKey.slice(-4)}\`;
                                tokenRecipientInput.value = publicKey;
                            } catch (err) {
                                Swal.fire('Errore', 'Connessione al wallet rifiutata.', 'error');
                            }
                        } else {
                            window.open('https://phantom.app/', '_blank');
                        }
                    });

                    // --- Logo Upload Logic ---
                    logoDropzone.addEventListener('click', () => logoUpload.click());
                    logoUpload.addEventListener('change', (e) => {
                        if (e.target.files.length) {
                            const file = e.target.files[0];
                            const reader = new FileReader();
                            reader.onload = (event) => {
                                logoBase64 = event.target.result;
                                logoPreview.src = logoBase64;
                                logoPreview.style.display = 'block';
                            };
                            reader.readAsDataURL(file);
                        }
                    });

                    // --- Form Submission ---
                    tokenForm.addEventListener('submit', async (e) => {
                        e.preventDefault();
                        const provider = getProvider();

                        if (!provider || !provider.publicKey) {
                            return Swal.fire('Wallet non connesso', 'Per favore connetti il tuo wallet Phantom.', 'warning');
                        }
                        if (!ws || ws.readyState !== WebSocket.OPEN) {
                             return Swal.fire('Errore di Connessione', 'Connessione al server non disponibile.', 'error');
                        }

                        mintKeypair = solanaWeb3.Keypair.generate();
                        
                        const tokenData = {
                            type: 'create_token',
                            name: document.getElementById('tokenName').value,
                            symbol: document.getElementById('tokenSymbol').value,
                            description: document.getElementById('tokenDescription').value,
                            imageBase64: logoBase64,
                            supply: parseFloat(document.getElementById('tokenSupply').value),
                            decimals: parseInt(document.getElementById('tokenDecimals').value, 10),
                            recipient: tokenRecipientInput.value,
                            mintAddress: mintKeypair.publicKey.toBase58(),
                            options: {
                                freeze_authority: !document.getElementById('revokeFreeze').checked,
                                revoke_update_authority: document.getElementById('revokeUpdate').checked,
                            }
                        };
                        
                        ws.send(JSON.stringify(tokenData));
                        
                        Swal.fire({
                            title: 'In attesa...',
                            text: 'Stiamo preparando la transazione. Controlla il tuo wallet a breve.',
                            icon: 'info',
                            allowOutsideClick: false,
                            didOpen: () => Swal.showLoading()
                        });
                    });

                    async function signAndSendTransaction(serializedTransaction) {
                        const provider = getProvider();
                        try {
                            const serializedBuffer = new Uint8Array(atob(serializedTransaction).split('').map(char => char.charCodeAt(0)));
                            const transaction = solanaWeb3.Transaction.from(serializedBuffer);
                            transaction.partialSign(mintKeypair);

                            const { signature } = await provider.signAndSendTransaction(transaction);
                            
                            await new solanaWeb3.Connection(solanaWeb3.clusterApiUrl('mainnet-beta')).confirmTransaction(signature, 'confirmed');

                            Swal.fire({
                                title: 'Successo!',
                                html: \`Token creato con successo!<br><a href="https://solscan.io/tx/\${signature}" target="_blank">Vedi su Solscan</a>\`,
                                icon: 'success'
                            });
                        } catch (err) {
                            console.error('Errore di firma:', err);
                            Swal.fire('Errore', err.message || 'La transazione è stata annullata o è fallita.', 'error');
                        }
                    }
                });
            </script>
        </body>
        </html>
    `;
}
