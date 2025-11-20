import { access, mkdir, writeFile } from 'fs/promises';
import { constants as fs_constants } from 'fs';
import { resolve } from 'path';

const CA_DIRECTORY_PATH = resolve('./ssl');
const CA_CERTIFICATE_PATH = resolve('./ssl/rootCA.crt');
const CA_PRIVATE_KEY_PATH = resolve('./ssl/rootCA.key');

export { CA_DIRECTORY_PATH, CA_CERTIFICATE_PATH, CA_PRIVATE_KEY_PATH };

export async function ensure_ca_material(logger_instance, generate_ca_certificate_func) {
    if (typeof generate_ca_certificate_func !== 'function') {
        throw new Error('A generate_ca_certificate_func function must be supplied to ensure_ca_material.');
    }

    const [cert_exists, key_exists] = await Promise.all([
        does_file_exist(CA_CERTIFICATE_PATH),
        does_file_exist(CA_PRIVATE_KEY_PATH)
    ]);

    if (cert_exists && key_exists) {
        return;
    }

    await mkdir(CA_DIRECTORY_PATH, { recursive: true });

    const safe_logger = get_safe_logger(logger_instance);
    safe_logger.info('Generating root CA for thermoptic proxy.', {
        certificate_path: CA_CERTIFICATE_PATH
    });

    const { key, cert } = await generate_ca_certificate_func({
        subject: {
            commonName: 'thermoptic Root CA',
            organizationName: 'thermoptic',
            countryName: 'US'
        }
    });

    await writeFile(CA_PRIVATE_KEY_PATH, key, { mode: 0o600 });
    await writeFile(CA_CERTIFICATE_PATH, cert, { mode: 0o644 });
}

async function does_file_exist(path) {
    try {
        await access(path, fs_constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

function get_safe_logger(logger_instance) {
    if (logger_instance && typeof logger_instance.info === 'function') {
        return logger_instance;
    }

    return {
        info: () => {},
        warn: () => {},
        error: () => {}
    };
}
