const { applyCors } = require("../lib/cors");

module.exports = async (req, res) => {
    if (applyCors(req, res)) return;

    if (req.method !== "GET") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    const { lat, lon } = req.query || {};
    if (!lat || !lon) {
        return res.status(400).json({ error: "`lat` and `lon` are required" });
    }

    if (!process.env.OPENWEATHER_API_KEY) {
        return res.status(500).json({ error: "OPENWEATHER_API_KEY is not configured on the server" });
    }

    const search = new URLSearchParams({
        lat: Array.isArray(lat) ? lat[0] : lat,
        lon: Array.isArray(lon) ? lon[0] : lon,
        appid: process.env.OPENWEATHER_API_KEY,
        units: "metric",
        lang: "kr",
    });

    const url = `https://api.openweathermap.org/data/2.5/weather?${search.toString()}`;

    let weatherRes;
    try {
        weatherRes = await fetch(url);
    } catch (err) {
        return res.status(502).json({ error: "Failed to reach OpenWeatherMap", detail: err.message });
    }

    const rawBody = await weatherRes.text();
    try {
        return res.status(weatherRes.status).json(JSON.parse(rawBody));
    } catch (err) {
        return res.status(502).json({
            error: "OpenWeatherMap returned a non-JSON response",
            weatherStatus: weatherRes.status,
            bodyPreview: rawBody.slice(0, 300),
        });
    }
};
