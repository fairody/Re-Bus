/* global L, REBUS_DATA */
(function () {
  const REFRESH_MS = 10_000;
  const OVERPASS_URL = `${window.location.origin}/api/overpass`;
  const NOMINATIM_REVERSE_URL = `${window.location.origin}/api/nominatim/reverse`;
  const OSRM_ROUTE_URL = `${window.location.origin}/api/osrm/route`;
  // Vivid colours chosen to stand out on the OSM basemap (no OSM road/area uses them).
  // Keep in sync with the legend dots in styles.css.
  const MAP_THEME = {
    pier: "#ffb300",
    routeOutline: "#ffffff",
    river: "#e6007e",
    bus: "#7c3aed",
    stop: "#7c3aed",
    walk: "#0047ff",
    pointA: "#00b140",
    pointB: "#e3001b",
  };

  // Moscow corridor covering all currently open regular river lines.
  const ROUTE_BBOX = { s: 55.66, w: 37.46, n: 55.78, e: 37.72 };
  /** Points outside ROUTE_BBOX are served if a pier is within this distance (reached on foot or by bus). */
  const PIER_REACH_MAX_METERS = 3000;
  /** A walking-only route is recommended only up to this duration; longer trips go by river. */
  const WALK_ONLY_MAX_MIN = 20;

  /** @type {Map<string, {coords:[number,number][],durationSec:number}>} */
  const osrmRouteCache = new Map();
  let footRouteQueue = Promise.resolve();
  let lastFootRouteRequestAt = 0;
  let footRouterUnavailableUntil = 0;

  let routeBuildGen = 0;

  const els = {
    map: document.getElementById("map"),
    pointA: document.getElementById("pointA"),
    pointB: document.getElementById("pointB"),
    pointAAddress: document.getElementById("pointAAddress"),
    pointBAddress: document.getElementById("pointBAddress"),
    buildBtn: document.getElementById("buildBtn"),
    resetBtn: document.getElementById("resetBtn"),
    routeSummary: document.getElementById("routeSummary"),
    riverBoard: document.getElementById("riverBoard"),
    busBoard: document.getElementById("busBoard"),
    statusClock: document.getElementById("statusClock"),
  };

  /** @type {L.Map} */
  let map;
  /** @type {L.LayerGroup} */
  let markerLayer;
  /** @type {L.LayerGroup} */
  let routeLayer;
  /** @type {L.LayerGroup} */
  let pointLayer;

  /** @type {Map<string, string>} */
  const reverseGeocodeCache = new Map();

  async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  /** @type {Map<string, {id:string,type:'stop',name:string,coord:[number,number],routes:string[]}>} */
  const runtimeBusStopsById = new Map();

  /** Text from outside sources (addresses, OSM names) must not be inserted as HTML. */
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  function stripPierName(name) {
    return String(name || "")
      .replace(/[«»"]/g, "")
      .replace(/^Причал\s+/i, "")
      .trim();
  }

  function initialRouteState() {
    return {
      builtAt: null,
      selectedPierId: "pier_kievsky",
      pierFromId: null,
      placing: "a",
      mapPoints: { a: null, b: null },
      cachedRoute: null,
    };
  }

  let routeState = initialRouteState();

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function fmtClock(d) {
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }

  function fmtMinutes(min) {
    return min <= 0 ? "сейчас" : `${min} мин`;
  }

  function minutesBetween(a, b) {
    return Math.round((b.getTime() - a.getTime()) / 60000);
  }

  function fmtHm(d) {
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function isSameDay(a, b) {
    return a.toDateString() === b.toDateString();
  }

  // ---------------------------------------------------------------------------
  // River timetable: published schedule (RIVER_SCHEDULE in data.js), no real time.
  // ---------------------------------------------------------------------------

  function parseHm(hm) {
    const [h, m] = String(hm).split(":").map(Number);
    return h * 60 + m;
  }

  /** Departure times (minutes after midnight) from either terminal of the line. */
  function terminalDepartureMinutes(line) {
    const schedule = line.schedule || REBUS_DATA.RIVER_SCHEDULE;
    const last = parseHm(schedule.lastDeparture);
    const out = [];
    for (let t = parseHm(schedule.firstDeparture); t <= last;) {
      out.push(t);
      const slot = schedule.intervals.find((s) => t >= parseHm(s.from) && t < parseHm(s.to));
      t += slot ? slot.min : 30;
    }
    return out;
  }

  /** Sailing minutes from the starting terminal to the pier (forward = pierIds order). */
  function minutesFromTerminal(line, pierId, forward) {
    const ids = forward ? line.pierIds : line.pierIds.slice().reverse();
    let total = 0;
    for (let i = 0; i < ids.length; i++) {
      if (ids[i] === pierId) return total;
      if (i + 1 < ids.length) {
        const key = forward ? `${ids[i]}__${ids[i + 1]}` : `${ids[i + 1]}__${ids[i]}`;
        total += line.segmentMinutes[key] ?? 0;
      }
    }
    return null;
  }

  /** Scheduled departures from a pier in one direction, at or after `after` (today, then tomorrow). */
  function riverDeparturesFrom(line, pierId, forward, after, limit) {
    const ids = forward ? line.pierIds : line.pierIds.slice().reverse();
    const offset = minutesFromTerminal(line, pierId, forward);
    if (offset === null || ids[ids.length - 1] === pierId) return []; // boats end their run here
    const towards = getById(ids[ids.length - 1])?.name || "";
    const out = [];
    for (let day = 0; day < 2 && out.length < limit; day++) {
      const midnight = new Date(after);
      midnight.setHours(0, 0, 0, 0);
      midnight.setDate(midnight.getDate() + day);
      for (const minutes of terminalDepartureMinutes(line)) {
        const at = new Date(midnight.getTime() + (minutes + offset) * 60_000);
        if (at < after) continue;
        out.push({ at, towards, lineId: line.id });
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  /** Next scheduled boat of `line` from one pier towards another (null if the piers are not on the line). */
  function nextRiverDeparture(line, fromPierId, toPierId, after) {
    const from = line.pierIds.indexOf(fromPierId);
    const to = line.pierIds.indexOf(toPierId);
    if (from < 0 || to < 0 || from === to) return null;
    return riverDeparturesFrom(line, fromPierId, from < to, after, 1)[0] || null;
  }

  /**
   * Typical interval by Moscow route type — an ESTIMATE until real bus
   * timetables (transport.mos.ru) are added.
   */
  function busIntervalEstimate(ref) {
    const r = String(ref).trim().toLowerCase();
    if (r.startsWith("н")) return { min: 30, label: "≈ 30 мин, только ночью" };
    if (r.startsWith("м")) return { min: 7, label: "≈ 7 мин" };
    if (r.startsWith("е")) return { min: 10, label: "≈ 10 мин" };
    if (r.startsWith("с") || r.startsWith("т")) return { min: 20, label: "≈ 20 мин" };
    return { min: 12, label: "≈ 12 мин" };
  }

  function getOrderedPiers() {
    const ids = [...new Set(Object.values(REBUS_DATA.RIVER_LINES).flatMap((line) => line.pierIds || []))];
    return ids.map((id) => REBUS_DATA.PIERS.find((p) => p.id === id)).filter(Boolean);
  }

  function initStaticBusStops() {
    const stops = REBUS_DATA.PIER_BUS_STOPS || {};
    for (const pier of REBUS_DATA.PIERS) {
      const stop = stops[pier.id];
      if (!stop) continue;
      const entry = { ...stop, type: "stop" };
      runtimeBusStopsById.set(entry.id, entry);
      pier.stopId = entry.id;
    }
  }

  function inRouteBbox(coord) {
    if (!coord || !Number.isFinite(coord[0]) || !Number.isFinite(coord[1])) return false;
    const [lat, lon] = coord;
    const { s, w, n, e } = ROUTE_BBOX;
    return lat >= s && lat <= n && lon >= w && lon <= e;
  }

  // ---------------------------------------------------------------------------
  // Getting to / from the pier: walking, or bus (+ walking to and from the stops).
  // ---------------------------------------------------------------------------

  /** Closer than this to the pier, a bus is never worth it — walking only. */
  const BUS_MIN_DISTANCE_METERS = 400;
  /** Walking to/from the pier is offered up to this straight-line distance. */
  const WALK_MAX_METERS = 4000;
  /** Average wait for a bus at a stop (no live timetable). */
  const BUS_WAIT_MIN = 5;
  /** Bus is chosen automatically only if it is at least this much faster than walking. */
  const BUS_ADVANTAGE_MIN = 2;
  const WALK_M_PER_MIN = 80;
  /** Max distance between stops for a bus-to-bus transfer. */
  const TRANSFER_MAX_METERS = 250;

  function pathMeters(coords) {
    let total = 0;
    for (let i = 1; i < coords.length; i++) total += haversineMeters(coords[i - 1], coords[i]);
    return total;
  }

  function estimateWalkMin(a, b) {
    return (haversineMeters(a, b) * 1.3) / WALK_M_PER_MIN;
  }

  function busRideMin(distanceMeters) {
    return Math.max(1, Math.ceil(distanceMeters / 250) + 3);
  }

  /**
   * Street walking path via OSRM; if the router fails, an approximate straight line.
   * null = no walking path (the router could only get there by ferry).
   */
  async function footPath(fromCoord, toCoord) {
    if (haversineMeters(fromCoord, toCoord) <= 35) return { coords: [fromCoord, toCoord], minutes: 0, approximate: false };
    try {
      const route = await fetchOsrmRoute(fromCoord, toCoord, "foot");
      if (route.viaFerry) return null; // the only "walk" goes over the water by boat: not walkable
      return { coords: route.coords, minutes: Math.max(1, Math.ceil(route.durationSec / 60)), approximate: false };
    } catch {
      return { coords: [fromCoord, toCoord], minutes: Math.max(1, Math.ceil(estimateWalkMin(fromCoord, toCoord))), approximate: true };
    }
  }

  function walkStep(title, from, to, path) {
    return { mode: "walk", title: title + (path.approximate ? " (примерно)" : ""), from, to, rideMin: path.minutes };
  }

  function legEndNames(point, pier, role) {
    const pointName = point.address || (role === "departure" ? "Откуда" : "Куда");
    return role === "departure" ? { startName: pointName, endName: pier.name } : { startName: pier.name, endName: pointName };
  }

  async function walkLegOption(point, pier, role, maxWalkMeters = WALK_MAX_METERS) {
    if (haversineMeters(point.coord, pier.coord) > maxWalkMeters) return null;
    const departure = role === "departure";
    const { startName, endName } = legEndNames(point, pier, role);
    const path = await footPath(departure ? point.coord : pier.coord, departure ? pier.coord : point.coord);
    if (!path) return null;
    return {
      mode: "walk",
      minutes: path.minutes,
      segments: [{ coords: path.coords, dashed: true, kind: "walk" }],
      steps: path.minutes > 0 ? [walkStep(departure ? "Пешком до причала" : "Пешком от причала", startName, endName, path)] : [],
      routeRef: null,
    };
  }

  /** @type {Map<string, any[]>} */
  const pierStopsCache = new Map();

  /** Bus stops (with their OSM route refs) within walking distance of a pier. */
  async function stopsNearPier(pier) {
    if (pierStopsCache.has(pier.id)) return pierStopsCache.get(pier.id);
    const staticStop = REBUS_DATA.PIER_BUS_STOPS?.[pier.id];
    let stops = [];
    let fromOsm = false;
    try {
      stops = (await overpassStopsAroundWithRoutes(pier.coord, 600)).filter((stop) => stop.routes.length);
      fromOsm = true;
    } catch {
      stops = [];
    }
    if (staticStop && !stops.some((stop) => haversineMeters(stop.coord, staticStop.coord) < 40)) {
      stops.push({ ...staticStop, type: "stop" });
    }
    if (fromOsm) pierStopsCache.set(pier.id, stops);
    return stops;
  }

  /** Index of a stop inside a route relation (by OSM id, or by position for static stops). */
  function stopIndexInRoute(route, stop) {
    const byId = route.stops.findIndex((s) => s.id === stop.id);
    if (byId >= 0) return byId;
    if (String(stop.id).startsWith("osm_node_")) return -1;
    return route.stops.findIndex((s) => haversineMeters(s.coord, stop.coord) < 30);
  }

  /**
   * Best bus option for one leg. "departure": point A → bus → pier.
   * "arrival": pier → bus → point B (the bus really runs in that direction).
   * Direct buses first; one bus-to-bus transfer if there is no direct bus.
   */
  async function busLegOption(point, pier, role) {
    if (haversineMeters(point.coord, pier.coord) < BUS_MIN_DISTANCE_METERS) return null;
    let pointStops;
    let pierStops;
    try {
      [pointStops, pierStops] = await Promise.all([
        overpassStopsAroundWithRoutes(point.coord, 1000),
        stopsNearPier(pier),
      ]);
    } catch {
      return null;
    }
    pointStops = pointStops.filter((stop) => stop.routes.length);
    if (!pointStops.length || !pierStops.length) return null;

    const refs = [...new Set([...pointStops, ...pierStops].flatMap((stop) => stop.routes))];
    let routes;
    try {
      routes = await overpassBusRouteOptions(refs, [point.coord, pier.coord]);
    } catch {
      return null;
    }
    if (!routes.length) return null;

    const departure = role === "departure";
    const originStops = departure ? pointStops : pierStops;
    const destStops = departure ? pierStops : pointStops;
    const startCoord = departure ? point.coord : pier.coord;
    const endCoord = departure ? pier.coord : point.coord;
    const knownNames = new Map([...pointStops, ...pierStops].map((stop) => [stop.id, stop.name]));
    // "ост." keeps a stop named after a pier («Причал «ЗИЛ»») distinguishable from the pier itself.
    // Route relation members carry no names; such stops are only used for bus-to-bus transfers.
    const stopName = (stop) => {
      const name = knownNames.get(stop.id) || (stop.name !== "Остановка" ? stop.name : "");
      return name ? `ост. ${name}` : "ост. пересадки";
    };

    // For every relation: the origin / destination stops it serves, closest walk first.
    const served = routes.map((route) => {
      const pick = (stops, coord) => stops
        .map((stop) => ({ stop, index: stopIndexInRoute(route, stop) }))
        .filter((x) => x.index >= 0)
        .map((x) => ({ ...x, walk: estimateWalkMin(coord, x.stop.coord) }))
        .sort((a, b) => a.walk - b.walk);
      return { route, origins: pick(originStops, startCoord), dests: pick(destStops, endCoord) };
    });

    const estimateRide = (from, to) => busRideMin(haversineMeters(from.coord, to.coord) * 1.3);
    const candidates = [];

    // Direct bus: origin stop before destination stop on the same relation (= right direction).
    for (const { route, origins, dests } of served) {
      for (const o of origins) {
        const d = dests.find((x) => x.index > o.index);
        if (!d) continue;
        const from = route.stops[o.index];
        const to = route.stops[d.index];
        candidates.push({
          rides: [{ route, from, to, fromName: stopName(o.stop), toName: stopName(d.stop) }],
          estimate: o.walk + BUS_WAIT_MIN + estimateRide(from, to) + d.walk,
        });
      }
    }

    // One transfer between two relations, both in the right direction.
    if (!candidates.length) {
      for (const first of served) {
        const o = first.origins[0];
        if (!o) continue;
        for (const second of served) {
          if (second === first || String(second.route.ref).toUpperCase() === String(first.route.ref).toUpperCase()) continue;
          const d = second.dests[0];
          if (!d) continue;
          let best = null;
          for (const t1 of first.route.stops.slice(o.index + 1)) {
            for (const t2 of second.route.stops.slice(0, d.index)) {
              const distance = haversineMeters(t1.coord, t2.coord);
              if (distance <= TRANSFER_MAX_METERS && (!best || distance < best.distance)) best = { t1, t2, distance };
            }
          }
          if (!best) continue;
          const from = first.route.stops[o.index];
          const to = second.route.stops[d.index];
          candidates.push({
            rides: [
              { route: first.route, from, to: best.t1, fromName: stopName(o.stop), toName: stopName(best.t1) },
              { route: second.route, from: best.t2, to, fromName: stopName(best.t2), toName: stopName(d.stop) },
            ],
            estimate: o.walk + 2 * BUS_WAIT_MIN + estimateRide(from, best.t1) + best.distance / WALK_M_PER_MIN +
              estimateRide(best.t2, to) + d.walk,
          });
        }
      }
    }

    candidates.sort((a, b) => a.estimate - b.estimate);
    const { startName, endName } = legEndNames(point, pier, role);

    for (const candidate of candidates.slice(0, 3)) {
      const busCoords = candidate.rides.map((ride) => sliceBusRouteGeometry(ride.route, ride.from, ride.to));
      if (busCoords.some((coords) => !coords || coords.length < 2)) continue;

      const rides = candidate.rides;
      const firstRide = rides[0];
      const lastRide = rides[rides.length - 1];
      const walkIn = await footPath(startCoord, firstRide.from.coord);
      const transferWalks = [];
      for (let i = 1; i < rides.length; i++) transferWalks.push(await footPath(rides[i - 1].to.coord, rides[i].from.coord));
      const walkOut = await footPath(lastRide.to.coord, endCoord);
      if (!walkIn || !walkOut || transferWalks.some((walk) => !walk)) continue;

      const segments = [];
      const steps = [];
      if (walkIn.minutes > 0) {
        segments.push({ coords: walkIn.coords, dashed: true, kind: "walk" });
        steps.push(walkStep("Пешком до остановки", startName, firstRide.fromName, walkIn));
      }
      rides.forEach((ride, i) => {
        if (i > 0 && transferWalks[i - 1].minutes > 0) {
          segments.push({ coords: transferWalks[i - 1].coords, dashed: true, kind: "walk" });
          steps.push(walkStep("Пешком на пересадку", rides[i - 1].toName, ride.fromName, transferWalks[i - 1]));
        }
        const interval = busIntervalEstimate(ride.route.ref);
        steps.push({
          mode: "wait",
          title: `Ожидание автобуса ${ride.route.ref} (интервал ${interval.label}, оценка)`,
          from: ride.fromName,
          to: ride.fromName,
          rideMin: Math.max(2, Math.round(interval.min / 2)),
        });
        segments.push({ coords: busCoords[i], dashed: false, kind: "bus" });
        steps.push({ mode: "bus", title: `Автобус ${ride.route.ref}`, from: ride.fromName, to: ride.toName, rideMin: busRideMin(pathMeters(busCoords[i])) });
      });
      if (walkOut.minutes > 0) {
        segments.push({ coords: walkOut.coords, dashed: true, kind: "walk" });
        steps.push(walkStep(departure ? "Пешком до причала" : "Пешком до точки назначения", lastRide.toName, endName, walkOut));
      }

      return {
        mode: "bus",
        minutes: steps.reduce((total, step) => total + step.rideMin, 0),
        segments,
        steps,
        rides: rides.map((ride) => ({ ref: ride.route.ref, fromName: ride.fromName, toName: ride.toName })),
        routeRef: rides.map((ride) => ride.route.ref).join(" / "),

      };
    }
    return null;
  }

  /**
   * Both ways to cover one leg (walk / bus). Picks the faster one; the user
   * can switch in the route summary.
   */
  async function resolveEndpointLeg(point, pier, role, maxWalkMeters = WALK_MAX_METERS) {
    if (!pier?.coord) return { ok: false, reason: "Не удалось найти причал для пересадки." };
    const [walk, bus] = await Promise.all([
      walkLegOption(point, pier, role, maxWalkMeters).catch(() => null),
      busLegOption(point, pier, role).catch(() => null),
    ]);
    if (!walk && !bus) {
      return {
        ok: false,
        reason: `Не удалось добраться ${role === "departure" ? "до причала" : "от причала"} «${pier.name}»: пешком слишком далеко, подходящий автобус не найден.`,
      };
    }
    const selected = bus && (!walk || bus.minutes + BUS_ADVANTAGE_MIN <= walk.minutes) ? "bus" : "walk";
    return { ok: true, options: { walk, bus }, selected };
  }

  function selectedLegOption(leg) {
    return leg.options[leg.selected] || leg.options.walk || leg.options.bus;
  }

  /** Derives the flat route fields used by the renderers from the chosen leg options. */
  function applyLegSelection(res) {
    const a = selectedLegOption(res.legA);
    const b = selectedLegOption(res.legB);
    res.bus1Min = a.minutes;
    res.bus2Min = b.minutes;
    res.bus1Segments = a.segments;
    res.bus2Segments = b.segments;
    if (!res.rides) return res;

    // River part: each boat ride, then the change to the next one (water or land).
    const riverSteps = [];
    const linkRides = [];
    const riverCoords = [];
    res.rides.forEach((ride, i) => {
      riverSteps.push({
        mode: "river",
        rideIndex: i,
        // Only the line number: the boat may run opposite to the direction in the line's name.
        title: `${REBUS_DATA.RIVER_LINES[ride.lineId].name.split(":")[0]} (речной транспорт)`,
        from: getById(ride.fromId).name,
        to: getById(ride.toId).name,
        rideMin: ride.minutes,
      });
      riverCoords.push(...ride.coords);
      const link = res.links[i];
      if (!link) return;
      if (link.kind === "water") {
        if (link.walkMin > 0) {
          riverSteps.push({ mode: "walk", title: "Пересадка: пешком к другому причалу", from: getById(link.fromId).name, to: getById(link.toId).name, rideMin: link.walkMin });
          riverCoords.push(...link.coords);
        }
      } else {
        const option = selectedLegOption(link.leg);
        option.steps.forEach((s, k) => {
          riverSteps.push(k === 0 ? { ...s, title: `Пересадка между линиями: ${s.title.charAt(0).toLowerCase()}${s.title.slice(1)}` } : s);
        });
        for (const seg of option.segments) riverCoords.push(...seg.coords);
        linkRides.push(...(option.rides || []));
      }
    });
    res.riverSteps = riverSteps;
    res.riverCoords = riverCoords;
    res.rideMin = res.rides.reduce((total, ride) => total + ride.minutes, 0) +
      res.links.reduce((total, link) => total + linkMinutes(link), 0);
    res.steps = [...a.steps, ...riverSteps, ...b.steps];
    res.busRides = [...(a.rides || []), ...linkRides, ...(b.rides || [])];
    return res;
  }

  function osrmCacheKey(fromCoord, toCoord, profile) {
    const f = fromCoord.map((x) => x.toFixed(5)).join(",");
    const t = toCoord.map((x) => x.toFixed(5)).join(",");
    return `${profile}|${f}|${t}`;
  }

  async function fetchOsrmRoute(fromCoord, toCoord, profile = "foot") {
    const key = osrmCacheKey(fromCoord, toCoord, profile);
    if (osrmRouteCache.has(key)) return osrmRouteCache.get(key);

    const request = async () => {
      const from = `${fromCoord[0]},${fromCoord[1]}`;
      const to = `${toCoord[0]},${toCoord[1]}`;
      const url = `${OSRM_ROUTE_URL}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&profile=${profile}`;
      try {
        const r = await fetchWithTimeout(url, { headers: { Accept: "application/json" } }, 6000);
        if (!r.ok) throw new Error("osrm_failed");
        const json = await r.json();
        if (json.code !== "Ok" || !json.routes?.[0]?.geometry?.coordinates?.length) throw new Error("osrm_no_route");
        const route = json.routes[0];
        // The foot router treats OSM ferry lines (incl. our river routes) as walkable;
        // such a "walk" actually crosses the river by boat, so it is flagged.
        const viaFerry = (route.legs || []).some((leg) => (leg.steps || []).some((step) => step.mode === "ferry"));
        const out = { coords: route.geometry.coordinates.map(([lon, lat]) => [lat, lon]), durationSec: route.duration || 0, approximate: false, viaFerry };
        osrmRouteCache.set(key, out);
        return out;
      } catch (error) {
        // Pause the walking router only when it is unreachable; "no route between
        // these points" is a valid answer and must not disable routing for others.
        if (profile === "foot" && error.message !== "osrm_no_route") footRouterUnavailableUntil = Date.now() + 60_000;
        throw error;
      }
    };

    const unavailableFootRoute = () => new Error("foot_router_unavailable");
    if (profile !== "foot") return request();
    if (Date.now() < footRouterUnavailableUntil) throw unavailableFootRoute();
    const queued = footRouteQueue.then(async () => {
      const waitMs = Math.max(0, 1100 - (Date.now() - lastFootRouteRequestAt));
      if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
      lastFootRouteRequestAt = Date.now();
      return request();
    });
    footRouteQueue = queued.catch(() => {});
    return queued.catch(() => { throw unavailableFootRoute(); });
  }

  async function reverseGeocode(lat, lon) {
    const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
    if (reverseGeocodeCache.has(key)) return reverseGeocodeCache.get(key);
    const url = `${NOMINATIM_REVERSE_URL}?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`;
    const r = await fetchWithTimeout(url, { headers: { Accept: "application/json" } }, 6000);
    if (!r.ok) throw new Error("reverse_geocode_failed");
    const json = await r.json();
    const fullName = json.display_name || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    const addressParts = fullName.split(",").map((part) => part.trim()).filter(Boolean);
    const cityIndex = addressParts.findIndex((part) => /^(?:г(?:ород)?\.?\s*)?москва$/i.test(part));
    const name = cityIndex >= 0
      ? addressParts.slice(0, cityIndex + 1).join(", ")
      : fullName;
    reverseGeocodeCache.set(key, name);
    return name;
  }

  function updatePointCards() {
    const a = routeState.mapPoints.a;
    const b = routeState.mapPoints.b;
    els.pointA.classList.toggle("pointCard--empty", !a);
    els.pointB.classList.toggle("pointCard--empty", !b);
    els.pointA.classList.toggle("pointCard--active", routeState.placing === "a");
    els.pointB.classList.toggle("pointCard--active", routeState.placing === "b");
    els.pointAAddress.textContent = a?.address || (routeState.placing === "a" ? "Кликните на карту" : "Не задана");
    els.pointBAddress.textContent = b?.address || (a ? "Кликните на карту для точки B" : "Затем выберите вторую точку");
  }

  function renderPointMarkers() {
    if (!pointLayer) return;
    pointLayer.clearLayers();
    ensurePinCss();
    const a = routeState.mapPoints.a;
    const b = routeState.mapPoints.b;
    if (a?.coord) {
      L.marker(a.coord, { icon: makeDivIcon(MAP_THEME.pointA, "A"), zIndexOffset: 500 })
        .bindPopup(`<b>Откуда</b><div style="margin-top:6px;opacity:.85">${escapeHtml(a.address)}</div>`)
        .addTo(pointLayer);
    }
    if (b?.coord) {
      L.marker(b.coord, { icon: makeDivIcon(MAP_THEME.pointB, "B"), zIndexOffset: 500 })
        .bindPopup(`<b>Куда</b><div style="margin-top:6px;opacity:.85">${escapeHtml(b.address)}</div>`)
        .addTo(pointLayer);
    }
  }

  async function placeMapPoint(latlng) {
    const coord = [latlng.lat, latlng.lng];
    const slot = routeState.placing;
    // A route still being built belongs to the old points: drop its result.
    routeBuildGen += 1;
    els.buildBtn.disabled = false;
    const loading = "Определяем адрес…";
    if (slot === "a") {
      routeState.mapPoints.a = { coord, address: loading };
      routeState.mapPoints.b = null;
      routeState.placing = "b";
    } else {
      routeState.mapPoints.b = { coord, address: loading };
      routeState.placing = "a";
    }
    routeState.builtAt = null;
    routeState.cachedRoute = null;
    updatePointCards();
    renderPointMarkers();
    clearRouteLayerOnly();
    try {
      const address = await reverseGeocode(coord[0], coord[1]);
      const pt = routeState.mapPoints[slot];
      if (pt && pt.coord[0] === coord[0] && pt.coord[1] === coord[1]) {
        pt.address = address;
      }
    } catch {
      const pt = routeState.mapPoints[slot];
      if (pt && pt.coord[0] === coord[0] && pt.coord[1] === coord[1]) {
        pt.address = `${coord[0].toFixed(5)}, ${coord[1].toFixed(5)}`;
      }
    }
    updatePointCards();
    renderPointMarkers();
  }

  function clearRouteLayerOnly() {
    routeLayer.clearLayers();
    els.routeSummary.classList.add("routeSummary--empty");
    els.routeSummary.textContent = "Поставьте точки A и B на карте, затем нажмите «Построить маршрут».";
  }

  function getById(id) {
    return (
      REBUS_DATA.PIERS.find((x) => x.id === id) ||
      (runtimeBusStopsById.get(id) || null) ||
      null
    );
  }

  function haversineMeters(a, b) {
    const toRad = (x) => (x * Math.PI) / 180;
    const R = 6371000;
    const dLat = toRad(b[0] - a[0]);
    const dLon = toRad(b[1] - a[1]);
    const lat1 = toRad(a[0]);
    const lat2 = toRad(b[0]);
    const s =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  }

  function nearestStopForPier(pier) {
    if (!pier?.stopId) return null;
    const stop = runtimeBusStopsById.get(pier.stopId);
    if (!stop) return null;
    const d = haversineMeters(pier.coord, stop.coord);
    // Лужники pier: the nearest real stop is ~1.1 km away (no stops inside the park).
    if (d > 1200) return null;
    return { stop, d };
  }

  function normalizeRoutes(raw) {
    if (!raw) return [];
    const s = String(raw)
      .replace(/;/g, ",")
      .replace(/\s+/g, " ")
      .trim();
    const parts = s.split(",").map((x) => x.trim()).filter(Boolean);
    // Some stops have "route_ref" like "m2 239" with spaces
    const exploded = [];
    for (const p of parts) {
      if (p.includes(" ")) exploded.push(...p.split(" ").map((x) => x.trim()).filter(Boolean));
      else exploded.push(p);
    }
    // de-dupe preserving order
    const seen = new Set();
    const out = [];
    for (const r of exploded) {
      const key = r.toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
    return out;
  }

  async function overpassStopsAroundWithRoutes(coord, radiusMeters) {
    // Returns bus stops around coord with route refs extracted from route relations.
    const [lat, lon] = coord;
    const q = `
      [out:json][timeout:40];
      (
        node(around:${radiusMeters},${lat},${lon})["highway"="bus_stop"];
        node(around:${radiusMeters},${lat},${lon})["public_transport"="platform"]["bus"="yes"];
      )->.stops;
      (
        rel(bn.stops)["type"="route"]["route"="bus"];
        rel(bn.stops)["type"="route"]["route"="trolleybus"];
      )->.routes;
      (.stops; .routes;);
      out body;
    `;
    const r = await fetchWithTimeout(OVERPASS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: "data=" + encodeURIComponent(q),
    }, 10000);
    if (!r.ok) throw new Error("overpass_failed");
    const json = await r.json();
    const elements = Array.isArray(json.elements) ? json.elements : [];

    const stops = [];
    const routesByStopNodeId = new Map();

    for (const e of elements) {
      if (e.type === "relation") continue;
      if (e.type === "node" && Number.isFinite(e.lat) && Number.isFinite(e.lon)) {
        const tags = e.tags || {};
        const isStop =
          tags.highway === "bus_stop" ||
          (tags.public_transport === "platform" && tags.bus === "yes") ||
          false;
        if (!isStop) continue;
        const name = tags.name || tags["name:ru"] || "Остановка";
        stops.push({ nodeId: e.id, name, coord: [Number(e.lat), Number(e.lon)] });
      }
    }

    // Map route relations to stop members
    for (const e of elements) {
      if (e.type !== "relation") continue;
      const tags = e.tags || {};
      const ref = tags.ref || tags["route_ref"] || tags.name || "";
      const routeRef = String(ref).trim();
      if (!routeRef) continue;
      const members = Array.isArray(e.members) ? e.members : [];
      for (const m of members) {
        if (m.type === "node" && typeof m.ref === "number") {
          const arr = routesByStopNodeId.get(m.ref) || [];
          arr.push(routeRef);
          routesByStopNodeId.set(m.ref, arr);
        }
      }
    }

    const out = stops.map((s) => {
      const routes = normalizeRoutes((routesByStopNodeId.get(s.nodeId) || []).join(","));
      return {
        id: `osm_node_${s.nodeId}`,
        type: "stop",
        name: s.name,
        coord: s.coord,
        routes,
      };
    });

    return out;
  }

  const busRouteCache = new Map();

  async function overpassBusRouteOptions(routeRefs, nearCoords = []) {
    const refs = [...new Set((routeRefs || []).map((ref) => String(ref).trim()).filter(Boolean))];
    if (!refs.length) return [];
    const escapeRegex = (value) => value.replace(/[.+?^|()[\]{}\\]/g, "\\$&");
    const pattern = refs.map(escapeRegex).join("|");
    const coords = nearCoords.filter((coord) => Array.isArray(coord) && Number.isFinite(coord[0]) && Number.isFinite(coord[1]));
    const cacheKey = refs.map((ref) => ref.toUpperCase()).sort().join("|") + "#" +
      coords.map((coord) => coord.map((value) => value.toFixed(2)).join(",")).sort().join("|");
    if (busRouteCache.has(cacheKey)) return busRouteCache.get(cacheKey);
    const bounds = coords.length
      ? {
          s: Math.max(ROUTE_BBOX.s, Math.min(...coords.map((coord) => coord[0])) - 0.025),
          w: Math.max(ROUTE_BBOX.w, Math.min(...coords.map((coord) => coord[1])) - 0.035),
          n: Math.min(ROUTE_BBOX.n, Math.max(...coords.map((coord) => coord[0])) + 0.025),
          e: Math.min(ROUTE_BBOX.e, Math.max(...coords.map((coord) => coord[1])) + 0.035),
        }
      : ROUTE_BBOX;
    const q = `[out:json][timeout:25];relation["type"="route"]["route"="bus"]["ref"~"^(${pattern})$",i](${bounds.s},${bounds.w},${bounds.n},${bounds.e});out body geom;`;
    const response = await fetchWithTimeout(OVERPASS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: "data=" + encodeURIComponent(q),
    }, 10000);
    if (!response.ok) throw new Error("overpass_bus_route_failed");
    const json = await response.json();
    const routes = [];
    for (const relation of json.elements || []) {
      if (relation.type !== "relation") continue;
      const members = relation.members || [];
      const stops = members
        .filter((member) => member.type === "node" && /(stop|platform)/i.test(member.role || ""))
        .map((member) => ({
          id: "osm_node_" + member.ref,
          name: member.tags?.name || member.tags?.["name:ru"] || "Остановка",
          coord: [Number(member.lat), Number(member.lon)],
          memberIndex: members.indexOf(member),
        }))
        .filter((stop) => Number.isFinite(stop.coord[0]) && Number.isFinite(stop.coord[1]));
      let coords = [];
      for (const member of members) {
        if (member.type !== "way" || !Array.isArray(member.geometry)) continue;
        let part = member.geometry.map((point) => [Number(point.lat), Number(point.lon)])
          .filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]));
        if (member.role === "backward") part.reverse();
        if (coords.length && part.length) {
          const previous = coords[coords.length - 1];
          if (haversineMeters(previous, part[part.length - 1]) < haversineMeters(previous, part[0])) part.reverse();
          if (haversineMeters(previous, part[0]) < 12) part.shift();
        }
        coords.push(...part);
      }
      if (coords.length > 1) routes.push({
        ref: relation.tags?.ref || refs[0],
        name: relation.tags?.name || relation.tags?.["name:ru"] || relation.tags?.ref || refs[0],
        stops,
        coords,
      });
    }
    busRouteCache.set(cacheKey, routes);
    return routes;
  }

  function sliceBusRouteGeometry(route, fromStop, toStop) {
    const routeStopId = (stop) => Number(String(stop.id).replace("osm_node_", ""));
    const fromId = routeStopId(fromStop);
    const toId = routeStopId(toStop);
    const fromOrder = route.stops.findIndex((stop) => routeStopId(stop) === fromId);
    const toOrder = route.stops.findIndex((stop) => routeStopId(stop) === toId);
    const order = fromOrder >= 0 && toOrder >= 0 ? Math.sign(toOrder - fromOrder) : 0;
    const nearestIndex = (point) => {
      let bestIndex = 0;
      let bestDistance = Infinity;
      route.coords.forEach((coord, index) => {
        const distance = haversineMeters(point, coord);
        if (distance < bestDistance) { bestIndex = index; bestDistance = distance; }
      });
      return { index: bestIndex, distance: bestDistance };
    };
    const from = nearestIndex(fromStop.coord);
    const to = nearestIndex(toStop.coord);
    if (from.distance > 600 || to.distance > 600) return null;
    const direction = order || Math.sign(to.index - from.index) || 1;
    const first = direction > 0 ? from.index : to.index;
    const last = direction > 0 ? to.index : from.index;
    const coords = route.coords.slice(first, last + 1);
    return direction > 0 ? coords : coords.reverse();
  }


  function coordsEqual(a, b) {
    return a && b && a[0] === b[0] && a[1] === b[1];
  }

  function dedupeCoords(coords) {
    const out = [];
    for (const c of coords) {
      if (!c || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
      if (out.length && coordsEqual(out[out.length - 1], c)) continue;
      out.push(c);
    }
    return out;
  }

  function initMap() {
    map = L.map("map", { zoomControl: true }).setView([55.745, 37.53], 12);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · <a href="https://routing.openstreetmap.de/">FOSSGIS walking routes</a>',
    }).addTo(map);

    markerLayer = L.layerGroup().addTo(map);
    routeLayer = L.layerGroup().addTo(map);
    pointLayer = L.layerGroup().addTo(map);

    map.on("click", (e) => {
      placeMapPoint(e.latlng);
    });
  }

  function iconHtml(color, label) {
    return `<div class="pin" style="--pin:${color}"><div class="pin__dot"></div><div class="pin__label">${label}</div></div>`;
  }

  function makeDivIcon(color, label) {
    return L.divIcon({
      className: "rebus-pin",
      html: iconHtml(color, label),
      iconSize: [34, 34],
      // The colored dot's center is at y=19 after the CSS translate. Anchor it
      // to the actual coordinate instead of placing the pin's bottom there.
      iconAnchor: [17, 19],
      popupAnchor: [0, -28],
    });
  }

  function ensurePinCss() {
    if (document.getElementById("pinCss")) return;
    const style = document.createElement("style");
    style.id = "pinCss";
    style.textContent = `
      .rebus-pin{background:transparent;border:none}
      .pin{position:relative;display:grid;place-items:center;width:34px;height:34px;transform:translateY(2px)}
      .pin__dot{width:18px;height:18px;border-radius:999px;background:var(--pin);border:2.5px solid #fff;box-shadow:0 0 0 2px rgba(0,0,0,.8),0 6px 18px rgba(0,0,0,.5)}
      .pin__label{position:absolute;top:17px;font-size:10.5px;font-weight:900;color:#fff;text-shadow:0 0 3px #000,0 0 3px #000,0 1px 6px rgba(0,0,0,.9)}
    `;
    document.head.appendChild(style);
  }

  /** Pier popup, computed when it opens so the next departure is always current. */
  function pierPopupHtml(pier) {
    const nextR = getRiverBoard(new Date(), pier.id, 1)[0];
    const eta = nextR ? `${fmtHm(nextR.at)}${nextR.nextDay ? " (завтра)" : ""} → ${escapeHtml(stripPierName(nextR.towards))}` : "—";
    const nearest = nearestStopForPier(pier);
    const busRoutes = nearest?.stop.routes?.length ? nearest.stop.routes.join(", ") : "данные о маршрутах не указаны";
    const busHint = nearest
      ? `<div style="opacity:.8;margin-top:6px">Ближайшая остановка: <b>${escapeHtml(nearest.stop.name)}</b> (${Math.round(nearest.d)} м)</div>` +
        `<div style="opacity:.8;margin-top:4px">Автобусы: <b>${escapeHtml(busRoutes)}</b></div>`
      : `<div style="opacity:.7;margin-top:6px">Рядом нет привязанной автобусной остановки</div>`;
    return `
      <b>${escapeHtml(pier.name)}</b>
      <div style="opacity:.8;margin-top:6px">Линии: ${pier.lines.join(", ")}</div>
      <div style="margin-top:6px"><span style="opacity:.75">Ближайшее отправление (по расписанию):</span> <b>${eta}</b></div>
      ${busHint}
    `;
  }

  function stopPopupHtml(stop) {
    const routes = stop.routes && stop.routes.length
      ? stop.routes.map((ref) => `${ref} (${busIntervalEstimate(ref).label})`).join(", ")
      : "—";
    return `
      <b>${escapeHtml(stop.name)}</b>
      <div style="opacity:.8;margin-top:6px">Маршруты и интервалы: ${escapeHtml(routes)}</div>
      <div style="opacity:.6;margin-top:6px">Интервалы автобусов — оценка, не расписание</div>
    `;
  }

  /**
   * Pier and bus stop markers are created once. Their popups are functions, so
   * they show fresh data when opened and are not closed by the periodic refresh.
   */
  function renderMarkers() {
    markerLayer.clearLayers();
    ensurePinCss();

    for (const pier of getOrderedPiers()) {
      const m = L.marker(pier.coord, { icon: makeDivIcon(MAP_THEME.pier, "П") }).bindPopup(() => pierPopupHtml(pier)).addTo(markerLayer);
      m.on("click", () => {
        routeState.selectedPierId = pier.id;
        renderBoards(new Date());
      });
    }

    for (const stop of runtimeBusStopsById.values()) {
      L.marker(stop.coord, { icon: makeDivIcon(MAP_THEME.stop, "О") }).bindPopup(() => stopPopupHtml(stop)).addTo(markerLayer);
    }
  }

  /** Next scheduled departures from a pier: every line, both directions, soonest first. */
  function getRiverBoard(now, pierId, limitPerDirection) {
    const pier = getById(pierId);
    const items = [];
    for (const lineId of pier?.lines || []) {
      const line = REBUS_DATA.RIVER_LINES[lineId];
      if (!line) continue;
      for (const forward of [true, false]) {
        for (const d of riverDeparturesFrom(line, pierId, forward, now, limitPerDirection)) {
          items.push({
            lineId,
            name: line.name,
            towards: d.towards,
            at: d.at,
            inMin: minutesBetween(now, d.at),
            nextDay: !isSameDay(d.at, now),
          });
        }
      }
    }
    return items.sort((a, b) => a.at - b.at);
  }

  function getRiverLegPaths() {
    return window.REBUS_RIVER_PATHS || {};
  }

  function riverSubpath(fromPierId, toPierId, line) {
    const legPaths = getRiverLegPaths();
    const ids = line.pierIds || [];
    const a = ids.indexOf(fromPierId);
    const b = ids.indexOf(toPierId);
    if (a === -1 || b === -1) return { ok: false, coords: [], minutes: 0 };
    if (a === b) return { ok: true, coords: [getById(fromPierId).coord], minutes: 0 };
    const dir = a < b ? 1 : -1;

    let minutes = 0;
    const coords = [];

    for (let i = a; i !== b; i += dir) {
      const fromId = ids[i];
      const toId = ids[i + dir];
      const key = dir === 1 ? `${fromId}__${toId}` : `${toId}__${fromId}`;
      minutes += line.segmentMinutes[key] ?? 0;

      let leg = legPaths[key];
      if (!leg || leg.length < 2) {
        const fc = getById(fromId)?.coord;
        const tc = getById(toId)?.coord;
        if (!fc || !tc) continue;
        leg = [fc, tc];
      } else if (dir === -1) {
        leg = leg.slice().reverse();
      }

      if (coords.length) coords.push(...leg.slice(1));
      else coords.push(...leg);
    }

    return { ok: true, coords: dedupeCoords(coords), minutes };
  }

  // ---------------------------------------------------------------------------
  // River part of the trip: boat rides, water transfers between lines and —
  // between the two groups of lines that do not meet on the water — a land link.
  // ---------------------------------------------------------------------------

  /** Piers of different lines at most this far apart form a water transfer. */
  const PIER_TRANSFER_MAX_METERS = 150;
  /** Average wait for the next boat when changing lines (half a typical interval). */
  const RIVER_TRANSFER_WAIT_MIN = 10;
  /**
   * Walking minutes count double when choosing piers: a longer boat ride (or a
   * transfer) is preferred over a long, tiring walk.
   */
  const WALK_EFFORT_FACTOR = 2;
  /** Land links between line groups: this many closest pier pairs per group pair… */
  const LAND_LINKS_PER_GROUP_PAIR = 3;
  /** …at most this far apart. */
  const LAND_LINK_MAX_METERS = 6000;

  let riverTransfers = null;

  /** Places where passengers can change between two river lines (same pier or nearby berths). */
  function getRiverTransfers() {
    if (riverTransfers) return riverTransfers;
    riverTransfers = [];
    const lines = Object.values(REBUS_DATA.RIVER_LINES);
    for (const fromLine of lines) {
      for (const toLine of lines) {
        if (fromLine === toLine) continue;
        for (const fromId of fromLine.pierIds) {
          for (const toId of toLine.pierIds) {
            const a = getById(fromId);
            const b = getById(toId);
            if (!a || !b) continue;
            const meters = fromId === toId ? 0 : haversineMeters(a.coord, b.coord);
            if (meters <= PIER_TRANSFER_MAX_METERS) riverTransfers.push({ fromLine, fromId, toLine, toId, meters });
          }
        }
      }
    }
    return riverTransfers;
  }

  let riverNetwork = null;

  /**
   * Graph of "pier@line" nodes. Edges: sailing between neighbouring piers,
   * water transfers, and land links between piers of line groups that are
   * not connected on the water (built once).
   */
  function getRiverNetwork() {
    if (riverNetwork) return riverNetwork;
    const nodes = new Map();
    const node = (pierId, line) => {
      const key = `${pierId}@${line.id}`;
      if (!nodes.has(key)) nodes.set(key, { key, pierId, line, edges: [] });
      return nodes.get(key);
    };
    const lines = Object.values(REBUS_DATA.RIVER_LINES);

    for (const line of lines) {
      line.pierIds.forEach((id, i) => {
        const here = node(id, line);
        if (i === 0) return;
        const prev = node(line.pierIds[i - 1], line);
        const minutes = line.segmentMinutes[`${line.pierIds[i - 1]}__${id}`] ?? 0;
        prev.edges.push({ to: here.key, kind: "sail", cost: minutes });
        here.edges.push({ to: prev.key, kind: "sail", cost: minutes });
      });
    }

    for (const t of getRiverTransfers()) {
      node(t.fromId, t.fromLine).edges.push({
        to: `${t.toId}@${t.toLine.id}`,
        kind: "water",
        meters: t.meters,
        cost: t.meters / WALK_M_PER_MIN + RIVER_TRANSFER_WAIT_MIN,
      });
    }

    // Line groups = lines connected by water transfers.
    const parent = new Map(lines.map((l) => [l.id, l.id]));
    const root = (id) => (parent.get(id) === id ? id : root(parent.get(id)));
    for (const t of getRiverTransfers()) parent.set(root(t.fromLine.id), root(t.toLine.id));
    const groups = [...lines.reduce((acc, l) => acc.set(root(l.id), [...(acc.get(root(l.id)) || []), l]), new Map()).values()];
    const piersOf = (group) => [...new Set(group.flatMap((l) => l.pierIds))];
    const linesAt = (pierId) => lines.filter((l) => l.pierIds.includes(pierId));

    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const pairs = [];
        for (const a of piersOf(groups[i])) {
          for (const b of piersOf(groups[j])) {
            const meters = haversineMeters(getById(a).coord, getById(b).coord);
            if (meters <= LAND_LINK_MAX_METERS) pairs.push({ a, b, meters });
          }
        }
        pairs.sort((x, y) => x.meters - y.meters);
        for (const { a, b, meters } of pairs.slice(0, LAND_LINKS_PER_GROUP_PAIR)) {
          // Estimated bus trip: walk to the stop, wait, ride, walk to the pier.
          const cost = 6 + BUS_WAIT_MIN + busRideMin(meters * 1.4);
          for (const la of linesAt(a)) {
            for (const lb of linesAt(b)) {
              node(a, la).edges.push({ to: `${b}@${lb.id}`, kind: "land", meters, cost });
              node(b, lb).edges.push({ to: `${a}@${la.id}`, kind: "land", meters, cost });
            }
          }
        }
      }
    }
    riverNetwork = nodes;
    return nodes;
  }

  /**
   * Cheapest path A → (walk) → boats/transfers → (walk) → B through the network.
   * States track the last move so that a trip starts and ends with a boat ride
   * and transfers only happen between rides.
   * accessCost / egressCost: pierId → minutes, or null if out of reach.
   * blocked: land links ("fromPier>toPier") that turned out to be impossible.
   */
  function searchRiverPath(accessCost, egressCost, blocked) {
    const network = getRiverNetwork();
    const START = 0; // reached on foot, nothing sailed yet
    const SAILED = 1; // last move was a boat ride
    const CHANGING = 2; // last move was a transfer
    const dist = new Map();
    const prev = new Map();
    const done = new Set();
    for (const n of network.values()) {
      const c = accessCost(n.pierId);
      if (c == null) continue;
      const s = `${n.key}#${START}`;
      if (c < (dist.get(s) ?? Infinity)) dist.set(s, c);
    }

    let best = null;
    for (;;) {
      let cur = null;
      for (const [k, d] of dist) if (!done.has(k) && (cur === null || d < dist.get(cur))) cur = k;
      if (cur === null) break;
      const d = dist.get(cur);
      if (best && d >= best.cost) break;
      done.add(cur);
      const [nodeKey, phaseText] = cur.split("#");
      const phase = Number(phaseText);
      const here = network.get(nodeKey);
      if (phase === SAILED) {
        const out = egressCost(here.pierId);
        if (out != null && (!best || d + out < best.cost)) best = { cost: d + out, end: cur };
      }
      for (const e of here.edges) {
        if (e.kind !== "sail" && phase !== SAILED) continue;
        if (e.kind === "land" && blocked.has(`${here.pierId}>${network.get(e.to).pierId}`)) continue;
        const next = `${e.to}#${e.kind === "sail" ? SAILED : CHANGING}`;
        const nd = d + e.cost;
        if (nd < (dist.get(next) ?? Infinity)) {
          dist.set(next, nd);
          prev.set(next, { from: cur, edge: e });
        }
      }
    }
    if (!best) return null;

    const path = [];
    let k = best.end;
    while (prev.has(k)) {
      const p = prev.get(k);
      path.unshift({ from: network.get(p.from.split("#")[0]), to: network.get(k.split("#")[0]), edge: p.edge });
      k = p.from;
    }
    return { cost: best.cost, startPierId: network.get(k.split("#")[0]).pierId, endPierId: network.get(best.end.split("#")[0]).pierId, path };
  }

  /** Walking cost from the street router; straight-line estimates miss rivers and railways. */
  async function realWalkCost(fromCoord, toCoord) {
    try {
      const route = await fetchOsrmRoute(fromCoord, toCoord, "foot");
      if (route.viaFerry) return estimateWalkMin(fromCoord, toCoord) * 1.5 * WALK_EFFORT_FACTOR;
      return (route.durationSec / 60) * WALK_EFFORT_FACTOR;
    } catch {
      return estimateWalkMin(fromCoord, toCoord) * WALK_EFFORT_FACTOR;
    }
  }

  /**
   * Chooses piers, boat rides and transfers with the lowest cost. Walks to and
   * from the river are first estimated in a straight line, then the chosen
   * start/end piers are re-checked with real street routes and the search is
   * repeated until both are real.
   */
  async function planRiverTrip(pointA, pointB, blocked = new Set()) {
    const reachable = (point, pier) =>
      inRouteBbox(point.coord) || haversineMeters(point.coord, pier.coord) <= PIER_REACH_MAX_METERS;
    const realAccess = new Map();
    const realEgress = new Map();
    const access = (pierId) => {
      const pier = getById(pierId);
      if (!reachable(pointA, pier)) return null;
      return realAccess.get(pierId) ?? estimateWalkMin(pointA.coord, pier.coord) * WALK_EFFORT_FACTOR;
    };
    const egress = (pierId) => {
      const pier = getById(pierId);
      if (!reachable(pointB, pier)) return null;
      return realEgress.get(pierId) ?? estimateWalkMin(pier.coord, pointB.coord) * WALK_EFFORT_FACTOR;
    };

    let result = null;
    for (let round = 0; round < 4; round++) {
      result = searchRiverPath(access, egress, blocked);
      if (!result || round === 3) break;
      let refined = false;
      if (!realAccess.has(result.startPierId)) {
        realAccess.set(result.startPierId, await realWalkCost(pointA.coord, getById(result.startPierId).coord));
        refined = true;
      }
      if (!realEgress.has(result.endPierId)) {
        realEgress.set(result.endPierId, await realWalkCost(getById(result.endPierId).coord, pointB.coord));
        refined = true;
      }
      if (!refined) break;
    }
    if (!result) return null;

    // Path → boat rides (merged along one line) and the links between them.
    const rides = [];
    const links = [];
    let ride = null;
    for (const { from, to, edge } of result.path) {
      if (edge.kind === "sail") {
        if (ride && ride.line === from.line && ride.toId === from.pierId) ride.toId = to.pierId;
        else rides.push((ride = { line: from.line, fromId: from.pierId, toId: to.pierId }));
      } else {
        links.push({ kind: edge.kind, fromId: from.pierId, toId: to.pierId, meters: edge.meters });
        ride = null;
      }
    }
    return { rides, links, cost: result.cost };
  }

  async function buildTransitRoute(now, pointA, pointB) {
    if (!pointA?.coord || !pointB?.coord) {
      return { ok: false, reason: "Поставьте обе точки A и B на карте." };
    }
    // A land link can fail (no bus found); then the next best trip without it is tried.
    const blocked = new Set();
    for (let attempt = 0; attempt < 3; attempt++) {
      const trip = await planRiverTrip(pointA, pointB, blocked);
      if (!trip) {
        return {
          ok: false,
          reason: attempt
            ? "Не удалось найти наземную связь между речными линиями для этой поездки."
            : "Не удалось подобрать причалы: точки «Откуда» или «Куда» слишком далеко от речных маршрутов.",
        };
      }
      const res = await buildTripRoute(trip, pointA, pointB);
      if (res.ok || !res.blockLink) return res;
      blocked.add(res.blockLink);
    }
    return { ok: false, reason: "Не удалось найти наземную связь между речными линиями для этой поездки." };
  }

  async function buildTripRoute(trip, pointA, pointB) {
    const rides = [];
    for (const r of trip.rides) {
      const sub = riverSubpath(r.fromId, r.toId, r.line);
      if (!sub.ok || sub.coords.length < 2) {
        return { ok: false, reason: "Не удалось построить речной участок между причалами." };
      }
      rides.push({ lineId: r.line.id, fromId: r.fromId, toId: r.toId, minutes: sub.minutes, coords: sub.coords });
    }

    const links = [];
    for (const l of trip.links) {
      const from = getById(l.fromId);
      const to = getById(l.toId);
      if (l.kind === "water") {
        // Changing between two berths (Киевский) is a short walk; at a shared pier (ЗИЛ) there is none.
        if (l.fromId === l.toId) {
          links.push({ kind: "water", fromId: l.fromId, toId: l.toId, walkMin: 0, coords: [] });
          continue;
        }
        const path = (await footPath(from.coord, to.coord)) || { coords: [from.coord, to.coord], minutes: 1 };
        links.push({ kind: "water", fromId: l.fromId, toId: l.toId, walkMin: Math.max(1, path.minutes), coords: path.coords });
      } else {
        // Land link between the line groups: walk or bus, like the legs to and from the river.
        // Walking is allowed for the whole link as a last resort, so the trip still
        // works when no bus can be found (e.g. the bus data service is overloaded).
        const leg = await resolveEndpointLeg({ coord: from.coord, address: from.name }, to, "departure", LAND_LINK_MAX_METERS + 500);
        if (!leg.ok) return { ok: false, blockLink: `${l.fromId}>${l.toId}`, reason: leg.reason };
        links.push({ kind: "land", fromId: l.fromId, toId: l.toId, leg });
      }
    }

    const pierFrom = getById(rides[0].fromId);
    const pierTo = getById(rides[rides.length - 1].toId);
    const [legA, legB] = await Promise.all([
      resolveEndpointLeg(pointA, pierFrom, "departure"),
      resolveEndpointLeg(pointB, pierTo, "arrival"),
    ]);
    if (!legA.ok) return legA;
    if (!legB.ok) return legB;

    // legA / legB / land links hold both options (walk and bus); applyLegSelection
    // fills the flat fields (segments, minutes, steps…) from the selected ones.
    return applyLegSelection({ ok: true, pierFromId: pierFrom.id, pierToId: pierTo.id, rides, links, legA, legB });
  }

  function linkMinutes(link) {
    return link.kind === "land" ? selectedLegOption(link.leg).minutes : link.walkMin;
  }

  /**
   * Scheduled boats along the river part, starting from the arrival at the first
   * pier. A ride with no boat left today is flagged (shown as a note, its
   * overnight wait is not counted).
   */
  function riverTimeline(res, arrivalAtPier) {
    const departures = [];
    let t = arrivalAtPier;
    let waitMin = 0;
    let noBoatsToday = false;
    res.rides.forEach((ride, i) => {
      if (i > 0) t = new Date(t.getTime() + linkMinutes(res.links[i - 1]) * 60_000);
      const dep = nextRiverDeparture(REBUS_DATA.RIVER_LINES[ride.lineId], ride.fromId, ride.toId, t);
      if (!dep || !isSameDay(dep.at, arrivalAtPier)) {
        noBoatsToday = true;
        departures.push({ at: dep?.at || null, towards: dep?.towards || "", waitMin: 0, tomorrow: true });
        if (dep) t = new Date(dep.at.getTime() + ride.minutes * 60_000);
        return;
      }
      const wait = Math.max(0, minutesBetween(t, dep.at));
      waitMin += wait;
      departures.push({ at: dep.at, towards: dep.towards, waitMin: wait, tomorrow: false });
      t = new Date(dep.at.getTime() + ride.minutes * 60_000);
    });
    return { departures, waitMin: noBoatsToday ? 0 : waitMin, noBoatsToday };
  }

  function walkingOnlyRoute(pointA, pointB, route) {
    const minutes = Math.max(1, Math.ceil(route.durationSec / 60));
    return {
      ok: true,
      walkingOnly: true,
      walkCoords: route.coords,
      totalMin: minutes,
      steps: [{
        mode: "walk",
        title: "Пешком",
        from: pointA.address || "Откуда",
        to: pointB.address || "Куда",
        rideMin: minutes,
      }],
    };
  }

  async function buildMultimodalRoute(now, pointA, pointB) {
    const walkPromise = fetchOsrmRoute(pointA.coord, pointB.coord, "foot").catch(() => null);
    const transitPromise = buildTransitRoute(now, pointA, pointB).catch(() => ({
      ok: false,
      reason: "Не удалось построить маршрут общественным транспортом.",
    }));
    const [walk, transit] = await Promise.all([walkPromise, transitPromise]);

    // Only recommend walking when the pedestrian router returned a real street
    // path. If routing fails, transit remains the only candidate we can verify.
    if (walk && !walk.approximate && !walk.viaFerry) {
      const walking = walkingOnlyRoute(pointA, pointB, walk);
      // No river route: walking is the only option left, say why.
      if (!transit.ok) return { ...walking, note: transit.reason };
      // Bus waits are already part of bus1Min / bus2Min.
      const arrivalAtPier = new Date(now.getTime() + transit.bus1Min * 60_000);
      const riverWait = riverTimeline(transit, arrivalAtPier).waitMin;
      const transitMinutes = transit.bus1Min + riverWait + transit.rideMin + transit.bus2Min;
      // Prefer a clear walking-time win; small estimated differences are within
      // the uncertainty of bus waits, pier access and boarding time.
      // Long walks are tiring: walking-only is offered just for short trips,
      // otherwise the river route is preferred even if it takes a bit longer.
      if (walking.totalMin <= WALK_ONLY_MAX_MIN && walking.totalMin + 4 <= transitMinutes) return walking;
    }
    return transit;
  }

  function renderBoards(now) {
    const riverPierId =
      routeState.pierFromId || routeState.selectedPierId || "pier_kievsky";
    const riverItems = getRiverBoard(now, riverPierId, 2).slice(0, 4);
    if (riverItems.length === 0) {
      els.riverBoard.classList.add("board--empty");
      els.riverBoard.textContent = "—";
    } else {
      els.riverBoard.classList.remove("board--empty");
      const pierLabel = stripPierName(getById(riverPierId)?.name || "Причал");
      els.riverBoard.innerHTML = riverItems
        .map((x) => `
            <div class="row">
              <div class="row__left">
                <div class="row__title">${x.name.split(":")[0]} → ${escapeHtml(stripPierName(x.towards))}</div>
                <div class="row__sub">${escapeHtml(pierLabel)} · ${fmtHm(x.at)}${x.nextDay ? " (завтра)" : ""}</div>
              </div>
              <div class="row__right">${x.nextDay ? "завтра" : fmtMinutes(x.inMin)}<span class="pill pill--ok">расписание</span></div>
            </div>
          `)
        .join("");
    }

    // Buses: no timetable yet — the routes used (or near the selected pier) with an estimated interval.
    const route = routeState.cachedRoute;
    let busRows = [];
    if (route && !route.walkingOnly) {
      busRows = (route.busRides || []).map((ride) => ({ ref: ride.ref, where: ride.fromName }));
    } else if (!route) {
      const pier = getById(routeState.selectedPierId);
      const stop = pier && REBUS_DATA.PIER_BUS_STOPS?.[pier.id];
      if (stop) busRows = (stop.routes || []).map((ref) => ({ ref, where: stop.name }));
    }

    if (!busRows.length) {
      els.busBoard.classList.add("board--empty");
      els.busBoard.textContent = route?.walkingOnly
        ? "Для пешего маршрута автобус не нужен"
        : route ? "В маршруте нет автобусов" : "Кликните причал";
    } else {
      els.busBoard.classList.remove("board--empty");
      els.busBoard.innerHTML = busRows
        .slice(0, 5)
        .map((x) => `
            <div class="row">
              <div class="row__left">
                <div class="row__title">Автобус ${escapeHtml(x.ref)}</div>
                <div class="row__sub">${escapeHtml(x.where)} · интервал ${busIntervalEstimate(x.ref).label}</div>
              </div>
              <div class="row__right"><span class="pill pill--warn">оценка</span></div>
            </div>
          `)
        .join("");
    }
  }

  function clearRoute() {
    clearRouteLayerOnly();
    routeState.builtAt = null;
    routeState.cachedRoute = null;
    routeState.pierFromId = null;
  }

  function collectRouteCoords(res) {
    if (res.walkingOnly) return (res.walkCoords || []).filter((c) => c && Number.isFinite(c[0]) && Number.isFinite(c[1]));
    const out = [];
    for (const seg of res.bus1Segments || []) out.push(...seg.coords);
    out.push(...(res.riverCoords || []));
    for (const seg of res.bus2Segments || []) out.push(...seg.coords);
    return out.filter((c) => c && Number.isFinite(c[0]) && Number.isFinite(c[1]));
  }

  function renderRouteGeometry(res) {
    routeLayer.clearLayers();

    if (res.walkingOnly) {
      polyline(res.walkCoords, MAP_THEME.walk, true).addTo(routeLayer);
      const walkCoords = collectRouteCoords(res);
      if (walkCoords.length >= 2) {
        map.fitBounds(L.latLngBounds(walkCoords.map((c) => L.latLng(c[0], c[1]))).pad(0.15));
      }
      return;
    }

    for (const seg of res.bus1Segments || []) {
      polyline(seg.coords, seg.dashed ? MAP_THEME.walk : MAP_THEME.bus, seg.dashed).addTo(routeLayer);
    }
    for (const ride of res.rides) routePolylines(ride.coords, MAP_THEME.river).addTo(routeLayer);
    for (const link of res.links) {
      const segments = link.kind === "land"
        ? selectedLegOption(link.leg).segments
        : [{ coords: link.coords, dashed: true }];
      for (const seg of segments) {
        if (seg.coords.length >= 2) polyline(seg.coords, seg.dashed ? MAP_THEME.walk : MAP_THEME.bus, seg.dashed).addTo(routeLayer);
      }
    }
    for (const seg of res.bus2Segments || []) {
      polyline(seg.coords, seg.dashed ? MAP_THEME.walk : MAP_THEME.bus, seg.dashed).addTo(routeLayer);
    }

    const allCoords = collectRouteCoords(res);
    if (allCoords.length >= 2) {
      const bounds = L.latLngBounds(allCoords.map((c) => L.latLng(c[0], c[1])));
      map.fitBounds(bounds.pad(0.15));
    }
  }

  function updateRouteSummary(now) {
    const res = routeState.cachedRoute;
    if (!res) return;

    if (res.walkingOnly) {
      els.routeSummary.classList.remove("routeSummary--empty");
      els.routeSummary.innerHTML = `
        <div class="routeSummary__kpi">
          <div class="kpi">
            <div class="kpi__label">В пути (пешком)</div>
            <div class="kpi__value">${res.totalMin} мин</div>
          </div>
        </div>
        <div class="steps">
          <div class="step step--walk">
            <div class="step__title">${escapeHtml(res.steps[0].title)}</div>
            <div class="step__meta">${escapeHtml(res.steps[0].from)} → ${escapeHtml(res.steps[0].to)} · <b>${res.totalMin} мин</b></div>
          </div>
        </div>
        ${res.note ? `<p class="hint">Речной маршрут не найден: ${escapeHtml(res.note)}</p>` : ""}
      `;
      return;
    }

    // The boat is caught after the trip to the pier, not right now.
    const arrivalAtPier = new Date(now.getTime() + res.bus1Min * 60_000);
    const timeline = riverTimeline(res, arrivalAtPier);
    const totalMin = res.bus1Min + timeline.waitMin + res.rideMin + res.bus2Min;
    // Boats run 07:00–23:00: an overnight wait is shown as a note, not added to the trip time.
    const departureHtml = (dep) => dep.tomorrow
      ? `<div class="step step--depart">
          <div class="step__title">Речной транспорт сейчас не ходит</div>
          <div class="step__meta">Суда работают 07:00–23:00${dep.at ? ` · ближайшее отправление завтра в <b>${fmtHm(dep.at)}</b>` : ""}</div>
        </div>`
      : `<div class="step step--depart">
          <div class="step__title">Отправление с причала → ${escapeHtml(stripPierName(dep.towards))}</div>
          <div class="step__meta"><b>${fmtHm(dep.at)}</b> по расписанию · ожидание: <b>${fmtMinutes(dep.waitMin)}</b></div>
        </div>`;

    const stepHtml = (s) => `
      <div class="step step--${s.mode}">
        <div class="step__title">${escapeHtml(s.title)}</div>
        <div class="step__meta">${s.mode === "wait" ? `${escapeHtml(s.from)} · <b>~${s.rideMin} мин</b>` : `${escapeHtml(s.from)} → ${escapeHtml(s.to)} · <b>${s.rideMin} мин</b>`}</div>
      </div>
    `;
    const a = selectedLegOption(res.legA);
    const b = selectedLegOption(res.legB);

    els.routeSummary.classList.remove("routeSummary--empty");
    els.routeSummary.innerHTML = `
      <div class="routeSummary__kpi">
        <div class="kpi">
          <div class="kpi__label">В пути (оценка)</div>
          <div class="kpi__value">${totalMin} мин</div>
        </div>
        <div class="kpi">
          <div class="kpi__label">До реки / река / после</div>
          <div class="kpi__value">${res.bus1Min} / ${res.rideMin} / ${res.bus2Min} мин</div>
        </div>
      </div>
      ${legSwitchHtml("a", "До причала", res.legA)}
      ${res.links.map((link, i) => (link.kind === "land" ? legSwitchHtml(`link${i}`, "Между причалами разных линий", link.leg) : "")).join("")}
      ${legSwitchHtml("b", "От причала", res.legB)}
      <div class="steps">
        ${a.steps.map(stepHtml).join("")}
        ${res.riverSteps
          .map((s) => (s.mode === "river" ? departureHtml(timeline.departures[s.rideIndex]) : "") + stepHtml(s))
          .join("")}
        ${b.steps.map(stepHtml).join("")}
      </div>
    `;
  }

  /** Walk / bus switch for one leg; a plain note when only one option exists. */
  function legSwitchHtml(key, label, leg) {
    const { walk, bus } = leg.options;
    if (!walk || !bus) {
      const only = walk || bus;
      const note = walk ? "автобус не нужен или не найден" : "пешком слишком далеко";
      return `
        <div class="legSwitch">
          <div class="legSwitch__label">${label}</div>
          <div class="legSwitch__note">${only.mode === "bus" ? "Автобус" : "Пешком"} · ${only.minutes} мин <span>(${note})</span></div>
        </div>
      `;
    }
    const button = (mode, text, option) => `
      <button type="button" class="legSwitch__btn${leg.selected === mode ? " legSwitch__btn--active" : ""}" data-leg="${key}" data-mode="${mode}">
        ${text} · ${option.minutes} мин${mode === "bus" ? `<small>${escapeHtml(option.routeRef)}</small>` : ""}
      </button>
    `;
    return `
      <div class="legSwitch">
        <div class="legSwitch__label">${label}</div>
        <div class="legSwitch__btns">${button("walk", "Пешком", walk)}${button("bus", "Автобус", bus)}</div>
      </div>
    `;
  }

  function showRouteMessage(text) {
    routeState.cachedRoute = null;
    routeState.builtAt = null;
    routeState.pierFromId = null;
    routeLayer.clearLayers();
    els.routeSummary.classList.add("routeSummary--empty");
    els.routeSummary.textContent = text;
  }

  async function buildRoute(now) {
    const { a, b } = routeState.mapPoints;
    if (!a?.coord || !b?.coord) {
      routeBuildGen += 1;
      showRouteMessage("Поставьте обе точки A и B на карте, затем нажмите «Построить маршрут».");
      return;
    }
    const gen = ++routeBuildGen;
    els.buildBtn.disabled = true;
    els.routeSummary.classList.remove("routeSummary--empty");
    els.routeSummary.textContent = "Строим маршрут…";

    try {
      const res = await buildMultimodalRoute(now, a, b);
      if (gen !== routeBuildGen) return;

      if (!res.ok) {
        showRouteMessage(res.reason);
        return;
      }

      routeState.cachedRoute = res;
      routeState.builtAt = now;
      routeState.pierFromId = res.walkingOnly ? null : res.pierFromId;

      renderRouteGeometry(res);
      updateRouteSummary(now);
      renderBoards(now);
    } catch (error) {
      // Never leave «Строим маршрут…» hanging on an unexpected failure.
      console.error(error);
      if (gen === routeBuildGen) showRouteMessage("Не удалось построить маршрут: картографические сервисы не ответили. Попробуйте ещё раз.");
    } finally {
      if (gen === routeBuildGen) els.buildBtn.disabled = false;
    }
  }

  function routePolylines(coords, color) {
    const group = L.layerGroup();
    L.polyline(coords, {
      color: MAP_THEME.routeOutline,
      weight: 9,
      opacity: 0.92,
      lineCap: "round",
      lineJoin: "round",
    }).addTo(group);
    L.polyline(coords, {
      color,
      weight: 6,
      opacity: 1,
      lineCap: "round",
      lineJoin: "round",
    }).addTo(group);
    return group;
  }

  /** Bus / walking line with a white casing so it stands out from the map's roads. */
  function polyline(coords, color, dashed) {
    const group = L.layerGroup();
    L.polyline(coords, {
      color: MAP_THEME.routeOutline,
      weight: 9,
      opacity: 0.9,
      lineCap: "round",
      lineJoin: "round",
    }).addTo(group);
    L.polyline(coords, {
      color,
      weight: 6,
      opacity: 1,
      dashArray: dashed ? "10 10" : undefined,
      lineCap: "round",
      lineJoin: "round",
    }).addTo(group);
    return group;
  }

  function tick() {
    const now = new Date();
    els.statusClock.textContent = `${fmtClock(now)} · автообновление`;
    renderBoards(now);

    if (routeState.builtAt && routeState.cachedRoute) {
      updateRouteSummary(now);
    }
  }

  function wireEvents() {
    els.buildBtn.addEventListener("click", () => {
      buildRoute(new Date());
    });

    // Walk / bus switch for the legs to and from the pier.
    els.routeSummary.addEventListener("click", (event) => {
      const button = event.target.closest("[data-leg][data-mode]");
      const res = routeState.cachedRoute;
      if (!button || !res || res.walkingOnly) return;
      const key = button.dataset.leg;
      const leg = key === "a" ? res.legA : key === "b" ? res.legB : res.links[Number(key.slice(4))]?.leg;
      const mode = button.dataset.mode;
      if (!leg?.options[mode] || leg.selected === mode) return;
      leg.selected = mode;
      applyLegSelection(res);
      const now = new Date();
      renderRouteGeometry(res);
      updateRouteSummary(now);
      renderBoards(now);
    });

    els.resetBtn.addEventListener("click", () => {
      routeBuildGen += 1;
      routeState = initialRouteState();
      els.buildBtn.disabled = false;
      clearRoute();
      updatePointCards();
      renderPointMarkers();
      tick();
    });
  }

  function bootstrap() {
    initMap();
    wireEvents();
    updatePointCards();
    clearRoute();
    initStaticBusStops();
    renderMarkers();
    tick();
    setInterval(tick, REFRESH_MS);
  }

  bootstrap();
})();

