require('dotenv').config();

const express = require('express');
const path = require('path'); // Modul Node.js untuk menangani path file
const multer = require('multer'); // Impor multer
const { Pool } = require('pg');
const cors = require('cors'); 
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');

const app = express();

// --- PORT CONFIGURATION ---
const rawPort = process.env.PORT; // Ambil port mentah (string)
console.log(`Raw process.env.PORT: ${rawPort} (Type: ${typeof rawPort})`); // Log 1

const parsedPort = parseInt(rawPort, 10); // Coba parse
console.log(`Parsed port: ${parsedPort} (Type: ${typeof parsedPort})`); // Log 2

const port = parsedPort || 3001; // Fallback ke 3001 jika NaN
console.log(`Final port value: ${port} (Type: ${typeof port})`); // Log 3
// ----------------------------

// middleware
app.use(express.json());
app.use(cors());

const pool = new Pool({
    user: 'postgres',
    host: 'ballast.proxy.rlwy.net',
    database: 'railway',
    password: 'HGpxsvjvmDpuWqxwHleIuAojuzirycuH',
    port: 48994,
});

// --- MIDDLEWARE OTENTIKASI BARU ---
function authMiddleware(req, res, next) {
  // 1. Ambil token dari header 'Authorization'
  //    Formatnya: "Bearer <token>"
  const authHeader = req.header('Authorization');
  const token = authHeader && authHeader.split(' ')[1]; // Ambil bagian token saja

  // 2. Jika tidak ada token, tolak akses
  if (!token) {
    return res.status(401).json({ error: 'Akses ditolak. Tidak ada token.' });
  }

  try {
    // 3. Verifikasi token
    //    'jwt.verify' akan error jika token tidak valid atau kedaluwarsa
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // 4. Jika valid, tempelkan payload (info user) ke req.user
    //    Ini agar rute selanjutnya bisa tahu siapa yang membuat request
    req.user = decoded.user; 

    // 5. Lanjutkan ke middleware/rute berikutnya
    next(); 

  } catch (err) {
    // 6. Jika token tidak valid
    console.error("Token tidak valid:", err.message);
    res.status(401).json({ error: 'Token tidak valid.' });
  }
}

const resumeStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    // Simpan di folder 'uploads/resumes' relatif terhadap server.js
    // Pastikan Anda membuat folder 'uploads' dan 'resumes' di proyek backend Anda
    cb(null, path.join(__dirname, 'uploads', 'resumes'));
  },
  filename: function (req, file, cb) {
    // Buat nama file unik: userId-timestamp-originalname
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const userId = req.user?.id || 'unknown'; // Ambil userId dari token jika ada
    cb(null, `${userId}-${uniqueSuffix}-${file.originalname}`);
  }
});

// Middleware multer untuk HANYA menerima 1 file dengan nama field 'resumeFile'
const uploadResume = multer({
   storage: resumeStorage,
   // Tambahkan limits atau fileFilter di sini jika perlu (misal, hanya PDF max 5MB)
   // limits: { fileSize: 5 * 1024 * 1024 }, // Contoh limit 5MB
   // fileFilter: function(req, file, cb){ ... cb(null, true/false) ... }
}).single('resumeFile'); // 'resumeFile' HARUS sama dengan nama <input type="file"> di frontend

// --- AKHIR Konfigurasi Multer ---




// --- AKHIR MIDDLEWARE ---

