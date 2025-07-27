// api/create-token.js
const axios = require('axios');
const FormData = require('form-data');
const {
    Connection, PublicKey, Transaction, SystemProgram, clusterApiUrl, SYSVAR_RENT_PUBKEY
} = require('@solana/web3.js');
const {
    createInitializeMintInstruction, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction,
    createMintToInstruction, MINT_SIZE, TOKEN_PROGRAM_ID
} = require('@solana/spl-token');
const { 
    createCreateMetadataAccountV3Instruction, PROGRAM_ID: METADATA_PROGRAM_ID 
} = require('@metaplex-foundation/mpl-token-metadata');

// --- PINATA CREDENTIALS ---
const PINATA_API_KEY = process.env.PINATA_API_KEY || '652df35488890fe4377c';
const PINATA_SECRET_API_KEY = process.env.PINATA_SECRET_API_KEY || '29b2db0dd13dbce7c036eb68386c61916887a4b470fd288a309343814fab0f03';

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const data = req.body;
        
        console.log('[API] Token creation request received.');
        
        // Upload metadata to IPFS
        const metadataUrl = await uploadMetadataToIPFS(data);
        console.log(`[API] Metadata uploaded: ${metadataUrl}`);

        // Build transaction
        const serializedTransaction = await buildTokenTransaction({ ...data, metadataUrl });
        console.log('[API] Transaction built successfully.');

        res.status(200).json({ 
            success: true, 
            serializedTransaction 
        });

    } catch (error) {
        console.error('[API] Error during token creation:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message || 'An unknown error occurred.' 
        });
    }
}

async function uploadMetadataToIPFS({ name, symbol, description, imageBase64 }) {
    const metadata = { 
        name, 
        symbol, 
        description, 
        seller_fee_basis_points: 0, 
        properties: { files: [], category: 'image' }
    };
    
    if (imageBase64) {
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
        });
        
        metadata.image = `https://gateway.pinata.cloud/ipfs/${imgRes.data.IpfsHash}`;
        metadata.properties.files.push({ uri: metadata.image, type: 'image/png' });
    }
    
    const jsonRes = await axios.post('https://api.pinata.cloud/pinning/pinJSONToIPFS', metadata, {
        headers: { 
            pinata_api_key: PINATA_API_KEY, 
            pinata_secret_api_key: PINATA_SECRET_API_KEY, 
            'Content-Type': 'application/json' 
        }
    });
    
    return `https://gateway.pinata.cloud/ipfs/${jsonRes.data.IpfsHash}`;
}

async function buildTokenTransaction(params) {
    const { name, symbol, decimals, supply, recipient, mintAddress, metadataUrl, options } = params;
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
    transaction.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
    
    return transaction.serialize({ 
        requireAllSignatures: false, 
        verifySignatures: false 
    }).toString('base64');
}
