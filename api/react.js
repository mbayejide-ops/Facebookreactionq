// language: JavaScript, file: api/react.js, target: Vercel Serverless Function
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        res.setHeader('Content-Type', 'text/html');
        return res.status(200).send(require('fs').readFileSync(require('path').join(__dirname, '../public/index.html'), 'utf8'));
    }

    const cookieInput = req.body.cookie || process.env.FB_COOKIE;
    const { postUrl, reaction = 'LIKE', limit = 50 } = req.body;

    if (!cookieInput || !postUrl) {
        return res.status(400).json({ error: 'Missing required inputs: cookie or postUrl' });
    }

    let browser = null;
    let results = { success: 0, failed: 0, logs: [] };

    try {
        // Essential Chromium configuration for Vercel serverless environment
        chromium.setHeadlessMode = true;
        chromium.setGraphicsMode = false;

        browser = await puppeteer.launch({
            args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--single-process'],
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
            ignoreHTTPSErrors: true,
        });

        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // Parse and inject cookies
        let cookies = [];
        try {
            if (cookieInput.trim().startsWith('[')) {
                cookies = JSON.parse(cookieInput);
            } else {
                cookies = cookieInput.split(';').map(c => {
                    const [name, ...val] = c.trim().split('=');
                    return { name: name.trim(), value: val.join('=').trim(), domain: '.facebook.com', path: '/' };
                }).filter(c => c.name && c.value);
            }
        } catch (e) {
            if (browser) await browser.close();
            return res.status(400).json({ error: 'Invalid cookie array or string format.' });
        }

        await page.setCookie(...cookies);
        results.logs.push('Cookies injected successfully.');

        // Navigate to Facebook to verify authentication state
        await page.goto('https://www.facebook.com/', { waitUntil: 'networkidle2' });
        
        if (page.url().includes('login')) {
            if (browser) await browser.close();
            return res.status(401).json({ error: 'Authentication failed. Cookies expired or invalid.' });
        }

        // Fetch user managed pages
        results.logs.push('Extracting managed page links...');
        await page.goto('https://www.facebook.com/pages/?category=your_pages', { waitUntil: 'networkidle2' });
        
        const managedPages = await page.evaluate((maxLimit) => {
            const pageElements = Array.from(document.querySelectorAll('a[href*="/profile.php?id="], a[href*="/pages/"], a[href^="https://www.facebook.com/"]'));
            const extracted = [];
            
            for (let el of pageElements) {
                const href = el.href;
                if (href && !href.includes('/create/') && !href.includes('/discover/') && !href.includes('/help/') && !href.includes('/privacy/')) {
                    extracted.push(href);
                }
            }
            return [...new Set(extracted)].slice(0, maxLimit);
        }, parseInt(limit));

        results.logs.push(`Discovered ${managedPages.length} profile targets.`);

        if (managedPages.length === 0) {
            results.logs.push('Warning: No page links found via dashboard. Falling back to primary profile reaction only.');
            managedPages.push(postUrl);
        }

        // Execution loop across page identities
        for (let i = 0; i < managedPages.length; i++) {
            const pageUrl = managedPages[i];
            try {
                results.logs.push(`[${i + 1}/${managedPages.length}] Processing profile context...`);
                
                if (pageUrl !== postUrl) {
                    await page.goto(pageUrl, { waitUntil: 'networkidle2' });
                    
                    // Trigger profile identity switch if context button exists
                    await page.evaluate(async () => {
                        const switchBtn = document.querySelector('div[role="button"][aria-label*="Switch"], div[role="button"][aria-label*="সুইচ"]');
                        if (switchBtn) {
                            switchBtn.click();
                        }
                    });

                    await new Promise(r => setTimeout(r, 2000));
                }

                // Navigate to target post
                await page.goto(postUrl, { waitUntil: 'networkidle2' });

                // Execute targeted reaction click
                const reactionResult = await page.evaluate(async (targetReaction) => {
                    // Check if already reacted to prevent untoggling
                    const activeReactBtn = document.querySelector('div[aria-label="Remove Like"], div[aria-label="Remove Reaction"], [aria-label*="Unlike"]');
                    if (activeReactBtn) {
                        return { status: 'skipped', reason: 'Already reacted under this identity.' };
                    }

                    const likeButton = document.querySelector('div[aria-label="Like"], div[aria-label="লাইক"], div[role="button"][aria-label*="Like"]');
                    if (likeButton) {
                        likeButton.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
                        await new Promise(r => setTimeout(r, 800));

                        const targetReactEl = document.querySelector(`div[aria-label="${targetReaction}"], div[role="button"][aria-label*="${targetReaction}"]`);
                        if (targetReactEl) {
                            targetReactEl.click();
                            return { status: 'success', method: 'dock_reaction' };
                        } else {
                            likeButton.click();
                            return { status: 'success', method: 'direct_like' };
                        }
                    }
                    return { status: 'failed', reason: 'Reaction DOM button not found.' };
                }, reaction.toUpperCase());

                if (reactionResult.status === 'success') {
                    results.success++;
                    results.logs.push(`[${i + 1}] Reaction [${reaction.toUpperCase()}] applied via ${reactionResult.method}.`);
                } else if (reactionResult.status === 'skipped') {
                    results.logs.push(`[${i + 1}] Skipped: ${reactionResult.reason}`);
                } else {
                    results.failed++;
                    results.logs.push(`[${i + 1}] Failed: ${reactionResult.reason}`);
                }

            } catch (err) {
                results.failed++;
                results.logs.push(`[${i + 1}] Iteration error: ${err.message}`);
            }
        }

        await browser.close();
        return res.status(200).json({ status: 'completed', results });

    } catch (err) {
        if (browser) await browser.close();
        return res.status(500).json({ error: err.message, logs: results.logs });
    }
};