// --- MODIFIKASI Rute PUT /api/profile ---
// Tambahkan 'uploadResume' sebagai middleware KEDUA (setelah authMiddleware)
app.put('/api/profile', authMiddleware, uploadResume, async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;

    let queryText;
    let values;

    if (userRole === 'seeker') {
      // req.body sekarang berisi field teks dari FormData
      const { bio, skills: skillsString, expected_salary, disability_info } = req.body;

      // req.file berisi info file yang diupload (jika ada) dari multer
      const resume_filename = req.file ? req.file.filename : null;

      // --- PERUBAHAN DI SINI ---
      // Ubah string skills (yang dipisah koma) menjadi array JavaScript
      // Tangani juga jika stringnya kosong atau tidak ada
      const skillsArray = skillsString ? skillsString.split(',').map(s => s.trim()).filter(s => s) : [];
      // --------------------------

      // --- Query UPSERT Diupdate ---
      // Kita HANYA update resume_filename jika file baru diupload
      // COALESCE(kolom_baru, kolom_lama) akan memakai nilai baru jika tidak null, jika null pakai nilai lama
      queryText = `
        INSERT INTO user_profiles (user_id, bio, skills, expected_salary, disability_info, resume_filename)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (user_id)
        DO UPDATE SET
          bio = EXCLUDED.bio,
          skills = EXCLUDED.skills,
          expected_salary = EXCLUDED.expected_salary,
          disability_info = EXCLUDED.disability_info,
          resume_filename = COALESCE($6, user_profiles.resume_filename) -- Update hanya jika $6 (filename baru) tidak NULL
        RETURNING *;
      `;
      // --- PERUBAHAN DI SINI ---
      // Gunakan 'skillsArray' (array JS) di posisi $3
      values = [userId, bio, skillsArray, expected_salary, disability_info, resume_filename];
      // --------------------------

    } else if (userRole === 'recruiter') {
      // --- Logika untuk Recruiter (TETAP SAMA, tidak ada upload file di sini) ---
      const { company_name, company_description, company_website } = req.body;
      queryText = `
        INSERT INTO company_profiles (recruiter_user_id, company_name, company_description, company_website)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (recruiter_user_id)
        DO UPDATE SET /* ... update fields ... */
        RETURNING *;
      `;
      values = [userId, company_name, company_description, company_website];
      // -------------------------------------------------------------------
    } else {
      return res.status(403).json({ error: "Admin tidak bisa mengupdate profil." });
    }

    const result = await pool.query(queryText, values);
    res.json(result.rows[0]);

  } catch (err) {
    console.error("Error updating profile:", err.message); // Log error lebih detail
    // Hapus file yang mungkin terupload jika query DB gagal
    if (req.file) {
       const fs = require('fs');
       fs.unlink(req.file.path, (unlinkErr) => {
          if (unlinkErr) console.error("Error deleting uploaded file after DB error:", unlinkErr);
       });
    }
    res.status(500).json({ error: "Gagal mengupdate profil" });
  }
});

app.get('/api/mahasiswa', async (req, res) => {
    console.log("Fungsi api berjalan");

    try {
        const result = await pool.query('Select * from mahasiswa')

        res.json(result.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Gagal mengambil data dari database' });
    }
})

app.post('/api/mahasiswa', async (req, res) => {
    try{
        const { nama, npm } = req.body;

        const queryText = `INSERT INTO mahasiswa(nama, npm) VALUES($1, $2) returning *`;

        const values = [nama, npm]; 

        const result =  await pool.query(queryText, values);

        res.status(201).json(result.rows[0]);
    } catch (err){
        console.error(err.message);
        res.status(500).json({ error: 'Gagal memasukkan data'});
    }
})

app.delete('/api/mahasiswa/:id', async (req, res) => {
    try{
        const { id } = req.params;

        const queryText = 'Delete from mahasiswa where id = $1 returning *';

        const result = await pool.query(queryText, [id]);

        if(result.rows.length === 0){
            return res.status(404).json({error: 'Mahasiswa tidak ditemukan'});
        }

        res.status(200).json(result.rows[0]);
    } catch(err) {
        console.error(err.message);
        res.status(500).json({ error: "Gagal menghapus data" });
    }
}) 

// --- 2. Tambahkan Rute Registrasi BARU ---
// MODUL OTENTIKASI: Registrasi User Baru
app.post('/api/auth/register', async (req, res) => {
  // Kita pakai try...catch untuk menangkap semua error
  try {
    // 1. Ambil data dari body (pastikan app.use(express.json()) ada)
    const { full_name, email, password, role } = req.body;

    // 2. Validasi input sederhana
    if (!full_name || !email || !password || !role) {
      return res.status(400).json({ error: "Semua field wajib diisi (full_name, email, password, role)" });
    }
    
    // Validasi role (sesuai ENUM di database Anda)
    if (role !== 'seeker' && role !== 'recruiter') {
      return res.status(400).json({ error: "Role tidak valid. Pilih 'seeker' atau 'recruiter'." });
      // Kita tidak mengizinkan orang mendaftar sebagai 'admin'
    }

    // 3. Hash password (Langkah Keamanan WAJIB)
    //    'genSalt(10)' adalah "biaya" hashing. Angka 10 sudah standar.
    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);

    // 4. Masukkan user baru ke database
    //    Kita pakai RETURNING * agar Postgres mengembalikan data user yg baru dibuat
    const queryText = `
      INSERT INTO users (full_name, email, password_hash, role)
      VALUES ($1, $2, $3, $4)
      RETURNING id, full_name, email, role, created_at
    `;
    const values = [full_name, email, password_hash, role];

    const result = await pool.query(queryText, values);
    const newUser = result.rows[0];

    // 5. Kirim balasan sukses (Status 201 = Created)
    res.status(201).json(newUser);

  } catch (err) {
    // 6. Tangani Error
    console.error(err.message);
    
    // Cek jika error-nya adalah "email sudah ada"
    // Kode '23505' adalah kode error 'unique_violation' dari Postgres
    if (err.code === '23505') {
      return res.status(400).json({ error: "Email sudah terdaftar." });
    }

    // Error server lainnya
    res.status(500).json({ error: "Terjadi kesalahan pada server" });
  }
});

