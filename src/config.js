import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getCookies() {
    try {
        const cookiePath = path.resolve(__dirname, '../cookies.json');
        if (fs.existsSync(cookiePath)) {
            console.log('Loading cookies from cookies.json...');
            const fileContent = fs.readFileSync(cookiePath, 'utf8');
            return JSON.parse(fileContent);
        }
        return [];
    } catch (e) {
        console.error("Failed to parse cookies from cookies.json", e);
        return [];
    }
}

export default {
    cookies: getCookies(),
    username: process.env.USER_ID,
    password: process.env.PASSWORD,
    mfaSecret: process.env.MFA_SECRET,
    apikey: process.env.APIKEY,
    sendfrom: process.env.SENDFROM,
    sendto: process.env.SENDTO,
    baseUrl: 'https://webclass.kosen-k.go.jp/webclass/',
    entryUrl: 'https://webclass.kosen-k.go.jp/webclass/index.php',
};
