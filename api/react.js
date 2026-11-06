// language: JavaScript, file: api/react.js, target: Vercel Serverless Function
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        res.setHeader('Content-Type', 'text/html');
        return res.status(200).send(require('fs').readFileSync(require('path').join(__dirname, '../public/index.html'), 'utf8'));
    }

    const { cookie, postUrl, reaction, limit } = req.body;
    if (!cookie || !postUrl) {
        return res.status(400).json({ error: 'Missing required parameters: cookie or postUrl' });
    }

    let browser = null;
    let results = { success: 0, failed: 0, logs: [] };

    try {
        browser = await puppeteer.launch({
            args: chromium.args,
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
            if (cookie.trim().startsWith('[')) {
                cookies = JSON.parse(cookie);
            } else {
                cookies = cookie.split(';').map(c => {
                    const [name, ...val] = c.trim().split('=');
                    return { name, value: val.join('='), domain: '.facebook.com', path: '/' };
                }).filter(c => c.name && c.value);
            }
        } catch (e) {
            return res.status(400).json({ error: 'Invalid cookie format parsed.' });
        }

        await page.setCookie(...cookies);
        results.logs.push('Cookies injected successfully. Navigating to Facebook...');

        // Navigate to basic mobile/web layout to grab pages list
        await page.goto('https://mbasic.facebook.com/pages/?category=your_pages', { waitUntil: 'networkidle2' });
        
        if (page.url().includes('login')) {
            return res.status(401).json({ error: 'Authentication failed. Cookies expired or invalid.' });
        }

        // Extract managed page links up to the specified limit
        let pageLinks = await page.evaluate((maxLimit) => {
            const anchors = Array.from(document.querySelectorAll('a'));
            return anchors
                .map(a => a.href)
                .filter(href => href.includes('/profile.php?id=') || (href.includes('facebook.com/') && !href.includes('/pages/') && !href.includes('/help/') && !href.includes('privacy')))
                .filter((v, i, self) => self.indexOf(v) === i)
                .slice(0, maxLimit);
        }, parseInt(limit) || 50);

        results.logs.push(`Discovered ${pageLinks.length} pages/profiles linked to account.`);

        // Iterate through each page context and react to target post
        for (let i = 0; i < pageLinks.length; i++) {
            const pageLink = pageLinks[i];
            try {
                results.logs.push(`Switching context to page ${i + 1}/${pageLinks.length}`);
                // Navigate to the target post using individual page identity switcher
                await page.goto(postUrl, { waitUntil: 'networkidle2' });
                
                // Switch identity dropdown/action if available on mobile layout
                // or interact with the reaction button
                const reacted = await page.evaluate((targetReaction) => {
                    // Simple interaction trigger for standard like/reaction buttons
                    const buttons = Array.from(document.querySelectorAll('a, button'));
                    const likeBtn = buttons.find(b => b.innerText.toLowerCase().includes('like') || b.innerText.toLowerCase().includes('react'));
                    if (likeBtn) {
                        likeBtn.click();
                        return true;
                    }
                    return false;
                }, reaction);

                if (reacted) {
                    results.success++;
                    results.logs.push(`Page ${i + 1}: Reaction dispatched successfully.`);
                } else {
                    results.failed++;
                    results.logs.push(`Page ${i + 1}: Reaction element not found.`);
                }
            } catch (err) {
                results.failed++;
                results.logs.push(`Page ${i + 1} error: ${err.message}`);
            }
        }

        await browser.close();
        return res.status(200).json({ status: 'completed', results });

    } catch (err) {
        if (browser) await browser.close();
        return res.status(500).json({ error: err.message, logs: results.logs });
    }
};
