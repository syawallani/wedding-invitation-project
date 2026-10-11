# Setup QR undangan dan check-in

Integrasi ini menggunakan token acak pada QR, Supabase Edge Function untuk lookup/RSVP/check-in, dan login Supabase Auth untuk petugas. `service_role` hanya dipakai di runtime Edge Function; jangan masukkan key itu ke HTML.

## 1. Jalankan skema

Di Supabase Dashboard, buka **SQL Editor**, lalu jalankan seluruh isi `supabase-schema.sql`. Skema membuat tabel `guest_invitations` privat dan `checkin_staff`, mengunci insert anonim pada tabel RSVP lama, serta menambahkan RPC check-in atomik.

## 2. Deploy Edge Function

Prasyarat: pasang Supabase CLI dan login dengan akun pemilik proyek.

```powershell
supabase login
supabase link --project-ref lgsbtyquphlvoahlntsq
supabase secrets set ALLOWED_ORIGINS="https://domain-undangan-anda.com,https://www.domain-undangan-anda.com"
supabase functions deploy guest-access
```

Ganti domain dengan origin persis yang digunakan situs. Untuk uji lokal, tambahkan origin localhost, misalnya `http://localhost:5500`. Jangan tambahkan garis miring path. Supabase menyediakan URL dan key service role di lingkungan Edge Function; jangan mengirimkannya ke browser.

## 3. Buat QR dan impor tamu

1. Buka `generate-guest-qrs.html` secara lokal atau melalui localhost. Jangan unggah generator ini ke situs publik; ini alat privat untuk membuat token dan tautan tamu.
2. Masukkan URL publik `index.html`, lalu satu nama per baris. Format keluarga: `Nama Keluarga; jumlah maksimal`.
3. Pilih **Buat QR**. Cetak kartu QR dan unduh kedua CSV.
4. Simpan `guest-invitation-links-private.csv` secara privat; isinya adalah tautan bearer yang dapat digunakan pemegangnya.
5. Di Supabase **Table Editor → guest_invitations → Import data from CSV**, impor `guest-invitations-import.csv`. CSV database hanya berisi nama, batas tamu, dan hash token. Kolom lain memakai nilai default.
6. Kirim tautan/QR yang sesuai kepada masing-masing tamu.

Buat ulang CSV/QR bila daftar tamu berubah. Jangan membuat QR ulang untuk tamu yang sudah menerima link, karena hash token baru tidak akan cocok dengan link lama.

## 4. Buat akun petugas

1. Di Supabase **Authentication → Users**, undang atau buat akun email/password untuk setiap petugas. Matikan pendaftaran publik jika tidak diperlukan.
2. Salin UUID user petugas, lalu jalankan SQL berikut melalui SQL Editor:

```sql
insert into public.checkin_staff (user_id)
values ('UUID-PETUGAS-DARI-AUTH')
on conflict (user_id) do nothing;
```

3. Deploy `checkin.html` pada origin yang sama dengan undangan. Petugas login, scan QR, cocokkan nama/jumlah, lalu tekan **Konfirmasi check-in**. Kamera memerlukan HTTPS atau localhost; tersedia input token manual sebagai cadangan.

Menghapus user dari `checkin_staff` langsung mencabut hak check-in. Menghapus akun Auth juga menghapus entri staff terkait.

## 5. Cara kerja token

Token 256-bit berada di URL QR. Edge Function menghitung SHA-256 lalu mencari hash di `guest_invitations`. Nama, RSVP, dan check-in tidak bisa dibaca langsung lewat REST publik. RSVP mengubah baris undangan yang sama; check-in memerlukan sesi Auth dan UUID petugas yang terdaftar. Check-in grup mencatat seluruh jumlah RSVP sekaligus dan menolak scan kedua.

`verify_jwt = false` diperlukan pada konfigurasi function karena lookup/RSVP publik memakai token undangan, bukan akun Auth. Aksi `checkin` tetap memeriksa access token Auth dan keanggotaan `checkin_staff` di dalam function.
