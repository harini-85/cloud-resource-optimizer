const logger = require('../utils/logger');

/**
 * Recommendation Handler Module
 * Processes ML service responses and enriches them with additional metadata
 * 
 * Handles:
 * - Prediction code mapping (0=Optimal, 1=Oversized, 2=Undersized, 3=Zombie)
 * - Anomaly flag processing (zombie_candidate, sustained_overload, memory_crisis, spike_contamination)
 * - Confidence score validation (0.0-1.0)
 * - Metadata enrichment (data_quality, data_days, granularity, model_version)
 */

/**
 * Map ML prediction codes to recommendation types
 */
const PREDICTION_MAP = {
    0: 'Optimal',
    1: 'Oversized',
    2: 'Undersized',
    3: 'Zombie'
};

/**
 * Validate confidence score is within valid range
 * @param {number} confidence - Confidence score from ML service
 * @returns {number} Validated confidence score (clamped to 0.0-1.0)
 */
function validateConfidence(confidence) {
    if (typeof confidence !== 'number' || isNaN(confidence)) {
        logger.warn('Invalid confidence score received', { confidence });
        return 0.0;
    }

    if (confidence < 0.0) {
        logger.warn('Confidence score below 0.0, clamping to 0.0', { confidence });
        return 0.0;
    }

    if (confidence > 1.0) {
        logger.warn('Confidence score above 1.0, clamping to 1.0', { confidence });
        return 1.0;
    }

    return confidence;
}

/**
 * Map prediction code to recommendation type
 * @param {number} predictionCode - ML prediction code (0-3)
 * @returns {string} Recommendation type
 */
function mapPredictionCode(predictionCode) {
    const recommendation = PREDICTION_MAP[predictionCode];

    if (!recommendation) {
        logger.warn('Unknown prediction code received', { predictionCode });
        return 'Unknown';
    }

    return recommendation;
}

/**
 * Process anomaly flags and determine if recommendation should be blocked
 * @param {string} anomalyFlag - Anomaly flag from ML service
 * @param {string} anomalyMessage - Anomaly message from ML service
 * @returns {Object} Processed anomaly information
 */
function processAnomalyFlags(anomalyFlag, anomalyMessage) {
    // Handle null or 'none' anomaly flags
    if (!anomalyFlag || anomalyFlag === 'none' || anomalyFlag === null) {
        return {
            anomaly_flag: 'none',
            anomaly_message: null,
            recommendation_blocked: false,
            override_recommendation: null
        };
    }

    const result = {
        anomaly_flag: anomalyFlag,
        anomaly_message: anomalyMessage || null,
        recommendation_blocked: false,
        override_recommendation: null
    };

    // Process specific anomaly types
    switch (anomalyFlag) {
        case 'zombie_candidate':
            // Zombie instances should override recommendation to TERMINATE
            result.override_recommendation = 'Zombie';
            result.recommendation_blocked = false;
            logger.info('Zombie candidate detected, overriding recommendation to TERMINATE');
            break;

        case 'sustained_overload':
            // Block recommendation for sustained overload - requires investigation
            result.recommendation_blocked = true;
            logger.warn('Sustained overload detected, blocking recommendation');
            break;

        case 'memory_crisis':
            // Block recommendation for memory crisis - immediate action needed
            result.recommendation_blocked = true;
            logger.warn('Memory crisis detected, blocking recommendation');
            break;

        case 'spike_contamination':
            // Don't block, but flag for reduced confidence
            result.recommendation_blocked = false;
            logger.info('Spike contamination detected, confidence may be reduced');
            break;

        default:
            logger.warn('Unknown anomaly flag received', { anomalyFlag });
            break;
    }

    return result;
}

/**
 * Process a single ML service response
 * @param {Object} mlResponse - Raw response from ML service
 * @param {Object} originalVM - Original VM data for context
 * @returns {Object} Enriched recommendation response
 */
