const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "";

// Applies CORS headers and handles the OPTIONS preflight.
// Returns true if the caller should stop (preflight already answered).
function applyCors(req, res) {
    if (ALLOWED_ORIGIN) {
        res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
        res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
        res.status(204).end();
        return true;
    }
    return false;
}

module.exports = { applyCors };
