const logger = require('../utils/logger');

/**
 * Feature Transformation Service
 * Transforms MongoDB Resource documents into ML model feature format
 * 
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7
 */

/**
 * Extract 12 core features from MongoDB Resource document
 * 
 * Core Features:
 * - cpu_avg: Average CPU utilization (0-100)
 * - cpu_p95: 95th percentile CPU utilization (0-100)
 * - memory_avg: Average memory utilization (0-100, nullable)
 * - memory_p95: 95th percentile memory utilization (0-100, nullable)
 * - disk_read_iops: Disk read IOPS (>= 0)
 * - disk_write_iops: Disk write IOPS (>= 0)
 * - network_in_bytes: Network inbound bytes (>= 0)
 * - network_out_bytes: Network outbound bytes (>= 0)
 * - vcpu_count: Number of vCPUs (>= 0)
 * - ram_gb: RAM in GB (>= 0)
 * - uptime_hours: Uptime in hours (>= 0)
 * - cost_per_month: Monthly cost (>= 0)
 * 
 * @param {Object} resource - MongoDB Resource document
 * @returns {Object} Transformed features object
 */
function extractCoreFeatures(resource) {
    // Extract CPU metrics (required)
    const cpu_avg = resource.cpu_avg ?? resource.avgCpuUtilization ?? null;
    const cpu_p95 = resource.cpu_p95 ?? resource.maxCpuUtilization ?? null;

    // Extract memory metrics (nullable - ML service handles missing memory)
    const memory_avg = resource.memory_avg ?? resource.avgMemoryUtilization ?? null;
    const memory_p95 = resource.memory_p95 ?? resource.maxMemoryUtilization ?? null;

    // Extract disk metrics (default to 0 if missing)
    const disk_read_iops = resource.disk_read_iops ?? resource.diskReadBytes ?? 0;
    const disk_write_iops = resource.disk_write_iops ?? resource.diskWriteBytes ?? 0;

    // Extract network metrics (default to 0 if missing)
    const network_in_bytes = resource.network_in_bytes ?? resource.networkIn ?? 0;
    const network_out_bytes = resource.network_out_bytes ?? resource.networkOut ?? 0;

    // Extract instance specs
    const vcpu_count = resource.vCpu ?? resource.vcpu_count ?? 0;
    const ram_gb = resource.memoryGb ?? resource.ram_gb ?? 0;

    // Calculate uptime_hours from running_hours_last_14d
    const uptime_hours = calculateUptimeHours(resource);

    // Calculate cost_per_month from pricing data
    const cost_per_month = calculateCostPerMonth(resource);

    return {
        cpu_avg,
        cpu_p95,
        memory_avg,
        memory_p95,
        disk_read_iops,
        disk_write_iops,
        network_in_bytes,
        network_out_bytes,
        vcpu_count,
        ram_gb,
        uptime_hours,
        cost_per_month
    };
}

/**
 * Calculate uptime_hours from running_hours_last_14d
 * 
 * @param {Object} resource - MongoDB Resource document
 * @returns {number} Uptime in hours
 */
function calculateUptimeHours(resource) {
    // Priority 1: Use running_hours_last_14d if available
    if (resource.running_hours_last_14d !== null && resource.running_hours_last_14d !== undefined) {
        return Math.max(0, resource.running_hours_last_14d);
    }

    // Priority 2: Use uptime_hours if already calculated
    if (resource.uptime_hours !== null && resource.uptime_hours !== undefined) {
        return Math.max(0, resource.uptime_hours);
    }

    // Priority 3: Calculate from metrics_window_days
    if (resource.metrics_window_days !== null && resource.metrics_window_days !== undefined) {
        return Math.max(0, resource.metrics_window_days * 24);
    }

    // Default: Assume 30 days (720 hours)
    return 720;
}

/**
 * Calculate cost_per_month from pricing data
 * 
 * @param {Object} resource - MongoDB Resource document
 * @returns {number} Monthly cost
 */
function calculateCostPerMonth(resource) {
    // Priority 1: Use estimatedMonthlyCost if available
    if (resource.estimatedMonthlyCost !== null && resource.estimatedMonthlyCost !== undefined) {
        return Math.max(0, resource.estimatedMonthlyCost);
    }

    // Priority 2: Use cost_per_month if already calculated
    if (resource.cost_per_month !== null && resource.cost_per_month !== undefined) {
        return Math.max(0, resource.cost_per_month);
    }

    // Priority 3: Calculate from price_per_hour (730 hours per month)
    if (resource.price_per_hour !== null && resource.price_per_hour !== undefined) {
        return Math.max(0, resource.price_per_hour * 730);
    }

    // Default: 0 (pricing unavailable)
    return 0;
}

