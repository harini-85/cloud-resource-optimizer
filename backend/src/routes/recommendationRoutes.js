const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const mlService = require('../services/mlService');
const recommendationHandler = require('../services/recommendationHandler');
const featureTransformer = require('../services/featureTransformer');
const Resource = require('../models/Resource');
const logger = require('../utils/logger');

/**
 * Recommendation API Routes
 * Provides ML-based recommendation endpoints for cloud resource optimization
 * 
 * Endpoints:
 * - GET /api/resources/:id/recommendation - Get recommendation for a single resource
 * - POST /api/resources/recommendations/batch - Get recommendations for multiple resources
 * - GET /api/ml/health - Check ML service health
 * - GET /api/ml/model-info - Get ML model information
 */

/**
 * Validate request parameters
 * @param {Object} params - Parameters to validate
 * @param {Array} required - Required parameter names
 * @returns {Object|null} Error object if validation fails, null otherwise
 */
function validateParams(params, required) {
    for (const param of required) {
        if (!params[param]) {
            return {
                success: false,
                error: `Missing required parameter: ${param}`,
                code: 'INVALID_INPUT'
            };
        }
    }
    return null;
}

/**
 * GET /api/resources/:id/recommendation
 * Get ML-based recommendation for a single resource
 * 
 * Requirements: 13.1
 * 
 * Response:
 * - 200: Recommendation data
 * - 400: Invalid input
 * - 404: Resource not found
 * - 503: ML service unavailable
 */
router.get('/:id/recommendation', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;

        // Validate resource ID
        const validationError = validateParams({ id }, ['id']);
        if (validationError) {
            return res.status(400).json(validationError);
        }

        logger.info(`Getting recommendation for resource ${id}`);

        // Fetch resource from database
        const resource = await Resource.findById(id);
        if (!resource) {
            return res.status(404).json({
                success: false,
                error: 'Resource not found',
                code: 'RESOURCE_NOT_FOUND'
            });
        }

        // Transform resource to ML features
        const features = featureTransformer.transformResource(resource);

        // Check if resource has sufficient data for ML prediction
        if (!features || features.cpu_avg === null || features.cpu_avg === undefined) {
            return res.status(200).json({
                success: true,
                data: {
                    instance_id: resource.instance_id,
                    status: 'insufficient_data',
                    prediction: 'Insufficient Data',
                    confidence: 0,
                    confidence_flag: 'insufficient',
                    recommendation: null,
                    message: 'Insufficient CPU metrics for ML prediction'
                }
            });
        }

        // Get prediction from ML service
        try {
            const prediction = await mlService.predictSingle(features);

            // Process response with recommendation handler
            const enrichedResponse = recommendationHandler.enrichResponse(
                recommendationHandler.processSingleResponse(prediction, resource)
            );

            return res.status(200).json({
                success: true,
                data: enrichedResponse
            });

        } catch (mlError) {
            // ML service unavailable - return 503
            logger.error('ML service error for single prediction', {
                instance_id: resource.instance_id,
                error: mlError.message
            });

            return res.status(503).json({
                success: false,
                error: 'ML service is currently unavailable',
                code: 'ML_SERVICE_UNAVAILABLE',
                details: mlError.message
            });
        }

    } catch (error) {
        logger.error('Error getting recommendation', {
            resourceId: req.params.id,
            error: error.message
        });

        return res.status(500).json({
            success: false,
            error: 'Internal server error',
            code: 'INTERNAL_ERROR'
        });
    }
});

/**
 * POST /api/resources/recommendations/batch
 * Get ML-based recommendations for multiple resources
 * 
 * Requirements: 13.2
 * 
 * Request body:
 * {
 *   "resource_ids": ["id1", "id2", ...] // Array of resource IDs (max 1000)
 * }
 * 
 * Response:
 * - 200: Batch recommendation data
 * - 400: Invalid input (missing IDs, too many IDs)
 * - 503: ML service unavailable
 */