// MODUL OTENTIKASI: Login User
app.post('/api/auth/login', async (req, res) => {
  try {
    // 1. Ambil email dan password dari body
    const { email, password } = req.body;

    // 2. Validasi input
    if (!email || !password) {
      return res.status(400).json({ error: "Email dan password wajib diisi." });
    }

    // 3. Cek apakah user ada di database
    const queryText = 'SELECT * FROM users WHERE email = $1';
    const result = await pool.query(queryText, [email]);

    if (result.rows.length === 0) {
      // JANGAN bilang "user tidak ditemukan".
      // Untuk keamanan, gunakan pesan yang ambigu.
      return res.status(401).json({ error: "Email atau password salah." });
    }

    const user = result.rows[0];

    // 4. Bandingkan password (Langkah Keamanan Kunci)
    //    bcrypt.compare() akan membandingkan 'password' mentah dari klien
    //    dengan 'user.password_hash' yang ada di database.
    const isMatch = await bcrypt.compare(password, user.password_hash);

    if (!isMatch) {
      // Password tidak cocok
      return res.status(401).json({ error: "Email atau password salah." });
    }

    // 5. JIKA BERHASIL: Buat "Kunci" (JWT Token)
    //    Kita masukkan data PENTING (tapi tidak rahasia) ke dalam token.
    //    Ini disebut "Payload".
    const payload = {
      user: {
        id: user.id,
        role: user.role
        // Jangan pernah masukkan password di sini!
      }
    };

    // 6. Tandatangani token-nya
    //    Kita gunakan Kunci Rahasia dari .env
    //    Kita set token ini kedaluwarsa dalam '1h' (1 jam)
    jwt.sign(
      payload,
      process.env.JWT_SECRET,
      { expiresIn: '1h' }, // atau '7d' (7 hari) untuk UAS
      (err, token) => {
        if (err) throw err;
        
        // 7. Kirim balasan sukses (Token-nya)
        res.status(200).json({
          message: "Login berhasil!",
          token: token // Ini adalah "tiket" yang akan dipakai React
        });
      }
    );

  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Terjadi kesalahan pada server" });
  }
});

// --- RUTE TERPROTEKSI PERTAMA ---
// MODUL OTENTIKASI: Mendapatkan data user yang sedang login
// Perhatikan 'authMiddleware' DITARUH DI TENGAH!
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  // Karena 'authMiddleware' sudah berjalan SEBELUM fungsi ini,
  // kita DIJAMIN sudah punya 'req.user' jika sampai di sini.
  try {
    // Kita bisa ambil ID user dari req.user yang sudah ditempel middleware
    const userId = req.user.id; 

    // (Opsional tapi bagus) Ambil data user lengkap dari DB (kecuali password)
    // Ini memastikan data selalu terbaru jika user ganti nama, dll.
    const queryText = 'SELECT id, full_name, email, role, created_at FROM users WHERE id = $1';
    const result = await pool.query(queryText, [userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User tidak ditemukan." });
    }

    // Kirim data user yang sedang login
    res.json(result.rows[0]);

  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Terjadi kesalahan pada server" });
  }
});




// --- MODUL PROFIL ---

