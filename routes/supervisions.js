const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'secret_key_dev';

// 🔐 Middleware d'authentification JWT
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Token manquant.' });

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Token invalide.' });

    req.user = decoded; // Injecte l'utilisateur dans la requête
    next();
  });
}

// 🔧 POST /supervisions : Assigner un superviseur via téléphone
router.post('/', authenticateToken, async (req, res) => {
  const { phoneNumber, propertyId } = req.body;

  if (!phoneNumber || !propertyId) {
    return res.status(400).json({ error: 'Téléphone et ID du bien requis.' });
  }

  try {
    // Vérifier que l'utilisateur connecté est le propriétaire du bien
    const property = await prisma.property.findUnique({ where: { id: propertyId } });
    if (!property || property.hostId !== req.user.userId) {
      return res.status(403).json({ error: 'Non autorisé à assigner ce bien.' });
    }

    // Rechercher l'utilisateur à assigner
    const targetUser = await prisma.user.findUnique({ where: { phoneNumber } });
    if (!targetUser) return res.status(404).json({ error: 'Utilisateur non trouvé.' });

    // Ajouter le rôle "supervisor" s’il ne l’a pas
    const existingRole = await prisma.role.findFirst({
      where: {
        userId: targetUser.id,
        role: 'supervisor'
      }
    });

    if (!existingRole) {
      await prisma.role.create({
        data: {
          userId: targetUser.id,
          role: 'supervisor',
          active: true
        }
      });
    }

    // Créer le lien de supervision
    await prisma.supervision.create({
      data: {
        propertyId,
        supervisorId: targetUser.id,
        assignedById: req.user.userId
      }
    });

    res.status(201).json({ message: 'Superviseur assigné avec succès.' });
  } catch (err) {
    console.error('Erreur dans /supervisions :', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// 📄 GET /supervisions : Voir les biens supervisés ou assignés
router.get('/', authenticateToken, async (req, res) => {
  try {
    const supervisions = await prisma.supervision.findMany({
      where: {
        OR: [
          { supervisorId: req.user.userId },         // je suis superviseur
          { assignedById: req.user.userId }          // je suis le propriétaire
        ]
      },
      include: {
        property: {
          select: {
            id: true,
            title: true,
            address: true,
            city: true,
            active: true
          }
        },
        supervisor: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            phoneNumber: true
          }
        },
        assignedBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    res.json(supervisions);
  } catch (err) {
    console.error('Erreur dans GET /supervisions :', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ❌ DELETE /supervisions/:id : Retirer un superviseur d’un bien
router.delete('/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    const supervision = await prisma.supervision.findUnique({
      where: { id },
    });

    if (!supervision) {
      return res.status(404).json({ error: 'Supervision non trouvée.' });
    }

    if (supervision.assignedById !== req.user.userId) {
      return res.status(403).json({ error: 'Non autorisé à supprimer cette supervision.' });
    }

    await prisma.supervision.delete({
      where: { id },
    });

    res.json({ message: 'Superviseur retiré avec succès.' });
  } catch (err) {
    console.error('Erreur dans DELETE /supervisions/:id :', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

module.exports = router;
