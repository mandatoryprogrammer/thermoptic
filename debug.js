import net from 'net';

const server = net.createServer((socket) => {
    socket.on('data', (chunk) => {
        console.log('--- Raw HTTP Request ---');
        console.log(chunk.toString()); // This is the full raw request, byte-for-byte
        console.log('------------------------\n');

        const body = 'Request received\n';
        const response =
            `HTTP/1.1 200 OK\r\n` +
            `Content-Type: text/plain\r\n` +
            `Content-Length: ${Buffer.byteLength(body)}\r\n` +
            `Access-Control-Allow-Origin: *\r\n` +
            `Access-Control-Allow-Methods: *\r\n` +
            `Access-Control-Allow-Headers: *\r\n` +
            `\r\n` +
            body;

        socket.write(response);
        socket.end();
    });

    socket.on('error', (err) => {
        console.error('Socket error:', err);
    });
});

const PORT = 3333;
server.listen(PORT, () => {
    console.log(`Raw HTTP dump server listening on http://localhost:${PORT}`);
});