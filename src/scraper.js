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
        await page.waitForSelector(otpSelector, { timeout: 10000 });
        const otpInput = await page.$(otpSelector);

        if (otpInput) {
            console.log('TOTP (Authenticator App) input detected.');
            if (!config.mfaSecret) {
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
        console.log(`TOTP input not found or timed out. Proceeding...\n${e}`);
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

    // Ensure we are on the main dashboard before finishing
    console.log(`Navigating to dashboard page: ${config.entryUrl}`);
    await page.goto(config.entryUrl, { waitUntil: 'networkidle2' });
    console.log(`Now on page: ${page.url()}`);

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
        if (config.cookies && config.cookies.length > 0) {
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

        // --- Start Scraping (Original Logic) ---
        console.log('Extracting course links...');
        console.log('Extracting course links...');
        const courseLinks = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a[href*="/webclass/course.php/"]'));
            return links
                .map(a => a.href)
                .filter(href => href.includes('/login'))
                .filter((v, i, a) => a.indexOf(v) === i);
        });

        console.log(`Found ${courseLinks.length} unique courses.`);

        if (courseLinks.length === 0) {
            console.warn('No courses found! Saving debug info...');
            const debugHtmlPath = path.resolve(__dirname, '../output/debug_no_courses.html');
            const debugPngPath = path.resolve(__dirname, '../output/debug_no_courses.png');
            fs.writeFileSync(debugHtmlPath, await page.content());
            await page.screenshot({ path: debugPngPath, fullPage: true });
            console.log(`Debug info saved to ${debugHtmlPath} and ${debugPngPath}`);
        }

        const allAssignments = [];

        for (const courseUrl of courseLinks) {
            console.log(`Processing course: ${courseUrl}`);

            await limiter.schedule(async () => {
                try {
                    await page.goto(courseUrl, { waitUntil: 'networkidle2' });
                } catch (e) {
                    console.error(`Failed to load ${courseUrl}:`, e.message);
                    return;
                }
            });

            const courseTitle = await page.title();
            console.log(`  Title: ${courseTitle}`);

            const assignments = await page.evaluate((url) => {
                const results = [];
                const contentNodes = document.querySelectorAll('.cl-contentsList_content');

                contentNodes.forEach(node => {
                    const titleNode = node.querySelector('.cm-contentsList_contentName');
                    const categoryNode = node.querySelector('.cl-contentsList_categoryLabel');
                    const periodNodes = node.querySelectorAll('.cm-contentsList_contentDetailListItem');

                    const title = titleNode ? titleNode.textContent.trim() : 'Unknown Title';
                    const category = categoryNode ? categoryNode.textContent.trim() : 'Unknown Category';

                    if (!['レポート', 'テスト', 'アンケート'].includes(category)) {
                        return;
                    }

                    let period = '';
                    let start = null;
                    let deadline = null;

                    periodNodes.forEach(pNode => {
                        const label = pNode.querySelector('.cm-contentsList_contentDetailListItemLabel');
                        const data = pNode.querySelector('.cm-contentsList_contentDetailListItemData');
                        if (label && label.textContent.includes('利用可能期間') && data) {
                            period = data.textContent.trim();
                            const parts = period.split(' - ');
                            if (parts.length > 1) {
                                start = parts[0];
                                deadline = parts[1];
                            }
                        }
                    });

                    if (deadline) {
                        results.push({
                            title,
                            category,
                            period,
                            start,
                            deadline,
                            url,
                        });
                    }
                });
                return results;
            }, courseUrl);

            console.log(`  Found ${assignments.length} assignments in this course.`);

            const cleanCourseTitle = courseTitle.replace(' - WebClass', '').trim();
            assignments.forEach(a => {
                a.course = cleanCourseTitle;
                allAssignments.push(a);
            });
        }


        console.log(`Found ${allAssignments.length} total assignments.`);
        const outputPath = path.resolve(outputDir, 'assignments.json');
        fs.writeFileSync(outputPath, JSON.stringify(allAssignments, null, 2));
        console.log(`Assignments saved to ${outputPath}`);
        return allAssignments;

    } catch (error) {
        console.error('An error occurred during scraping:', error);
        const screenshotPath = path.resolve(outputDir, 'error_screenshot.png');
        await page.screenshot({ path: screenshotPath, fullPage: true });
        console.error(`A screenshot has been saved to ${screenshotPath}`);
        return { loginRequired: true, error: error.message };
    } finally {
        const screenshotPath = path.resolve(outputDir, 'result_screenshot.png');
        await page.screenshot({ path: screenshotPath, fullPage: true });
        console.log('Closing browser...');
        await browser.close();
    }
}