function processSingleResponse(mlResponse, originalVM = {}) {
    // Validate confidence score
    const validatedConfidence = validateConfidence(mlResponse.confidence);

    // Map prediction code to recommendation type
    let recommendationType = mapPredictionCode(mlResponse.prediction);

    // Process anomaly flags
    const anomalyInfo = processAnomalyFlags(
        mlResponse.anomaly_flag,
        mlResponse.anomaly_message
    );

    // Override recommendation if anomaly requires it
    if (anomalyInfo.override_recommendation) {
        recommendationType = anomalyInfo.override_recommendation;
    }

    // Build enriched response
    const enrichedResponse = {
        // Core prediction
        prediction: recommendationType,
        prediction_code: mlResponse.prediction,
        confidence: validatedConfidence,
        recommendation: mlResponse.recommendation || `${recommendationType} recommendation`,

        // Anomaly information
        anomaly_flag: anomalyInfo.anomaly_flag,
        anomaly_message: anomalyInfo.anomaly_message,
        recommendation_blocked: anomalyInfo.recommendation_blocked,

        // Data quality indicators
        data_quality: mlResponse.data_quality || 'unknown',
        data_days: mlResponse.data_days || null,
        granularity: mlResponse.granularity || 'unknown',

        // Model metadata for audit trail
        model_version: mlResponse.model_version || 'unknown',

        // Original VM context (if provided)
        instance_id: originalVM.instance_id || null,
        instance_type: originalVM.instance_type || null,
        region: originalVM.region || null,
        cloud: originalVM.cloud || null
    };

    // Log if recommendation is blocked
    if (anomalyInfo.recommendation_blocked) {
        logger.warn('Recommendation blocked due to anomaly', {
            instance_id: originalVM.instance_id,
            anomaly_flag: anomalyInfo.anomaly_flag,
            anomaly_message: anomalyInfo.anomaly_message
        });
    }

    return enrichedResponse;
}

/**
 * Process batch ML service responses
 * @param {Array} mlResponses - Array of ML service responses
 * @param {Array} originalVMs - Array of original VM data for context
 * @returns {Array} Array of enriched recommendation responses
 */
function processBatchResponses(mlResponses, originalVMs = []) {
    if (!Array.isArray(mlResponses)) {
        logger.error('Invalid batch responses format', { mlResponses });
        throw new Error('ML responses must be an array');
    }

    return mlResponses.map((response, index) => {
        const originalVM = originalVMs[index] || {};

        try {
            return processSingleResponse(response, originalVM);
        } catch (error) {
            logger.error('Error processing response', {
                index,
                instance_id: originalVM.instance_id,
                error: error.message
            });

            // Return error response for this item
            return {
                prediction: 'Error',
                prediction_code: -1,
                confidence: 0.0,
                recommendation: 'Error processing recommendation',
                anomaly_flag: 'none',
                anomaly_message: error.message,
                recommendation_blocked: true,
                data_quality: 'unknown',
                data_days: null,
                granularity: 'unknown',
                model_version: 'unknown',
                instance_id: originalVM.instance_id || null,
                instance_type: originalVM.instance_type || null,
                region: originalVM.region || null,
                cloud: originalVM.cloud || null,
                error: error.message
            };
        }
    });
}

/**
 * Check if a recommendation should be shown based on confidence and blocking flags
 * @param {Object} processedResponse - Processed recommendation response
 * @param {number} minConfidence - Minimum confidence threshold (default 0.5)
 * @returns {boolean} True if recommendation should be shown
 */
function shouldShowRecommendation(processedResponse, minConfidence = 0.5) {
    // Don't show if recommendation is blocked
    if (processedResponse.recommendation_blocked) {
        return false;
    }

    // Don't show if confidence is below threshold
    if (processedResponse.confidence < minConfidence) {
        return false;
    }

    return true;
}

/**
 * Get confidence level label
 * @param {number} confidence - Confidence score (0.0-1.0)
 * @returns {string} Confidence level label
 */
function getConfidenceLevel(confidence) {
    if (confidence >= 0.75) {
        return 'high';
    } else if (confidence >= 0.50) {
        return 'medium';
    } else {
        return 'low';
    }
}

/**
 * Enrich response with additional computed fields
 * @param {Object} processedResponse - Processed recommendation response
 * @returns {Object} Response with additional computed fields
 */
function enrichResponse(processedResponse) {
    return {
        ...processedResponse,
        confidence_level: getConfidenceLevel(processedResponse.confidence),
        should_show: shouldShowRecommendation(processedResponse),
        confidence_percentage: Math.round(processedResponse.confidence * 100)
    };
}

module.exports = {
    processSingleResponse,
    processBatchResponses,
    validateConfidence,
    mapPredictionCode,
    processAnomalyFlags,
    shouldShowRecommendation,
    getConfidenceLevel,
    enrichResponse,
    PREDICTION_MAP
};
