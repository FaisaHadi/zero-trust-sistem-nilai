# Zero Trust Sistem Nilai dan Transkrip Akademik

Proyek praktikum API berbasis Node.js untuk nilai dan transkrip. Klien memakai **API Gateway** pada port 3000. Service Nilai (3001) dan Service Transkrip (3002) memeriksa ulang gateway secret, JWT, serta hak akses yang relevan. Ketiga proses memakai database SQLite yang sama di `data/academic.sqlite`.

## Arsitektur

```text
Klien ──> API Gateway :3000 ──> Service Nilai :3001 ──┐
                           └──> Service Transkrip :3002 ├──> data/academic.sqlite
API Gateway ────────────────────────────────────────────┘

Finalisasi: Service Nilai ──> Gateway /auth/service
             Service Nilai ──> Gateway /transkrip/sinkron ──> Service Transkrip
```

Gateway berperan sebagai Policy Enforcement Point; modul autentikasi dan `policy.js` di dalamnya menjalankan keputusan Policy Engine/Administrator, audit keputusan, dan proxy. Service Nilai membaca nilai serta mengubah/finalisasi kelas; Service Transkrip membaca transkrip dan menyinkronkan nilai kelas final. Port service memakai `HOST=127.0.0.1` pada konfigurasi contoh, sehingga request langsung **lokal** masih dapat dipakai untuk demonstrasi penolakan. Akses aplikasi yang sah tetap melalui Gateway.

## Prasyarat dan persiapan di Windows PowerShell

- Node.js **v24.22.1** dan npm; versi Node ini diperlukan untuk `node:sqlite` bawaan.
- Jalankan perintah dari akar repository. `package-lock.json` sudah tersedia.
- Tidak perlu paket SQLite terpisah. `npm ci` memasang dependency yang tercantum di `package.json`: `express`, `http-proxy-middleware`, `jsonwebtoken`, dan `bcryptjs`.

```powershell
node --version
npm --version
npm ci
Copy-Item apps/gateway/.env.example apps/gateway/.env
Copy-Item apps/nilai/.env.example apps/nilai/.env
Copy-Item apps/transkrip/.env.example apps/transkrip/.env
```

Isi placeholder dalam tiga `.env` **secara lokal** sebelum menjalankan service. Gunakan `JWT_SECRET` dan `GATEWAY_SECRET` yang sama pada ketiga proses; gunakan `SERVICE_NILAI_CLIENT_ID` yang sama pada ketiganya; cocokkan `SERVICE_NILAI_CLIENT_SECRET` antara Gateway dan Service Nilai. Ketiga secret tersebut harus berupa nilai nyata sesuai panjang minimum yang diminta kode (32 karakter untuk secret). Jangan commit `.env` atau menayangkan nilainya. URL dan port dalam contoh adalah:

| Proses | File contoh | Variabel koneksi utama |
| --- | --- | --- |
| Gateway | `apps/gateway/.env.example` | `PORT=3000`, `HOST=127.0.0.1`, `NILAI_SERVICE_URL=http://127.0.0.1:3001`, `TRANSKRIP_SERVICE_URL=http://127.0.0.1:3002` |
| Nilai | `apps/nilai/.env.example` | `PORT=3001`, `HOST=127.0.0.1`, `GATEWAY_URL=http://127.0.0.1:3000` |
| Transkrip | `apps/transkrip/.env.example` | `PORT=3002`, `HOST=127.0.0.1` |

Untuk `GATEWAY_URL`, HTTP hanya diterima pada alamat loopback (`127.0.0.1` atau `[::1]`); host lain harus memakai HTTPS. Permintaan internal Service Nilai ke Gateway tidak mengikuti redirect. `npm run seed` tetap dapat berjalan tanpa `.env` karena script memakai `--env-file-if-exists`.

Siapkan database sekali dari akar repository:

```powershell
npm run seed
```

Untuk menjalankan ketiga aplikasi dalam satu terminal PowerShell, tetap dari akar repository:

```powershell
npm start
```

