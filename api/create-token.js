// api/create-token.js
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
        
        const web3 = require('@solana/web3.js');
        const splToken = require('@solana/spl-token');
        
        console.log('[API] Solana libraries loaded successfully');

        // Build transaction
        console.log('[API] Building transaction...');
        const serializedTransaction = await buildTokenTransaction({ 
            ...data, 
            metadataUrl,
            web3,
            splToken
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

async function uploadMetadataToIPFS({ name, symbol, description, imageBase64, creator, social }) {
    try {
        const metadata = { 
            name, 
            symbol, 
            description: description || '', 
            seller_fee_basis_points: 0, 
            properties: { files: [], category: 'image' },
            attributes: []
        };

        // Add creator info if provided
        if (creator && creator.name) {
            metadata.properties.creator = creator.name;
            if (creator.address) {
                metadata.creators = [{
                    address: creator.address,
                    verified: false,
                    share: 100
                }];
            }
        }

        // Add social links if provided
        if (social) {
            const externalUrl = social.website || social.twitter || social.telegram || social.discord;
            if (externalUrl) {
                metadata.external_url = externalUrl;
            }
            
            // Add social links to attributes
            if (social.website) {
                metadata.attributes.push({
                    trait_type: "Website",
                    value: social.website
                });
            }
            if (social.twitter) {
                metadata.attributes.push({
                    trait_type: "Twitter",
                    value: social.twitter
                });
            }
            if (social.telegram) {
                metadata.attributes.push({
                    trait_type: "Telegram",
                    value: social.telegram
                });
            }
            if (social.discord) {
                metadata.attributes.push({
                    trait_type: "Discord",
                    value: social.discord
                });
            }
        }
        
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

// Manual metadata instruction creation to avoid Metaplex library issues
function createMetadataInstruction(metadata, mint, mintAuthority, updateAuthority, isMutable) {
    const METADATA_PROGRAM_ID = new (require('@solana/web3.js')).PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
    
    const keys = [
        { pubkey: metadata, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: mintAuthority, isSigner: true, isWritable: false },
        { pubkey: mintAuthority, isSigner: true, isWritable: false }, // payer
        { pubkey: updateAuthority, isSigner: false, isWritable: false },
        { pubkey: require('@solana/web3.js').SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: require('@solana/web3.js').SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
    ];

    // Create metadata account instruction data
    const instructionData = Buffer.concat([
        Buffer.from([33]), // CreateMetadataAccountV3 discriminator
        Buffer.from([1]), // CreateMetadataAccountArgsV3 discriminator
        encodeString(metadata.name),
        encodeString(metadata.symbol),
        encodeString(metadata.uri),
        Buffer.from([0, 0]), // seller_fee_basis_points (u16)
        Buffer.from([0]), // creators option (None)
        Buffer.from([0]), // collection option (None)
        Buffer.from([0]), // uses option (None)
        Buffer.from([isMutable ? 1 : 0]), // is_mutable
        Buffer.from([0]) // collection_details option (None)
    ]);

    return new (require('@solana/web3.js')).TransactionInstruction({
        keys,
        programId: METADATA_PROGRAM_ID,
        data: instructionData
    });
}

function encodeString(str) {
    const stringBytes = Buffer.from(str, 'utf8');
    const lengthBytes = Buffer.alloc(4);
    lengthBytes.writeUInt32LE(stringBytes.length, 0);
    return Buffer.concat([lengthBytes, stringBytes]);
}

async function buildTokenTransaction(params) {
    try {
        const { 
            name, symbol, decimals, supply, recipient, mintAddress, metadataUrl, options,
            web3, splToken
        } = params;
        
        console.log('[API] Building transaction with params:', {
            name,
            symbol,
            decimals,
            supply,
            recipient: recipient.substring(0, 8) + '...',
            mintAddress: mintAddress.substring(0, 8) + '...',
            metadataUrl,
            options
        });
        
        const connection = new web3.Connection(web3.clusterApiUrl('mainnet-beta'), 'confirmed');
        const mint = new web3.PublicKey(mintAddress);
        const payer = new web3.PublicKey(recipient);
        const freezeAuthority = options?.freeze_authority ? payer : null;
        const updateAuthority = options?.revoke_update_authority ? null : payer;
        
        const lamports = await connection.getMinimumBalanceForRentExemption(splToken.MINT_SIZE);
        const associatedTokenAccount = await splToken.getAssociatedTokenAddress(mint, payer);
        
        // Metaplex Token Metadata Program ID
        const METADATA_PROGRAM_ID = new web3.PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
        
        const [metadataPDA] = web3.PublicKey.findProgramAddressSync(
            [Buffer.from('metadata'), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
            METADATA_PROGRAM_ID
        );

        const metadataData = {
            name, 
            symbol, 
            uri: metadataUrl
        };
        
        const createMetadataInstr = createMetadataInstruction(
            metadataData, 
            mint, 
            payer, 
            updateAuthority || payer, 
            !options?.revoke_update_authority
        );
        
        const instructions = [
            // Create mint account
            web3.SystemProgram.createAccount({ 
                fromPubkey: payer, 
                newAccountPubkey: mint, 
                space: splToken.MINT_SIZE, 
                lamports, 
                programId: splToken.TOKEN_PROGRAM_ID 
            }),
            // Initialize mint with initial authorities
            splToken.createInitializeMintInstruction(mint, decimals, payer, freezeAuthority),
            // Create associated token account
            splToken.createAssociatedTokenAccountInstruction(payer, associatedTokenAccount, payer, mint),
            // Mint tokens to the associated account
            splToken.createMintToInstruction(mint, associatedTokenAccount, payer, BigInt(supply) * BigInt(10 ** decimals)),
            // Create metadata
            createMetadataInstr
        ];

        // If mint authority should be revoked, add instruction to set it to null
        if (options?.revoke_mint_authority) {
            instructions.push(
                splToken.createSetAuthorityInstruction(
                    mint, // mint
                    payer, // current authority
                    splToken.AuthorityType.MintTokens, // authority type
                    null // new authority (null = revoke)
                )
            );
        }
        
        const transaction = new web3.Transaction().add(...instructions);
        
        transaction.feePayer = payer;
        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        transaction.recentBlockhash = blockhash;
        
        console.log('[API] Transaction built successfully with authorities:', {
            mintAuthority: options?.revoke_mint_authority ? 'REVOKED' : 'RETAINED',
            freezeAuthority: options?.freeze_authority ? 'RETAINED' : 'REVOKED',
            updateAuthority: options?.revoke_update_authority ? 'REVOKED' : 'RETAINED'
        });
        
        return transaction.serialize({ 
            requireAllSignatures: false, 
            verifySignatures: false 
        }).toString('base64');
        
    } catch (error) {
        console.error('[API] Transaction build error:', error);
        throw new Error(`Transaction build failed: ${error.message}`);
    }
}
