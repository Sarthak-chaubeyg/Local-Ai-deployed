/**
 * Netlify Serverless Function — Tavily Search Proxy (v2)
 * 
 * This function securely proxies Tavily API requests so the API key
 * is never exposed to the browser. The key is stored as a Netlify
 * environment variable (TAVILY_API_KEY).
 *
 * Endpoint: /.netlify/functions/tavily-search
 * Method:   POST
 * Body:     { query, search_depth, max_results, include_raw_content }
 */

exports.handler = async function (event) {
    // CORS headers for all responses
    const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
    };

    // Handle CORS preflight
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 204, headers, body: '' };
    }

    // Only allow POST
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers,
            body: JSON.stringify({ error: 'Method not allowed' })
        };
    }

    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) {
        console.error('[tavily-search] TAVILY_API_KEY env var is missing or empty');
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'TAVILY_API_KEY not configured in Netlify environment variables. Please add it in Site Settings → Environment Variables and redeploy.' })
        };
    }

    let body;
    try {
        body = JSON.parse(event.body);
    } catch (_e) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'Invalid JSON body' })
        };
    }

    if (!body.query || !String(body.query).trim()) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'Missing required field: query' })
        };
    }

    // Build Tavily payload — inject the secret key server-side
    const tavilyPayload = {
        api_key: apiKey,
        query: String(body.query).trim(),
        search_depth: body.search_depth || 'basic',
        include_answer: false,
        include_images: false,
        include_raw_content: body.include_raw_content !== false,
        max_results: Math.min(Number(body.max_results) || 10, 20)
    };

    try {
        const response = await fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(tavilyPayload)
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error('[tavily-search] Tavily API returned', response.status, errText);
            return {
                statusCode: response.status,
                headers,
                body: JSON.stringify({ error: 'Tavily API error: ' + errText })
            };
        }

        const data = await response.json();

        return {
            statusCode: 200,
            headers: { ...headers, 'Cache-Control': 'no-store' },
            body: JSON.stringify(data)
        };

    } catch (err) {
        console.error('[tavily-search] Fetch error:', err.message);
        return {
            statusCode: 502,
            headers,
            body: JSON.stringify({ error: 'Failed to reach Tavily API: ' + err.message })
        };
    }
};
