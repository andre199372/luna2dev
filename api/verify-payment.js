// /api/verify-payment.js
const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');

// --- CONFIGURAZIONE ---
const FEE_SOL = 0.3;
const FEE_RECIPIENT_ADDRESS = 'BeEbsaq4dKfzZQBK6zet4wj8UJCTF9zzU7QLgWpERqBg';
const EXPECTED_FEE_LAMPORTS = FEE_SOL * LAMPORTS_PER_SOL;

// ENDPOINT RPC aggiornati e testati - solo mainnet funzionanti
const RPC_ENDPOINTS = [
    'https://api.mainnet-beta.solana.com',
    'https://solana-api.projectserum.com', 
    'https://solana.public-rpc.com',
    'https://rpc.helius.xyz/?api-key=public',
    'https://api.metaplex.solana.com',
    'https://solana-mainnet.phantom.app/YBPpkkN'
];

// Funzione per creare una connessione con fallback e timeout
async function createConnectionWithFallback() {
    const errors = [];
    
    for (let i = 0; i < RPC_ENDPOINTS.length; i++) {
        const endpoint = RPC_ENDPOINTS[i];
        try {
            console.log(`[API] Tentativo ${i + 1}/${RPC_ENDPOINTS.length}: Connessione a ${endpoint}`);
            
            const connection = new Connection(endpoint, {
                commitment: 'confirmed',
                disableRetryOnRateLimit: false,
                confirmTransactionInitialTimeout: 30000
            });
            
            // Test della connessione con timeout
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Connection timeout')), 8000)
            );
            
            const testPromise = connection.getLatestBlockhash('confirmed');
            
            await Promise.race([testPromise, timeoutPromise]);
            
            console.log(`[API] ✅ Connesso con successo a ${endpoint}`);
            return connection;
            
        } catch (error) {
            const errorMsg = `${endpoint}: ${error.message}`;
            errors.push(errorMsg);
            console.warn(`[API] ❌ Fallimento ${i + 1}: ${errorMsg}`);
            
            // Breve pausa prima del prossimo tentativo
            if (i < RPC_ENDPOINTS.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    }
    
    throw new Error(`Nessun endpoint RPC disponibile. Errori: ${errors.join('; ')}`);
}

// Funzione per verificare la transazione con tentativi e fallback RPC
async function verifyTransaction(signature, payerAddress) {
    const connection = await createConnectionWithFallback();
    
    console.log(`[API] 🔍 Inizio verifica transazione: ${signature}`);
    console.log(`[API] 👤 Payer atteso: ${payerAddress}`);
    console.log(`[API] 💰 Importo atteso: ${FEE_SOL} SOL (${EXPECTED_FEE_LAMPORTS} lamports)`);
    console.log(`[API] 🎯 Destinatario atteso: ${FEE_RECIPIENT_ADDRESS}`);
    
    // Tenta per 60 secondi con intervalli intelligenti
    const maxAttempts = 20;
    const baseDelay = 2000; // 2 secondi base
    
    for (let i = 0; i < maxAttempts; i++) {
        try {
            console.log(`[API] Tentativo ${i + 1}/${maxAttempts}: Verifica transazione...`);
            
            const tx = await connection.getTransaction(signature, { 
                maxSupportedTransactionVersion: 0,
                commitment: 'confirmed'
            });
            
            if (tx) {
                console.log('[API] 📦 Transazione trovata, verifica in corso...');
                
                // 1. Controlla che la transazione non sia fallita
                if (tx.meta.err) {
                    console.error('[API] ❌ Transazione fallita:', tx.meta.err);
                    throw new Error('La transazione di pagamento è fallita on-chain: ' + JSON.stringify(tx.meta.err));
                }
                
                // 2. Controlla il pagante
                const signer = tx.transaction.message.accountKeys[0].toBase58();
                console.log(`[API] 👤 Payer effettivo: ${signer}`);
                
                if (signer !== payerAddress) {
                    throw new Error(`Il pagante non corrisponde. Atteso: ${payerAddress}, Ricevuto: ${signer}`);
                }
                
                // 3. Trova l'istruzione di trasferimento del System Program
                const transferInstruction = tx.transaction.message.instructions.find(ix => {
                    const programId = tx.transaction.message.accountKeys[ix.programIdIndex].toBase58();
                    return programId === '11111111111111111111111111111111'; // System Program
                });
                
                if (!transferInstruction) {
                    console.error('[API] ❌ Nessuna istruzione di trasferimento trovata');
                    throw new Error('Nessuna istruzione di trasferimento trovata nella transazione.');
                }
                
                // 4. Controlla il destinatario e l'importo
                const destAccountIndex = transferInstruction.accounts[1];
                const recipient = tx.transaction.message.accountKeys[destAccountIndex].toBase58();
                
                console.log(`[API] 🎯 Destinatario effettivo: ${recipient}`);
                
                if (recipient !== FEE_RECIPIENT_ADDRESS) {
                    throw new Error(`Destinatario della commissione non corretto. Atteso: ${FEE_RECIPIENT_ADDRESS}, Ricevuto: ${recipient}`);
                }
                
                // Calcola l'importo trasferito
                const lamportsTransferred = tx.meta.postBalances[destAccountIndex] - tx.meta.preBalances[destAccountIndex];
                const solTransferred = lamportsTransferred / LAMPORTS_PER_SOL;
                
                console.log(`[API] 💰 Importo trasferito: ${solTransferred} SOL (${lamportsTransferred} lamports)`);
                
                if (lamportsTransferred < EXPECTED_FEE_LAMPORTS) {
                    throw new Error(`Importo della commissione insufficiente. Atteso: ${EXPECTED_FEE_LAMPORTS} lamports (${FEE_SOL} SOL), Ricevuto: ${lamportsTransferred} lamports (${solTransferred} SOL)`);
                }
                
                console.log(`[API] ✅ Pagamento verificato con successo!`);
                console.log(`[API] 📊 Dettagli: ${solTransferred} SOL trasferiti da ${signer} a ${recipient}`);
                
                return {
                    verified: true,
                    signature,
                    amount: solTransferred,
                    payer: signer,
                    recipient,
                    timestamp: new Date().toISOString()
                };
            }
            
        } catch (error) {
            // Se è un errore di verifica (non di rete), rilancia subito
            if (error.message.includes('pagante non corrisponde') || 
                error.message.includes('Destinatario della commissione') ||
                error.message.includes('Importo della commissione') ||
                error.message.includes('transazione è fallita')) {
                throw error;
            }
            
            // Per errori di rete, logga e continua
            console.warn(`[API] ⚠️ Tentativo ${i + 1}: Errore nel recupero della transazione:`, error.message);
        }
        
        // Attendi con backoff esponenziale
        const delay = Math.min(baseDelay * Math.pow(1.2, i), 8000); // Max 8 secondi
        console.log(`[API] ⏳ Attesa ${delay}ms prima del prossimo tentativo...`);
        await new Promise(resolve => setTimeout(resolve, delay));
    }
    
    // Se il loop finisce, la transazione non è stata trovata o confermata in tempo
    throw new Error(`Timeout: Non è stato possibile confermare il pagamento entro ${maxAttempts} tentativi. La transazione potrebbe non essere ancora confermata sulla blockchain o potresti essere connesso alla rete sbagliata.`);
}

module.exports = async (req, res) => {
    // Gestione CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    if (req.method !== 'POST') {
        return res.status(405).json({ 
            success: false, 
            error: 'Method Not Allowed' 
        });
    }
    
    const { signature, payer } = req.body;
    
    // Validazione input
    if (!signature || !payer) {
        return res.status(400).json({ 
            success: false, 
            error: 'Signature e Payer sono obbligatori.' 
        });
    }
    
    // Validazione formato signature
    if (typeof signature !== 'string' || signature.length < 80) {
        return res.status(400).json({ 
            success: false, 
            error: 'Formato signature non valido.' 
        });
    }
    
    // Validazione formato payer (deve essere una valid base58 pubkey)
    try {
        new PublicKey(payer);
    } catch (error) {
        return res.status(400).json({ 
            success: false, 
            error: 'Formato payer address non valido.' 
        });
    }
    
    try {
        console.log(`[API] 🚀 Inizio verifica pagamento`);
        console.log(`[API] 📝 Signature: ${signature}`);
        console.log(`[API] 👤 Payer: ${payer}`);
        console.log(`[API] 🌐 Endpoints disponibili: ${RPC_ENDPOINTS.length}`);
        
        const result = await verifyTransaction(signature, payer);
        
        console.log(`[API] ✅ Verifica completata con successo`);
        
        res.status(200).json({ 
            success: true, 
            message: 'Pagamento verificato con successo.',
            data: result
        });
        
    } catch (error) {
        console.error(`[API] ❌ Verifica fallita per la firma ${signature.substring(0, 20)}...:`);
        console.error(`[API] 📋 Errore completo:`, error.message);
        
        // Determina il tipo di errore per il codice di stato appropriato
        let statusCode = 400;
        if (error.message.includes('Timeout') || error.message.includes('endpoint RPC')) {
            statusCode = 503; // Service Unavailable
        } else if (error.message.includes('transazione è fallita')) {
            statusCode = 422; // Unprocessable Entity
        }
        
        res.status(statusCode).json({ 
            success: false, 
            error: error.message,
            signature: signature.substring(0, 20) + '...', // Solo primi 20 caratteri per log sicuri
            timestamp: new Date().toISOString()
        });
    }
};
