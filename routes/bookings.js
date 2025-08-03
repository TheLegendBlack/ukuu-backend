const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'secret_key_dev';

// 🔐 Middleware d'authentification
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Token manquant.' });

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Token invalide.' });

    req.user = decoded;
    next();
  });
}

// 📥 POST /bookings — Créer une réservation
router.post('/', authenticateToken, async (req, res) => {
  const {
    propertyId,
    checkInDate,
    checkOutDate,
    guestsCount,
    rentalType,
    specialRequests
  } = req.body;

  try {
    // 1. Récupérer le bien
    const property = await prisma.property.findUnique({
      where: { id: propertyId },
      select: {
        pricePerNight: true,
        pricePerMonth: true
      }
    });

    if (!property) {
      return res.status(404).json({ error: 'Bien introuvable.' });
    }

    // 2. Calcul automatique du montant
    const start = new Date(checkInDate);
    const end = new Date(checkOutDate);
    const durationInDays = (end - start) / (1000 * 60 * 60 * 24);

    let totalAmount = 0;

    if (rentalType === 'short_term') {
      if (!property.pricePerNight) {
        return res.status(400).json({ error: 'Tarif par nuit manquant pour ce bien.' });
      }
      totalAmount = durationInDays * property.pricePerNight;
    } else if (rentalType === 'long_term') {
      if (!property.pricePerMonth) {
        return res.status(400).json({ error: 'Tarif mensuel manquant pour ce bien.' });
      }
      totalAmount = property.pricePerMonth;
    } else {
      return res.status(400).json({ error: 'Type de location invalide.' });
    }

    // 3. Créer la réservation
    const booking = await prisma.booking.create({
      data: {
        propertyId,
        guestId: req.user.userId,
        checkInDate: start,
        checkOutDate: end,
        guestsCount,
        rentalType,
        totalAmount,
        specialRequests
      }
    });

    res.status(201).json({ message: 'Réservation enregistrée.', booking });
  } catch (err) {
    console.error('Erreur POST /bookings :', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// 📄 GET /bookings — Voir ses réservations
router.get('/', authenticateToken, async (req, res) => {
  try {
    const bookings = await prisma.booking.findMany({
      where: { guestId: req.user.userId },
      include: {
        property: {
          select: {
            id: true,
            title: true,
            address: true,
            city: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json(bookings);
  } catch (err) {
    console.error('Erreur GET /bookings :', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ✅ PATCH /bookings/:id/status — Modifier le statut (host uniquement)
router.patch('/:id/status', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body; // confirmed, cancelled, completed

  try {
    const booking = await prisma.booking.findUnique({ where: { id } });
    if (!booking) return res.status(404).json({ error: 'Réservation introuvable.' });

    // Vérifie si l'utilisateur est le propriétaire du bien
    const property = await prisma.property.findUnique({ where: { id: booking.propertyId } });
    if (property.hostId !== req.user.userId) {
      return res.status(403).json({ error: 'Non autorisé à modifier cette réservation.' });
    }

    const updated = await prisma.booking.update({
      where: { id },
      data: { status }
    });

    res.json({ message: 'Statut mis à jour.', booking: updated });
  } catch (err) {
    console.error('Erreur PATCH /bookings/:id/status :', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ❌ DELETE /bookings/:id — Annuler une réservation (par guest)
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking || booking.guestId !== req.user.userId) {
      return res.status(403).json({ error: 'Non autorisé.' });
    }

    await prisma.booking.delete({ where: { id: req.params.id } });
    res.json({ message: 'Réservation annulée.' });
  } catch (err) {
    console.error('Erreur DELETE /bookings/:id :', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

module.exports = router;
