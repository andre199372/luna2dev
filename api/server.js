// server.js (Minimal Test Version with Final Vercel Fix)
const WebSocket = require('ws');

// 1. Crea l'istanza del server WebSocket UNA SOLA VOLTA, fuori dal gestore.
// Questo permette al server di persistere tra le chiamate della funzione serverless.
const wss = new WebSocket.Server({ noServer: true });

wss.on('connection', (ws) => {
    console.log('[WS] Vercel: Client connesso con successo!');
    
    ws.on('message', (message) => {
        const messageString = message.toString();
        console.log(`[WS] Vercel: Messaggio ricevuto: ${messageString}`);
        
        // Rimanda il messaggio al client (echo).
        ws.send(`Server echo: ${messageString}`);
    });

    ws.on('close', () => {
        console.log('[WS] Vercel: Client disconnesso.');
    });
    
    ws.on('error', (error) => {
        console.error('[WS] Vercel: Errore WebSocket:', error);
    });
});

// 2. Questo è il gestore della funzione serverless di Vercel.
// Viene eseguito per ogni richiesta in arrivo.
module.exports = (req, res) => {
    // Controlla se è una richiesta di upgrade a WebSocket.
    if (req.headers['upgrade']?.toLowerCase() === 'websocket') {
        // 3. Usa l'istanza 'wss' singola per gestire l'upgrade.
        wss.handleUpgrade(req, req.socket, Buffer.alloc(0), (ws) => {
            wss.emit('connection', ws, req);
        });
    } else {
        // 4. Gestisce le normali richieste HTTP (es. quando visiti l'URL nel browser)
        // e termina la risposta per evitare il timeout.
        res.status(200).send('Server WebSocket attivo e pronto per le connessioni.');
    }
};
