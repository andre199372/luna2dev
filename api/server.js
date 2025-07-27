// server.js (Minimal Test Version with Vercel Fix)
const WebSocket = require('ws');

// This is the Vercel serverless function handler
module.exports = (req, res) => {
    // If it's not a WebSocket upgrade request, Vercel handles it, so we don't need to send a response.
    if (req.headers['upgrade']?.toLowerCase() !== 'websocket') {
        res.status(200).send('WebSocket server is ready. Please connect with a WebSocket client.');
        return;
    }

    // Vercel requires us to "hijack" the socket from the HTTP response object.
    const wss = new WebSocket.Server({ noServer: true });

    wss.handleUpgrade(req, req.socket, Buffer.alloc(0), (ws) => {
        // Now that the WebSocket connection is established, we can attach our event listeners.
        wss.emit('connection', ws, req);
    });
};

// We handle the actual WebSocket logic outside the main handler to keep it clean.
const wss = new WebSocket.Server({ noServer: true });

wss.on('connection', (ws) => {
    console.log('[WS] Vercel: Client connected successfully!');
    
    ws.on('message', (message) => {
        const messageString = message.toString();
        console.log(`[WS] Vercel: Received message: ${messageString}`);
        
        // Echo the message back to the client.
        ws.send(`Server echo: ${messageString}`);
    });

    ws.on('close', () => {
        console.log('[WS] Vercel: Client disconnected.');
    });
    
    ws.on('error', (error) => {
        console.error('[WS] Vercel: WebSocket Error:', error);
    });
});
