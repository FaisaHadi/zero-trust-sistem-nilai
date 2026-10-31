# Pesan respons API

Respons objek JSON menambahkan `success` dan `message` berbahasa Indonesia; semua field lama tetap di tingkat teratas. `error` tetap kode mesin. Pesan di bawah berdasarkan inspeksi kode; perubahan ini belum diuji melalui HTTP. Hasil pengujian terdahulu tidak membuktikan respons versi ini.

| Endpoint | Skenario | HTTP aktual menurut kode | Kode mesin | Message | Arti untuk demo |
| --- | --- | --- | --- | --- | --- |
| POST /auth/login | Berhasil | 200 | — | Autentikasi berhasil. Token akses dan token penyegaran telah diterbitkan. | Field token dan TTL tetap tersedia. |
| POST /auth/login | Input kurang / device tidak disertakan | 400 | invalid_request | Permintaan tidak valid. Periksa data yang wajib disertakan. / Identitas perangkat wajib disertakan melalui header X-Device-ID. | Lengkapi input. |
| POST /auth/login | Kredensial atau device salah | 401 | invalid_credentials | Autentikasi gagal. Kredensial atau perangkat tidak valid. | Tidak mengungkap keberadaan akun. |
| POST /auth/refresh | Aktif | 200 | — | Token akses berhasil diperbarui. | Refresh token tidak dirotasi. |
| POST /auth/refresh, /auth/logout | Format token salah | 400 | invalid_request | Token penyegaran wajib disertakan dalam format yang valid. | Body harus berisi token yang valid. |
| POST /auth/refresh, /auth/logout | Kedaluwarsa atau dicabut | 401 | invalid_refresh_token | Token penyegaran tidak valid atau tidak lagi berlaku. Silakan masuk kembali. | Token tidak lagi dapat dipakai. |
| POST /auth/logout | Berhasil | 204 | — | — | Body kosong; refresh dicabut, access JWT tetap berlaku hingga kedaluwarsa. |
| POST /auth/service | Berhasil | 200 | — | Token akses layanan berhasil diterbitkan. | Token tetap pada field lama. |
| POST /auth/service | Input/kredensial salah | 400 / 401 | invalid_request / invalid_credentials | Permintaan tidak valid. Periksa data yang wajib disertakan. / Autentikasi layanan gagal. Kredensial layanan tidak valid. | Tidak menampilkan kredensial. |
| GET /nilai | Baris tersedia / kosong | 200 | — | Data nilai dalam cakupan akses Anda berhasil ditampilkan. / Tidak ada data nilai yang tersedia dalam cakupan akses Anda. | `grades` tetap array; daftar kosong bukan 404. |
| PUT /nilai/:id | Berhasil | 200 | — | Nilai berhasil diperbarui. | Field nilai tetap di tingkat teratas. |
| PUT /nilai/:id | Nilai tidak valid | 400 | invalid_grade_value | Nilai wajib diisi dan panjangnya tidak boleh melebihi 64 karakter. | Validasi input oleh Service Nilai setelah request lolos policy Gateway. |
| PUT /nilai/:id | ID nilai tidak ditemukan oleh policy Gateway | 404 | not_found | Data nilai tidak ditemukan. | Respons berasal dari Gateway; alasan auditnya `grade_not_found`. Request tidak diteruskan ke Service Nilai. |
| PUT /nilai/:id | ID nilai tidak ditemukan dalam pemeriksaan Service Nilai | 404 | grade_not_found | Data nilai tidak ditemukan. | Keterangan lapisan internal apabila request telah diteruskan dan pemeriksaan service tidak menemukan nilai. |
| PUT /nilai/:id | Kelas sudah final | 403 Gateway / 409 service | forbidden / class_finalized | Nilai tidak dapat diubah karena kelas telah difinalisasi. | Status berbeda sesuai lapisan; tidak diubah. |
| POST /kelas/:id/finalisasi | Berhasil | 200 | — | Kelas berhasil difinalisasi dan transkrip berhasil disinkronkan. | Hanya setelah sinkronisasi terkonfirmasi. |
| POST /kelas/:id/finalisasi | Kelas tidak ditemukan / sudah final | 404 / 409 | not_found atau class_not_found / class_finalized | Kelas tidak ditemukan. / Kelas sudah difinalisasi. | Kode not_found berasal dari Gateway. |
| POST /kelas/:id/finalisasi | Token service tidak tersedia | 502 | transcript_sync_failed | Kelas telah difinalisasi, tetapi sinkronisasi transkrip belum dimulai karena token layanan tidak tersedia. | `transcriptSyncStatus: not_started`. |
| POST /kelas/:id/finalisasi | Hasil sinkronisasi tidak pasti | 502 | transcript_sync_failed | Kelas telah difinalisasi, tetapi hasil sinkronisasi transkrip belum dapat dipastikan. | `transcriptSyncStatus: unknown`; tidak menyatakan commit gagal. |
| GET /transkrip/:nim | Ada / kosong | 200 | — | Data transkrip berhasil ditampilkan. / Tidak ada data transkrip yang tersedia. | `nim` dan `entries` tetap tersedia. |
| GET /transkrip/:nim | Bukan miliknya / tidak ditemukan | 403 / 404 | forbidden / not_found | Anda tidak memiliki izin untuk melihat transkrip ini. / Transkrip mahasiswa tidak ditemukan. | Gateway dan service dapat berbeda kode untuk data tidak ditemukan. |
| POST /transkrip/sinkron | Berhasil | 200 | — | Sinkronisasi transkrip berhasil diproses. | `classId`, `inserted`, `total` tetap tersedia. |
| POST /transkrip/sinkron | Token user | 403 | forbidden | Akses ditolak. Sinkronisasi transkrip hanya dapat dilakukan oleh layanan yang berwenang. | Hanya service yang berwenang. |
| POST /transkrip/sinkron | Body salah / kelas tidak ada / belum final | 400 / 404 / 409 | invalid_request / not_found / class_not_finalized | Permintaan sinkronisasi harus menyertakan classId yang valid. / Kelas tidak ditemukan. / Transkrip tidak dapat disinkronkan karena kelas belum difinalisasi. | Kondisi sinkronisasi dibedakan. |
| Route non-auth | Token hilang / tidak valid | 401 | unauthorized | Token akses wajib disertakan melalui header Authorization. / Token akses tidak valid atau telah kedaluwarsa. | JWT diperiksa Gateway dan service. |
| Route user | Device hilang / tidak terdaftar | 403 | forbidden atau device_not_registered | Identitas perangkat wajib disertakan melalui header X-Device-ID. / Perangkat tidak diizinkan untuk mengakses layanan ini. | Kode bergantung lapisan. |
| Route terbatas | Role / pengampu tidak sesuai | 403 | forbidden | Anda tidak memiliki izin untuk melakukan tindakan ini. / Anda tidak memiliki izin untuk mengelola kelas ini. | Penolakan sesuai policy. |
| PUT /nilai/:id; POST /kelas/:id/finalisasi | Di luar jam | 403 | forbidden atau outside_access_window | Tindakan hanya diizinkan mulai 07:00 sampai sebelum 21:00 zona Asia/Jakarta. | Pesan diambil dari konfigurasi dan batas akhir eksklusif. |
| Service langsung | Gateway secret tidak valid | 403 | gateway_required atau forbidden | Akses ke layanan tidak diizinkan melalui jalur ini. | Kedua service memeriksa asal request. |
| Semua | JSON tidak valid | 400; parser dapat mengembalikan 4xx lain | invalid_request | Isi permintaan tidak valid. | Status parser dipertahankan. |
| Route tidak dikenal | Route tidak ditemukan setelah pemeriksaan identitas | 404 | not_found | Endpoint yang diminta tidak ditemukan. | Tanpa token, Gateway dapat lebih dahulu menjawab 401. |
| Proxy | Komunikasi service terganggu | 502 | bad_gateway | Komunikasi dengan layanan tujuan terganggu. Hasil permintaan belum dapat dipastikan. | Hasil upstream tidak tersedia. |
| Semua | Kesalahan internal | 500 | internal_error | Permintaan tidak dapat diproses karena terjadi kesalahan internal. | Tidak menampilkan stack trace atau detail internal. |

Kode `error` dalam respons dan alasan audit adalah field dengan fungsi berbeda. Contohnya, penolakan Gateway untuk ID nilai yang tidak ditemukan memakai `error: "not_found"` pada respons dan `grade_not_found` sebagai alasan audit. Pemeriksaan ID oleh policy terjadi setelah pemeriksaan role dan jam akses; penolakan yang terjadi lebih awal dapat menghasilkan respons lain.

Keputusan policy `allow` tetap terpisah dari hasil service dalam audit. Pesan tidak mengklaim audit berhasil dicatat. Mekanisme retry dan rekonsiliasi belum tersedia. `unknown` juga mencakup kegagalan respons upstream selain timeout; pesan tidak menebak penyebabnya.
