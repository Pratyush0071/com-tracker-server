export function errorHandler(err, _req, res, _next) {
    console.error('[API Error]', err);
    if (err.code === 11000) {
        res.status(409).json({
            error: 'A record with this unique identifier already exists.',
        });
        return;
    }
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    const message = status < 500 ? err.message : 'An unexpected server error occurred. Please try again.';
    res.status(status).json({ error: message });
}
