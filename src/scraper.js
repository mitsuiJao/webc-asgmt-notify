const puppeteer = require('puppeteer');
const config = require('./config');
const Bottleneck = require('bottleneck');
const fs = require('fs');
const path = require('path');
const readline = require('readline'); // Added for MFA input

// Rate limiter: 1 request every 3 seconds to be safe
const limiter = new Bottleneck({
    minTime: 3000
});

async function scrapeAssignments() {
    console.log('Launching browser...');
    const browser = await puppeteer.launch({
        headless: "new",
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
        ],
        ignoreDefaultArgs: ['--enable-automation']
    });

    // Ensure output directory exists
    const outputDir = path.resolve(__dirname, '../output');
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    try {
        const page = await browser.newPage();

        // Set User Agent to match the browser where cookies were obtained (Edge/143)
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0 OS/10.0.26100');

        // 1. Set Cookies
        console.log('Setting cookies...');
        if (config.cookies.length > 0) {
            console.log(`Loading ${config.cookies.length} cookies from .env:`);
            config.cookies.forEach(c => console.log(` - ${c.name} (${c.domain})`));
            await page.setCookie(...config.cookies);
        } else {
            console.log('No cookies found in .env, proceeding to automatic login...');
        }

        // 2. Access WebClass Dashboard directly
        // If Microsoft cookies are valid, WebClass might auto-redirect to SSO and back, or just work if WBT_Session is alive.
        console.log(`Navigating to ${config.entryUrl}...`);
        await page.goto(config.entryUrl, { waitUntil: 'networkidle2' });

        // Wait for potential rederects or SSO dance
        try {
            if (page.url().includes('login.microsoftonline.com')) {
                console.log('Redirected to Microsoft Login, waiting for auto-redirect...');
                await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
            }
        } catch (e) {
            console.log('Navigation wait timeout or error:', e.message);
        }

        // Check where we are
        const currentUrl = page.url();
        console.log(`Current URL: ${currentUrl}`);

        if (currentUrl.includes('login.php')) {
            console.log('Detected login page. Attempting to force SAML login...');

            // Try to find and click SAML link or navigate directly
            // From HTML debug: <a href="...auth_mode=SAML">
            const ssoTriggered = await page.evaluate(() => {
                const links = Array.from(document.querySelectorAll('a'));
                const samlLink = links.find(a => a.href.includes('auth_mode=SAML'));
                if (samlLink) {
                    samlLink.click();
                    return true;
                }
                return false;
            });

            if (!ssoTriggered) {
                console.log('SAML link not found, navigating specifically to SSO URL...');
                await page.goto('https://webclass.kosen-k.go.jp/webclass/login.php?auth_mode=SAML', { waitUntil: 'networkidle2' });
            } else {
                console.log('Clicked SAML login link.');
                await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(e => console.log('Wait timeout:', e.message));
            }

            // Wait again for Microsoft -> WebClass
            if (page.url().includes('login.microsoftonline.com')) {
                console.log('Redirected to Microsoft, waiting for return...');
                await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => { });
            }
        }

        const finalUrl = page.url();
        console.log(`Final URL: ${finalUrl}`);

        if (finalUrl.includes('login.php') || finalUrl.includes('login.microsoftonline.com')) {
            // If called as a module, just report that login is needed.
            if (require.main !== module) {
                console.log('Session expired or login required. Returning status to caller.');
                return { loginRequired: true }; // Notify the caller that login is needed
            }

            // If run directly, start the interactive login flow.
            console.log('Session expired or login required. Initiating Interactive Login...');

            if (config.username && config.password) {
                console.log('Credentials found. Attempting automated login...');

                // 1. Ensure we are on Microsoft Login
                if (!page.url().includes('login.microsoftonline.com')) {
                    console.log('Not on Microsoft login page, trying to get there...');
                    await page.goto('https://webclass.kosen-k.go.jp/webclass/login.php?auth_mode=SAML', { waitUntil: 'networkidle2' });
                }

                // 2. Email Step
                try {
                    console.log('Waiting for email input...');
                    await page.waitForSelector('input[type="email"]', { timeout: 10000 });
                    await page.type('input[type="email"]', config.username);
                    await page.click('input[type="submit"]'); // Next button
                } catch (e) {
                    console.log('Email input not found (maybe already entered or passed):', e.message);
                }

                // 3. Password Step
                try {
                    console.log('Waiting for password input...');
                    await page.waitForSelector('input[type="password"]', { timeout: 10000 });
                    await new Promise(r => setTimeout(r, 1000)); // Brief pause
                    await page.type('input[type="password"]', config.password);
                    await page.click('input[type="submit"]'); // Sign in button
                } catch (e) {
                    console.log('Password input not found (maybe SSO bypassed or error):', e.message);
                }

                // 4. Handle 2FA (TOTP) / Stay Signed In
                console.log('Waiting for authentication challenge...');
                await new Promise(r => setTimeout(r, 2000)); // Allow time for transition

                if (page.url().includes('login.microsoftonline.com')) {
                    try {
                        const otpSelector = 'input[name="otc"], input[id="idTxtBx_SAOTCC_OTC"]';
                        const otpInput = await page.$(otpSelector);

                        if (otpInput) {
                            console.log('TOTP (Authenticator App) detected.');
                            const readlineInterface = readline.createInterface({
                                input: process.stdin,
                                output: process.stdout
                            });
                            const code = await new Promise(resolve => {
                                console.log('\nACTION REQUIRED: Please enter the 6-digit MFA code from your authenticator app:');
                                readlineInterface.question('Code: ', (answer) => {
                                    readlineInterface.close();
                                    resolve(answer.trim());
                                });
                            });

                            if (code) {
                                console.log(`Entering confirmation code: ${code}`);
                                await otpInput.type(code);
                                await page.click('input[type="submit"], input[id="idSubmit_SAOTCC_Continue"]');
                                await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 15000 }).catch(() => {});
                            }
                        } else {
                            console.log('No TOTP input found. Checking for other screens...');
                        }
                    } catch (e) {
                        console.log('Error handling TOTP:', e.message);
                    }
                }

                console.log('Waiting for final redirection to WebClass...');
                const startTime = Date.now();
                while (Date.now() - startTime < 180000) { // 3 min timeout
                    const url = page.url();
                    if (url.includes('webclass.kosen-k.go.jp/webclass') && !url.includes('login.php')) {
                        console.log('Login successful! Landed on WebClass.');
                        break;
                    }
                    try {
                        const kmsiButton = await page.$('#idSIButton9'); // "Stay signed in?" -> Yes
                        if (kmsiButton) {
                            console.log('Detected "Stay signed in?" prompt. Clicking Yes...');
                            await Promise.all([
                                page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {}),
                                kmsiButton.click()
                            ]);
                            continue;
                        }
                    } catch (e) {
                        // Ignore errors here, the button might not exist
                    }
                    await new Promise(r => setTimeout(r, 2000));
                }

                if (!page.url().includes('webclass.kosen-k.go.jp/webclass') || page.url().includes('login.php')) {
                    const debugHtml = path.resolve(__dirname, '../output/login_timeout.html');
                    const debugPng = path.resolve(__dirname, '../output/login_timeout.png');
                    fs.writeFileSync(debugHtml, await page.content());
                    await page.screenshot({ path: debugPng, fullPage: true });
                    console.log(`Login failed. Saved debug info to:\n ${debugHtml}\n ${debugPng}`);
                    throw new Error('Interactive login timed out. See screenshot.');
                }

                // 5. Save Cookies
                console.log('Exporting new session cookies...');
                const cookies = await page.cookies();
                // We will now save cookies to a separate file instead of .env
                const cookiePath = path.resolve(__dirname, '../cookies.json');
                fs.writeFileSync(cookiePath, JSON.stringify(cookies, null, 2));
                console.log(`Saved ${cookies.length} cookies to ${cookiePath}. Future runs will use these.`);

            } else {
                console.error('Credentials (USER_ID/PASSWORD) not found in .env. Cannot automate login.');
                throw new Error('Login required but no credentials provided.');
            }
        } else {
            console.log('Logged in successfully (SSO redirect valid).');
        }

        // 3. Extract Course Links
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

        // 4. Iterate courses
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

            // Extract assignments from the current page, passing courseUrl into the browser context
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

                    let useCount = 0;
                    if (node.textContent.includes('利用回数')) {
                        const match = node.textContent.match(/利用回数\s*(\d+)/);
                        if (match) {
                            useCount = parseInt(match[1], 10);
                        }
                    }

                    if (deadline) {
                        results.push({
                            title,
                            category,
                            period,
                            start,
                            deadline,
                            url, // Use the url passed into the evaluate function
                            useCount
                        });
                    }
                });
                return results;
            }, courseUrl); // Pass courseUrl as an argument to page.evaluate

            console.log(`  Found ${assignments.length} assignments.`);

            // Add course name to assignments
            const cleanCourseTitle = courseTitle.replace(' - WebClass', '');
            assignments.forEach(a => {
                a.course = cleanCourseTitle;
                allAssignments.push(a);
            });
        }

        // 5. Output results
        const outputPath = path.resolve(__dirname, '../output/assignments.json');
        fs.writeFileSync(outputPath, JSON.stringify(allAssignments, null, 2));
        console.log(`Saved ${allAssignments.length} assignments to ${outputPath}`);

        // Simple Console Report
        console.log('\n--- Upcoming Deadlines ---');
        const now = new Date();
        allAssignments
            .filter(a => new Date(a.deadline) > now) // Only future deadlines
            .sort((a, b) => new Date(a.deadline) - new Date(b.deadline))
            .forEach(a => {
                console.log(`[${a.deadline}] ${a.course} - ${a.title} (${a.category})`);
            });

        return allAssignments;

    } catch (error) {
        console.error('Error occurred:', error);
        throw error; // Re-throw so parent knows it failed
    } finally {
        if (browser) await browser.close();
    }
}

if (require.main === module) {
    scrapeAssignments().then(assignments => {
        console.log(JSON.stringify(assignments, null, 2));
    }).catch(err => {
        console.error("Scraper failed", err);
        process.exit(1);
    });
}

module.exports = { scrapeAssignments };