// 1. RUTE: Mengambil Profil Milik User yang Login
//    Hanya user yang sudah login (punya token valid) yang bisa akses
app.get('/api/profile', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id; // ID user didapat dari token via middleware
    const userRole = req.user.role; // Role user juga didapat dari token

    let profileData;
    let queryText;

    // Bedakan query berdasarkan role
    if (userRole === 'seeker') {
      queryText = `
        SELECT u.id, u.full_name, u.email, u.role, p.bio, p.skills, p.resume_filename, p.expected_salary, p.disability_info 
        FROM users u 
        LEFT JOIN user_profiles p ON u.id = p.user_id 
        WHERE u.id = $1
      `;
    } else if (userRole === 'recruiter') {
      queryText = `
        SELECT u.id, u.full_name, u.email, u.role, c.id as company_id, c.company_name, c.company_description, c.company_website 
        FROM users u 
        LEFT JOIN company_profiles c ON u.id = c.recruiter_user_id 
        WHERE u.id = $1
      `;
      // Note: LEFT JOIN dipakai agar user tetap dapat data walau profil belum diisi
    } else {
      // Admin tidak punya profil spesifik di sini
      return res.status(403).json({ error: "Admin tidak memiliki profil di endpoint ini" });
    }

    const result = await pool.query(queryText, [userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Profil user tidak ditemukan." });
    }

    profileData = result.rows[0];
    res.json(profileData);

  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Terjadi kesalahan pada server" });
  }
});


// 2. RUTE: Mengupdate Profil Milik User yang Login
app.put('/api/profile', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;

    let queryText;
    let values;
    let profileFields;

    if (userRole === 'seeker') {
      // Ambil field yang BOLEH diupdate seeker dari req.body
      const { bio, skills, resume_filename, expected_salary, disability_info } = req.body;
      profileFields = { bio, skills, resume_filename, expected_salary, disability_info };

      // Query UPSERT: Jika profil sudah ada, UPDATE. Jika belum, INSERT.
      // ON CONFLICT(user_id) DO UPDATE ...
      queryText = `
        INSERT INTO user_profiles (user_id, bio, skills, resume_filename, expected_salary, disability_info)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (user_id) 
        DO UPDATE SET 
          bio = EXCLUDED.bio, 
          skills = EXCLUDED.skills, 
          resume_filename = EXCLUDED.resume_filename, 
          expected_salary = EXCLUDED.expected_salary, 
          disability_info = EXCLUDED.disability_info
        RETURNING *; 
      `;
      values = [userId, bio, skills, resume_filename, expected_salary, disability_info];

    } else if (userRole === 'recruiter') {
      // Ambil field yang BOLEH diupdate recruiter
      const { company_name, company_description, company_website } = req.body;
       profileFields = { company_name, company_description, company_website };

      // Query UPSERT untuk company_profiles
       queryText = `
        INSERT INTO company_profiles (recruiter_user_id, company_name, company_description, company_website)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (recruiter_user_id) 
        DO UPDATE SET 
          company_name = EXCLUDED.company_name, 
          company_description = EXCLUDED.company_description, 
          company_website = EXCLUDED.company_website
        RETURNING *;
      `;
       values = [userId, company_name, company_description, company_website];

    } else {
      return res.status(403).json({ error: "Admin tidak bisa mengupdate profil di endpoint ini" });
    }

    // Jalankan query
    const result = await pool.query(queryText, values);
    res.json(result.rows[0]); // Kirim profil yang sudah terupdate/terbuat

  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Gagal mengupdate profil" });
  }
});

// --- MODUL LOWONGAN PEKERJAAN ---

// 1. RUTE: Membuat Loker Baru (Hanya Recruiter)
app.post('/api/jobs', authMiddleware, async (req, res) => {
  // Lapisan Keamanan 2: Cek Role setelah token valid
  if (req.user.role !== 'recruiter') {
    return res.status(403).json({ error: "Akses ditolak. Hanya recruiter yang bisa membuat loker." });
  }

  try {
    const recruiterUserId = req.user.id; 
    const { title, description, location, salary_range } = req.body;

    // Validasi input
    if (!title || !description) {
      return res.status(400).json({ error: "Judul dan deskripsi loker wajib diisi." });
    }

    // Cari dulu company_id si recruiter
    const companyResult = await pool.query('SELECT id FROM company_profiles WHERE recruiter_user_id = $1', [recruiterUserId]);
    if (companyResult.rows.length === 0) {
      return res.status(400).json({ error: "Profil perusahaan belum lengkap. Silakan lengkapi profil Anda." });
    }
    const companyId = companyResult.rows[0].id;

    // Buat loker baru
    const queryText = `
      INSERT INTO job_postings (company_id, title, description, location, salary_range)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `;
    const values = [companyId, title, description, location, salary_range];

    const result = await pool.query(queryText, values);
    res.status(201).json(result.rows[0]);

  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Gagal membuat loker" });
  }
});


