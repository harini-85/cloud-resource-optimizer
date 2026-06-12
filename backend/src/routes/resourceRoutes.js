const express = require('express');
const router = express.Router();
const resourceController = require('../controllers/resourceController');
const authMiddleware = require('../middleware/authMiddleware');

// Legacy endpoints
router.get('/:resourceId/metrics', authMiddleware, resourceController.getResourceMetrics);
router.get('/instances/:instanceId/usage', authMiddleware, resourceController.getInstanceUsage);

// Enhanced multi-provider metrics endpoints
router.get('/instances/:instanceId/enhanced-usage', authMiddleware, resourceController.getEnhancedInstanceUsage);
router.get('/instances/:instanceId/gcp-metrics', authMiddleware, resourceController.getGCPInstanceMetrics);
router.get('/instances/:instanceId/azure-metrics', authMiddleware, resourceController.getAzureInstanceMetrics);

// Compute Optimizer endpoints
router.get('/compute-optimizer/recommendations', authMiddleware, resourceController.getComputeOptimizerRecommendations);
router.get('/compute-optimizer/diagnostics', authMiddleware, resourceController.diagnoseComputeOptimizerSetup);
router.get('/instances/:instanceId/compute-optimizer', authMiddleware, resourceController.getInstanceComputeOptimizerRecommendation);

// ML recommendation endpoints
router.get('/:id/recommendation', authMiddleware, resourceController.getRecommendation);
router.post('/recommendations/batch', authMiddleware, resourceController.getBatchRecommendations);

module.exports = router;
