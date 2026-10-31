import { accessTimeZone, defaultAccessWindow } from './config.js';

const messages = {
  invalid_credentials: 'Autentikasi gagal. Kredensial atau perangkat tidak valid.',
  unregistered_device: 'Autentikasi gagal. Kredensial atau perangkat tidak valid.',
  invalid_service_credentials: 'Autentikasi layanan gagal. Kredensial layanan tidak valid.',
  missing_or_invalid_input: 'Permintaan tidak valid. Periksa data yang wajib disertakan.',
  missing_or_invalid_token: 'Token penyegaran wajib disertakan dalam format yang valid.',
  invalid_refresh_token: 'Token penyegaran tidak valid atau tidak lagi berlaku. Silakan masuk kembali.',
  missing_bearer_token: 'Token akses wajib disertakan melalui header Authorization.',
  bearer_missing: 'Token akses wajib disertakan melalui header Authorization.',
  invalid_or_expired_token: 'Token akses tidak valid atau telah kedaluwarsa.',
  token_invalid: 'Token akses tidak valid atau telah kedaluwarsa.',
  invalid_token_claims: 'Token akses tidak valid atau telah kedaluwarsa.',
  token_claims_invalid: 'Token akses tidak valid atau telah kedaluwarsa.',
  inactive_user_or_role_mismatch: 'Token akses tidak valid atau telah kedaluwarsa.',
  user_or_role_invalid: 'Token akses tidak valid atau telah kedaluwarsa.',
  token_use_invalid: 'Token akses tidak sesuai untuk permintaan ini.',
  user_token_required: 'Token akses pengguna diperlukan untuk permintaan ini.',
  device_not_registered: 'Perangkat tidak diizinkan untuk mengakses layanan ini.',
  device_unregistered: 'Perangkat tidak diizinkan untuk mengakses layanan ini.',
  missing_device: 'Identitas perangkat wajib disertakan melalui header X-Device-ID.',
  role_forbidden: 'Anda tidak memiliki izin untuk melakukan tindakan ini.',
  role_not_allowed: 'Anda tidak memiliki izin untuk melakukan tindakan ini.',
  not_class_lecturer: 'Anda tidak memiliki izin untuk mengelola kelas ini.',
  class_not_taught: 'Anda tidak memiliki izin untuk mengelola kelas ini.',
  transcript_owner_mismatch: 'Anda tidak memiliki izin untuk melihat transkrip ini.',
  transcript_not_owned: 'Anda tidak memiliki izin untuk melihat transkrip ini.',
  service_token_required: 'Akses ditolak. Sinkronisasi transkrip hanya dapat dilakukan oleh layanan yang berwenang.',
  service_identity_invalid: 'Akses ditolak. Identitas layanan tidak berwenang.',
  gateway_secret_invalid: 'Akses ke layanan tidak diizinkan melalui jalur ini.',
  invalid_gateway_request_id: 'Permintaan melalui gateway tidak valid.',
  invalid_grade_value: 'Nilai wajib diisi dan panjangnya tidak boleh melebihi 64 karakter.',
  invalid_sync_request: 'Permintaan sinkronisasi harus menyertakan classId yang valid.',
  invalid_request_body: 'Isi permintaan tidak valid.',
  request_parse_error: 'Isi permintaan tidak valid.',
  grade_not_found: 'Data nilai tidak ditemukan.',
  class_not_found: 'Kelas tidak ditemukan.',
  nim_not_found: 'Transkrip mahasiswa tidak ditemukan.',
  student_not_found: 'Transkrip mahasiswa tidak ditemukan.',
  route_not_allowed: 'Endpoint yang diminta tidak ditemukan.',
  route_not_found: 'Endpoint yang diminta tidak ditemukan.',
  grade_finalized: 'Nilai tidak dapat diubah karena kelas telah difinalisasi.',
  class_finalized: 'Kelas sudah difinalisasi.',
  class_not_finalized: 'Transkrip tidak dapat disinkronkan karena kelas belum difinalisasi.',
  internal_error: 'Permintaan tidak dapat diproses karena terjadi kesalahan internal.',
};

export function errorResponse(error, reason = error) {
  const hours = `Tindakan hanya diizinkan mulai ${defaultAccessWindow.start} sampai sebelum ${defaultAccessWindow.end} zona ${accessTimeZone}.`;
  const message = reason === 'outside_access_window' || reason === 'outside_access_hours'
    ? hours : messages[reason] ?? messages[error] ?? messages.internal_error;
  return { success: false, message, error };
}

export function successResponse(message, fields) {
  return { success: true, message, ...fields };
}
