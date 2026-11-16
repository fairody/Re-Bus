// Rebuilds river-paths.js legs for the given lines from the official OSM ferry
// route relations («N-й речной»). Their ways are drawn along the actual boat
// track on the water, unlike river centerlines, which cut across land at bends,
// islands and backwaters.
//
// Usage: node scripts/build-ferry-paths.js R2 [R3 ...]
//
// For each line: all ferry ways of both direction relations form a graph; each
// pier is attached to the nearest point on that graph, and every leg between
// consecutive piers is the shortest path through it.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const RELATIONS = {
  R1: [15834245, 15834246], // 1-й речной: Парк «Фили» ⇄ Киевский
  R2: [16404070, 16404071], // 2-й речной: ЗИЛ ⇄ Печатники
  R3: [19298309, 19298310], // 3-й речной: Новоспасский ⇄ ЗИЛ
  R4: [20948560, 20948561], // 4-й речной: Киевский ⇄ Лужники
};
const MAX_SNAP_METERS = 400;

function load(file) {
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), "utf8"), ctx);
  return ctx.window;
}

function haversine(a, b) {
  const r = (x) => (x * Math.PI) / 180;
  const s = Math.sin(r(b[0] - a[0]) / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(r(b[1] - a[1]) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(s));
}

/** Closest point to p on segment a–b (local flat projection) and its t in [0,1]. */
function project(p, a, b) {
  const k = Math.cos((p[0] * Math.PI) / 180);
  const ax = a[1] * k, ay = a[0], bx = b[1] * k, by = b[0], px = p[1] * k, py = p[0];
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return { t, point: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])] };
}

async function fetchRelation(id) {
  const url = `https://api.openstreetmap.org/api/0.6/relation/${id}/full.json`;
  const res = await fetch(url, { headers: { "User-Agent": "ReBusDemo/1.0" } });
  if (!res.ok) throw new Error(`relation ${id}: HTTP ${res.status}`);
  return (await res.json()).elements;
}

async function buildGraph(lineId) {
  const nodes = new Map(); // key -> { coord, edges: Map<key, meters> }
  const addNode = (key, coord) => { if (!nodes.has(key)) nodes.set(key, { coord, edges: new Map() }); };
  const link = (a, b) => {
    const d = haversine(nodes.get(a).coord, nodes.get(b).coord);
    nodes.get(a).edges.set(b, d);
    nodes.get(b).edges.set(a, d);
  };
  const segments = [];
  for (const relId of RELATIONS[lineId]) {
    const elements = await fetchRelation(relId);
    const osmNodes = new Map(elements.filter((e) => e.type === "node").map((e) => [e.id, [e.lat, e.lon]]));
    for (const way of elements.filter((e) => e.type === "way" && e.tags?.route === "ferry")) {
      way.nodes.forEach((id) => addNode(String(id), osmNodes.get(id)));
      for (let i = 1; i < way.nodes.length; i++) {
        const a = String(way.nodes[i - 1]), b = String(way.nodes[i]);
        if (!nodes.get(a).edges.has(b)) { link(a, b); segments.push([a, b]); }
      }
    }
  }
  return { nodes, segments, link, addNode };
}

/** Adds the pier as a node attached to the nearest point of the ferry track. */
function attachPier(graph, pier) {
  let best = null;
  for (const [a, b] of graph.segments) {
    const { t, point } = project(pier.coord, graph.nodes.get(a).coord, graph.nodes.get(b).coord);
    const d = haversine(pier.coord, point);
    if (!best || d < best.d) best = { a, b, t, point, d };
  }
  if (!best || best.d > MAX_SNAP_METERS) throw new Error(`${pier.id}: ferry track is ${best ? Math.round(best.d) : "?"} m away`);
  const snapKey = `snap:${pier.id}`;
  const pierKey = `pier:${pier.id}`;
  graph.addNode(snapKey, best.point);
  graph.addNode(pierKey, pier.coord);
  graph.link(snapKey, best.a);
  graph.link(snapKey, best.b);
  graph.link(pierKey, snapKey);
  return { key: pierKey, snapMeters: best.d };
}

function shortestPath(nodes, from, to) {
  const dist = new Map([[from, 0]]);
  const prev = new Map();
  const done = new Set();
  while (true) {
    let cur = null;
    for (const [k, d] of dist) if (!done.has(k) && (cur === null || d < dist.get(cur))) cur = k;
    if (cur === null) return null;
    if (cur === to) break;
    done.add(cur);
    for (const [next, w] of nodes.get(cur).edges) {
      const nd = dist.get(cur) + w;
      if (nd < (dist.get(next) ?? Infinity)) { dist.set(next, nd); prev.set(next, cur); }
    }
  }
  const out = [];
  for (let k = to; k !== undefined; k = prev.get(k)) out.unshift(nodes.get(k).coord);
  return { coords: out, meters: dist.get(to) };
}

async function main() {
  const lines = process.argv.slice(2);
  if (!lines.length || lines.some((id) => !RELATIONS[id])) throw new Error(`usage: build-ferry-paths.js ${Object.keys(RELATIONS).join(" | ")} ...`);
  const { REBUS_DATA } = load("data.js");
  const paths = load("river-paths.js").REBUS_RIVER_PATHS;
  const round = ([lat, lon]) => [Number(lat.toFixed(6)), Number(lon.toFixed(6))];

  for (const lineId of lines) {
    const line = REBUS_DATA.RIVER_LINES[lineId];
    const graph = await buildGraph(lineId);
    const attached = new Map();
    for (const id of line.pierIds) attached.set(id, attachPier(graph, REBUS_DATA.PIERS.find((p) => p.id === id)));
    console.log(`${lineId}: ${graph.nodes.size} graph nodes`);
    for (let i = 1; i < line.pierIds.length; i++) {
      const from = line.pierIds[i - 1], to = line.pierIds[i];
      const result = shortestPath(graph.nodes, attached.get(from).key, attached.get(to).key);
      if (!result) throw new Error(`${from} → ${to}: ferry track is not connected`);
      const key = `${from}__${to}`;
      paths[key] = result.coords.map(round);
      console.log(`  ${key}: ${result.coords.length} pts, ${Math.round(result.meters)} m (snaps ${Math.round(attached.get(from).snapMeters)} / ${Math.round(attached.get(to).snapMeters)} m)`);
    }
  }

  fs.writeFileSync(
    path.join(ROOT, "river-paths.js"),
    `// OSM river geometry between consecutive piers on routes R1–R4\n(function(){window.REBUS_RIVER_PATHS=${JSON.stringify(paths, null, 2)};})();\n`
  );
  console.log("river-paths.js updated");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
