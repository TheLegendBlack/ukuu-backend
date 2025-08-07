const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const SALT_ROUNDS = 10;
const JWT_SECRET = process.env.JWT_SECRET || 'secret_key_dev';

// 🔐 Inscription utilisateur
router.post('/register', async (req, res) => {
  const { firstName, lastName, phoneNumber, password } = req.body;

  if (!firstName || !lastName || !phoneNumber || !password) {
    return res.status(400).json({ error: 'Champs requis manquants.' });
  }

  try {
    const existing = await prisma.user.findUnique({ where: { phoneNumber } });
    if (existing) {
      return res.status(409).json({ error: 'Numéro déjà enregistré.' });
    }

    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

    const user = await prisma.user.create({
      data: {
        firstName,
        lastName,
        phoneNumber,
        verified: false, // ✅ à changer plus tard si SMS réel
        bio: '',
        roles: {
          create: {
            role: 'guest',
            active: true
          }
        },
        documents: {
          create: []
        },
        password: hashedPassword, // 👈 tu dois ajouter ce champ dans le modèle `User`
      }
    });

    return res.status(201).json({ message: 'Utilisateur créé avec succès.', user: { id: user.id, phoneNumber: user.phoneNumber } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// 🔐 Connexion utilisateur
router.post('/login', async (req, res) => {
  const { phoneNumber, password } = req.body;

  if (!phoneNumber || !password) {
    return res.status(400).json({ error: 'Téléphone et mot de passe requis.' });
  }

  try {
    const user = await prisma.user.findUnique({ where: { phoneNumber } });
    if (!user) return res.status(404).json({ error: 'Utilisateur non trouvé.' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Mot de passe incorrect.' });

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });

    res.json({ message: 'Connexion réussie', token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

module.exports = router;
