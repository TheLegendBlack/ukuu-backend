const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.send('API Gestion Locative en ligne !');
});

// 📦 ROUTES
app.use('/auth', require('./routes/auth'));
app.use('/users', require('./routes/users'));
app.use('/properties', require('./routes/properties'));
app.use('/supervisions', require('./routes/supervisions'));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`);
});

