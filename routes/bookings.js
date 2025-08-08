const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'secret_key_dev';

/* =========================
   🔐 Auth & Roles
========================= */
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

function authorizeRoles(...allowedRoles) {
  return async (req, res, next) => {
    try {
      const roles = await prisma.userRoleOnUser.findMany({
        where: { userId: req.user.userId, active: true },
        select: { role: true }
      });
      const userRoles = roles.map(r => r.role);
      const hasAccess = userRoles.some(role => allowedRoles.includes(role));
      if (!hasAccess) return res.status(403).json({ error: 'Accès interdit. Rôle insuffisant.' });
      next();
    } catch (err) {
      console.error('Erreur autorisation rôle :', err);
      res.status(500).json({ error: 'Erreur serveur.' });
    }
  };
}

const isAdmin = authorizeRoles('admin');

/* =========================
   🛠 Utils (dates & calculs)
========================= */
function toDate(d) { return new Date(d); }
function isValidRange(start, end) {
  return start instanceof Date && end instanceof Date && !isNaN(start) && !isNaN(end) && end > start;
}

// Vérifie s'il existe une réservation qui chevauche [start, end) pour ce bien
async function hasOverlap(propertyId, start, end, excludeBookingId = null) {
  const where = {
    propertyId,
    status: { in: ['pending', 'confirmed'] }, // on bloque si déjà réservé/confirmé
    NOT: [
      { checkOutDate: { lte: start } }, // fin ≤ début demandé
      { checkInDate:  { gte: end } }    // début ≥ fin demandée
    ]
  };
  if (excludeBookingId) where.id = { not: excludeBookingId };
  const count = await prisma.booking.count({ where });
  return count > 0;
}

async function getPropertyRentalType(propertyId) {
  const data = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { rentalType: true }
  });
  return data?.rentalType || null;
}

// Recalcule le montant selon le rentalType du bien
async function computeTotalAmount(propertyId, start, end) {
  const prop = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { rentalType: true, pricePerNight: true, pricePerMonth: true }
  });
  if (!prop) throw new Error('PROPERTY_NOT_FOUND');

  const durationInDays = Math.ceil((end - start) / (1000 * 60 * 60 * 24));

  if (prop.rentalType === 'short_term') {
    if (!prop.pricePerNight) throw new Error('MISSING_NIGHT_PRICE');
    return durationInDays * prop.pricePerNight;
  }
  if (prop.rentalType === 'long_term') {
    if (!prop.pricePerMonth) throw new Error('MISSING_MONTH_PRICE');
    return prop.pricePerMonth;
  }
  throw new Error('INVALID_RENTAL_TYPE');
}

