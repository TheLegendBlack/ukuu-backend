const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'secret_key_dev';

// 🔐 Middleware pour authentifier via JWT
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

    res.status(201).json(newProperty);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la création du bien.' });
  }
});

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

// 🔄 Modifier un bien existant (propriétaire uniquement)
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
