import { createHmac } from 'crypto';
import config from './config.js';

function base32ToBuffer(base32) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    let hex = '';

    const str = base32.toUpperCase().replace(/\s/g, '').replace(/=+$/, '');

    for (let i = 0; i < str.length; i++) {
        const val = alphabet.indexOf(str[i]);
        if (val === -1) {
            throw new Error(`Invalid Base32 character: ${str[i]}`);
        }
        bits += val.toString(2).padStart(5, '0');
    }

    for (let i = 0; i + 8 <= bits.length; i += 8) {
        const chunk = bits.substring(i, i + 8);
        hex += parseInt(chunk, 2).toString(16).padStart(2, '0');
    }

    return Buffer.from(hex, 'hex');
}

function generateTOTP() {
    const secretBase32 = config.otpSecret;
    const key = base32ToBuffer(secretBase32);

    const epoch = Math.round(new Date().getTime() / 1000.0);
    const timeStep = 30;
    const counter = Math.floor(epoch / timeStep);

    const buffer = Buffer.alloc(8);
    for (let i = 0; i < 8; i++) {
        const byte = (BigInt(counter) >> BigInt((7 - i) * 8)) & 0xffn;
        buffer[i] = Number(byte);
    }

    const hmac = createHmac('sha1', key);
    hmac.update(buffer);
    const digest = hmac.digest();
    const offset = digest[digest.length - 1] & 0xf;
    const binary =
        ((digest[offset] & 0x7f) << 24) |
        ((digest[offset + 1] & 0xff) << 16) |
        ((digest[offset + 2] & 0xff) << 8) |
        (digest[offset + 3] & 0xff);

    const token = binary % 1000000;

    return token.toString().padStart(6, '0');
}

export default generateTOTP;