/* =========================
   📥 Créer une réservation
========================= */
// POST /bookings
router.post('/', authenticateToken, async (req, res) => {
  const {
    propertyId,
    checkInDate,
    checkOutDate,
    guestsCount,
    specialRequests
  } = req.body || {};

  try {
    const start = toDate(checkInDate);
    const end   = toDate(checkOutDate);

    if (!propertyId || !guestsCount || !isValidRange(start, end)) {
      return res.status(400).json({ error: 'Paramètres invalides.' });
    }

    // Refus si chevauchement
    if (await hasOverlap(propertyId, start, end)) {
      return res.status(409).json({ error: 'Ce créneau est déjà réservé.' });
    }

    const totalAmount = await computeTotalAmount(propertyId, start, end);
    const rentalType  = await getPropertyRentalType(propertyId);
    if (!rentalType) return res.status(404).json({ error: 'Bien introuvable.' });

    const booking = await prisma.booking.create({
      data: {
        propertyId,
        guestId: req.user.userId,
        checkInDate: start,
        checkOutDate: end,
        guestsCount,
        rentalType,              // injecté automatiquement depuis la propriété
        totalAmount,
        specialRequests: specialRequests || null
      }
    });

    res.status(201).json({ message: 'Réservation enregistrée.', booking });
  } catch (err) {
    console.error('Erreur POST /bookings :', err);
    if (err.message === 'PROPERTY_NOT_FOUND')   return res.status(404).json({ error: 'Bien introuvable.' });
    if (err.message === 'MISSING_NIGHT_PRICE')  return res.status(400).json({ error: 'Tarif par nuit manquant pour ce bien.' });
    if (err.message === 'MISSING_MONTH_PRICE')  return res.status(400).json({ error: 'Tarif mensuel manquant pour ce bien.' });
    if (err.message === 'INVALID_RENTAL_TYPE')  return res.status(400).json({ error: 'Type de location invalide.' });
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

/* =========================
   📄 Voir ses réservations (guest)
========================= */
// GET /bookings
router.get('/', authenticateToken, async (req, res) => {
  try {
    const bookings = await prisma.booking.findMany({
      where: { guestId: req.user.userId },
      include: {
        property: { select: { id: true, title: true, address: true, city: true } }
      },
      orderBy: { createdAt: 'desc' }
    });
    res.json(bookings);
  } catch (err) {
    console.error('Erreur GET /bookings :', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

/* =========================
   ✏️ Modifier une réservation (guest) 
   + anti-overlap + recalcul
========================= */
// PATCH /bookings/:id
router.patch('/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { checkInDate, checkOutDate, guestsCount, specialRequests } = req.body || {};

  try {
    const existing = await prisma.booking.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Réservation introuvable.' });
    if (existing.guestId !== req.user.userId) return res.status(403).json({ error: 'Non autorisé.' });

    const start = checkInDate ? toDate(checkInDate) : existing.checkInDate;
    const end   = checkOutDate ? toDate(checkOutDate) : existing.checkOutDate;
    if (!isValidRange(start, end)) {
      return res.status(400).json({ error: 'Plage de dates invalide.' });
    }

    // Refus si chevauchement (on exclut la resa elle-même)
    if (await hasOverlap(existing.propertyId, start, end, existing.id)) {
      return res.status(409).json({ error: 'Ce créneau est déjà réservé.' });
    }

    // Recalcul si les dates changent
    let totalAmount = existing.totalAmount;
    if (checkInDate || checkOutDate) {
      totalAmount = await computeTotalAmount(existing.propertyId, start, end);
    }

    const updated = await prisma.booking.update({
      where: { id },
      data: {
        checkInDate: start,
        checkOutDate: end,
        guestsCount: (typeof guestsCount === 'number' ? guestsCount : existing.guestsCount),
        specialRequests: (specialRequests !== undefined ? specialRequests : existing.specialRequests),
        totalAmount
      }
    });

    res.json({ message: 'Réservation modifiée.', booking: updated });
  } catch (err) {
    console.error('Erreur PATCH /bookings/:id :', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

/* =========================
   📬 Réservations reçues (host)
========================= */
// GET /bookings/received
router.get('/received', authenticateToken, async (req, res) => {
  try {
    const properties = await prisma.property.findMany({
      where: { hostId: req.user.userId },
      select: { id: true }
    });
    const propertyIds = properties.map(p => p.id);

    const bookings = await prisma.booking.findMany({
      where: { propertyId: { in: propertyIds } },
      include: {
        guest:    { select: { firstName: true, lastName: true, phoneNumber: true } },
        property: { select: { title: true, address: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json(bookings);
  } catch (err) {
    console.error('Erreur GET /bookings/received :', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

/* =========================
   ✅ Changer statut (host ou superviseur assigné)
========================= */
// PATCH /bookings/:id/status
router.patch('/:id/status', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { status } = (req.body || {}); // expected: confirmed, cancelled, completed
  const userId = req.user.userId;

  try {
    const booking = await prisma.booking.findUnique({
      where: { id },
      include: { property: true }
    });
    if (!booking) return res.status(404).json({ error: 'Réservation introuvable.' });

    const property = booking.property;

    const isHost = property.hostId === userId;
    const isAssignedSupervisor = await prisma.supervision.findFirst({
      where: { propertyId: property.id, supervisorId: userId, active: true }
    });

    if (!isHost && !isAssignedSupervisor) {
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

/* =========================
   ❌ Annuler une réservation (guest)
========================= */
// DELETE /bookings/:id
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

/* =========================
   🌐 Tout voir (admins)
========================= */
// GET /bookings/all
router.get('/all', authenticateToken, isAdmin, async (req, res) => {
  try {
    const bookings = await prisma.booking.findMany({
      include: {
        guest:    { select: { firstName: true, lastName: true } },
        property: { select: { title: true, city: true } }
      },
      orderBy: { createdAt: 'desc' }
    });
    res.json(bookings);
  } catch (err) {
    console.error('Erreur GET /bookings/all :', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

module.exports = router;
