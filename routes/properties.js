const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'secret_key_dev';

/* ===================== Auth ===================== */
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Format: Bearer <token>

  if (!token) return res.status(401).json({ error: 'Token manquant.' });

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Token invalide.' });

    req.user = decoded; // { userId: ... }
    next();
  });
}

/* ============== Utils: calendrier ============== */
function parseISODate(d) {
  const x = new Date(d);
  return (x instanceof Date && !isNaN(x)) ? x : null;
}
function toISOyyyyMMdd(d) {
  return d.toISOString().slice(0,10);
}
function addDays(d, n) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

/* ================== CREATE ================== */
// 📥 POST /properties : Créer un nouveau bien
router.post('/', authenticateToken, async (req, res) => {
  const {
    title,
    description,
    propertyType,
    rentalType,
    maxGuests,
    bedrooms,
    bathrooms,
    pricePerNight,
    pricePerMonth,
    address,
    city,
    country,
    latitude,
    longitude,
    images,
    houseRules
  } = req.body;

  try {
    // 1. Créer le bien
    const newProperty = await prisma.property.create({
      data: {
        hostId: req.user.userId,
        title,
        description,
        propertyType,
        rentalType,
        maxGuests,
        bedrooms,
        bathrooms,
        pricePerNight,
        pricePerMonth,
        address,
        city,
        country: country || 'Republic of Congo',
        latitude,
        longitude,
        images,
        houseRules
      }
    });

    // 2. Vérifie si l'utilisateur a déjà le rôle "host"
    const hasHostRole = await prisma.userRoleOnUser.findFirst({
      where: {
        userId: req.user.userId,
        role: 'host'
      }
    });

    // 3. Si ce n'est pas le cas, on lui attribue
    if (!hasHostRole) {
      await prisma.userRoleOnUser.create({
        data: {
          userId: req.user.userId,
          role: 'host',
          active: true
        }
      });
    }

    res.status(201).json(newProperty);
  } catch (err) {
    console.error('Erreur POST /properties :', err);
    res.status(500).json({ error: 'Erreur lors de la création du bien.' });
  }
});

/* ================== LIST PUBLIC ================== */
// 📤 GET /properties : Lister tous les biens actifs
router.get('/', async (req, res) => {
  try {
    const properties = await prisma.property.findMany({
      where: { active: true },
      include: {
        host: {
          select: { firstName: true, lastName: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json(properties);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la récupération des biens.' });
  }
});

/* ================== DETAIL PUBLIC ================== */
// 🔍 GET /properties/:id : Voir un bien spécifique
router.get('/:id', async (req, res) => {
  try {
    const property = await prisma.property.findUnique({
      where: { id: req.params.id },
      include: {
        host: {
          select: {
            id: true,
            firstName: true,
            lastName: true
          }
        }
      }
    });

    if (!property) return res.status(404).json({ error: 'Bien non trouvé.' });

    res.json(property);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

/* ================== AVAILABILITY ================== */
// 📅 GET /properties/:id/availability?from=YYYY-MM-DD&to=YYYY-MM-DD
// Renvoie un tableau de jours avec disponibilité calculée à partir des bookings + blocs d’indispo
router.get('/:id/availability', async (req, res) => {
  const { id } = req.params;
  const fromParam = req.query.from;
  const toParam   = req.query.to;

  try {
    // Bornes par défaut : aujourd’hui → +60 jours
    const today = new Date();
    const defaultFrom = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    const defaultTo   = addDays(defaultFrom, 60);

    const from = fromParam ? parseISODate(fromParam) : defaultFrom;
    const to   = toParam   ? parseISODate(toParam)   : defaultTo;

    if (!from || !to || !(to > from)) {
      return res.status(400).json({ error: 'Paramètres from/to invalides.' });
    }

    // Existence du bien ?
    const exists = await prisma.property.findUnique({ where: { id }, select: { id: true } });
    if (!exists) return res.status(404).json({ error: 'Bien introuvable.' });

    // Récupérer bookings qui intersectent l’intervalle
    const bookings = await prisma.booking.findMany({
      where: {
        propertyId: id,
        status: { in: ['pending', 'confirmed'] },
        NOT: [
          { checkOutDate: { lte: from } },
          { checkInDate:  { gte: to } }
        ]
      },
      select: { checkInDate: true, checkOutDate: true }
    });

    // Récupérer indispos / overrides manuels
    const blocks = await prisma.propertyAvailability.findMany({
      where: {
        propertyId: id,
        date: { gte: from, lt: to }
      },
      select: { date: true, available: true, priceOverride: true }
    });

    // Construire calendrier jour par jour
    const days = [];
    for (let d = new Date(from); d < to; d = addDays(d, 1)) {
      const key = toISOyyyyMMdd(d);

      // Booked ?
      const isBooked = bookings.some(b => {
        const bStart = new Date(b.checkInDate);
        const bEnd   = new Date(b.checkOutDate);
        // jour d ∈ [bStart, bEnd)
        const startUTC = new Date(Date.UTC(bStart.getUTCFullYear(), bStart.getUTCMonth(), bStart.getUTCDate()));
        const endUTC   = new Date(Date.UTC(bEnd.getUTCFullYear(), bEnd.getUTCMonth(), bEnd.getUTCDate()));
        return d >= startUTC && d < endUTC;
      });

      // Bloc manuel ?
      const block = blocks.find(x => toISOyyyyMMdd(new Date(x.date)) === key);
      let available = !isBooked && (!block || block.available !== false);
      let reason = null;
      if (isBooked) reason = 'booked';
      else if (block && block.available === false) reason = 'blocked';

      days.push({
        date: key,
        available,
        reason,                                  // 'booked' | 'blocked' | null
        priceOverride: block ? block.priceOverride : null
      });
    }

    res.json({
      propertyId: id,
      from: toISOyyyyMMdd(from),
      to: toISOyyyyMMdd(to),
      days
    });
  } catch (err) {
    console.error('Erreur GET /properties/:id/availability :', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

/* ================== DELETE (soft) ================== */
// 🧹 DELETE /properties/:id : Supprimer un bien (logiquement, pas physiquement)
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const property = await prisma.property.findUnique({
      where: { id: req.params.id }
    });

    if (!property || property.hostId !== req.user.userId) {
      return res.status(403).json({ error: 'Non autorisé.' });
    }

    await prisma.property.update({
      where: { id: req.params.id },
      data: { active: false }
    });

    res.json({ message: 'Bien désactivé avec succès.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

/* ================== UPDATE ================== */
// 🔄 PATCH /properties/:id : Modifier un bien (propriétaire uniquement)
router.patch('/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const updates = req.body;

  try {
    // Vérifier que le bien appartient à l'utilisateur connecté
    const property = await prisma.property.findUnique({ where: { id } });

    if (!property) {
      return res.status(404).json({ error: 'Bien non trouvé.' });
    }

    if (property.hostId !== req.user.userId) {
      return res.status(403).json({ error: 'Accès refusé.' });
    }

    // Mise à jour du bien
    const updated = await prisma.property.update({
      where: { id },
      data: updates,
    });

    res.json({ message: 'Bien mis à jour avec succès.', property: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

module.exports = router;
