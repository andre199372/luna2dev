// api/get-blockhash.js
const { Connection } = require('@solana/web3.js');

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
            const blockhash = await connection.getLatestBlockhash();
            return { connection, ...blockhash };
        } catch (error) {
            console.warn(`Failed to connect to ${endpoint}: ${error.message}`);
        }
    }
    throw new Error('No working RPC endpoints available');
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    try {
        const { blockhash, lastValidBlockHeight } = await getWorkingConnection();
        
        res.json({
            blockhash,
            lastValidBlockHeight
        });
        
    } catch (error) {
        console.error('Blockhash error:', error);
        res.status(500).json({ error: 'Failed to get blockhash: ' + error.message });
    }
};
