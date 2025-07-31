// /api/verify-payment.js
const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');

// --- CONFIGURAZIONE ---
const FEE_SOL = 0.3;
const FEE_RECIPIENT_ADDRESS = 'BeEbsaq4dKfzZQBK6zet4wj8UJCTF9zzU7QLgWpERqBg';
const EXPECTED_FEE_LAMPORTS = FEE_SOL * LAMPORTS_PER_SOL;

// Funzione per verificare la transazione con tentativi
async function verifyTransaction(signature, payerAddress) {
    const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
    
    // Tenta per 60 secondi
    for (let i = 0; i < 60; i++) {
        try {
            const tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
            if (tx) {
                // 1. Controlla che la transazione non sia fallita
                if (tx.meta.err) {
                    throw new Error('La transazione di pagamento è fallita on-chain.');
                }

                // 2. Controlla il pagante
                const signer = tx.transaction.message.accountKeys[0].toBase58();
                if (signer !== payerAddress) {
                    throw new Error('Il pagante non corrisponde.');
                }

                // 3. Controlla l'istruzione di trasferimento
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
                const lamportsTransferred = tx.meta.postBalances[destAccountIndex] - tx.meta.preBalances[destAccountIndex];

                if (recipient !== FEE_RECIPIENT_ADDRESS) {
                    throw new Error('Destinatario della commissione non corretto.');
                }
                if (lamportsTransferred < EXPECTED_FEE_LAMPORTS) {
                    throw new Error('Importo della commissione non corretto.');
                }
                
                // Se tutti i controlli passano, la transazione è valida
                return true;
            }
        } catch (error) {
            // Se c'è un errore durante il recupero, potrebbe essere un errore di rete, riprova
            console.warn(`Tentativo ${i + 1}: Errore nel recupero della transazione, riprovo...`);
        }
        // Attendi un secondo prima del prossimo tentativo
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    // Se il loop finisce, la transazione non è stata trovata o confermata in tempo
    throw new Error('Verifica della transazione scaduta. Non è stato possibile confermare il pagamento.');
}


module.exports = async (req, res) => {
    // Gestione CORS e metodo
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    const { signature, payer } = req.body;
    if (!signature || !payer) {
        return res.status(400).json({ error: 'Signature e Payer sono obbligatori.' });
    }

    try {
        await verifyTransaction(signature, payer);
        res.status(200).json({ success: true, message: 'Pagamento verificato con successo.' });
    } catch (error) {
        console.error(`Verifica fallita per la firma ${signature}:`, error.message);
        res.status(400).json({ success: false, error: error.message });
    }
};
