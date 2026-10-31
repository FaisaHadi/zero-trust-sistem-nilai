import { printAudit } from './audit-console.js';

// The statement remains the caller's existing INSERT; deferred callbacks belong to one transaction.
export function createAuditRecorder(database, statement, source) {
  const select = database.prepare('SELECT recorded_at, subject, method, endpoint, device_id, decision, reason FROM audit_logs WHERE id = ?');
  return (parameters, defer = false) => {
    const result = statement.run(...parameters);
    const emit = () => {
      try {
        const row = select.get(result.lastInsertRowid);
        if (row) printAudit(source, row);
      } catch {
        try { console.error('Tampilan audit tidak tersedia.'); } catch { /* Display failures do not affect the transaction. */ }
      }
    };
    if (defer) return emit;
    emit();
  };
}
