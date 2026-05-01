/**
 * Netlify Serverless Function — Tavily Search Proxy
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
    // Only allow POST
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Method not allowed' })
        };
    }

    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) {
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'TAVILY_API_KEY not configured in Netlify environment variables' })
        };
    }

    let body;
    try {
        body = JSON.parse(event.body);
    } catch (_e) {
        return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Invalid JSON body' })
        };
    }

    // Build Tavily payload — inject the secret key server-side
    const tavilyPayload = {
        api_key: apiKey,
        query: body.query || '',
        search_depth: body.search_depth || 'basic',
        include_answer: false,
        include_images: false,
        include_raw_content: body.include_raw_content !== false,
        max_results: body.max_results || 10
    };

    try {
        const response = await fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(tavilyPayload)
        });

        if (!response.ok) {
            const errText = await response.text();
            return {
                statusCode: response.status,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Tavily API error: ' + errText })
            };
        }

        const data = await response.json();

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store'
            },
            body: JSON.stringify(data)
        };

    } catch (err) {
        return {
            statusCode: 502,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Failed to reach Tavily API: ' + err.message })
        };
    }
};
