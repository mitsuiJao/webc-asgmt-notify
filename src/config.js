require('dotenv').config();

function getCookies() {
    try {
        // Priority 1: cookies.json (Latest valid session from interactive login)
        const fs = require('fs');
        const path = require('path');
        const localCookiePath = path.resolve(__dirname, '../cookies.json');
        if (fs.existsSync(localCookiePath)) {
            console.log('Loading cookies from cookies.json...');
            const fileContent = fs.readFileSync(localCookiePath, 'utf8');
            return JSON.parse(fileContent);
        }

        // Priority 2: .env (Initial setup)
        if (process.env.COOKIES_JSON) {
            console.log('Loading cookies from .env variable...');
            return JSON.parse(process.env.COOKIES_JSON);
        }

        return [];
    } catch (e) {
        console.error("Failed to parse cookies from .env or cookies.json", e);
        return [];
    }
}

module.exports = {
    cookies: getCookies(),
    username: process.env.USER_ID,
    password: process.env.PASSWORD,
    baseUrl: 'https://webclass.kosen-k.go.jp/webclass/', // WebClass root
    entryUrl: 'https://webclass.kosen-k.go.jp/webclass/index.php', // Main dashboard
};