// 2. RUTE: Menampilkan Semua Loker Aktif (Untuk Seeker)
app.get('/api/jobs', authMiddleware, async (req, res) => {
  // Cek Role (Opsional, tapi bagus untuk memastikan hanya seeker yang lihat ini)
  if (req.user.role !== 'seeker') {
     return res.status(403).json({ error: "Akses ditolak. Endpoint ini hanya untuk seeker." });
  }
  
  try {
    // Ambil semua loker yang aktif, dan join dengan nama perusahaan
    const queryText = `
      SELECT j.*, c.company_name 
      FROM job_postings j
      JOIN company_profiles c ON j.company_id = c.id
      WHERE j.is_active = true
      ORDER BY j.created_at DESC 
    `;
    // Kita tidak pakai $1 karena tidak ada input dinamis
    const result = await pool.query(queryText); 
    
    res.json(result.rows);

  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Gagal mengambil data loker" });
  }
});

// --- MODUL LAMARAN (Applications) ---

// RUTE: Menampilkan SEMUA lamaran milik seeker yang sedang login
app.get('/api/applications/seeker', authMiddleware, async (req, res) => {
  // Hanya seeker yang boleh akses
  if (req.user.role !== 'seeker') {
    return res.status(403).json({ error: "Akses ditolak." });
  }

  try {
    const seekerId = req.user.id;

    // Query dengan JOIN ke job_postings dan company_profiles
    const queryText = `
      SELECT 
        a.id,                 -- ID lamaran
        a.status,             -- Status lamaran ('pending', 'accepted', etc.)
        a.applied_at,         -- Tanggal melamar
        j.title AS job_title, -- Judul pekerjaan dari tabel job_postings
        c.company_name        -- Nama perusahaan dari tabel company_profiles
      FROM 
        job_applications a    -- Alias 'a' untuk applications
      JOIN 
        job_postings j ON a.job_id = j.id -- Join ke jobs berdasarkan job_id
      JOIN 
        company_profiles c ON j.company_id = c.id -- Join ke companies berdasarkan company_id
      WHERE 
        a.seeker_id = $1      -- Filter hanya lamaran milik seeker ini
      ORDER BY 
        a.applied_at DESC;    -- Urutkan dari yang terbaru
    `;

    const result = await pool.query(queryText, [seekerId]);

    res.json(result.rows); // Kirim hasilnya (array lamaran)

  } catch (err) {
    console.error("Error fetching seeker applications:", err.message);
    res.status(500).json({ error: "Gagal mengambil data lamaran" });
  }
});

// RUTE: Recruiter melihat SEMUA pelamar untuk SATU lowongan miliknya
app.get('/api/applications/recruiter/:jobId', authMiddleware, async (req, res) => {
  if (req.user.role !== 'recruiter') {
    return res.status(403).json({ error: "Akses ditolak." });
  }
  try {
    const { jobId } = req.params;
    const recruiterUserId = req.user.id;

    // Query untuk mengambil pelamar + info seeker, TAPI pastikan job ini milik si recruiter
    const queryText = `
      SELECT 
        a.id AS application_id, a.status, a.applied_at, a.cover_letter,
        u.id AS seeker_id, u.full_name AS seeker_name, u.email AS seeker_email,
        p.skills, p.resume_filename, p.expected_salary, p.disability_info, p.bio
      FROM job_applications a
      JOIN users u ON a.seeker_id = u.id
      LEFT JOIN user_profiles p ON u.id = p.user_id
      JOIN job_postings j ON a.job_id = j.id
      JOIN company_profiles c ON j.company_id = c.id 
      WHERE a.job_id = $1 AND c.recruiter_user_id = $2 
      ORDER BY a.applied_at ASC;
    `;
    
    const result = await pool.query(queryText, [jobId, recruiterUserId]);
    
    // Jika tidak ada job milik recruiter / tidak ada pelamar, hasilnya array kosong (itu OK)
    res.json(result.rows);

  } catch (err) {
    console.error("Error fetching recruiter applications:", err.message);
    res.status(500).json({ error: "Gagal mengambil data pelamar" });
  }
});


