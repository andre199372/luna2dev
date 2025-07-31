// /api/upload-metadata.js
const axios = require('axios');
const FormData = require('form-data');


const PINATA_API_KEY = process.env.PINATA_API_KEY;
const PINATA_SECRET_API_KEY = process.env.PINATA_SECRET_API_KEY;

// Funzione principale del serverless handler
module.exports = async function handler(req, res) {
    // Abilita CORS per permettere al tuo frontend di chiamare questa API
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Gestisce la richiesta pre-flight CORS
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // Accetta solo richieste POST
    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, error: 'Method Not Allowed' });
    }

    // Controlla che le chiavi API siano state configurate
    if (!PINATA_API_KEY || !PINATA_SECRET_API_KEY) {
        console.error('Pinata API keys are not set in environment variables.');
        return res.status(500).json({ success: false, error: 'Server configuration error: Missing API keys.' });
    }

    try {
        const { name, symbol, description, imageBase64 } = req.body;

        // Validazione dei dati ricevuti
        if (!name || !symbol) {
            return res.status(400).json({ success: false, error: 'Missing required fields: name and symbol' });
        }
        
        console.log(`[API] Received metadata for: ${name} (${symbol})`);

        // Costruisci l'oggetto metadata secondo lo standard Metaplex
        const metadata = {
            name,
            symbol,
            description: description || '',
            seller_fee_basis_points: 0,
            image: '', // Verrà popolato dopo l'upload dell'immagine
            attributes: [],
            properties: {
                files: [],
                category: 'image',
            },
        };

        // Se è stata fornita un'immagine, caricala su Pinata
        if (imageBase64) {
             console.log('[API] Uploading image to IPFS via Pinata...');
             const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
             const buffer = Buffer.from(base64Data, 'base64');
             const formData = new FormData();
             formData.append('file', buffer, { filename: 'token-logo.png' }); // Dà un nome al file
             
             const imgRes = await axios.post('https://api.pinata.cloud/pinning/pinFileToIPFS', formData, {
                 maxBodyLength: Infinity,
                 headers: { 
                     ...formData.getHeaders(),
                     'pinata_api_key': PINATA_API_KEY,
                     'pinata_secret_api_key': PINATA_SECRET_API_KEY
                 },
                 timeout: 30000
             });
             
             // Aggiorna l'URL dell'immagine nei metadati
             const imageUrl = `https://gateway.pinata.cloud/ipfs/${imgRes.data.IpfsHash}`;
             metadata.image = imageUrl;
             metadata.properties.files.push({ uri: imageUrl, type: 'image/png' });
             console.log(`[API] Image uploaded successfully: ${imageUrl}`);
        }

        // Carica il file JSON dei metadati completi su Pinata
        console.log('[API] Uploading metadata JSON to IPFS...');
        const jsonRes = await axios.post('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
            pinataContent: metadata,
            pinataMetadata: { name: `${name} Metadata` }
        }, {
            headers: {
                'pinata_api_key': PINATA_API_KEY,
                'pinata_secret_api_key': PINATA_SECRET_API_KEY,
                'Content-Type': 'application/json'
            },
            timeout: 30000
        });

        const metadataUrl = `https://gateway.pinata.cloud/ipfs/${jsonRes.data.IpfsHash}`;
        console.log(`[API] Metadata JSON uploaded successfully: ${metadataUrl}`);
        
        // Invia l'URL dei metadati al frontend
        res.status(200).json({
            success: true,
            metadataUrl: metadataUrl
        });

    } catch (error) {
        console.error('[API] Error during IPFS upload:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: error.message || 'An unknown error occurred during upload.'
        });
    }
};
