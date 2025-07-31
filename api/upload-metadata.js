// api/upload-metadata.js
const axios = require('axios');
const FormData = require('form-data');

const PINATA_API_KEY = process.env.PINATA_API_KEY;
const PINATA_SECRET_API_KEY = process.env.PINATA_SECRET_API_KEY;

// Simple rate limiting
const rateLimitMap = new Map();

function checkRateLimit(ip) {
    const now = Date.now();
    const windowMs = 60000; // 1 minute
    const maxRequests = 10;
    
    if (!rateLimitMap.has(ip)) {
        rateLimitMap.set(ip, []);
    }
    
    const requests = rateLimitMap.get(ip);
    const validRequests = requests.filter(time => now - time < windowMs);
    
    if (validRequests.length >= maxRequests) {
        return false;
    }
    
    validRequests.push(now);
    rateLimitMap.set(ip, validRequests);
    return true;
}

module.exports = async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, error: 'Method Not Allowed' });
    }

    // Rate limiting
    const clientIP = req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';
    if (!checkRateLimit(clientIP)) {
        return res.status(429).json({ 
            success: false, 
            error: 'Rate limit exceeded. Please try again later.' 
        });
    }

    // Check API keys
    if (!PINATA_API_KEY || !PINATA_SECRET_API_KEY) {
        console.error('Pinata API keys not configured');
        return res.status(500).json({ 
            success: false, 
            error: 'Server configuration error: Missing IPFS API keys' 
        });
    }

    try {
        const { name, symbol, description, imageBase64, website, twitter, telegram, discord, github } = req.body;

        // Validation
        if (!name || !symbol) {
            return res.status(400).json({ 
                success: false, 
                error: 'Missing required fields: name and symbol' 
            });
        }

        if (name.length > 32 || symbol.length > 10) {
            return res.status(400).json({ 
                success: false, 
                error: 'Name too long (max 32 chars) or symbol too long (max 10 chars)' 
            });
        }
        
        console.log(`[API] Processing metadata for: ${name} (${symbol})`);

        // Build metadata object following Metaplex standard
        const metadata = {
            name: name.trim(),
            symbol: symbol.trim().toUpperCase(),
            description: description?.trim() || '',
            seller_fee_basis_points: 0,
            image: '',
            external_url: website || '',
            attributes: [],
            properties: {
                files: [],
                category: 'image',
                creators: []
            }
        };

        // Add social links if provided
        if (twitter || telegram || discord || github) {
            metadata.properties.links = {};
            if (twitter) metadata.properties.links.twitter = twitter;
            if (telegram) metadata.properties.links.telegram = telegram;
            if (discord) metadata.properties.links.discord = discord;
            if (github) metadata.properties.links.github = github;
        }

        // Upload image if provided
        if (imageBase64) {
            console.log('[API] Uploading image to IPFS...');
            
            try {
                const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
                const buffer = Buffer.from(base64Data, 'base64');
                const formData = new FormData();
                formData.append('file', buffer, { 
                    filename: `${symbol.toLowerCase()}-logo.png`,
                    contentType: 'image/png'
                });
                
                const imgRes = await axios.post('https://api.pinata.cloud/pinning/pinFileToIPFS', formData, {
                    maxBodyLength: Infinity,
                    headers: { 
                        ...formData.getHeaders(),
                        'pinata_api_key': PINATA_API_KEY,
                        'pinata_secret_api_key': PINATA_SECRET_API_KEY
                    },
                    timeout: 25000
                });
                
                const imageUrl = `https://gateway.pinata.cloud/ipfs/${imgRes.data.IpfsHash}`;
                metadata.image = imageUrl;
                metadata.properties.files.push({ 
                    uri: imageUrl, 
                    type: 'image/png' 
                });
                
                console.log(`[API] Image uploaded: ${imageUrl}`);
            } catch (error) {
                console.error('[API] Image upload failed:', error.message);
                // Continue without image rather than failing completely
                console.log('[API] Continuing without image...');
            }
        }

        // Upload metadata JSON
        console.log('[API] Uploading metadata JSON...');
        const jsonRes = await axios.post('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
            pinataContent: metadata,
            pinataMetadata: { 
                name: `${name} Token Metadata`,
                keyvalues: {
                    symbol: symbol,
                    type: 'token-metadata'
                }
            }
        }, {
            headers: {
                'pinata_api_key': PINATA_API_KEY,
                'pinata_secret_api_key': PINATA_SECRET_API_KEY,
                'Content-Type': 'application/json'
            },
            timeout: 25000
        });

        const metadataUrl = `https://gateway.pinata.cloud/ipfs/${jsonRes.data.IpfsHash}`;
        console.log(`[API] Metadata uploaded: ${metadataUrl}`);
        
        res.status(200).json({
            success: true,
            metadataUrl: metadataUrl,
            imageUrl: metadata.image || null
        });

    } catch (error) {
        console.error('[API] Upload error:', error.response?.data || error.message);
        
        let errorMessage = 'Upload failed';
        if (error.code === 'ECONNABORTED') {
            errorMessage = 'Upload timeout - please try again';
        } else if (error.response?.status === 401) {
            errorMessage = 'Invalid IPFS API credentials';
        } else if (error.response?.status === 413) {
            errorMessage = 'File too large';
        }
        
        res.status(500).json({
            success: false,
            error: errorMessage
        });
    }
};
