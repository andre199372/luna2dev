// server.js (Minimal Test Version)
const WebSocket = require('ws');

// This is the Vercel serverless function handler
module.exports = (req, res) => {
    // If it's not a WebSocket upgrade request, just send a simple response.
    if (req.headers['upgrade']?.toLowerCase() !== 'websocket') {
        res.status(200).send('WebSocket echo server is running. Please connect with a WebSocket client.');
        return;
    }

    // Create a WebSocket server without attaching it to an HTTP server.
    const wss = new WebSocket.Server({ noServer: true });

    // Handle the upgrade request from the client.
    wss.handleUpgrade(req, req.socket, Buffer.alloc(0), (ws) => {
        console.log('[WS] Vercel: Client connected successfully!');
        
        // When a message is received from the client...
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
};
