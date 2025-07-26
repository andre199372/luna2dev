// server.js
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

const PINATA_API_KEY = '652df35488890fe4377c';
const PINATA_SECRET_API_KEY = '29b2db0dd13dbce7c036eb68386c61916887a4b470fd288a309343814fab0f03';
const PORT = process.env.PORT || 8443;

const server = http.createServer();
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('[WS] Client connected');

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === 'create_token') {
        const {
          name,
          symbol,
          description,
          imageBase64,
          supply,
          decimals,
          options // { mint_authority, freeze_authority, revoke_update_authority }
        } = data;

        // Salva temporaneamente l'immagine
        const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
        const filename = `token_${Date.now()}.png`;
        const filepath = path.join(__dirname, filename);
        fs.writeFileSync(filepath, base64Data, { encoding: 'base64' });

        // Upload immagine su Pinata
        const formData = new FormData();
        formData.append('file', fs.createReadStream(filepath));

        const imgRes = await axios.post('https://api.pinata.cloud/pinning/pinFileToIPFS', formData, {
          maxBodyLength: Infinity,
          headers: {
            ...formData.getHeaders(),
            pinata_api_key: PINATA_API_KEY,
            pinata_secret_api_key: PINATA_SECRET_API_KEY,
          },
        });

        const imageUrl = `https://gateway.pinata.cloud/ipfs/${imgRes.data.IpfsHash}`;

        // Costruisce metadati
        const metadata = {
          name,
          symbol,
          description,
          image: imageUrl,
          properties: {
            files: [
              {
                uri: imageUrl,
                type: 'image/png'
              }
            ],
            category: 'image'
          }
        };

        // Upload JSON metadati
        const jsonRes = await axios.post('https://api.pinata.cloud/pinning/pinJSONToIPFS', metadata, {
          headers: {
            pinata_api_key: PINATA_API_KEY,
            pinata_secret_api_key: PINATA_SECRET_API_KEY,
            'Content-Type': 'application/json'
          }
        });

        const metadataUrl = `https://gateway.pinata.cloud/ipfs/${jsonRes.data.IpfsHash}`;

        // ✅ Invia il comando al frontend per iniziare la creazione del token
        ws.send(JSON.stringify({
          command: 'create_token',
          payload: {
            uri: metadataUrl
          }
        }));

        // 🧼 Rimuove l'immagine temporanea
        fs.unlinkSync(filepath);
      }

    } catch (err) {
      console.error('[WS] Error:', err);
      ws.send(JSON.stringify({ status: 'error', message: err.message }));
    }
  });

  ws.on('close', () => {
    console.log('[WS] Client disconnected');
  });
});

server.listen(PORT, () => {
  console.log(`[WS] Server listening on port ${PORT}`);
});
