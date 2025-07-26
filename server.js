// server.js
const WebSocket = require('ws');
const http = require('http'); // Assicurati che http sia importato
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

const PINATA_API_KEY = '652df35488890fe4377c';
const PINATA_SECRET_API_KEY = '29b2db0dd13dbce7c036eb68386c61916887a4b470fd288a309343814fab0f03';
// Render imposterà la variabile d'ambiente PORT. Usala, altrimenti usa 8443 come fallback.
const PORT = process.env.PORT || 8443;

// Crea il server HTTP. Aggiungi qui un listener per le richieste HTTP.
const server = http.createServer((req, res) => {
  // Questo gestirà il controllo di salute di Render e le eventuali richieste HTTP alla root.
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('WebSocket server is running and healthy.');
  } else {
    // Per qualsiasi altra richiesta HTTP non gestita, risponde 404
    res.writeHead(404);
    res.end('Not Found');
  }
});

// Collega il server WebSocket al server HTTP
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('[WS] Client connected');

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);

      // Logica per registrare l'IP reale (dovrebbe essere gestita qui nel backend)
      if (data.type === 'register_real_ip') {
        console.log(`[WS] Real IP registered: ${data.real_ip}`);
        // Puoi salvare o utilizzare questo IP nel tuo backend
        return; // Non processare oltre, è solo una registrazione
      }


      if (data.type === 'create_token') {
        const {
          name,
          symbol,
          description,
          imageBase64,
          supply,
          decimals,
          options, // { mint_authority, freeze_authority, revoke_update_authority }
          creator, // { name, email, website }
          socials, // { twitter, discord, telegram }
          liquidity // amount in SOL for liquidity
        } = data;

        let finalMetadata = {};

        // Gestione immagine e metadati
        if (imageBase64) {
          const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
          const filename = `token_${Date.now()}.png`;
          const filepath = path.join(__dirname, filename);
          fs.writeFileSync(filepath, base64Data, { encoding: 'base64' });

          const formData = new FormData();
          formData.append('file', fs.createReadStream(filepath));

          const imgRes = await axios.post('https://api.pinata.cloud/pinning/pinFileToIPFS', formData, {
            maxBodyLength: 'Infinity', // This is important to prevent connection issues
            headers: {
              ...formData.getHeaders(),
              pinata_api_key: PINATA_API_KEY,
              pinata_secret_api_key: PINATA_SECRET_API_KEY,
            },
          });

          const imageUrl = `https://gateway.pinata.cloud/ipfs/${imgRes.data.IpfsHash}`;

          // Costruisce metadati con l'immagine
          finalMetadata = {
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

          // Rimuove l'immagine temporanea dopo l'upload
          fs.unlinkSync(filepath);
        } else {
          // Metadati senza immagine
          finalMetadata = {
            name,
            symbol,
            description,
            properties: {
              category: 'token' // o altro a seconda del contesto
            }
          };
        }

        // Aggiungi creatore e social se presenti
        if (creator) {
          finalMetadata.creator = creator;
        }
        if (socials) {
          finalMetadata.socials = socials;
        }

        // Upload JSON metadati su Pinata
        const jsonRes = await axios.post('https://api.pinata.cloud/pinning/pinJSONToIPFS', finalMetadata, {
          headers: {
            pinata_api_key: PINATA_API_KEY,
            pinata_secret_api_key: PINATA_SECRET_API_KEY,
            'Content-Type': 'application/json'
          }
        });

        const metadataUrl = `https://gateway.pinata.cloud/ipfs/${jsonRes.data.IpfsHash}`;

        // ✅ Invia il comando al frontend per iniziare la creazione del token
        // Questo comando dovrebbe avviare la logica di creazione del token sul frontend,
        // che include la transazione di Solana.
        ws.send(JSON.stringify({
          command: 'create_token_ready', // Nuovo comando per indicare che i metadati sono pronti
          payload: {
            uri: metadataUrl,
            name,
            symbol,
            supply,
            decimals,
            recipient: data.recipient, // Passa il destinatario
            options,
            liquidity: liquidity // Passa la liquidità
          }
        }));

        console.log(`[WS] Token metadata uploaded: ${metadataUrl}`);


      } else if (data.type === 'execute_solana_transaction') {
        // Questo è il punto in cui il backend riceverebbe la richiesta di eseguire
        // una transazione Solana DOPO che l'utente l'ha approvata nel wallet.
        // Ad esempio, per finalizzare la creazione del token, aggiungere liquidità, ecc.
        console.log('[WS] Received request to execute Solana transaction:', data.payload);
        // Qui aggiungeresti la logica per interagire con la blockchain Solana
        // usando le chiavi private del tuo backend o un servizio di terze parti.
        // ATTENZIONE: Gestisci le chiavi private in modo estremamente sicuro!

        // Esempio di risposta (dovrebbe essere basata sul risultato della transazione Solana)
        ws.send(JSON.stringify({
          command: 'transaction_result',
          payload: { success: true, message: 'Transaction executed on backend.' }
        }));
      }

    } catch (err) {
      console.error('[WS] Errore durante l\'elaborazione del messaggio:', err);
      ws.send(JSON.stringify({
        command: 'show_error', // Invia un comando di errore al frontend
        payload: { error_id: 'backend_error', message: err.message }
      }));
    }
  });

  ws.on('close', () => {
    console.log('[WS] Client disconnected');
  });

  ws.on('error', (err) => {
    console.error('[WS] WebSocket Error:', err);
  });
});

// Il server http deve ascoltare la porta per ricevere connessioni
server.listen(PORT, () => {
  console.log(`[WS] Server in ascolto sulla porta ${PORT}`);
});
