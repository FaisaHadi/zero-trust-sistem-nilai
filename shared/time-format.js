// Pemformatan tampilan saja.
// Jangan gunakan hasilnya untuk penyimpanan database atau perhitungan JWT.
//
// Input yang didukung:
// - SQLite UTC: "2026-10-31 06:30:00"
// - ISO UTC: "2026-10-31T06:30:00.123Z"
// - ISO dengan offset: "2026-10-31T13:30:00.123+07:00"
//
// Input kosong atau tidak valid menghasilkan null.

const jakartaFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Jakarta",
  calendar: "iso8601",
  numberingSystem: "latn",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
  hourCycle: "h23",
});

function parseTimestamp(value) {
  if (typeof value !== "string") return null;

  const text = value.trim();

  const sqlite = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d{1,3})?$/.exec(
    text,
  );

  const iso =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(
      text,
    );

  const match = sqlite ?? iso;
  if (!match) return null;

  const [, date, time, fraction = ""] = match;

  // Tolak tanggal tidak valid dan jam 24:00.
  const wallTime = new Date(`${date}T${time}${fraction}Z`);

  if (
    !Number.isFinite(wallTime.getTime()) ||
    wallTime.toISOString().slice(0, 19) !== `${date}T${time}`
  ) {
    return null;
  }

  // CURRENT_TIMESTAMP SQLite adalah UTC meskipun tanpa akhiran Z.
  const zone = sqlite ? "Z" : match[4];
  const instant = new Date(`${date}T${time}${fraction}${zone}`);

  return Number.isFinite(instant.getTime()) ? instant : null;
}

function jakartaParts(value) {
  const instant = parseTimestamp(value);
  if (!instant) return null;

  return Object.fromEntries(
    jakartaFormatter
      .formatToParts(instant)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

// Untuk respons JSON.
// Contoh: "2026-10-31T13:30:00.123+07:00"
export function formatJakartaIso(value) {
  const p = jakartaParts(value);
  if (!p) return null;

  return (
    `${p.year}-${p.month}-${p.day} ` +
    `T ${p.hour}:${p.minute}:${p.second}` +
    ` +07:00`
  );
}

// Untuk log terminal.
// Contoh: "31/10/2026 13:30:00 WIB"
export function formatJakartaLog(value) {
  const p = jakartaParts(value);
  if (!p) return null;

  return (
    `${p.day}/${p.month}/${p.year} ` + `${p.hour}:${p.minute}:${p.second} WIB`
  );
}
