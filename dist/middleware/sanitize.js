function sanitizeValue(val) {
    if (typeof val === 'string') {
        return val.replace(/\0/g, '').trim();
    }
    if (Array.isArray(val)) {
        return val.map(sanitizeValue);
    }
    if (val && typeof val === 'object') {
        const clean = {};
        for (const [k, v] of Object.entries(val)) {
            if (k.startsWith('$') || k.includes('.')) {
                continue;
            }
            clean[k] = sanitizeValue(v);
        }
        return clean;
    }
    return val;
}
export function sanitizeInput(req, _res, next) {
    if (req.body && typeof req.body === 'object') {
        req.body = sanitizeValue(req.body);
    }
    next();
}
