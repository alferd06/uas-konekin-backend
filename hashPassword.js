const bcrypt = require('bcryptjs');

async function hashMyPassword() {
  const passwordToHash = 'password123'; // Ganti ini
  const salt = await bcrypt.genSalt(10);
  const hash = await bcrypt.hash(passwordToHash, salt);
  console.log("Password Hash:", hash);
}

hashMyPassword();