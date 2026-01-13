import puppeteer from 'puppeteer';
import config from './config.js';
import generateTOTP from './otp.js';
import Bottleneck from 'bottleneck';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const limiter = new Bottleneck({
    minTime: 3000
});

async function performLogin(page) {
    console.log('Initiating automated login...');
    if (!config.username || !config.password) {
        throw new Error('USER_ID and PASSWORD must be set in .env file.');
    }

    const screenshot = async (name) => {
        const screenshotPath = path.resolve(__dirname, `../output/${name}.png`);
        await page.screenshot({ path: screenshotPath });
        console.log(`Screenshot saved to ${screenshotPath}`);
    };

    console.log(`Navigating to SAML login entry point...`);
    await page.goto('https://webclass.kosen-k.go.jp/webclass/login.php?auth_mode=SAML', { waitUntil: 'networkidle2' });

    // 1. Email Step
    try {
        console.log('Waiting for email input...');
        await page.waitForSelector('input[type="email"]', { timeout: 15000 });
        await page.type('input[type="email"]', config.username);
        await page.click('input[type="submit"]'); // Next button
        console.log('Email submitted.');
    } catch (e) {
        console.log('Email input not found (maybe already entered or passed):', e.message);
        await screenshot('debug_email_step_failed');
    }

    // 2. Password Step
    try {
        console.log('Waiting for password input...');
        await page.waitForSelector('input[type="password"]', { timeout: 10000 });
        await new Promise(r => setTimeout(r, 1000)); // Brief pause
        await page.type('input[type="password"]', config.password);
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 15000 }).catch(() => console.log('Navigation after password submit did not complete as expected, but continuing.')),
            page.click('input[type="submit"]') // Sign in button
        ]);
        console.log('Password submitted.');
    } catch (e) {
        console.log('Password input not found (maybe SSO bypassed or error):', e.message);
        await screenshot('debug_password_step_failed');
    }

    // 3. Handle 2FA (TOTP)
    try {
        console.log('Waiting for authentication challenge...');
        const otpSelector = 'input[name="otc"], input[id="idTxtBx_SAOTCC_OTC"]';
        await page.waitForSelector(otpSelector, { timeout:330000 });
        const otpInput = await page.$(otpSelector);

        if (otpInput) {
            console.log('TOTP (Authenticator App) input detected.');
            if (!config.otpSecret) {
                throw new Error('MFA is required, but MFA_SECRET is not set in .env file.');
            }
            const token = generateTOTP();
            console.log(`Generated MFA token: ${token}. Entering...`);
            await new Promise(r => setTimeout(r, 1000)); // Brief pause
            await otpInput.type(token);
            await page.click('input[type="submit"], input[id="idSubmit_SAOTCC_Continue"]');
            console.log('MFA token submitted.');
        }
    } catch (e) {
        console.log('TOTP input not found or timed out. Proceeding...');
        await screenshot('debug_totp_step_failed');
    }

    // 4. "Stay signed in?" prompt
    try {
        console.log('Checking for "Stay signed in?" prompt...');
        const kmsiButton = await page.waitForSelector('#idSIButton9', { timeout: 10000 }); // "Yes" button
        if (kmsiButton) {
            console.log('Detected "Stay signed in?" prompt. Clicking Yes...');
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle2' }),
                kmsiButton.click()
            ]);
        }
    } catch (e) {
        console.log('"Stay signed in?" prompt not found. Continuing...');
        await screenshot('debug_kmsi_step_failed');
    }

    // 5. Final check for successful login
    console.log('Waiting for final redirection to WebClass...');
    await page.waitForFunction(
        'window.location.href.includes("webclass.kosen-k.go.jp/webclass") && !window.location.href.includes("login.php")',
        { timeout: 30000 }
    );

    console.log(`Login successful! Landed on: ${page.url()}`);

    // Save cookies for next time
    const cookies = await page.cookies();
    const cookiePath = path.resolve(__dirname, '../cookies.json');
    fs.writeFileSync(cookiePath, JSON.stringify(cookies, null, 2));
    console.log(`Session cookies saved to ${cookiePath}`);
}


export async function scrapeAssignments() {
    console.log('Launching browser...');
    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
        ignoreDefaultArgs: ['--enable-automation']
    });

    const outputDir = path.resolve(__dirname, '../output');
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const page = await browser.newPage();
    try {
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36');

        // 1. Try to use existing cookies
        if (config.cookies.length > 0) {
            console.log('Setting cookies...');
            await page.setCookie(...config.cookies);
        }

        // 2. Access dashboard and check if login is required
        console.log(`Navigating to ${config.entryUrl}...`);
        await page.goto(config.entryUrl, { waitUntil: 'networkidle2' });

        // If we are redirected to a login page, the cookies are invalid/expired.
        if (page.url().includes('login.php') || page.url().includes('login.microsoftonline.com')) {
            console.log('Session expired or not found. Proceeding with full login flow.');
            await performLogin(page);
        } else {
            console.log('Successfully accessed WebClass using existing session.');
        }

        // --- Start Scraping ---
        console.log('Navigating to assignment list...');
        const reportListUrl = `${config.baseUrl}report_list.php`;
        await page.goto(reportListUrl, { waitUntil: 'networkidle2' });

        console.log('Scraping assignment data...');
        const assignments = await page.evaluate(() => {
            const rows = Array.from(document.querySelectorAll('.contents-display > table > tbody > tr'));
            const courseHeaderRegex = /^(【.+】)$/;
            let currentCourse = 'N/A';
            const results = [];
            for (const row of rows) {
                const headerCell = row.querySelector('th.course-name');
                if (headerCell && courseHeaderRegex.test(headerCell.innerText.trim())) {
                    currentCourse = headerCell.innerText.trim();
                } else if (row.cells.length >= 5) {
                    results.push({
                        course: currentCourse,
                        status: row.cells[0].innerText.trim(),
                        title: row.cells[1].innerText.trim(),
                        startDate: row.cells[2].innerText.trim().replace(/\n/g, ' '),
                        endDate: row.cells[3].innerText.trim().replace(/\n/g, ' '),
                        submissionStatus: row.cells[4].innerText.trim(),
                    });
                }
            }
            return results;
        });

        console.log(`Found ${assignments.length} assignments.`);
        const outputPath = path.resolve(outputDir, 'assignments.json');
        fs.writeFileSync(outputPath, JSON.stringify(assignments, null, 2));
        console.log(`Assignments saved to ${outputPath}`);
        return assignments;

    } catch (error) {
        console.error('An error occurred during scraping:', error);
        const screenshotPath = path.resolve(outputDir, 'error_screenshot.png');
        await page.screenshot({ path: screenshotPath, fullPage: true });
        console.error(`A screenshot has been saved to ${screenshotPath}`);
        return { loginRequired: true, error: error.message };
    } finally {
        console.log('Closing browser...');
        await browser.close();
    }
}