Perintah ini memerlukan `concurrently` dalam **devDependencies**; gunakan `npm ci` dengan devDependencies terpasang. Label `[GATEWAY]`, `[NILAI]`, dan `[TRANSKRIP]` menunjukkan sumber setiap pesan. Pesan “aktif” muncul setelah aplikasi masing-masing berhasil mendengarkan port. Aplikasi tetap menjadi tiga proses terpisah dan harus tetap berjalan agar API dapat diakses melalui Gateway. Tekan **Ctrl+C** pada terminal tersebut untuk menghentikan kelompok proses.

Jika satu proses keluar, `concurrently` meminta proses lain dalam kelompok yang sama berhenti. Jika startup gagal karena port sudah dipakai, periksa instance yang sudah berjalan sebelum menanganinya; skrip tidak mematikan pemilik port yang ada secara otomatis. Tidak ada restart otomatis.

Untuk diagnosis atau demo, Anda juga dapat membuka **tiga jendela PowerShell** dan menjalankan skrip individual berikut:

```powershell
npm run start-gateway
```

```powershell
npm run start-nilai
```

```powershell
npm run start-transkrip
```

Seed membuat skema dan data contoh tanpa menghapus database; menjalankannya ulang tidak mereset status finalisasi atau password pengguna yang sudah ada. Path database ditetapkan dari akar proyek, jadi konsisten untuk ketiga proses. Berikut perintah pengujian yang tersedia; hasil eksekusi sebelumnya pada salinan terisolasi dirangkum di bagian verifikasi. Pembaruan dokumentasi ini tidak menjalankannya ulang:

```powershell
npm test
curl.exe -i http://127.0.0.1:3001/nilai
curl.exe -i http://127.0.0.1:3002/transkrip/2024051
```

`npm test` menjalankan `node --test`. Pada verifikasi integrasi terdahulu hasilnya **0 kasus uji**; sejak itu ditambahkan tes audit menggunakan SQLite in-memory. Tes audit tidak membuktikan seluruh alur HTTP. Dua request langsung ke service tanpa gateway secret sudah diamati menghasilkan HTTP 403 pada salinan terisolasi dalam verifikasi terdahulu.

## Hasil verifikasi yang sudah diamati

Verifikasi dilakukan pada **salinan proyek terisolasi**, memakai database dan konfigurasi pengujian milik salinan. Hasil berikut berasal dari laporan eksekusi sebelumnya; tidak ada pengujian ulang atau perubahan database dalam pembaruan dokumentasi ini.

| Tahap | Hasil tercatat | Makna |
| --- | --- | --- |
| Verifikasi integrasi awal | **109 kasus HTTP sesuai ekspektasi**, termasuk pemeriksaan respons/data | Mencakup autentikasi, refresh/logout, device, role/kepemilikan, default deny, token service, akses langsung, finalisasi, dan gangguan sinkronisasi. |
| Seluruh pemeriksaan runtime awal | **138 PASS, 1 FAIL** dari 139 pemeriksaan | Angka ini mencakup pemeriksaan non-HTTP; kegagalan awal adalah pelaporan startup saat port sibuk. |
| Regresi startup setelah perbaikan | **3 PASS, 0 FAIL**: Gateway, Service Nilai, Service Transkrip | Startup normal berhasil. Saat port sama sudah dipakai, instance kedua melaporkan `EADDRINUSE`, exit **1**, tanpa pesan “aktif”; instance pertama tetap berjalan. Semua proses uji dihentikan dan port 3000–3002 dibersihkan. |
| Script repository `npm test` saat verifikasi terdahulu | Exit **0**, **0 kasus uji**, **0 suite** | Tes audit ditambahkan kemudian; kasus HTTP dan regresi startup berasal dari harness terpisah. |

Perbaikan startup berada pada ketiga `apps/*/src/server.js`: pesan “aktif” hanya muncul pada event `listening`; handler `error` mencatat kode kegagalan, menutup database, dan menetapkan exit code nonzero. Pemeriksaan sintaks ketiga berkas setelah perbaikan exit 0. Hasil 3 PASS merupakan pengujian lanjutan khusus startup; hasil historis 138 PASS/1 FAIL tetap dicatat dan tidak diganti atau dijumlahkan sebagai satu suite baru.

