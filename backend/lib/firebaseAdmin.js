const admin = require("firebase-admin");

// Cold-start-safe singleton init: Vercel can reuse the same process for
// multiple invocations, and initializeApp() throws if called twice.
if (!admin.apps.length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
    });
}

// Verifies the "Authorization: Bearer <idToken>" header. Throws if missing
// or invalid; callers should catch and respond 401.
async function requireAuth(req) {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) {
        const err = new Error("Missing bearer token");
        err.statusCode = 401;
        throw err;
    }
    try {
        return await admin.auth().verifyIdToken(token);
    } catch (e) {
        const err = new Error("Invalid or expired token");
        err.statusCode = 401;
        throw err;
    }
}

module.exports = { admin, requireAuth };
