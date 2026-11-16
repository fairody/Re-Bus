// Static demo dataset for Re:Bus (Moscow). No build tools required.
(function () {
  // Lines follow the official Moscow regular river routes (OSM ferry relations «N-й речной»):
  //   R1 = 1-й речной: Киевский → Парк «Фили»
  //   R2 = 2-й речной: ЗИЛ → Печатники
  //   R3 = 3-й речной: Новоспасский → ЗИЛ
  //   R4 = 4-й речной: Лужники → Киевский
  // Piers of route 1, in route order:
  const PIERS = [
    {
      // Route 1 berth at Киевский (osm node 13565015474). Route 4 has its own berth next to it.
      id: "pier_kievsky",
      type: "pier",
      name: "Причал «Киевский» (маршрут 1)",
      coord: [55.7443206, 37.5728811],
      lines: ["R1"],
    },
    {
      id: "pier_trekhgorny",
      type: "pier",
      name: "Причал «Трёхгорный»",
      coord: [55.753231, 37.564416],
      lines: ["R1"],
    },
    {
      id: "pier_krasnopresnensky_park",
      type: "pier",
      name: "Причал «Краснопресненский парк»",
      coord: [55.749998, 37.551289],
      lines: ["R1"],
    },
    {
      id: "pier_city_bagration",
      type: "pier",
      name: "Причал «Сити-Багратион»",
      coord: [55.74657, 37.544803],
      lines: ["R1"],
    },
    {
      id: "pier_city_central",
      type: "pier",
      name: "Причал «Сити-Центральный»",
      coord: [55.746248, 37.542737],
      lines: ["R1"],
    },
    {
      id: "pier_kutuzovsky",
      type: "pier",
      name: "Причал «Кутузовский»",
      coord: [55.744607, 37.538122],
      lines: ["R1"],
    },
    {
      id: "pier_beregovoy",
      type: "pier",
      name: "Причал «Береговой»",
      coord: [55.758441, 37.512673],
      lines: ["R1"],
    },
    {
      id: "pier_heart_capital",
      type: "pier",
      name: "Причал «Сердце столицы»",
      coord: [55.760553, 37.511371],
      lines: ["R1"],
    },
    {
      id: "pier_park_fili",
      type: "pier",
      name: "Причал «Парк Фили»",
      coord: [55.749464, 37.475639],
      lines: ["R1"],
    },
    // Route 2: ЗИЛ → Печатники
    { id: "pier_zil", type: "pier", name: "Причал «ЗИЛ»", coord: [55.699419, 37.629040], lines: ["R2", "R3"] },
    { id: "pier_nagatinsky", type: "pier", name: "Причал «Нагатинский»", coord: [55.69053, 37.62786], lines: ["R2"] },
    { id: "pier_zaton_novinki", type: "pier", name: "Причал «Затон Новинки»", coord: [55.6921155, 37.6558169], lines: ["R2"] },
    { id: "pier_klenovy_bulvar", type: "pier", name: "Причал «Кленовый бульвар»", coord: [55.68623, 37.67153], lines: ["R2"] },
    { id: "pier_south_river_terminal", type: "pier", name: "Причал «Южный речной вокзал»", coord: [55.6894185, 37.676835], lines: ["R2"] },
    { id: "pier_moscow_shipyard", type: "pier", name: "Причал «Московская верфь»", coord: [55.6912734, 37.696284], lines: ["R2"] },
    { id: "pier_nagatinsky_backwater", type: "pier", name: "Причал «Нагатинский Затон»", coord: [55.6858606, 37.7012853], lines: ["R2"] },
    { id: "pier_kolomenskaya_embankment", type: "pier", name: "Причал «Коломенская набережная»", coord: [55.6844611, 37.7103591], lines: ["R2"] },
    { id: "pier_pechatniki", type: "pier", name: "Причал «Печатники»", coord: [55.6836296, 37.7142591], lines: ["R2"] },
    // Route 3: Новоспасский → ЗИЛ
    { id: "pier_novospassky", type: "pier", name: "Причал «Новоспасский»", coord: [55.73036, 37.65352], lines: ["R3"] },
    { id: "pier_derbenevskaya", type: "pier", name: "Причал «Дербеневская набережная»", coord: [55.7249879, 37.6564027], lines: ["R3"] },
    { id: "pier_torpedo", type: "pier", name: "Причал «Торпедо»", coord: [55.71881, 37.65349], lines: ["R3"] },
    { id: "pier_simonovsky", type: "pier", name: "Причал «Симоновский»", coord: [55.706356, 37.6424626], lines: ["R3"] },
    { id: "pier_avtozavodsky_bridge", type: "pier", name: "Причал «Автозаводский мост»", coord: [55.70281, 37.62657], lines: ["R3"] },
    // Route 4: Лужники → Воробьёвская набережная → Новодевичьи пруды → Киевский.
    // The two middle piers are new (opening announced for end of 2026) and not yet in OSM:
    // their coordinates are approximate, placed from the official descriptions.
    { id: "pier_luzhniki", type: "pier", name: "Причал «Лужники»", coord: [55.7132165, 37.549022], lines: ["R4"] },
    { id: "pier_vorobyovskaya", type: "pier", name: "Причал «Воробьёвская набережная»", coord: [55.7122, 37.5472], lines: ["R4"] },
    { id: "pier_novodevichy", type: "pier", name: "Причал «Новодевичьи пруды»", coord: [55.7281, 37.5503], lines: ["R4"] },
    // Separate route 4 berth at Киевский (osm node 13565015473).
    { id: "pier_kievsky_r4", type: "pier", name: "Причал «Киевский» (маршрут 4)", coord: [55.74417, 37.5727476], lines: ["R4"] },
  ];

  // Published river schedule (mos.ru, 2026): boats run daily 07:00–23:00,
  // interval 15–30 min, 15–18 min in the peak hours. No per-line timetable is
  // published, so all lines share this one; a line can override it with its own
  // `schedule` field. Departures are from each terminal; times at intermediate
  // piers add the line's segmentMinutes.
  const RIVER_SCHEDULE = {
    source: "mos.ru: ежедневно 07:00–23:00, интервал 15–30 мин, в час пик 15–18 мин",
    firstDeparture: "07:00",
    lastDeparture: "22:30", // last trip still arrives before 23:00 on the short lines
    intervals: [
      { from: "07:00", to: "10:00", min: 15 }, // morning peak
      { from: "10:00", to: "17:00", min: 20 },
      { from: "17:00", to: "20:00", min: 15 }, // evening peak
      { from: "20:00", to: "23:00", min: 30 },
    ],
  };

  const RIVER_LINES = {
    R1: {
      id: "R1",
      name: "1-й речной: Киевский → Парк «Фили»",
      color: "#e11d48",
      pierIds: [
        "pier_kievsky",
        "pier_trekhgorny",
        "pier_krasnopresnensky_park",
        "pier_city_bagration",
        "pier_city_central",
        "pier_kutuzovsky",
        "pier_beregovoy",
        "pier_heart_capital",
        "pier_park_fili",
      ],
      // Total 57 min = official trip time (OSM route relation «1-й речной», duration=57).
      segmentMinutes: {
        pier_kievsky__pier_trekhgorny: 7,
        pier_trekhgorny__pier_krasnopresnensky_park: 6,
        pier_krasnopresnensky_park__pier_city_bagration: 5,
        pier_city_bagration__pier_city_central: 6,
        pier_city_central__pier_kutuzovsky: 10,
        pier_kutuzovsky__pier_beregovoy: 9,
        pier_beregovoy__pier_heart_capital: 6,
        pier_heart_capital__pier_park_fili: 8,
      },
    },
    R2: { id: "R2", name: "2-й речной: ЗИЛ → Печатники", color: "#e11d48", pierIds: ["pier_zil", "pier_nagatinsky", "pier_zaton_novinki", "pier_klenovy_bulvar", "pier_south_river_terminal", "pier_moscow_shipyard", "pier_nagatinsky_backwater", "pier_kolomenskaya_embankment", "pier_pechatniki"], segmentMinutes: { "pier_zil__pier_nagatinsky": 8, "pier_nagatinsky__pier_zaton_novinki": 9, "pier_zaton_novinki__pier_klenovy_bulvar": 9, "pier_klenovy_bulvar__pier_south_river_terminal": 6, "pier_south_river_terminal__pier_moscow_shipyard": 8, "pier_moscow_shipyard__pier_nagatinsky_backwater": 9, "pier_nagatinsky_backwater__pier_kolomenskaya_embankment": 5, "pier_kolomenskaya_embankment__pier_pechatniki": 7 } },
    // R2 times: mos.ru gives Южный речной вокзал → Нагатинский Затон ≈ 17 min and Нагатинский Затон → Печатники ≈ 12 min;
    // the other sections are scaled to the same speed (total ≈ 61 min).
    // R3 has no published trip time: estimated at the speed of the other lines (≈ 5 km, total ≈ 33 min).
    R3: { id: "R3", name: "3-й речной: Новоспасский → ЗИЛ", color: "#e11d48", pierIds: ["pier_novospassky", "pier_derbenevskaya", "pier_torpedo", "pier_simonovsky", "pier_avtozavodsky_bridge", "pier_zil"], segmentMinutes: { "pier_novospassky__pier_derbenevskaya": 9, "pier_derbenevskaya__pier_torpedo": 8, "pier_torpedo__pier_simonovsky": 6, "pier_simonovsky__pier_avtozavodsky_bridge": 5, "pier_avtozavodsky_bridge__pier_zil": 5 } },
    // R4: official 32 min Лужники ↔ Киевский (OSM «4-й речной», duration=32) plus ~1 min per new intermediate stop (35 min).
    R4: { id: "R4", name: "4-й речной: Лужники → Киевский", color: "#e11d48", pierIds: ["pier_luzhniki", "pier_vorobyovskaya", "pier_novodevichy", "pier_kievsky_r4"], segmentMinutes: { "pier_luzhniki__pier_vorobyovskaya": 3, "pier_vorobyovskaya__pier_novodevichy": 14, "pier_novodevichy__pier_kievsky_r4": 18 } },
  };

  const PIER_BUS_STOPS = {
    pier_kievsky: {
      id: "stop_kievsky",
      name: "Киевский вокзал",
      coord: [55.74389, 37.56836],
      routes: ["м20", "240", "A10"],
    },
    pier_trekhgorny: {
      id: "stop_trekhgorny",
      name: "Улица Николаева",
      coord: [55.75508, 37.56785],
      routes: ["315", "м31"],
    },
    pier_krasnopresnensky_park: {
      id: "stop_krasnopresnensky",
      name: "Метро «Деловой центр»",
      coord: [55.75241, 37.5411],
      routes: ["3648", "с344"],
    },
    pier_city_bagration: {
      id: "stop_bagration",
      name: "Улица Дунаевского",
      coord: [55.746083, 37.546315],
      routes: ["с344", "м31", "91", "157"],
    },
    pier_city_central: {
      id: "stop_city_central",
      name: "Пресненская набережная",
      coord: [55.7468, 37.5418],
      routes: ["3648", "м31"],
    },
    pier_kutuzovsky: {
      id: "stop_kutuzovsky",
      name: "Студгородок",
      coord: [55.741213, 37.537376],
      routes: ["с344", "240", "116", "157"],
    },
    pier_beregovoy: {
      id: "stop_beregovoy",
      name: "ЖК «Береговой»",
      coord: [55.754932, 37.513558],
      routes: ["м23", "4", "155"],
    },
    pier_heart_capital: {
      id: "stop_heart_capital",
      name: "Романовская школа",
      coord: [55.75849, 37.5164],
      routes: ["с344", "155", "130"],
    },
    pier_park_fili: {
      id: "stop_park_fili",
      name: "Парк «Фили»",
      coord: [55.751328, 37.492787],
      routes: ["T73", "M2", "266"],
    },
    // Static pier stop data keeps the map and route planner usable offline.
    // R2/R3 stops: positions and routes taken from OpenStreetMap bus_stop nodes
    // (node id in comments) — the stop serving each pier, usually named after it.
    pier_zil: {
      id: "stop_zil_fallback",
      name: "Причал «ЗИЛ»", // osm node 11232508351
      coord: [55.6988467, 37.6296395],
      routes: ["766"],
    },
    pier_pechatniki: {
      id: "stop_pechatniki_fallback",
      name: "Причал «Печатники»", // osm node 3497388822
      coord: [55.6827537, 37.7173088],
      routes: ["292", "с783"],
    },
    pier_nagatinsky: {
      id: "stop_nagatinsky",
      name: "Причал «Нагатинский»", // osm node 13054667370
      coord: [55.6904615, 37.6276664],
      routes: ["с951"],
    },
    pier_zaton_novinki: {
      id: "stop_zaton_novinki",
      name: "Причал «Затон Новинки»", // osm node 12142624108
      coord: [55.6911328, 37.6583192],
      routes: ["766", "831"],
    },
    pier_klenovy_bulvar: {
      id: "stop_klenovy_bulvar",
      name: "Причал «Кленовый бульвар»", // osm node 2185090496
      coord: [55.686384, 37.6723792],
      routes: ["824"],
    },
    pier_south_river_terminal: {
      id: "stop_south_river_terminal",
      name: "Южный речной вокзал", // osm node 10814385229
      coord: [55.6900712, 37.6755506],
      routes: ["831"],
    },
    pier_moscow_shipyard: {
      id: "stop_moscow_shipyard",
      name: "Московская верфь", // osm node 13081533634
      coord: [55.6911925, 37.6940522],
      routes: ["824"],
    },
    pier_nagatinsky_backwater: {
      id: "stop_nagatinsky_backwater",
      name: "Метро «Нагатинский Затон»", // osm node 2179869050
      coord: [55.6844533, 37.7051665],
      routes: ["811", "824", "888", "с856"],
    },
    pier_kolomenskaya_embankment: {
      id: "stop_kolomenskaya_embankment",
      name: "Коломенская набережная, 6", // osm node 2179749249
      coord: [55.6845883, 37.7094031],
      routes: ["811"],
    },
    pier_novospassky: {
      id: "stop_novospassky",
      name: "Новоспасский мост", // osm node 10961182517
      coord: [55.7283586, 37.6503879],
      routes: ["913", "с932"],
    },
    pier_derbenevskaya: {
      id: "stop_derbenevskaya",
      name: "Дербеневская набережная", // osm node 472946222
      coord: [55.7255818, 37.6552572],
      routes: ["913", "984", "с932"],
    },
    pier_torpedo: {
      id: "stop_torpedo",
      name: "Причал «Торпедо»", // osm node 14225248644
      coord: [55.7188067, 37.6534948],
      routes: ["м79"],
    },
    pier_simonovsky: {
      id: "stop_simonovsky",
      name: "Даниловская набережная", // osm node 594912933
      coord: [55.707687, 37.6422876],
      routes: ["с910"],
    },
    pier_avtozavodsky_bridge: {
      id: "stop_avtozavodsky_bridge",
      name: "Причал «Автозаводский мост»", // osm node 11232529045
      coord: [55.7028134, 37.6265706],
      routes: ["с910"],
    },
    pier_vorobyovskaya: {
      id: "stop_vorobyovskaya",
      name: "Московская канатная дорога", // osm node 389781277
      coord: [55.7079167, 37.5450253],
      routes: ["297"],
    },
    pier_novodevichy: {
      id: "stop_novodevichy",
      name: "Новодевичий проезд", // osm node 10774858937
      coord: [55.7291276, 37.5579241],
      routes: ["с216"],
    },
    pier_luzhniki: {
      // Nearest real stop: the Luzhniki park interior has no bus stops, so this is the
      // «Стадион «Лужники»» platform on Лужнецкая набережная (~1.1 km east of the pier).
      id: "stop_luzhniki",
      name: "Стадион «Лужники»", // osm node 1423524986
      coord: [55.7143301, 37.5659925],
      routes: ["220", "379", "с216", "с755"],
    },
  };
  // Both Киевский berths are served by the same bus stop.
  PIER_BUS_STOPS.pier_kievsky_r4 = PIER_BUS_STOPS.pier_kievsky;

  window.REBUS_DATA = {
    PIERS,
    RIVER_LINES,
    RIVER_SCHEDULE,
    PIER_BUS_STOPS,
  };
})();
