// /api/verify-payment.js
const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');

// --- CONFIGURAZIONE ---
const FEE_SOL = 0.3;
const FEE_RECIPIENT_ADDRESS = 'BeEbsaq4dKfzZQBK6zet4wj8UJCTF9zzU7QLgWpERqBg';
const EXPECTED_FEE_LAMPORTS = FEE_SOL * LAMPORTS_PER_SOL;

// Lista di RPC endpoints gratuiti da provare in ordine
const RPC_ENDPOINTS = [
    'https://api.mainnet-beta.solana.com',
    'https://solana-api.projectserum.com',
    'https://rpc.ankr.com/solana',
    'https://solana-mainnet.g.alchemy.com/v2/demo', // Alchemy demo
    'https://mainnet.helius-rpc.com/?api-key=demo'   // Helius demo
];

// Funzione per creare una connessione con fallback
function createConnectionWithFallback() {
    for (const endpoint of RPC_ENDPOINTS) {
        try {
            return new Connection(endpoint, 'confirmed');
        } catch (error) {
            console.warn(`Fallimento connessione a ${endpoint}:`, error.message);
            continue;
        }
    }
    throw new Error('Nessun endpoint RPC disponibile');
}

// Funzione per verificare la transazione con tentativi e fallback RPC
async function verifyTransaction(signature, payerAddress) {
    const connection = createConnectionWithFallback();
    
    // Tenta per 60 secondi
    for (let i = 0; i < 60; i++) {
        try {
            console.log(`Tentativo ${i + 1}: Verifica transazione ${signature}`);
            
            const tx = await connection.getTransaction(signature, { 
                maxSupportedTransactionVersion: 0,
                commitment: 'confirmed'
            });
            
            if (tx) {
                console.log('Transazione trovata, verifica in corso...');
                
                // 1. Controlla che la transazione non sia fallita
                if (tx.meta.err) {
                    throw new Error('La transazione di pagamento è fallita on-chain.');
                }
                
                // 2. Controlla il pagante
                const signer = tx.transaction.message.accountKeys[0].toBase58();
                if (signer !== payerAddress) {
                    throw new Error(`Il pagante non corrisponde. Atteso: ${payerAddress}, Ricevuto: ${signer}`);
                }
                
                // 3. Trova l'istruzione di trasferimento del System Program
                const transferInstruction = tx.transaction.message.instructions.find(ix => {
                    const programId = tx.transaction.message.accountKeys[ix.programIdIndex].toBase58();
                    return programId === '11111111111111111111111111111111'; // System Program
                });
                
                if (!transferInstruction) {
                    throw new Error('Nessuna istruzione di trasferimento trovata.');
                }
                
                // 4. Controlla il destinatario e l'importo
                const destAccountIndex = transferInstruction.accounts[1];
                const recipient = tx.transaction.message.accountKeys[destAccountIndex].toBase58();
                
                if (recipient !== FEE_RECIPIENT_ADDRESS) {
                    throw new Error(`Destinatario della commissione non corretto. Atteso: ${FEE_RECIPIENT_ADDRESS}, Ricevuto: ${recipient}`);
                }
                
                // Calcola l'importo trasferito
                const lamportsTransferred = tx.meta.postBalances[destAccountIndex] - tx.meta.preBalances[destAccountIndex];
                
                if (lamportsTransferred < EXPECTED_FEE_LAMPORTS) {
                    throw new Error(`Importo della commissione insufficiente. Atteso: ${EXPECTED_FEE_LAMPORTS}, Ricevuto: ${lamportsTransferred}`);
                }
                
                console.log(`✅ Pagamento verificato: ${lamportsTransferred / LAMPORTS_PER_SOL} SOL trasferiti a ${recipient}`);
                return true;
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
            console.warn(`Tentativo ${i + 1}: Errore nel recupero della transazione:`, error.message);
        }
        
        // Attendi un secondo prima del prossimo tentativo
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Se il loop finisce, la transazione non è stata trovata o confermata in tempo
    throw new Error('Timeout: Non è stato possibile confermare il pagamento entro 60 secondi. La transazione potrebbe non essere ancora confermata sulla blockchain.');
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
        return res.status(405).json({ error: 'Method Not Allowed' });
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
        console.log(`🔍 Inizio verifica pagamento - Signature: ${signature}, Payer: ${payer}`);
        
        await verifyTransaction(signature, payer);
        
        console.log(`✅ Verifica completata con successo per ${payer}`);
        
        res.status(200).json({ 
            success: true, 
            message: 'Pagamento verificato con successo.',
            verifiedAt: new Date().toISOString()
        });
        
    } catch (error) {
        console.error(`❌ Verifica fallita per la firma ${signature}:`, error.message);
        
        res.status(400).json({ 
            success: false, 
            error: error.message,
            signature: signature.substring(0, 20) + '...' // Solo primi 20 caratteri per log sicuri
        });
    }
};
