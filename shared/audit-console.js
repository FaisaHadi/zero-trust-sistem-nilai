function safe(value) {
  if (value === null || value === undefined) return null;
  return String(value).slice(0, 256).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export function printAudit(source, row) {
  const entry = {
    waktu: `${safe(row.recorded_at)} UTC`, sumber: safe(source), subjek: safe(row.subject),
    metode: safe(row.method), endpoint: safe(row.endpoint), perangkat: safe(row.device_id),
    keputusan: safe(row.decision), alasan: safe(row.reason),
  };
  console.log(`[AUDIT] ${JSON.stringify(entry)}`);
}
