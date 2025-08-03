const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'secret_key_dev';

// 🔐 Middleware pour sécuriser les routes avec JWT
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Format: Bearer <token>

  if (!token) return res.sendStatus(401); // Non autorisé

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.sendStatus(403); // Token invalide

    req.user = decoded; // { userId: ... }
    next();
  });
}

// ✅ Route sécurisée pour obtenir son propre profil
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      include: {
        roles: true,
        documents: true
      }
    });

    if (!user) return res.status(404).json({ error: 'Utilisateur non trouvé.' });

    res.json({
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      phoneNumber: user.phoneNumber,
      verified: user.verified,
      roles: user.roles.map(r => r.role),
      documents: user.documents
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

module.exports = router;
