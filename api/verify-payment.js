// api/verify-payment.js  
const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');

const FEE_SOL = 0.3;
const FEE_RECIPIENT_ADDRESS = 'BeEbsaq4dKfzZQBK6zet4wj8UJCTF9zzU7QLgWpERqBg';
const EXPECTED_FEE_LAMPORTS = FEE_SOL * LAMPORTS_PER_SOL;

// Enhanced RPC endpoints with fallbacks
const RPC_ENDPOINTS = [
    'https://api.mainnet-beta.solana.com',
    'https://solana-api.projectserum.com',
    'https://solana.public-rpc.com',
    process.env.ALCHEMY_API_KEY ? 
        `https://solana-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}` : 
        'https://solana-mainnet.g.alchemy.com/v2/demo',
    process.env.HELIUS_API_KEY ? 
        `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : 
        'https://rpc.helius.xyz/?api-key=public',
    'https://api.metaplex.solana.com',
    process.env.QUICKNODE_ENDPOINT
].filter(Boolean);

// Rate limiting
const verificationAttempts = new Map();

function checkVerificationRateLimit(ip) {
    const now = Date.now();
    const windowMs = 300000; // 5 minutes
    const maxAttempts = 20;
    
    if (!verificationAttempts.has(ip)) {
        verificationAttempts.set(ip, []);
    }
    
    const attempts = verificationAttempts.get(ip);
    const validAttempts = attempts.filter(time => now - time < windowMs);
    
    if (validAttempts.length >= maxAttempts) {
        return false;
    }
    
    validAttempts.push(now);
    verificationAttempts.set(ip, validAttempts);
    return true;
}

async function createConnectionWithFallback() {
    const errors = [];
    
    for (let i = 0; i < RPC_ENDPOINTS.length; i++) {
        const endpoint = RPC_ENDPOINTS[i];
        try {
            console.log(`[API] Trying endpoint ${i + 1}/${RPC_ENDPOINTS.length}: ${endpoint}`);
            
            const connection = new Connection(endpoint, {
                commitment: 'confirmed',
                disableRetryOnRateLimit: false,
                confirmTransactionInitialTimeout: 30000
            });
            
            // Test connection with timeout
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Connection timeout')), 8000)
            );
            
            await Promise.race([
                connection.getLatestBlockhash('confirmed'),
                timeoutPromise
            ]);
            
            console.log(`[API] ✅ Connected to ${endpoint}`);
            return connection;
            
        } catch (error) {
            const errorMsg = `${endpoint}: ${error.message}`;
            errors.push(errorMsg);
            console.warn(`[API] ❌ Failed ${i + 1}: ${errorMsg}`);
            
            if (i < RPC_ENDPOINTS.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    }
    
    throw new Error(`All RPC endpoints failed. Errors: ${errors.join('; ')}`);
}

async function verifyTransaction(signature, payerAddress) {
    const connection = await createConnectionWithFallback();
    
    console.log(`[API] 🔍 Verifying transaction: ${signature}`);
    console.log(`[API] 👤 Expected payer: ${payerAddress}`);
    console.log(`[API] 💰 Expected amount: ${FEE_SOL} SOL (${EXPECTED_FEE_LAMPORTS} lamports)`);
    console.log(`[API] 🎯 Expected recipient: ${FEE_RECIPIENT_ADDRESS}`);
    
    const maxAttempts = 20;
    const baseDelay = 2000;
    
    for (let i = 0; i < maxAttempts; i++) {
        try {
            console.log(`[API] Attempt ${i + 1}/${maxAttempts}: Checking transaction...`);
            
            const tx = await connection.getTransaction(signature, { 
                maxSupportedTransactionVersion: 0,
                commitment: 'confirmed'
            });
            
            if (tx) {
                console.log('[API] 📦 Transaction found, verifying...');
                
                // Check if transaction failed
                if (tx.meta.err) {
                    console.error('[API] ❌ Transaction failed:', tx.meta.err);
                    throw new Error(`Payment transaction failed on-chain: ${JSON.stringify(tx.meta.err)}`);
                }
                
                // Verify payer
                const signer = tx.transaction.message.accountKeys[0].toBase58();
                console.log(`[API] 👤 Actual payer: ${signer}`);
                
                if (signer !== payerAddress) {
                    throw new Error(`Payer mismatch. Expected: ${payerAddress}, Got: ${signer}`);
                }
                
                // Find System Program transfer instruction
                const transferInstruction = tx.transaction.message.instructions.find(ix => {
                    const programId = tx.transaction.message.accountKeys[ix.programIdIndex].toBase58();
                    return programId === '11111111111111111111111111111111';
                });
                
                if (!transferInstruction) {
                    console.error('[API] ❌ No transfer instruction found');
                    throw new Error('No transfer instruction found in transaction');
                }
                
                // Verify recipient and amount
                const destAccountIndex = transferInstruction.accounts[1];
                const recipient = tx.transaction.message.accountKeys[destAccountIndex].toBase58();
                
                console.log(`[API] 🎯 Actual recipient: ${recipient}`);
                
                if (recipient !== FEE_RECIPIENT_ADDRESS) {
                    throw new Error(`Fee recipient incorrect. Expected: ${FEE_RECIPIENT_ADDRESS}, Got: ${recipient}`);
                }
                
                // Calculate transferred amount
                const lamportsTransferred = tx.meta.postBalances[destAccountIndex] - tx.meta.preBalances[destAccountIndex];
                const solTransferred = lamportsTransferred / LAMPORTS_PER_SOL;
                
                console.log(`[API] 💰 Amount transferred: ${solTransferred} SOL (${lamportsTransferred} lamports)`);
                
                // Allow small tolerance for rounding
                const tolerance = EXPECTED_FEE_LAMPORTS * 0.001; // 0.1%
                if (lamportsTransferred < EXPECTED_FEE_LAMPORTS - tolerance) {
                    throw new Error(`Insufficient fee amount. Expected: ${EXPECTED_FEE_LAMPORTS} lamports (${FEE_SOL} SOL), Got: ${lamportsTransferred} lamports (${solTransferred} SOL)`);
                }
                
                console.log(`[API] ✅ Payment verified successfully!`);
                
                return {
                    verified: true,
                    signature,
                    amount: solTransferred,
                    payer: signer,
                    recipient,
                    blockTime: tx.blockTime,
                    timestamp: new Date().toISOString()
                };
            }
            
        } catch (error) {
            // If validation error, throw immediately
            if (error.message.includes('Payer mismatch') || 
                error.message.includes('Fee recipient') ||
                error.message.includes('Insufficient fee') ||
                error.message.includes('failed on-chain')) {
                throw error;
            }
            
            console.warn(`[API] ⚠️ Attempt ${i + 1}: ${error.message}`);
        }
        
        // Wait with exponential backoff
        const delay = Math.min(baseDelay * Math.pow(1.2, i), 8000);
        console.log(`[API] ⏳ Waiting ${delay}ms before next attempt...`);
        await new Promise(resolve => setTimeout(resolve, delay));
    }
    
    throw new Error(`Timeout: Could not confirm payment within ${maxAttempts} attempts. Transaction may not be confirmed yet or you might be on wrong network.`);
}

module.exports = async (req, res) => {
    // CORS
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
    
    // Rate limiting
    const clientIP = req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';
    if (!checkVerificationRateLimit(clientIP)) {
        return res.status(429).json({ 
            success: false, 
            error: 'Too many verification attempts. Please wait before retrying.' 
        });
    }
    
    const { signature, payer } = req.body;
    
    // Input validation
    if (!signature || !payer) {
        return res.status(400).json({ 
            success: false, 
            error: 'Signature and payer are required' 
        });
    }
    
    if (typeof signature !== 'string' || signature.length < 80) {
        return res.status(400).json({ 
            success: false, 
            error: 'Invalid signature format' 
        });
    }
    
    try {
        new PublicKey(payer);
    } catch (error) {
        return res.status(400).json({ 
            success: false, 
            error: 'Invalid payer address format' 
        });
    }
    
    try {
        console.log(`[API] 🚀 Starting payment verification`);
        console.log(`[API] 📝 Signature: ${signature}`);
        console.log(`[API] 👤 Payer: ${payer}`);
        console.log(`[API] 🌐 Available endpoints: ${RPC_ENDPOINTS.length}`);
        
        const result = await verifyTransaction(signature, payer);
        
        console.log(`[API] ✅ Verification completed successfully`);
        
        res.status(200).json({ 
            success: true, 
            message: 'Payment verified successfully',
            data: result
        });
        
    } catch (error) {
        console.error(`[API] ❌ Verification failed for ${signature.substring(0, 20)}...:`);
        console.error(`[API] 📋 Full error:`, error.message);
        
        let statusCode = 400;
        if (error.message.includes('Timeout') || error.message.includes('RPC endpoints')) {
            statusCode = 503;
        } else if (error.message.includes('failed on-chain')) {
            statusCode = 422;
        }
        
        res.status(statusCode).json({ 
            success: false, 
            error: error.message,
            signature: signature.substring(0, 20) + '...',
            timestamp: new Date().toISOString()
        });
    }
};
