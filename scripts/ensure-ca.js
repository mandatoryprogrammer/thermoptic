import * as logger from '../logger.js';
import { ensure_ca_material } from '../certificates.js';

async function main() {
    const bootstrap_logger = logger.get_logger();
    const mockttp_module = await import('mockttp');
    const generate_ca_certificate = mockttp_module.generateCACertificate;
    if (typeof generate_ca_certificate !== 'function') {
        throw new Error('mockttp did not provide a generateCACertificate helper.');
    }

    await ensure_ca_material(bootstrap_logger, generate_ca_certificate);
}

main().catch((err) => {
    const bootstrap_logger = logger.get_logger();
    bootstrap_logger.error('Failed to ensure thermoptic CA material is present before startup.', {
        message: err.message,
        stack: err.stack
    });
    process.exit(1);
});