/**
 * Extract optional enhanced features when available
 * 
 * Enhanced Features (12 additional):
 * - cpu_spike_ratio: Ratio of peak to average CPU (>= 1.0)
 * - memory_spike_ratio: Ratio of peak to average memory (>= 1.0)
 * - cpu_throttle_percent: CPU throttling percentage (0-100)
 * - peak_hour_avg_cpu: Average CPU during peak hours (0-100)
 * - off_peak_avg_cpu: Average CPU during off-peak hours (0-100)
 * - weekend_avg_cpu: Average CPU during weekends (0-100)
 * - memory_swap_usage: Memory swap usage percentage (0-100)
 * - disk_latency_ms: Disk latency in milliseconds (>= 0)
 * - network_packet_loss: Network packet loss percentage (0-100)
 * - data_days: Number of days of data (>= 1)
 * - granularity_hourly: 1 for hourly, 0 for daily
 * - workload_pattern: 0=steady, 1=bursty, 2=periodic, 3=idle
 * 
 * @param {Object} resource - MongoDB Resource document
 * @param {Object} coreFeatures - Core features object
 * @returns {Object} Enhanced features object
 */
function extractEnhancedFeatures(resource, coreFeatures) {
    // Calculate spike ratios
    const cpu_spike_ratio = calculateSpikeRatio(coreFeatures.cpu_p95, coreFeatures.cpu_avg);
    const memory_spike_ratio = calculateSpikeRatio(coreFeatures.memory_p95, coreFeatures.memory_avg);

    // Extract throttling and time-based metrics
    const cpu_throttle_percent = resource.cpu_throttle_percent ?? 0;
    const peak_hour_avg_cpu = resource.peak_hour_avg_cpu ?? coreFeatures.cpu_avg;
    const off_peak_avg_cpu = resource.off_peak_avg_cpu ?? coreFeatures.cpu_avg;
    const weekend_avg_cpu = resource.weekend_avg_cpu ?? coreFeatures.cpu_avg;

    // Extract memory and disk metrics
    const memory_swap_usage = resource.memory_swap_usage ?? 0;
    const disk_latency_ms = resource.disk_latency_ms ?? 10.0;

    // Extract network metrics
    const network_packet_loss = resource.network_packet_loss ?? 0;

    // Extract data quality metrics
    const data_days = resource.metrics_window_days ?? resource.data_days ?? 30;
    const granularity_hourly = resource.granularity_hourly ?? 1;

    // Determine workload pattern
    const workload_pattern = determineWorkloadPattern(resource, coreFeatures);

    return {
        cpu_spike_ratio,
        memory_spike_ratio,
        cpu_throttle_percent,
        peak_hour_avg_cpu,
        off_peak_avg_cpu,
        weekend_avg_cpu,
        memory_swap_usage,
        disk_latency_ms,
        network_packet_loss,
        data_days,
        granularity_hourly,
        workload_pattern
    };
}

/**
 * Calculate spike ratio (p95 / avg)
 * 
 * @param {number|null} p95 - 95th percentile value
 * @param {number|null} avg - Average value
 * @returns {number} Spike ratio (>= 1.0)
 */
function calculateSpikeRatio(p95, avg) {
    // Handle null values
    if (p95 === null || avg === null || avg === 0) {
        return 1.0;
    }

    const ratio = p95 / avg;
    return Math.max(1.0, ratio);
}

/**
 * Determine workload pattern based on metrics
 * 
 * Patterns:
 * - 0: Steady (low variance)
 * - 1: Bursty (high spikes)
 * - 2: Periodic (time-based patterns)
 * - 3: Idle (very low utilization)
 * 
 * @param {Object} resource - MongoDB Resource document
 * @param {Object} coreFeatures - Core features object
 * @returns {number} Workload pattern (0-3)
 */
function determineWorkloadPattern(resource, coreFeatures) {
    // If explicitly set, use it
    if (resource.workload_pattern !== null && resource.workload_pattern !== undefined) {
        return Math.max(0, Math.min(3, resource.workload_pattern));
    }

    // Determine pattern from metrics
    const cpu_avg = coreFeatures.cpu_avg ?? 0;
    const cpu_spike_ratio = calculateSpikeRatio(coreFeatures.cpu_p95, coreFeatures.cpu_avg);

    // Idle: Very low CPU usage
    if (cpu_avg < 5) {
        return 3;
    }

    // Bursty: High spike ratio
    if (cpu_spike_ratio > 2.0) {
        return 1;
    }

    // Periodic: Check for time-based patterns
    const peak_hour_avg_cpu = resource.peak_hour_avg_cpu;
    const off_peak_avg_cpu = resource.off_peak_avg_cpu;
    if (peak_hour_avg_cpu !== null && off_peak_avg_cpu !== null) {
        const time_variance = Math.abs(peak_hour_avg_cpu - off_peak_avg_cpu);
        if (time_variance > 20) {
            return 2;
        }
    }

    // Default: Steady
    return 0;
}

