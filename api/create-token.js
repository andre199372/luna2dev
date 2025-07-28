async function uploadMetadataToIPFS({ name, symbol, description, imageBase64, creator, social }) {
    try {
        const metadata = { 
            name, 
            symbol, 
            description: description || '', 
            seller_fee_basis_points: 0, 
            properties: { files: [],// api/create-token.js
const axios = require('axios');
const FormData = require('form-data');

// --- PINATA CREDENTIALS ---
const PINATA_API_KEY = process.env.PINATA_API_KEY || '652df35488890fe4377c';
const PINATA_SECRET_API_KEY = process.env.PINATA_SECRET_API_KEY || '29b2db0dd13dbce7c036eb68386c61916887a4b470fd288a309343814fab0f03';

module.exports = async function handler(req, res) {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ 
            success: false, 
            error: 'Method not allowed' 
        });
    }

    try {
        const data = req.body;
        
        console.log('[API] Token creation request received.');
        console.log('[API] Request data keys:', Object.keys(data));
        
        // Validate required fields
        if (!data.name || !data.symbol || !data.recipient || !data.mintAddress) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: name, symbol, recipient, or mintAddress'
            });
        }

        // First, try just the metadata upload
        console.log('[API] Starting metadata upload...');
        const metadataUrl = await uploadMetadataToIPFS(data);
        console.log(`[API] Metadata uploaded: ${metadataUrl}`);

        // Then try to load Solana libraries
        console.log('[API] Loading Solana libraries...');
        let Connection, PublicKey, Transaction, SystemProgram, clusterApiUrl, SYSVAR_RENT_PUBKEY;
        let createInitializeMintInstruction, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction;
        let createMintToInstruction, MINT_SIZE, TOKEN_PROGRAM_ID;
        let createCreateMetadataAccountV3Instruction, METADATA_PROGRAM_ID;

        try {
            const web3 = require('@solana/web3.js');
            const splToken = require('@solana/spl-token');
            const mplMetadata = require('@metaplex-foundation/mpl-token-metadata');
            
            Connection = web3.Connection;
            PublicKey = web3.PublicKey;
            Transaction = web3.Transaction;
            SystemProgram = web3.SystemProgram;
            clusterApiUrl = web3.clusterApiUrl;
            SYSVAR_RENT_PUBKEY = web3.SYSVAR_RENT_PUBKEY;
            
            createInitializeMintInstruction = splToken.createInitializeMintInstruction;
            getAssociatedTokenAddress = splToken.getAssociatedTokenAddress;
            createAssociatedTokenAccountInstruction = splToken.createAssociatedTokenAccountInstruction;
            createMintToInstruction = splToken.createMintToInstruction;
            MINT_SIZE = splToken.MINT_SIZE;
            TOKEN_PROGRAM_ID = splToken.TOKEN_PROGRAM_ID;
            
            createCreateMetadataAccountV3Instruction = mplMetadata.createCreateMetadataAccountV3Instruction;
            METADATA_PROGRAM_ID = mplMetadata.PROGRAM_ID;
            
            console.log('[API] Solana libraries loaded successfully');
        } catch (libError) {
            console.error('[API] Error loading Solana libraries:', libError);
            throw new Error(`Failed to load Solana libraries: ${libError.message}`);
        }

        // Build transaction
        console.log('[API] Building transaction...');
        const serializedTransaction = await buildTokenTransaction({ 
            ...data, 
            metadataUrl,
            Connection,
            PublicKey,
            Transaction,
            SystemProgram,
            clusterApiUrl,
            SYSVAR_RENT_PUBKEY,
            createInitializeMintInstruction,
            getAssociatedTokenAddress,
            createAssociatedTokenAccountInstruction,
            createMintToInstruction,
            MINT_SIZE,
            TOKEN_PROGRAM_ID,
            createCreateMetadataAccountV3Instruction,
            METADATA_PROGRAM_ID
        });
        console.log('[API] Transaction built successfully.');

        res.status(200).json({ 
            success: true, 
            serializedTransaction,
            metadataUrl
        });

    } catch (error) {
        console.error('[API] Error during token creation:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message || 'An unknown error occurred.',
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
};

async function uploadMetadataToIPFS({ name, symbol, description, imageBase64 }) {
    try {
        const metadata = { 
            name, 
            symbol, 
            description: description || '', 
            seller_fee_basis_points: 0, 
            properties: { files: [], category: 'image' }
        };
        
        if (imageBase64) {
            console.log('[API] Uploading image to IPFS...');
            const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
            const buffer = Buffer.from(base64Data, 'base64');
            const formData = new FormData();
            formData.append('file', buffer, { filename: 'image.png' });
            
            const imgRes = await axios.post('https://api.pinata.cloud/pinning/pinFileToIPFS', formData, {
                maxBodyLength: Infinity,
                headers: { 
                    ...formData.getHeaders(), 
                    pinata_api_key: PINATA_API_KEY, 
                    pinata_secret_api_key: PINATA_SECRET_API_KEY 
                },
                timeout: 30000
            });
            
            metadata.image = `https://gateway.pinata.cloud/ipfs/${imgRes.data.IpfsHash}`;
            metadata.properties.files.push({ uri: metadata.image, type: 'image/png' });
            console.log('[API] Image uploaded successfully');
        }
        
        console.log('[API] Uploading metadata JSON to IPFS...');
        const jsonRes = await axios.post('https://api.pinata.cloud/pinning/pinJSONToIPFS', metadata, {
            headers: { 
                pinata_api_key: PINATA_API_KEY, 
                pinata_secret_api_key: PINATA_SECRET_API_KEY, 
                'Content-Type': 'application/json' 
            },
            timeout: 30000
        });
        
        console.log('[API] Metadata JSON uploaded successfully');
        return `https://gateway.pinata.cloud/ipfs/${jsonRes.data.IpfsHash}`;
        
    } catch (error) {
        console.error('[API] IPFS upload error:', error.response?.data || error.message);
        throw new Error(`IPFS upload failed: ${error.message}`);
    }
}

async function buildTokenTransaction(params) {
    try {
        const { 
            name, symbol, decimals, supply, recipient, mintAddress, metadataUrl, options,
            Connection, PublicKey, Transaction, SystemProgram, clusterApiUrl, SYSVAR_RENT_PUBKEY,
            createInitializeMintInstruction, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction,
            createMintToInstruction, MINT_SIZE, TOKEN_PROGRAM_ID,
            createCreateMetadataAccountV3Instruction, METADATA_PROGRAM_ID
        } = params;
        
        console.log('[API] Building transaction with params:', {
            name,
            symbol,
            decimals,
            supply,
            recipient: recipient.substring(0, 8) + '...',
            mintAddress: mintAddress.substring(0, 8) + '...',
            metadataUrl
        });
        
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
            name, 
            symbol, 
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
                collectionDetails: null 
            },
        };
        
        const createMetadataInstruction = createCreateMetadataAccountV3Instruction(accounts, args);
        
        const transaction = new Transaction().add(
            SystemProgram.createAccount({ 
                fromPubkey: payer, 
                newAccountPubkey: mint, 
                space: MINT_SIZE, 
                lamports, 
                programId: TOKEN_PROGRAM_ID 
            }),
            createInitializeMintInstruction(mint, decimals, mintAuthority, freezeAuthority),
            createAssociatedTokenAccountInstruction(payer, associatedTokenAccount, payer, mint),
            createMintToInstruction(mint, associatedTokenAccount, mintAuthority, BigInt(supply) * BigInt(10 ** decimals)),
            createMetadataInstruction
        );
        
        transaction.feePayer = payer;
        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        transaction.recentBlockhash = blockhash;
        
        console.log('[API] Transaction built successfully');
        return transaction.serialize({ 
            requireAllSignatures: false, 
            verifySignatures: false 
        }).toString('base64');
        
    } catch (error) {
        console.error('[API] Transaction build error:', error);
        throw new Error(`Transaction build failed: ${error.message}`);
    }
}
