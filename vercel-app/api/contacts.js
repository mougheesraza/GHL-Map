module.exports = async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const fail = (status, message) => res.status(status).json({success:false, message});
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return fail(405, 'Method not allowed.'); }
    const {location_id: locationId, cursor} = req.query;
    if (typeof locationId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(locationId)) return fail(400, 'A valid Location ID is required.');
    let searchAfter;
    if (cursor !== undefined) {
        try { searchAfter = typeof cursor === 'string' ? JSON.parse(cursor) : null; } catch (_) { return fail(400, 'Invalid pagination cursor.'); }
        if (!Array.isArray(searchAfter) || searchAfter.length < 2 || searchAfter.length > 10 || searchAfter.some(value => !['string','number'].includes(typeof value))) return fail(400, 'Invalid pagination cursor.');
    }
    let token = process.env.GHL_API_TOKEN;
    if (process.env.GHL_LOCATION_TOKENS) {
        let tokens;
        try { tokens = JSON.parse(process.env.GHL_LOCATION_TOKENS); } catch (_) { return fail(500, 'Invalid server token configuration.'); }
        if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) return fail(500, 'Invalid server token configuration.');
        token = Object.hasOwn(tokens, locationId) ? tokens[locationId] : null;
    }
    if (typeof token !== 'string' || !token.trim()) return fail(403, 'This sub-account is not connected. Configure its token on the server.');
    const payload = {locationId, pageLimit:20};
    if (searchAfter) payload.searchAfter = searchAfter;
    try {
        const upstream = await fetch('https://services.leadconnectorhq.com/contacts/search', {
            method:'POST', headers:{'Content-Type':'application/json', Version:'v3', Authorization:`Bearer ${token}`},
            body:JSON.stringify(payload), signal:AbortSignal.timeout(30000)
        });
        if (!upstream.ok) return fail(502, `LeadConnector API returned HTTP ${upstream.status}.`);
        const data = await upstream.json();
        if (!data || !Array.isArray(data.contacts)) return fail(502, 'Invalid contacts response.');
        const contacts = data.contacts;
        let hasMore = contacts.length >= 20;
        const nextCursor = contacts.at(-1)?.searchAfter;
        let warning = null;
        if (hasMore && (!Array.isArray(nextCursor) || nextCursor.length < 2 || JSON.stringify(nextCursor) === JSON.stringify(searchAfter))) {
            hasMore = false;
            warning = 'Pagination stopped: the API did not return a usable next cursor. Results may be incomplete.';
        }
        return res.status(200).json({success:true, contacts, count:contacts.length, apiTotal:data.total ?? null, hasMore, nextCursor:hasMore ? nextCursor : null, warning});
    } catch (_) { return fail(502, 'Contact service unavailable or timed out. Please retry.'); }
};
