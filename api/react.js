// language: JavaScript, file: api/react.js, target: Vercel Serverless Function
const https = require('https');

function makeRequest(url, headers, postData = null) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: postData ? 'POST' : 'GET',
            headers: headers
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
        });

        req.on('error', err => reject(err));
        if (postData) req.write(postData);
        req.end();
    });
}

function extractPostId(url) {
    const match = url.match(/(?:fbid=|posts\/|pfbid|story_fbid=)([\w\d]+)/);
    if (match) return match[1];
    // Fallback match for numeric IDs in URL paths
    const parts = url.split('/');
    const numericPart = parts.find(p => /^\d+$/.test(p));
    return numericPart || null;
}

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

    let results = { success: 0, failed: 0, logs: [] };

    try {
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Cookie': cookieInput,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5'
        };

        results.logs.push('Fetching Facebook home dashboard to extract user & page tokens...');
        const homeRes = await makeRequest('https://www.facebook.com/', headers);

        if (homeRes.body.includes('/login/') || homeRes.statusCode === 302 && homeRes.headers.location?.includes('login')) {
            return res.status(401).json({ error: 'Authentication failed. Cookies expired or invalid.' });
        }

        // Extract fb_dtsg token required for graph mutations
        const dtsgMatch = homeRes.body.match(/"DTSGInitialData"\s*,\s*\[\s*\]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"/);
        const fbDtsg = dtsgMatch ? dtsgMatch[1] : null;

        const userIdMatch = cookieInput.match(/c_user=(\d+)/);
        const userId = userIdMatch ? userIdMatch[1] : null;

        if (!fbDtsg || !userId) {
            return res.status(400).json({ error: 'Failed to extract security tokens (fb_dtsg or c_user).' });
        }

        results.logs.push(`Extracted user ID: ${userId} and security token.`);

        // Extract managed pages via mobile graph parser
        results.logs.push('Extracting managed page identities...');
        const mbasicRes = await makeRequest('https://mbasic.facebook.com/pages/?category=your_pages', headers);
        
        const pageMatches = [...mbasicRes.body.matchAll(/\/profile\.php\?id=(\d+)/g)].map(m => m[1]);
        const uniquePages = [...new Set(pageMatches)].slice(0, parseInt(limit));

        results.logs.push(`Discovered ${uniquePages.length} unique page identities.`);

        if (uniquePages.length === 0) {
            uniquePages.push(userId); // Fallback to primary account if no pages found
        }

        const targetPostId = extractPostId(postUrl);
        if (!targetPostId) {
            return res.status(400).json({ error: 'Could not parse target post ID from URL.' });
        }

        // Reaction mapping types
        const reactionTypeMap = { 'LIKE': 1, 'LOVE': 2, 'WOW': 3, 'HAHA': 4, 'SAD': 7, 'ANGRY': 8, 'CARE': 16 };
        const reactionType = reactionTypeMap[reaction.toUpperCase()] || 1;

        // Dispatch reactions across profiles/pages
        for (let i = 0; i < uniquePages.length; i++) {
            const pageId = uniquePages[i];
            try {
                results.logs.push(`[${i + 1}/${uniquePages.length}] Dispatching reaction for identity: ${pageId}`);

                // Graph API reaction endpoint payload simulation
                const postData = new URLSearchParams({
                    av: pageId,
                    fb_dtsg: fbDtsg,
                    doc_id: '3336399999745581', // Facebook feedback mutation graph hash
                    variables: JSON.stringify({
                        input: {
                            feedback_id: targetPostId,
                            tracking: [],
                            feedback_source: 'OBJECT_FEED',
                            actor_id: pageId,
                            client_mutation_id: Math.random().toString()
                        }
                    })
                }).toString();

                const reactionRes = await makeRequest('https://www.facebook.com/api/graphql/', {
                    ...headers,
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'X-FB-Friendly-Name': 'CometUFICreatorFeedbackReactionMutation'
                }, postData);

                if (reactionRes.statusCode === 200) {
                    results.success++;
                    results.logs.push(`[${i + 1}] Reaction successfully dispatched.`);
                } else {
                    results.failed++;
                    results.logs.push(`[${i + 1}] Failed with status code: ${reactionRes.statusCode}`);
                }

            } catch (err) {
                results.failed++;
                results.logs.push(`[${i + 1}] Error: ${err.message}`);
            }
        }

        return res.status(200).json({ status: 'completed', results });

    } catch (err) {
        return res.status(500).json({ error: err.message, logs: results.logs });
    }
};
