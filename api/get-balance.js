// api/get-balance.js
const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');

const RPC_ENDPOINTS = [
    'https://api.mainnet-beta.solana.com',
    process.env.ALCHEMY_API_KEY ? 
        `https://solana-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}` : null,
    'https://solana.public-rpc.com'
].filter(Boolean);

async function getWorkingConnection() {
    for (const endpoint of RPC_ENDPOINTS) {
        try {
            const connection = new Connection(endpoint, 'confirmed');
            await connection.getLatestBlockhash();
            return connection;
        } catch (error) {
            console.warn(`Failed to connect to ${endpoint}: ${error.message}`);
        }
    }
    throw new Error('No working RPC endpoints available');
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }
    
    try {
        const { publicKey } = req.body;
        
        if (!publicKey) {
            return res.status(400).json({ error: 'Public key is required' });
        }
        
        const pubkey = new PublicKey(publicKey);
        const connection = await getWorkingConnection();
        const balance = await connection.getBalance(pubkey);
        
        res.json({ 
            balance,
            balanceSOL: balance / LAMPORTS_PER_SOL
        });
        
    } catch (error) {
        console.error('Balance check error:', error);
        res.status(500).json({ error: 'Failed to get balance: ' + error.message });
    }
};
