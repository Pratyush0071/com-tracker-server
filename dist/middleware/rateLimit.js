function createRateLimiter(options) {
    const buckets = new Map();
    // Periodic cleanup of expired buckets to prevent memory growth
    const cleanupInterval = setInterval(() => {
        const now = Date.now();
        for (const [key, bucket] of buckets.entries()) {
            if (bucket.resetAt <= now) {
                buckets.delete(key);
            }
        }
    }, Math.min(options.windowMs, 5 * 60 * 1000));
    cleanupInterval.unref?.();
    return (req, res, next) => {
        const ip = req.ip ||
            (typeof req.headers['x-forwarded-for'] === 'string'
                ? req.headers['x-forwarded-for'].split(',')[0].trim()
                : '') ||
            req.socket?.remoteAddress ||
            'unknown';
        const now = Date.now();
        let bucket = buckets.get(ip);
        if (!bucket || bucket.resetAt <= now) {
            bucket = { count: 0, resetAt: now + options.windowMs };
            buckets.set(ip, bucket);
        }
        bucket.count += 1;
        const remaining = Math.max(0, options.max - bucket.count);
        res.setHeader('X-RateLimit-Limit', String(options.max));
        res.setHeader('X-RateLimit-Remaining', String(remaining));
        res.setHeader('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));
        if (bucket.count > options.max) {
            res.status(429).json({ error: options.message });
            return;
        }
        next();
    };
}
export const loginLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 25,
    message: 'Too many login attempts from this IP. Please try again after 15 minutes.',
});
export const apiLimiter = createRateLimiter({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 300,
    message: 'Too many requests. Please slow down and try again shortly.',
});