Pada audit alur normal, **23 kelompok policy allow** memiliki UUID yang menghubungkan keputusan Gateway, hasil service, dan hasil upstream. Endpoint kanonik dan kode alasan tetap terjaga. Nilai `X-Request-ID` klien ditimpa oleh Gateway.

### Bukti dan batas sinkronisasi serta jam

Kedua percobaan gangguan memakai snapshot salinan sebelum finalisasi yang sama:

| Kondisi yang diuji | Respons finalisasi | Keadaan database salinan |
| --- | --- | --- |
| Alur berhasil untuk dua kelas | HTTP **200**, `confirmed` | Dua kelas final, empat entri transkrip. |
| Service Transkrip tidak tersedia | HTTP **502**, `unknown` | Satu kelas tetap final, **nol entri transkrip**. |
| Respons terputus setelah commit sinkronisasi | HTTP **502**, `unknown` | Satu kelas final, **dua entri transkrip sudah tersimpan**. |

Dengan demikian, gangguan sinkronisasi dapat meninggalkan kelas final tanpa entri transkrip. **Status respons `unknown` sendiri tidak memastikan apakah commit sinkronisasi terjadi atau tidak.** Belum tersedia retry atau rekonsiliasi otomatis; pemeriksaan keadaan database secara manual masih diperlukan untuk mengetahui hasilnya.

Batas jam **06.59, 07.00, 20.59, dan 21.00 pada verifikasi terdahulu diuji melalui simulasi formatter jam bisnis di proses pengujian**, tanpa mengubah jam OS atau waktu JWT. Penolakan di luar jam juga diamati pada waktu nyata 23.32 Asia/Jakarta. Hasil ini tidak membuktikan eksekusi pada seluruh batas jam nyata; **batas nyata tepat 21.00 WIB belum diamati**. Gangguan pada rangkaian terdahulu mencakup service tidak tersedia dan koneksi terputus setelah commit. Run lanjutan 31 Oktober 2026 mengamati respons timeout sekitar lima detik (5.175 ms secara end-to-end), tetapi **ketepatan timeout internal persis lima detik belum dipastikan**.

Sumber angka: artefak di luar repository pada folder verifikasi `zero-trust-verification-01/evidence/`, yaitu `verification-report.md`, `runtime-results.json`, `startup-after.json`, `preflight.json`, dan `npm-test-output.txt`. Artefak tersebut mencatat tahap awal dan tindak lanjut startup secara terpisah.

### Pembaruan verifikasi — 31 Oktober 2026

Setiap rangkaian berikut memiliki cakupan dan penyiapan sendiri. **Hasil antar-run tidak dijumlahkan sebagai jumlah kasus unik.** Run sebelumnya sekitar 05.23 WIB mencatat **77 HTTP PASS**, dengan **10 kasus HTTP dan 1 unit batas jam NOT_RUN** karena jam akses belum terbuka dan unit batas jam belum dijalankan.

| Rangkaian | Hasil yang diamati | Cakupan dan konteks |
| --- | --- | --- |
| Run lanjutan pada jam akses nyata, sekitar 10.28–10.29 WIB | **10 kasus HTTP yang sebelumnya NOT_RUN menjadi PASS**; run lengkap mencatat **29 HTTP PASS, 0 FAIL** | Memakai salinan terisolasi. Alur perubahan nilai, finalisasi melalui Gateway, pembacaan transkrip, penolakan akses, serta gangguan sinkronisasi diuji. Sebagian request adalah penyiapan/pemeriksaan pendukung yang dapat berulang dari run sebelumnya. |
| Audit kesesuaian terisolasi, sekitar 10.41 WIB | **33 HTTP PASS, 0 FAIL** dan **4 tes repository PASS** | Seed baru pada salinan; seluruh sembilan endpoint tercakup. Empat tes repository terdiri atas tiga tes audit dan satu tes migrasi sementara, terpisah dari hitungan HTTP. |
| Pengujian manual Postman pada salinan, dilaporkan pengguna pada 31 Oktober 2026 | PUT nilai **85 → 90: 200**; finalisasi `IF-101`: **200**, `transcriptSyncStatus: "confirmed"`; transkrip mahasiswa menampilkan **90**; PUT sesudah finalisasi: **403**; finalisasi ulang: **409** | Hasil manual ini merupakan rangkaian terpisah. Menurut laporan pengguna, database asli tetap: `IF-101` **belum final**, nilai **85**, dan transkrip **kosong**. Pembaruan README ini tidak memeriksa ulang database tersebut. |

