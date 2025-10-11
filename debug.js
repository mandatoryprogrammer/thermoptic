import net from 'net';
import * as logger from './logger.js';

const debug_logger = logger.get_logger();

const server = net.createServer((socket) => {
    socket.on('data', (chunk) => {
        debug_logger.info('Raw HTTP request captured.', {
            payload: chunk.toString()
        });

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
        debug_logger.error('Socket error in raw HTTP dump server.', {
            message: err.message,
            stack: err.stack
        });
    });
});

const PORT = 3333;
server.listen(PORT, () => {
    debug_logger.info('Raw HTTP dump server listening.', {
        url: `http://localhost:${PORT}`
    });
});