// RUTE: Recruiter menyetujui (ke admin) atau menolak lamaran
app.put('/api/applications/:appId/review', authMiddleware, async (req, res) => {
   if (req.user.role !== 'recruiter') {
    return res.status(403).json({ error: "Akses ditolak." });
  }
  try {
    const { appId } = req.params;
    const { new_status } = req.body; // Harusnya 'admin_review' or 'rejected'
    const recruiterUserId = req.user.id;

    if (new_status !== 'admin_review' && new_status !== 'rejected') {
        return res.status(400).json({ error: "Status baru tidak valid." });
    }

    // Update status HANYA JIKA lamaran ini milik job yang diposting oleh recruiter ini
    const queryText = `
      UPDATE job_applications
      SET status = $1
      WHERE id = $2 
      AND job_id IN (
        SELECT j.id FROM job_postings j
        JOIN company_profiles c ON j.company_id = c.id
        WHERE c.recruiter_user_id = $3
      )
      RETURNING *;
    `;
    
    const result = await pool.query(queryText, [new_status, appId, recruiterUserId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Lamaran tidak ditemukan atau Anda tidak berhak mengubahnya." });
    }

    res.json(result.rows[0]); // Kirim lamaran yang sudah diupdate

  } catch (err) {
     console.error("Error updating application status by recruiter:", err.message);
     res.status(500).json({ error: "Gagal mengupdate status lamaran" });
  }
});

// --- MODUL ADMIN ---

// RUTE: Admin melihat SEMUA lamaran yang butuh persetujuan final
app.get('/api/applications/admin', authMiddleware, async (req, res) => {
   if (req.user.role !== 'admin') { // Hanya Admin
    return res.status(403).json({ error: "Akses ditolak." });
  }
  try {
    // Ambil semua lamaran berstatus 'admin_review', join info lengkap
     const queryText = `
      SELECT 
        a.id AS application_id, a.status, a.applied_at,
        j.title AS job_title, 
        c.company_name,
        u.full_name AS seeker_name,
        u.email AS seeker_email
      FROM job_applications a
      JOIN job_postings j ON a.job_id = j.id
      JOIN company_profiles c ON j.company_id = c.id
      JOIN users u ON a.seeker_id = u.id
      WHERE a.status = 'admin_review'
      ORDER BY a.applied_at ASC;
    `;
    const result = await pool.query(queryText);
    res.json(result.rows);
  } catch (err) {
     console.error("Error fetching admin review applications:", err.message);
     res.status(500).json({ error: "Gagal mengambil data lamaran untuk admin" });
  }
});

// RUTE: Admin memberi persetujuan final (Accepted / Rejected)
app.put('/api/applications/:appId/finalize', authMiddleware, async (req, res) => {
   if (req.user.role !== 'admin') {
    return res.status(403).json({ error: "Akses ditolak." });
  }
  try {
    const { appId } = req.params;
    const { new_status } = req.body; // Harusnya 'accepted' or 'rejected'

     if (new_status !== 'accepted' && new_status !== 'rejected') {
        return res.status(400).json({ error: "Status final tidak valid." });
    }

    // Update statusnya (hanya jika status sebelumnya adalah 'admin_review')
    const queryText = `
      UPDATE job_applications
      SET status = $1
      WHERE id = $2 AND status = 'admin_review'
      RETURNING *;
    `;
    const result = await pool.query(queryText, [new_status, appId]);

     if (result.rows.length === 0) {
      return res.status(404).json({ error: "Lamaran tidak ditemukan atau statusnya bukan 'admin_review'." });
    }

    // TODO (Opsional): Kirim notifikasi email ke seeker di sini

    res.json(result.rows[0]);

  } catch (err) {
     console.error("Error finalizing application status by admin:", err.message);
     res.status(500).json({ error: "Gagal memfinalisasi status lamaran" });
  }
});

// --- Tambahan: Rute Recruiter melihat lokernya sendiri ---
app.get('/api/jobs/my-company', authMiddleware, async (req, res) => {
  if (req.user.role !== 'recruiter') {
    return res.status(403).json({ error: "Akses ditolak." });
  }
  try {
    const recruiterUserId = req.user.id;
    // Cari company_id si recruiter
    const companyResult = await pool.query('SELECT id FROM company_profiles WHERE recruiter_user_id = $1', [recruiterUserId]);
    if (companyResult.rows.length === 0) {
      return res.json([]); // Belum punya profil perusahaan, return array kosong
    }
    const companyId = companyResult.rows[0].id;

    // Ambil semua loker milik companyId ini
    const queryText = 'SELECT * FROM job_postings WHERE company_id = $1 ORDER BY created_at DESC';
    const result = await pool.query(queryText, [companyId]);
    res.json(result.rows);

  } catch (err) {
    console.error("Error fetching recruiter jobs:", err.message);
    res.status(500).json({ error: "Gagal mengambil data loker perusahaan" });
  }
});

// RUTE: Seeker melamar pekerjaan
app.post('/api/jobs/:jobId/apply', authMiddleware, async (req, res) => {
  if (req.user.role !== 'seeker') {
    return res.status(403).json({ error: "Hanya seeker yang bisa melamar." });
  }
  try {
    const { jobId } = req.params; // Ambil jobId dari URL
    const seekerId = req.user.id; // Ambil seekerId dari token

    // (Opsional: Cek jika seeker sudah pernah melamar job ini)
    const checkQuery = 'SELECT id FROM job_applications WHERE job_id = $1 AND seeker_id = $2';
    const checkResult = await pool.query(checkQuery, [jobId, seekerId]);
    if (checkResult.rows.length > 0) {
        return res.status(400).json({ error: "Anda sudah melamar pekerjaan ini." });
    }

    // Ambil cover_letter JIKA ADA, jika tidak, set ke null atau string kosong
    const cover_letter = req.body?.cover_letter || null; // '?' (optional chaining) + default null

    // Query INSERT tetap sama, tapi values disesuaikan
    const queryText = `
      INSERT INTO job_applications (job_id, seeker_id, cover_letter, status)
      VALUES ($1, $2, $3, 'pending')
      RETURNING id, status, applied_at
    `;
    // Pastikan urutan values cocok dengan $1, $2, $3
    const values = [jobId, seekerId, cover_letter];
    
    const result = await pool.query(queryText, values);

    res.status(201).json(result.rows[0]); // Kirim balasan sukses (lamaran baru)

  } catch (err) {
    console.error("Error applying for job:", err.message);
    // Cek jika error karena job tidak ditemukan (foreign key violation)
    if (err.code === '23503') { // Kode error foreign key violation postgres
         return res.status(404).json({ error: "Lowongan pekerjaan tidak ditemukan." });
    }
    res.status(500).json({ error: "Gagal memproses lamaran" });
  }
});

// --- Rute BARU untuk Mengakses/Download Resume ---
// --- Rute Untuk Mengakses/Download Resume (Tanpa Auth Middleware) ---
app.get('/api/resumes/:filename', (req, res) => {
  try {
    const filename = req.params.filename;

    // Validasi sederhana untuk mencegah path traversal (../)
    if (filename.includes('..')) {
      return res.status(400).send('Nama file tidak valid.');
    }

    // Buat path absolut ke file di folder uploads/resumes
    const filePath = path.join(__dirname, 'uploads', 'resumes', filename);

    // Cek apakah file benar-benar ada sebelum mengirim
    fs.access(filePath, fs.constants.R_OK, (err) => {
      if (err) {
        // Jika error (termasuk file tidak ada atau tidak bisa dibaca)
        console.error("Error accessing file:", err);
        return res.status(404).send('File tidak ditemukan atau tidak bisa diakses.');
      }

      // Kirim file sebagai response
      // res.sendFile akan otomatis mengatur Content-Type berdasarkan ekstensi file
      res.sendFile(filePath, (sendFileErr) => {
        if (sendFileErr) {
          console.error("Error sending file:", sendFileErr);
          // Hindari mengirim error detail ke klien
          res.status(500).send('Gagal mengirim file.');
        } else {
          console.log(`File sent: ${filename}`);
        }
      });
    });

  } catch (error) {
      // Menangkap error tak terduga lainnya
      console.error("Unexpected error in /api/resumes route:", error);
      res.status(500).send('Terjadi kesalahan pada server.');
  }
});
// --- AKHIR Rute Resume ---

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

