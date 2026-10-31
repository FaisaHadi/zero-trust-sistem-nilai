# Migrasi identitas demo pada database yang sudah ada

Dokumen ini berlaku untuk database SQLite yang sudah berisi data proyek dan **bukan** untuk membuat database baru. Untuk database baru, gunakan `npm run seed`; seed tidak dirancang untuk memperbarui identitas pada ID yang telah ada.

Skrip [`db/migrate-demo-identities.js`](../db/migrate-demo-identities.js) hanya mengubah username, NIM mahasiswa, tiga ID perangkat mahasiswa, dan nama kelas yang dipetakan berikut. ID internal, role, status aktif, hash password, enrollment, nilai, finalisasi, transkrip, refresh token, serta riwayat audit tidak diubah.

| ID internal | Target username | Target NIM | Target device |
| --- | --- | --- | --- |
| `admin-01` | `admin` | — | `DEV-ADM-01` |
| `dosen-01` | `dosenki` | — | `DEV-DOS-01` |
| `dosen-02` | `dosenkpt` | — | `DEV-DOS-02` |
| `mhs-01` | `faisal` | `2024051` | `DEV-MHS-051` |
| `mhs-02` | `hadi` | `2024052` | `DEV-MHS-052` |
| `mhs-03` | `saik` | `2024053` | `DEV-MHS-053` |

| Kelas | Target nama | Pengampu yang harus tetap ada |
| --- | --- | --- |
| `IF-101` | Keamanan Informasi | `dosen-01` / `dosenki` |
| `IF-102` | Komputasi Paralel | `dosen-02` / `dosenkpt` |

## Operasi aman

1. Hentikan Gateway, Service Nilai, dan Service Transkrip. Jangan jalankan migrasi ketika proses tersebut dapat menulis ke SQLite.
2. Pastikan target benar-benar ada. Skrip tidak membuat database kosong jika path salah.
3. Jalankan pemeriksaan tanpa perubahan dari akar repository:

   ```powershell
   node db/migrate-demo-identities.js --check
   ```

   Pemeriksaan mengharuskan keenam ID/role seed lama atau targetnya dikenali, setiap pengguna hanya memiliki satu perangkat yang dipetakan, target tidak dipakai oleh baris lain, dan pemeriksaan integritas/foreign key SQLite lulus. Jika satu syarat gagal, jangan gunakan `--apply` sebelum penyebabnya diselesaikan.

4. Buat backup baru yang belum ada. Gunakan nama bertimestamp dan jangan timpa backup lama:

   ```powershell
   $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
   node db/migrate-demo-identities.js --check --backup "data/academic-before-demo-identities-$stamp.sqlite"
   ```

   `--backup` memakai API online backup dari `node:sqlite`, lalu membuka hasil backup kembali untuk `integrity_check`, `foreign_key_check`, kecocokan jumlah baris, dan digest data. Ini aman terhadap mode WAL; jangan mengganti langkah tersebut dengan menyalin berkas `.sqlite`, `-wal`, atau `-shm` secara manual ketika aplikasi berjalan.

5. Untuk rehearsal, buat **salinan baru** dari backup dengan API yang sama dan migrasikan hanya salinan itu. Ganti nilai path di bawah dengan path backup yang baru dibuat:

   ```powershell
   $backup = (Resolve-Path 'data/academic-before-demo-identities-YYYYMMDD-HHMMSS.sqlite').Path
   $rehearsal = Join-Path $env:TEMP 'academic-demo-identities-rehearsal.sqlite'
   if (Test-Path -LiteralPath $rehearsal) { throw 'Path rehearsal sudah ada; gunakan nama baru.' }
   node db/migrate-demo-identities.js --database $backup --check --backup $rehearsal
   node db/migrate-demo-identities.js --database $rehearsal --apply
   node db/migrate-demo-identities.js --database $rehearsal --check
   node db/migrate-demo-identities.js --database $rehearsal --apply
   ```

   Penerapan kedua harus melaporkan `users`, `studentDevices`, dan `classes` bernilai `0` pada bagian `changed`; itu adalah no-op yang diharapkan. Jangan gunakan backup asli sebagai tempat rehearsal.

6. Setelah rehearsal dan pemeriksaan aktif kembali sesuai, lakukan apply aktif dengan backup baru:

   ```powershell
   $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
   node db/migrate-demo-identities.js --apply --backup "data/academic-before-demo-identities-$stamp.sqlite"
   node db/migrate-demo-identities.js --check
   ```

`--apply` memakai `PRAGMA foreign_keys = ON`, `BEGIN IMMEDIATE`, validasi ulang di dalam transaksi, `UPDATE` terparameterisasi, validasi hasil, lalu `COMMIT`. Kegagalan sebelum commit memicu `ROLLBACK`. Skrip tidak memakai `DELETE`, reset tabel, `INSERT OR REPLACE`, seed, atau perubahan skema.

## Dampak sesi dan pemulihan

Gateway memeriksa `X-Device-ID` terhadap baris `devices` pada setiap route pengguna. Sesudah perubahan perangkat mahasiswa, request yang tetap mengirim `DEV-MHS-01`, `DEV-MHS-02`, atau `DEV-MHS-03` akan ditolak sebagai perangkat tidak terdaftar. Login berikutnya harus memakai device ID target di tabel ini. Migrasi tidak mengubah refresh token, tidak mengubah JWT, dan tidak secara kriptografis mencabut access token yang telah diterbitkan; sistem saat ini juga tidak mengikat klaim JWT ke device. Karena itu, pengguna sebaiknya login ulang dengan header device baru setelah migrasi.

Pemulihan tidak dijalankan otomatis oleh skrip dan bukan bagian dari prosedur migrasi normal. Jika pemulihan perlu dilakukan, tetap hentikan semua service, buat backup insiden baru dengan API online backup terlebih dahulu, lalu hasilkan kandidat database dari backup tervalidasi dengan API backup SQLite, periksa integritas dan foreign key kandidat, dan lakukan penggantian database hanya dalam jendela pemeliharaan yang disetujui. Jangan menyalin atau menghapus berkas WAL/SHM secara manual. Setelah penggantian, jalankan `--check` sebelum service dihidupkan kembali.

Database dan file backup di bawah `data/` adalah lokal serta diabaikan Git. Tidak ada password, hash, token, atau secret yang dicetak oleh skrip.
