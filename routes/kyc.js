const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'secret_key_dev';

// --- Auth middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token manquant.' });

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Token invalide.' });
    req.user = decoded; // { userId: ... }
    next();
  });
}

// --- Role middleware
function authorizeRoles(...allowedRoles) {
  return async (req, res, next) => {
    try {
      const roles = await prisma.userRoleOnUser.findMany({
        where: { userId: req.user.userId, active: true },
        select: { role: true }
      });
      const userRoles = roles.map(r => r.role);
      const ok = userRoles.some(r => allowedRoles.includes(r));
      if (!ok) return res.status(403).json({ error: 'Accès interdit. Rôle insuffisant.' });
      next();
    } catch (err) {
      console.error('Erreur autorisation rôle :', err);
      res.status(500).json({ error: 'Erreur serveur.' });
    }
  };
}

const isAdmin = authorizeRoles('admin');

// ---------------------------
// 👤 Utilisateur : soumettre KYC
// POST /kyc/submit
// body: { documentUrls: ["https://...","https://..."], note?: "..." }
router.post('/submit', authenticateToken, async (req, res) => {
  const { documentUrls, note } = req.body;

  if (!Array.isArray(documentUrls) || documentUrls.length === 0) {
    return res.status(400).json({ error: 'Au moins un document est requis.' });
  }

  try {
    // Option : empêcher les doublons "pending"
    const existingPending = await prisma.kycVerification.findFirst({
      where: { userId: req.user.userId, status: 'pending' }
    });
    if (existingPending) {
      return res.status(409).json({ error: 'Une demande KYC est déjà en attente.' });
    }

    const kyc = await prisma.kycVerification.create({
      data: {
        userId: req.user.userId,
        documentUrls,
        note: note || null
      }
    });

    res.status(201).json({ message: 'KYC soumis.', kyc });
  } catch (err) {
    console.error('Erreur POST /kyc/submit :', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// 👤 Utilisateur : voir ma dernière demande KYC
// GET /kyc/mine
router.get('/mine', authenticateToken, async (req, res) => {
  try {
    const last = await prisma.kycVerification.findFirst({
      where: { userId: req.user.userId },
      orderBy: { createdAt: 'desc' }
    });
    res.json(last || null);
  } catch (err) {
    console.error('Erreur GET /kyc/mine :', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// 🛡️ Admin : lister les KYC en attente
// GET /kyc/pending
router.get('/pending', authenticateToken, isAdmin, async (req, res) => {
  try {
    const list = await prisma.kycVerification.findMany({
      where: { status: 'pending' },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, phoneNumber: true, verified: true } }
      },
      orderBy: { createdAt: 'asc' }
    });
    res.json(list);
  } catch (err) {
    console.error('Erreur GET /kyc/pending :', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// 🛡️ Admin : voir le détail d'une demande KYC
router.get('/:id', authenticateToken, isAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    const kyc = await prisma.kycVerification.findUnique({
      where: { id },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            phoneNumber: true,
            verified: true
          }
        },
        reviewedBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true
          }
        }
      }
    });

    if (!kyc) {
      return res.status(404).json({ error: 'Demande KYC introuvable.' });
    }

    res.json(kyc);
  } catch (err) {
    console.error('Erreur GET /kyc/:id :', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// 🛡️ Admin : approuver
// PATCH /kyc/:id/approve  body: { note?: string }
router.patch('/:id/approve', authenticateToken, isAdmin, async (req, res) => {
  const { id } = req.params;
  const { note } = req.body;

  try {
    const kyc = await prisma.kycVerification.findUnique({ where: { id } });
    if (!kyc) return res.status(404).json({ error: 'Demande KYC introuvable.' });
    if (kyc.status !== 'pending') return res.status(400).json({ error: 'La demande n’est pas en attente.' });

    const updated = await prisma.$transaction([
      prisma.kycVerification.update({
        where: { id },
        data: {
          status: 'approved',
          reviewedById: req.user.userId,
          reviewedAt: new Date(),
          note: note || null
        }
      }),
      prisma.user.update({
        where: { id: kyc.userId },
        data: { verified: true } // ✅ c’est ici que l’utilisateur devient “vérifié”
      })
    ]);

    res.json({ message: 'KYC approuvé. Utilisateur vérifié.', kyc: updated[0] });
  } catch (err) {
    console.error('Erreur PATCH /kyc/:id/approve :', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// 🛡️ Admin : rejeter
// PATCH /kyc/:id/reject  body: { note?: string }
router.patch('/:id/reject', authenticateToken, isAdmin, async (req, res) => {
  const { id } = req.params;
  const { note } = req.body;

  try {
    const kyc = await prisma.kycVerification.findUnique({ where: { id } });
    if (!kyc) return res.status(404).json({ error: 'Demande KYC introuvable.' });
    if (kyc.status !== 'pending') return res.status(400).json({ error: 'La demande n’est pas en attente.' });

    const updated = await prisma.kycVerification.update({
      where: { id },
      data: {
        status: 'rejected',
        reviewedById: req.user.userId,
        reviewedAt: new Date(),
        note: note || null
      }
    });

    // L’utilisateur reste verified=false
    res.json({ message: 'KYC rejeté.', kyc: updated });
  } catch (err) {
    console.error('Erreur PATCH /kyc/:id/reject :', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// 🛡️ Admin : annuler/retirer une demande KYC (même si approuvée)
router.delete('/:id', authenticateToken, isAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    const kyc = await prisma.kycVerification.findUnique({ where: { id } });
    if (!kyc) return res.status(404).json({ error: 'Demande KYC introuvable.' });

    await prisma.$transaction(async (tx) => {
      if (kyc.status === 'approved') {
        await tx.user.update({
          where: { id: kyc.userId },
          data: { verified: false }
        });
      }

      await tx.kycVerification.delete({ where: { id } });
    });

    res.json({
      message: kyc.status === 'approved'
        ? 'KYC annulé et statut vérifié retiré.'
        : 'Demande KYC supprimée.'
    });
  } catch (err) {
    console.error('Erreur DELETE /kyc/:id :', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});


module.exports = router;