/**
 * Validate that all feature values are non-negative
 * Only validates numeric features, skips metadata fields
 * 
 * @param {Object} features - Features object to validate
 * @returns {Object} Validation result { valid: boolean, errors: string[] }
 */
function validateFeatures(features) {
    const errors = [];

    // Metadata fields to skip (these are strings, not numeric features)
    const metadataFields = ['cloud', 'region', 'instance_type', 'instance_id', 'os', '_validation', '_error'];

    // Check each feature for non-negativity
    for (const [key, value] of Object.entries(features)) {
        // Skip metadata fields
        if (metadataFields.includes(key)) {
            continue;
        }

        // Skip null values (allowed for memory metrics)
        if (value === null) {
            continue;
        }

        // Check if value is a number
        if (typeof value !== 'number') {
            errors.push(`${key} must be a number, got ${typeof value}`);
            continue;
        }

        // Check if value is non-negative
        if (value < 0) {
            errors.push(`${key} must be non-negative, got ${value}`);
        }

        // Check if value is finite
        if (!isFinite(value)) {
            errors.push(`${key} must be finite, got ${value}`);
        }
    }

    return {
        valid: errors.length === 0,
        errors
    };
}

/**
 * Transform MongoDB Resource document to ML feature format
 * 
 * @param {Object} resource - MongoDB Resource document
 * @param {Object} options - Transformation options
 * @param {boolean} options.includeEnhanced - Include enhanced features (default: true)
 * @param {boolean} options.includeMetadata - Include cloud metadata (default: true)
 * @returns {Object} Transformed features with validation result
 */
function transformResource(resource, options = {}) {
    const {
        includeEnhanced = true,
        includeMetadata = true
    } = options;

    try {
        // Extract core features
        const coreFeatures = extractCoreFeatures(resource);

        // Validate core features
        const coreValidation = validateFeatures(coreFeatures);
        if (!coreValidation.valid) {
            logger.warn('Core feature validation failed', {
                resourceId: resource.resourceId,
                errors: coreValidation.errors
            });
        }

        // Build result object
        const result = {
            ...coreFeatures
        };

        // Add enhanced features if requested
        if (includeEnhanced) {
            const enhancedFeatures = extractEnhancedFeatures(resource, coreFeatures);
            const enhancedValidation = validateFeatures(enhancedFeatures);

            if (!enhancedValidation.valid) {
                logger.warn('Enhanced feature validation failed', {
                    resourceId: resource.resourceId,
                    errors: enhancedValidation.errors
                });
            }

            Object.assign(result, enhancedFeatures);
        }

        // Add metadata if requested
        if (includeMetadata) {
            result.cloud = resource.provider?.toLowerCase() ?? 'aws';
            result.region = resource.region ?? 'us-east-1';
            result.instance_type = resource.resourceType ?? 'unknown';
            result.instance_id = resource.resourceId ?? 'unknown';
            result.os = resource.os_type ?? 'Linux';
        }

        // Validate all features together
        const allValidation = validateFeatures(result);

        // Add validation metadata
        result._validation = {
            valid: allValidation.valid,
            errors: allValidation.errors
        };

        return result;

    } catch (error) {
        logger.error('Feature transformation failed', {
            resourceId: resource.resourceId,
            error: error.message
        });

        throw new Error(`Feature transformation failed: ${error.message}`);
    }
}

/**
 * Transform batch of MongoDB Resource documents
 * 
 * @param {Array<Object>} resources - Array of MongoDB Resource documents
 * @param {Object} options - Transformation options
 * @returns {Array<Object>} Array of transformed features
 */
function transformResourceBatch(resources, options = {}) {
    if (!Array.isArray(resources)) {
        throw new Error('Resources must be an array');
    }

    return resources.map(resource => {
        try {
            // Handle null or undefined resources
            if (!resource) {
                return {
                    instance_id: 'unknown',
                    _error: 'Resource is null or undefined',
                    _validation: {
                        valid: false,
                        errors: ['Resource is null or undefined']
                    }
                };
            }

            return transformResource(resource, options);
        } catch (error) {
            logger.error('Batch transformation failed for resource', {
                resourceId: resource?.resourceId ?? 'unknown',
                error: error.message
            });

            // Return error object for failed transformations
            return {
                instance_id: resource?.resourceId ?? 'unknown',
                _error: error.message,
                _validation: {
                    valid: false,
                    errors: [error.message]
                }
            };
        }
    });
}

module.exports = {
    transformResource,
    transformResourceBatch,
    extractCoreFeatures,
    extractEnhancedFeatures,
    calculateUptimeHours,
    calculateCostPerMonth,
    calculateSpikeRatio,
    determineWorkloadPattern,
    validateFeatures
};