Pada run lanjutan, service tidak tersedia maupun fixture yang tidak membalas sampai timeout menghasilkan **502**, `transcriptSyncStatus: "unknown"`; pemeriksaan database salinan menunjukkan kelas final dengan transkrip kosong. `unknown` tetap tidak memastikan apakah commit terjadi atau gagal pada setiap jenis gangguan. Belum tersedia retry atau rekonsiliasi. **Unit batas jam dan observasi nyata tepat 21.00 WIB tetap belum terverifikasi**; tidak ada perubahan jam OS atau pemalsuan waktu dalam kedua run otomatis terbaru.

Sumber run otomatis 31 Oktober: artefak di luar repository pada `qa-20261031/run3/` (run 77 HTTP PASS), `qa-20261031/followup-1026/attempt2/` (run lanjutan 29 HTTP PASS), serta hasil runner `audit-1040.mjs` (audit 33 HTTP PASS dan empat tes repository). Hasil manual Postman bersumber dari laporan pengguna. Tidak ada pengujian ulang, seed, atau operasi database saat pembaruan dokumentasi ini.

## Akun dan data demo dari seed

Pada database baru, `db/seed.js` membuat password default **`Demo@2026!`** untuk semua akun berikut, sebagai hash bcrypt. Jika `SEED_DEMO_PASSWORD` diisi saat seed pertama atau database sudah berisi akun tersebut, password yang berlaku dapat berbeda; seed tidak menimpa hash lama.

Pemetaan ini berlaku pada database baru. Database yang sudah berisi ID seed lama tidak otomatis memperbarui username, NIM, atau nama kelas; menjalankan seed ulang juga dapat menambahkan device mahasiswa baru pada pengguna lama. Untuk database yang sudah ada, gunakan prosedur dan skrip transaksi pada [migrasi identitas demo](docs/migrasi_identitas_demo.md), bukan seed ulang. Login mencocokkan username persis; skema tidak memiliki field nama tampilan terpisah.

| Username | Role | User ID | NIM | Device ID | Kelas terkait |
| --- | --- | --- | --- | --- | --- |
| `admin` | admin | `admin-01` | — | `DEV-ADM-01` | — |
| `dosenki` | dosen | `dosen-01` | — | `DEV-DOS-01` | pengampu `IF-101` |
| `dosenkpt` | dosen | `dosen-02` | — | `DEV-DOS-02` | pengampu `IF-102` |
| `faisal` | mahasiswa | `mhs-01` | `2024051` | `DEV-MHS-051` | `IF-101`, `IF-102` |
| `hadi` | mahasiswa | `mhs-02` | `2024052` | `DEV-MHS-052` | `IF-101` |
| `saik` | mahasiswa | `mhs-03` | `2024053` | `DEV-MHS-053` | `IF-102` |

Seed juga memasukkan `grade-001` dan `grade-002` pada `IF-101`, serta `grade-003` dan `grade-004` pada `IF-102`. Kelas awal belum final; nilai dan keanggotaan persisnya dapat dilihat di `db/seed.js`.

`IF-101` adalah Keamanan Informasi yang diampu `dosenki`; `IF-102` adalah Komputasi Paralel yang diampu `dosenkpt`.

## Endpoint dan kebijakan akses

