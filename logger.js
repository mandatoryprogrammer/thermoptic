import winston from 'winston';

const debug_enabled = typeof process.env.DEBUG !== 'undefined' && process.env.DEBUG !== '0' && process.env.DEBUG !== 'false';

const level_tag_map = {
    error: '[ERROR]',
    warn: '[WARN]',
    info: '[STATUS]',
    http: '[STATUS]',
    verbose: '[STATUS]',
    debug: '[DEBUG]',
    silly: '[DEBUG]'
};

const base_logger = winston.createLogger({
    level: debug_enabled ? 'debug' : 'info',
    levels: winston.config.npm.levels,
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message, request_id, ...meta }) => {
            const level_tag = level_tag_map[level] || `[${level.toUpperCase()}]`;
            const request_tag = request_id ? `[req:${request_id}] ` : '';
            const meta_payload = Object.keys(meta).length === 0 ? '' : ` ${JSON.stringify(meta)}`;
            return `${timestamp} ${level_tag} ${request_tag}${message}${meta_payload}`;
        })
    ),
    transports: [
        new winston.transports.Console({ stderrLevels: ['error'] })
    ]
});

export function get_logger() {
    return base_logger;
}

export function get_request_logger(context = {}) {
    return base_logger.child(context);
}

export function is_debug_enabled() {
    return debug_enabled;
}
