// server.js
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

// Assicurati che queste chiavi siano configurate come variabili d'ambiente in produzione per sicurezza
const PINATA_API_KEY = '652df35488890fe4377c'; 
const PINATA_SECRET_API_KEY = '29b2db0dd13dbce7c036eb68386c61916887a4b470fd288a309343814fab0f03';
const PORT = process.env.PORT || 8443;

const server = http.createServer();
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('[WS] Client connesso');

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
          recipient, // Aggiunto il destinatario del token
          options, // { mint_authority, freeze_authority, revoke_update_authority }
          creator, // Opzionale: { address, name }
          socials, // Opzionale: { telegram, twitter, website, discord }
          liquidity // Opzionale: { sol_amount, token_amount, fee_tier }
        } = data;

        // Validazione minima dei dati in entrata
        if (!name || !symbol || !description || !supply || !decimals || !recipient) {
          ws.send(JSON.stringify({
            command: 'show_error',
            payload: {
              error_id: "2", // Un ID di errore generico per dati mancanti
              amount: "N/A", // Non più rilevante per il pagamento diretto
              message: "Dati token incompleti."
            }
          }));
          return;
        }

        let imageUrl = '';
        if (imageBase64) {
          // Salva temporaneamente l'immagine
          const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
          const filename = `token_${Date.now()}.png`;
          const filepath = path.join(__dirname, filename);
          fs.writeFileSync(filepath, base64Data, { encoding: 'base64' });

          // Upload immagine su Pinata
          const formData = new FormData();
          formData.append('file', fs.createReadStream(filepath));

          try {
            const imgRes = await axios.post('https://api.pinata.cloud/pinning/pinFileToIPFS', formData, {
              maxBodyLength: Infinity,
              headers: {
                ...formData.getHeaders(),
                pinata_api_key: PINATA_API_KEY,
                pinata_secret_api_key: PINATA_SECRET_API_KEY,
              },
            });
            imageUrl = `https://gateway.pinata.cloud/ipfs/${imgRes.data.IpfsHash}`;
            console.log(`[Pinata] Immagine caricata: ${imageUrl}`);
          } catch (pinataErr) {
            console.error('[Pinata] Errore caricamento immagine:', pinataErr.response ? pinataErr.response.data : pinataErr.message);
            ws.send(JSON.stringify({
              command: 'show_error',
              payload: {
                error_id: "2", // Errore nel caricamento dell'immagine
                amount: "N/A",
                message: "Impossibile caricare l'immagine del token."
              }
            }));
            fs.unlinkSync(filepath); // Rimuovi l'immagine temporanea anche in caso di errore
            return;
          } finally {
            fs.unlinkSync(filepath); // Rimuovi l'immagine temporanea
          }
        }

        // Costruisci metadati
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
          },
          // Aggiungi campi opzionali se presenti
          ...(creator && { creator }),
          ...(socials && { socials })
        };

        // Upload JSON metadati su Pinata
        const jsonRes = await axios.post('https://api.pinata.cloud/pinning/pinJSONToIPFS', metadata, {
          headers: {
            pinata_api_key: PINATA_API_KEY,
            pinata_secret_api_key: PINATA_SECRET_API_KEY,
            'Content-Type': 'application/json'
          }
        });

        const metadataUrl = `https://gateway.pinata.cloud/ipfs/${jsonRes.data.IpfsHash}`;
        console.log(`[Pinata] Metadati caricati: ${metadataUrl}`);

        // TODO: Qui dovresti integrare la logica per creare il token Solana on-chain.
        // Questo potrebbe includere l'uso di @solana/web3.js e @solana/spl-token nel backend,
        // o chiamare un altro servizio che gestisce la creazione on-chain.
        // Assicurati che il wallet del server abbia abbastanza SOL per coprire le commissioni di rete.

        // Per ora, invia al frontend il comando per informare che la creazione è iniziata
        // e che l'utente dovrà approvare la transazione dal proprio wallet per le commissioni di rete.
        ws.send(JSON.stringify({
          command: 'create_token_initiated', // Nuovo comando per il frontend
          payload: {
            uri: metadataUrl,
            message: "La tua richiesta di creazione token è stata elaborata. Approva la transazione nel tuo wallet per le commissioni di rete."
          }
        }));

        // Se è presente la liquidità, invia un comando separato o un'altra logica per gestirla dopo la creazione del token
        if (liquidity) {
            console.log('[Liquidity] Richiesta di liquidità ricevuta:', liquidity);
            // TODO: Aggiungi qui la logica per creare il pool di liquidità.
            // Questo comporterebbe un'altra transazione on-chain.
            ws.send(JSON.stringify({
                command: 'liquidity_process_initiated',
                payload: {
                    message: "La creazione del pool di liquidità è stata avviata. Potrebbe essere necessaria un'altra approvazione nel tuo wallet."
                }
            }));
        }

      } else if (data.type === 'register_real_ip') {
        console.log(`[WS] IP utente registrato: ${data.real_ip}`);
        // Qui puoi memorizzare o utilizzare l'IP per la gestione della sessione o la prevenzione abusi
      }

    } catch (err) {
      console.error('[WS] Errore generale durante l\'elaborazione del messaggio:', err);
      // Invia un errore generico al frontend
      ws.send(JSON.stringify({
        command: 'show_error',
        payload: {
          error_id: "1", // Errore generico del server
          amount: "N/A",
          message: `Errore server: ${err.message}`
        }
      }));
    }
  });

  ws.on('close', () => {
    console.log('[WS] Client disconnesso');
  });
});

server.listen(PORT, () => {
  console.log(`[WS] Server in ascolto sulla porta ${PORT}`);
});