Respons JSON kini menyertakan `success` dan `message`, dengan kode `error`, token, dan data bisnis tetap pada field semula. Logout sukses tetap HTTP 204 tanpa body. Pada run otomatis 31 Oktober 2026, respons HTTP sudah diamati untuk login, refresh/logout, penerbitan token service, pembacaan nilai/transkrip, perubahan nilai dan finalisasi sukses, sinkronisasi ulang, serta sejumlah penolakan autentikasi, device, role/kepemilikan, input, ID tidak ditemukan, kelas final, dan gangguan upstream/sinkronisasi. Respons `success`, `message`, status HTTP, serta field bisnis/token diperiksa sesuai kasus pada harness; **ini tidak membuktikan seluruh variasi pesan atau seluruh cabang error telah diuji**. Daftar skenario dan pesan berdasarkan kode ada di [pesan respons API](docs/pesan_response_api.md); tabel tersebut merupakan referensi kontrak, bukan bukti bahwa setiap baris telah diamati melalui HTTP.

Semua URL klien di bawah memakai `http://127.0.0.1:3000`. Pada route pengguna selain `/auth/*`, kirim `Authorization: Bearer <accessToken>` dan `X-Device-ID` yang terdaftar untuk akun itu. Gateway dan service memeriksa ulang token serta device. Pengecualian adalah sinkronisasi internal, yang memakai token service.

| Endpoint | Pemanggil dan syarat utama | Respons utama sesuai kondisi |
| --- | --- | --- |
| `POST /auth/login` | Username/password pada JSON dan `X-Device-ID` terdaftar | 200: access JWT 10 menit dan refresh token 1 hari |
| `POST /auth/refresh` | JSON `{"refreshToken":"..."}` yang aktif, belum kedaluwarsa/dicabut | 200: access JWT baru |
| `POST /auth/logout` | JSON `{"refreshToken":"..."}` yang aktif | 204; refresh token dicabut |
| `POST /auth/service` | Internal Service Nilai: JSON `clientId` dan `clientSecret` dari konfigurasi | 200: JWT `role=service`, `token_use=service`, 5 menit |
| `GET /nilai` | Mahasiswa: nilai sendiri; dosen: nilai kelas yang diampu | 200: daftar nilai sesuai relasi database |
| `PUT /nilai/:id` | Dosen pengampu, kelas nilai belum final, waktu akses aktif; JSON `{"gradeValue":"90"}` | 200: nilai yang diperbarui |
| `POST /kelas/:id/finalisasi` | Dosen pengampu, kelas belum final, waktu akses aktif | 200 jika finalisasi dan sinkronisasi terkonfirmasi |
| `GET /transkrip/:nim` | Mahasiswa hanya NIM sendiri; admin boleh NIM mahasiswa yang ada | 200: entri transkrip |
| `POST /transkrip/sinkron` | Hanya token service milik Service Nilai; JSON `{"classId":"IF-101"}` | 200: jumlah entri; dipanggil Service Nilai melalui Gateway |

Waktu akses untuk **perubahan nilai dan finalisasi** ialah `07.00 ≤ waktu < 21.00` dalam zona `Asia/Jakarta`; tepat pukul 21.00 ditolak. Rentang dan zona ini ditetapkan di `shared/config.js`. Route yang tidak dikenal atau gagal policy ditolak. Untuk `GET /nilai`, Gateway menghapus query dan header `X-*` klien; Service Nilai mengambil batas baris dari `sub` JWT terverifikasi dan relasi pengguna/kelas di database. Mahasiswa tidak dapat menentukan NIM lain lewat input, dan dosen tidak dapat memperluas cakupan kelas lewat filter klien.

Contoh bentuk login melalui PowerShell (gunakan password demo hanya untuk lingkungan lokal):

```powershell
$login = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3000/auth/login' `
  -Headers @{ 'X-Device-ID' = 'DEV-MHS-051' } -ContentType 'application/json' `
  -Body '{"username":"faisal","password":"Demo@2026!"}'
$headers = @{ Authorization = "Bearer $($login.accessToken)"; 'X-Device-ID' = 'DEV-MHS-051' }
Invoke-RestMethod -Method Get -Uri 'http://127.0.0.1:3000/nilai' -Headers $headers
```