router.post('/recommendations/batch', authMiddleware, async (req, res) => {
    try {
        const { resource_ids } = req.body;

        // Validate request body
        if (!resource_ids || !Array.isArray(resource_ids)) {
            return res.status(400).json({
                success: false,
                error: 'Missing or invalid resource_ids array',
                code: 'INVALID_INPUT'
            });
        }

        // Validate batch size (max 1000)
        if (resource_ids.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'resource_ids array cannot be empty',
                code: 'INVALID_INPUT'
            });
        }

        if (resource_ids.length > 1000) {
            return res.status(400).json({
                success: false,
                error: 'Batch size exceeds maximum of 1000 resources',
                code: 'BATCH_SIZE_EXCEEDED'
            });
        }

        logger.info(`Getting batch recommendations for ${resource_ids.length} resources`);

        // Fetch resources from database
        const resources = await Resource.find({
            _id: { $in: resource_ids }
        });

        if (resources.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'No resources found with provided IDs',
                code: 'RESOURCES_NOT_FOUND'
            });
        }

        // Transform resources to ML features
        const enrichedVMs = resources.map(resource =>
            featureTransformer.transformResource(resource)
        );

        // Process VMs with ML service
        try {
            const predictions = await mlService.processVMsWithML(enrichedVMs);

            // Process responses with recommendation handler
            const enrichedResponses = predictions.map((prediction, index) => {
                const originalResource = resources[index];
                return recommendationHandler.enrichResponse(
                    recommendationHandler.processSingleResponse(prediction, originalResource)
                );
            });

            // Calculate batch statistics
            const stats = {
                total: enrichedResponses.length,
                optimal: enrichedResponses.filter(r => r.prediction === 'Optimal').length,
                oversized: enrichedResponses.filter(r => r.prediction === 'Oversized').length,
                undersized: enrichedResponses.filter(r => r.prediction === 'Undersized').length,
                zombie: enrichedResponses.filter(r => r.prediction === 'Zombie').length,
                insufficient_data: enrichedResponses.filter(r => r.prediction === 'Insufficient Data').length
            };

            return res.status(200).json({
                success: true,
                data: {
                    results: enrichedResponses,
                    statistics: stats
                }
            });

        } catch (mlError) {
            // ML service unavailable - return 503
            logger.error('ML service error for batch prediction', {
                batchSize: resource_ids.length,
                error: mlError.message
            });

            return res.status(503).json({
                success: false,
                error: 'ML service is currently unavailable',
                code: 'ML_SERVICE_UNAVAILABLE',
                details: mlError.message
            });
        }

    } catch (error) {
        logger.error('Error getting batch recommendations', {
            error: error.message
        });

        return res.status(500).json({
            success: false,
            error: 'Internal server error',
            code: 'INTERNAL_ERROR'
        });
    }
});

/**
 * GET /api/ml/health
 * Check ML service health and availability
 * 
 * Requirements: 13.3
 * 
 * Response:
 * - 200: ML service health status
 */
router.get('/ml/health', authMiddleware, async (req, res) => {
    try {
        const health = await mlService.checkHealth();

        return res.status(200).json({
            success: true,
            data: health
        });

    } catch (error) {
        logger.error('Error checking ML service health', {
            error: error.message
        });

        return res.status(200).json({
            success: true,
            data: {
                available: false,
                enabled: true,
                error: error.message
            }
        });
    }
});

/**
 * GET /api/ml/model-info
 * Get ML model version and metadata
 * 
 * Requirements: 13.4
 * 
 * Response:
 * - 200: Model information
 * - 503: ML service unavailable
 */
router.get('/ml/model-info', authMiddleware, async (req, res) => {
    try {
        // Get ML service configuration
        const config = mlService.getConfiguration();

        // Try to get health info which includes model version
        const health = await mlService.checkHealth();

        return res.status(200).json({
            success: true,
            data: {
                model_version: process.env.ML_MODEL_VERSION || 'v2_20250227_143022',
                service_url: config.url,
                service_enabled: config.enabled,
                service_available: health.available,
                model_loaded: health.model_loaded || false,
                postgres_connected: health.postgres_connected || false,
                timeout: config.timeout
            }
        });

    } catch (error) {
        logger.error('Error getting ML model info', {
            error: error.message
        });

        // Return configuration even if health check fails
        const config = mlService.getConfiguration();

        return res.status(200).json({
            success: true,
            data: {
                model_version: process.env.ML_MODEL_VERSION || 'v2_20250227_143022',
                service_url: config.url,
                service_enabled: config.enabled,
                service_available: false,
                error: error.message
            }
        });
    }
});

module.exports = router;
