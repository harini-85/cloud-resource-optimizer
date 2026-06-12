/**
 * Azure Native Recommendations Configuration
 * 
 * This module manages configuration for Azure native recommendation fetching,
 * including feature flags, API settings, and performance parameters.
 */

const logger = require('../utils/logger');

/**
 * Azure Native Recommendations Configuration
 */
const AZURE_NATIVE_CONFIG = {
    // Feature flag - global enable/disable
    enabled: process.env.AZURE_NATIVE_RECOMMENDATIONS_ENABLED === 'true',

    // API Configuration
    batchSize: parseInt(process.env.AZURE_BATCH_SIZE || '50'),
    maxRetries: parseInt(process.env.AZURE_MAX_RETRIES || '3'),
    timeoutMs: parseInt(process.env.AZURE_TIMEOUT_MS || '30000'),

    // Caching Configuration
    cacheEnabled: process.env.AZURE_CACHE_ENABLED !== 'false',
    cacheTtlHours: parseInt(process.env.AZURE_CACHE_TTL_HOURS || '24'),

    // Performance Configuration
    concurrency: parseInt(process.env.AZURE_CONCURRENCY || '5'),

    // Rate Limiting
    rateLimitDelay: 100, // ms between batch requests

    // Validation
    maxVmsPerRequest: 500, // Maximum VMs to process in a single request
    maxRegionsPerRequest: 20, // Maximum regions to process concurrently
};

/**
 * Validate configuration parameters
 */
function validateConfig() {
    const errors = [];

    if (AZURE_NATIVE_CONFIG.batchSize < 1 || AZURE_NATIVE_CONFIG.batchSize > 100) {
        errors.push('AZURE_BATCH_SIZE must be between 1 and 100');
    }

    if (AZURE_NATIVE_CONFIG.maxRetries < 0 || AZURE_NATIVE_CONFIG.maxRetries > 10) {
        errors.push('AZURE_MAX_RETRIES must be between 0 and 10');
    }

    if (AZURE_NATIVE_CONFIG.timeoutMs < 1000 || AZURE_NATIVE_CONFIG.timeoutMs > 300000) {
        errors.push('AZURE_TIMEOUT_MS must be between 1000 and 300000 (5 minutes)');
    }

    if (AZURE_NATIVE_CONFIG.cacheTtlHours < 1 || AZURE_NATIVE_CONFIG.cacheTtlHours > 168) {
        errors.push('AZURE_CACHE_TTL_HOURS must be between 1 and 168 (1 week)');
    }

    if (AZURE_NATIVE_CONFIG.concurrency < 1 || AZURE_NATIVE_CONFIG.concurrency > 20) {
        errors.push('AZURE_CONCURRENCY must be between 1 and 20');
    }

    if (errors.length > 0) {
        logger.error('[Azure Native Config] Configuration validation failed:', errors);
        throw new Error(`Azure Native configuration errors: ${errors.join(', ')}`);
    }

    logger.info('[Azure Native Config] Configuration validated successfully', {
        enabled: AZURE_NATIVE_CONFIG.enabled,
        batchSize: AZURE_NATIVE_CONFIG.batchSize,
        maxRetries: AZURE_NATIVE_CONFIG.maxRetries,
        timeoutMs: AZURE_NATIVE_CONFIG.timeoutMs,
        cacheEnabled: AZURE_NATIVE_CONFIG.cacheEnabled,
        cacheTtlHours: AZURE_NATIVE_CONFIG.cacheTtlHours,
        concurrency: AZURE_NATIVE_CONFIG.concurrency
    });
}

/**
 * Check if Azure native recommendations are enabled globally
 * @returns {boolean} True if enabled globally
 */
function isAzureNativeEnabled() {
    return AZURE_NATIVE_CONFIG.enabled;
}

/**
 * Check if Azure native recommendations are enabled for a specific user
 * This allows for gradual rollout and per-user feature flags
 * 
 * @param {string} userId - User ID to check
 * @param {string} tenantId - Optional tenant ID for multi-tenant scenarios
 * @returns {boolean} True if enabled for this user
 */
function isAzureNativeEnabledForUser(userId = null, tenantId = null) {
    // Global feature flag check first
    if (!AZURE_NATIVE_CONFIG.enabled) {
        return false;
    }

    // TODO: Implement per-user or per-tenant feature flags
    // This could be extended to check a database or configuration service
    // for user-specific or tenant-specific feature flag overrides

    // For now, return global setting
    // Future implementation could include:
    // - Database lookup for user-specific flags
    // - Percentage-based rollout (e.g., enable for 10% of users)
    // - Tenant-specific configuration

    return true;
}

/**
 * Get the current configuration
 * @returns {object} Current Azure native configuration
 */
function getConfig() {
    return { ...AZURE_NATIVE_CONFIG };
}

/**
 * Update configuration at runtime (for dynamic configuration support)
 * @param {object} updates - Configuration updates to apply
 */
function updateConfig(updates) {
    const allowedUpdates = [
        'batchSize',
        'maxRetries',
        'timeoutMs',
        'cacheEnabled',
        'cacheTtlHours',
        'concurrency'
    ];

    const validUpdates = {};
    for (const [key, value] of Object.entries(updates)) {
        if (allowedUpdates.includes(key)) {
            validUpdates[key] = value;
        } else {
            logger.warn(`[Azure Native Config] Ignoring invalid configuration update: ${key}`);
        }
    }

    if (Object.keys(validUpdates).length === 0) {
        logger.warn('[Azure Native Config] No valid configuration updates provided');
        return;
    }

    // Apply updates
    Object.assign(AZURE_NATIVE_CONFIG, validUpdates);

    // Re-validate configuration
    try {
        validateConfig();
        logger.info('[Azure Native Config] Configuration updated successfully', validUpdates);
    } catch (error) {
        logger.error('[Azure Native Config] Configuration update failed validation:', error.message);
        throw error;
    }
}

/**
 * Get cache TTL in milliseconds
 * @returns {number} Cache TTL in milliseconds
 */
function getCacheTtlMs() {
    return AZURE_NATIVE_CONFIG.cacheTtlHours * 60 * 60 * 1000;
}

/**
 * Check if caching is enabled
 * @returns {boolean} True if caching is enabled
 */
function isCacheEnabled() {
    return AZURE_NATIVE_CONFIG.cacheEnabled;
}

// Validate configuration on module load
try {
    validateConfig();
} catch (error) {
    logger.error('[Azure Native Config] Failed to initialize configuration:', error.message);
    // Don't throw here to prevent application startup failure
    // The error will be caught when the feature is actually used
}

module.exports = {
    AZURE_NATIVE_CONFIG,
    isAzureNativeEnabled,
    isAzureNativeEnabledForUser,
    getConfig,
    updateConfig,
    getCacheTtlMs,
    isCacheEnabled,
    validateConfig
};