Jangan tampilkan nilai access/refresh token saat merekam demo. Setelah `POST /kelas/IF-101/finalisasi`, respons sukses memiliki `isFinalized: true`, `transcriptSynced: true`, dan `transcriptSyncStatus: "confirmed"`. Jika token service belum berhasil diperoleh, service mengembalikan `transcriptSyncStatus: "not_started"`; jika hasil sinkronisasi tidak dapat dipastikan, statusnya `"unknown"`. Finalisasi mengubah state database dan seed ulang tidak mengembalikannya ke kondisi awal.

## Kontrol keamanan, audit, dan batas tahap ini

- Login memverifikasi hash bcrypt dan device terdaftar. Access JWT ditandatangani HS256, memuat `sub`, `role`, dan `token_use`. Refresh token acak disimpan sebagai hash SHA-256, memiliki waktu kedaluwarsa serta status pencabutan.
- Gateway menerapkan *default deny*, role, device, kepemilikan NIM, relasi dosen pengampu, status kelas, dan jam akses. Kedua service memverifikasi sendiri gateway secret, tanda tangan/masa berlaku JWT, role, dan batas data yang relevan.
- Gateway menimpa `X-Gateway-Secret` serta `X-Request-ID` dari klien sebelum proxy. UUID yang dibuat Gateway menghubungkan audit keputusan policy, hasil upstream, dan respons service melalui `request_id=...` pada kolom `reason`.
- `audit_logs` mencatat waktu, subjek, metode, endpoint kanonik, device, keputusan `allow`/`deny`, serta kode alasan tetap. Password, token, secret, dan body request tidak dimasukkan ke alasan audit.
- Audit baru yang berhasil disimpan ditampilkan otomatis sebagai satu baris `[AUDIT]` pada terminal, baik melalui `npm start` maupun skrip individual. Prefix `[GATEWAY]`, `[NILAI]`, dan `[TRANSKRIP]` pada `npm start` menunjukkan proses penghasilnya. Baris JSON memuat `waktu` (UTC, sesuai timestamp SQLite), `sumber`, `subjek`, `metode`, `endpoint`, `perangkat`, `keputusan`, dan `alasan`; karakter kontrol di-escape dan panjang field dibatasi hanya pada tampilan.
- Database tetap menyimpan riwayat utama; terminal hanya menampilkan audit baru, bukan memuat ulang riwayat lama. Satu request dapat menghasilkan beberapa catatan, misalnya keputusan policy dan hasil upstream: `allow` policy menunjukkan izin meneruskan, bukan keberhasilan operasi. Request finalisasi dan sinkronisasi juga masing-masing dapat menghasilkan catatan sendiri.
- Audit dalam transaksi login/logout ditampilkan setelah commit berhasil; penulisan yang dibatalkan tidak ditampilkan. Jika tampilan terminal gagal, pesan diagnostik terpisah tidak mengubah hasil transaksi atau respons API.
- Sinkronisasi transkrip memakai transaksi dan `ON CONFLICT ... DO NOTHING` agar pengulangan tidak menggandakan entri.
- Hasil sinkronisasi dapat berstatus `unknown` saat hasilnya tidak dapat dipastikan sesudah finalisasi. Pengujian membuktikan kelas dapat tetap final tanpa entri transkrip, maupun tetap final dengan entri transkrip yang sudah committed, sementara respons keduanya `unknown`. Belum ada retry, rekonsiliasi, atau `sync_pending`; status ini perlu diperiksa manual. Run lanjutan 31 Oktober 2026 mengamati timeout sekitar lima detik secara end-to-end; ketepatan timeout internal persis lima detik belum dipastikan. Tahap ini juga tidak mensyaratkan pemeriksaan bahwa semua mahasiswa sudah memiliki nilai sebelum finalisasi.
- Token pengguna **belum terikat secara kriptografis ke device** dan belum ada device attestation. Pemeriksaan device saat ini memakai ID terdaftar pada login dan request pengguna.

Materi tugas yang sudah ada tetap berada di `docs/materi/`. Rencana demonstrasi 7–8 menit ada di [`docs/naskah_demo_video.md`](docs/naskah_demo_video.md).
