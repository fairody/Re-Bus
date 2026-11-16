const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 5174;
const OVERPASS_HOSTS = ["overpass-api.de", "overpass.kumi.systems", "overpass.nchc.org.tw"];
const NOMINATIM_HOST = "nominatim.openstreetmap.org";
const OSRM_HOST = "router.project-osrm.org";
const FOOT_ROUTER_HOST = "routing.openstreetmap.de";
const USER_AGENT = "ReBusDemo/1.0";

/** Answers a proxy error without crashing if the upstream response had already started. */
function proxyFailed(res, message) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(message);
}

function corsJson(res, statusCode) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
}

function proxyNominatim(req, res, pathname, search) {
  const path = pathname + search;
  const proxyReq = https.request(
    {
      hostname: NOMINATIM_HOST,
      path,
      method: "GET",
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    },
    (proxyRes) => {
      corsJson(res, proxyRes.statusCode);
      proxyRes.pipe(res);
    }
  );
  res.on("close", () => proxyReq.destroy());
  proxyReq.setTimeout(5000, () => proxyReq.destroy(new Error("Nominatim timeout")));
  proxyReq.on("error", () => proxyFailed(res, "Nominatim proxy error"));
  proxyReq.end();
}

function proxyOsrmRoute(req, res, url) {
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!from || !to) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Missing from or to");
    return;
  }
  const parsePair = (s) => {
    const [lat, lon] = s.split(",").map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon };
  };
  const a = parsePair(from);
  const b = parsePair(to);
  if (!a || !b) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Invalid from or to");
    return;
  }
  const profile = url.searchParams.get("profile") === "driving" ? "driving" : "foot";
  const hostname = profile === "foot" ? FOOT_ROUTER_HOST : OSRM_HOST;
  const prefix = profile === "foot" ? "/routed-foot" : "";
  const path = `${prefix}/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=full&geometries=geojson&steps=true`;
  const proxyReq = https.request(
    {
      hostname,
      path,
      method: "GET",
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    },
    (proxyRes) => {
      corsJson(res, proxyRes.statusCode);
      proxyRes.pipe(res);
    }
  );
  res.on("close", () => proxyReq.destroy());
  proxyReq.setTimeout(5000, () => proxyReq.destroy(new Error("OSRM timeout")));
  proxyReq.on("error", () => proxyFailed(res, "OSRM proxy error"));
  proxyReq.end();
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function proxyOverpass(req, res) {
  let activeProxyReq = null;
  res.on("close", () => activeProxyReq?.destroy());
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    let hostIndex = 0;
    const tryNextHost = () => {
      if (res.destroyed) return;
      if (hostIndex >= OVERPASS_HOSTS.length) {
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("All Overpass servers are unavailable");
        }
        return;
      }

      const hostname = OVERPASS_HOSTS[hostIndex++];
      const proxyReq = https.request(
        {
          hostname,
          path: "/api/interpreter",
          method: "POST",
          headers: {
            "User-Agent": USER_AGENT,
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (proxyRes) => {
          if (proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
            res.writeHead(proxyRes.statusCode, {
              "Content-Type": "application/json; charset=utf-8",
              "Access-Control-Allow-Origin": "*",
            });
            proxyRes.pipe(res);
            return;
          }
          proxyRes.resume();
          tryNextHost();
        }
      );
      activeProxyReq = proxyReq;
      proxyReq.setTimeout(9000, () => proxyReq.destroy(new Error("Overpass timeout")));
      proxyReq.on("error", tryNextHost);
      proxyReq.write(body);
      proxyReq.end();
    };
    tryNextHost();
  });
}

const ROOT = process.cwd();

function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split("?")[0]);
  } catch {
    // Malformed %-encoding used to throw here and crash the whole server.
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Bad request");
    return;
  }
  const filePath = path.resolve(ROOT, urlPath === "/" ? "index.html" : "." + urlPath);
  // Only files inside the project folder may be served ("/../" tricks are refused).
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (req.method === "POST" && url.pathname === "/api/overpass") {
      proxyOverpass(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/nominatim/reverse") {
      proxyNominatim(req, res, "/reverse", url.search);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/osrm/route") {
      proxyOsrmRoute(req, res, url);
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/")) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    if (req.method === "GET") {
      serveStatic(req, res);
      return;
    }
    res.writeHead(405);
    res.end();
  })
  .listen(PORT, () => {
    console.log(`http://localhost:${PORT}`);
  });
